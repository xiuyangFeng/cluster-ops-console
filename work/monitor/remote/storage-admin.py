#!/usr/bin/env python3
# storage-admin.py —— 管理员存储视图的服务器端只读脚本（以 root 执行）。
#
# 安装位置：/usr/local/lib/codex-storage-admin/storage-admin.py（root:root 0755，由工作台生成的安装脚本写入）。
# 调用方式：root 的 authorized_keys 里那把专用密钥带 restrict,command="python3 <本脚本>"，
#   该密钥只能触发本脚本，开不了 shell、转发不了端口。子命令取 SSH_ORIGINAL_COMMAND 的第一个词
#   （白名单），其余参数一律从 stdin 读 JSON（≤ 64KB）——命令串里没有任何可注入的东西。
#   不经 SSH 时（root 手动排查）取 argv[1]。
#
# 只读：只做 lstat / scandir / statvfs / 读 /proc/self/mounts / 跑 repquota，不打开任何文件内容。
# 唯一的写入是本脚本自己的状态目录 /var/lib/codex-storage-admin/jobs（扫描进度与结果，最多保留 JOBS_KEEP 份，
# 每份条目数封顶）与 /etc/codex-storage-admin.json 由安装脚本写、这里只读。
# 扫描范围：只允许配置里 roots 列出的目录及其子目录（物理路径，路径上不许有符号链接），不跨文件系统，
# 不跟随符号链接。
#
# 子命令：
#   info         主机名、允许的根、相关挂载点的容量与 inode、根下一层目录、本机账号（含 SSH 最后登录时间，读
#                /var/log/lastlog）、配额是否开启、扫描任务简表
#   quota        {"mount": "/public"} → repquota -unp 的每用户占用（挂载点须开了 usrquota）
#   list         {"path": "/abs"} → 该目录下一层条目（名字、类型、属主、自身大小、修改时间），≤ LIST_CAP 条
#   scan-start   {"root": "/abs"} → 后台起一个整树扫描（同一时刻只允许一个），立即返回任务号
#   scan-status  {"job": "<id>"} → 任务进度（不含结果明细）
#   scan-result  {"job": "<id>"} → 任务完整结果（目录树中超过阈值的目录、属主合计、最大的文件）
#   scan-stop    {"job": "<id>"} → 停止运行中的任务（已扫部分照常出结果，标记 partial）
#   scan-list    全部任务简表
#   usage-start  {"mount": "/public"} → 后台按用户统计整块 ext4 盘：只读、顺序、限速地读块设备上的 inode 表，
#                按属主 uid 累加占用（i_blocks）与 inode 数。不遍历目录，几亿个文件也只要几分钟到十几分钟；
#                O_DIRECT 读，不进页缓存、不挤占别人的缓存。只给出每人合计，不含目录名。
# 输出：一行 JSON；出错为 {"k":"err","code":...}。兼容 Python 3.6+。
import heapq
import json
import mmap
import os
import pwd
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time

VERSION = 3

CONF_PATH = '/etc/codex-storage-admin.json'
STATE_DIR = '/var/lib/codex-storage-admin'
LASTLOG_PATH = '/var/log/lastlog'
# 测试钩子：只在非 root 时生效（root 下环境变量一律不认，避免借环境改写路径）。
if os.geteuid() != 0:
    CONF_PATH = os.environ.get('CODEX_STORAGE_ADMIN_CONF', CONF_PATH)
    STATE_DIR = os.environ.get('CODEX_STORAGE_ADMIN_STATE', STATE_DIR)
    LASTLOG_PATH = os.environ.get('CODEX_STORAGE_ADMIN_LASTLOG', LASTLOG_PATH)
JOBS_DIR = STATE_DIR + '/jobs'

STDIN_CAP = 64 * 1024
MAX_PATH = 4096
JOBS_KEEP = 10
ROOTS_CAP = 16
CHILDREN_CAP = 500
USERS_CAP = 3000
LIST_CAP = 3000
# 整树扫描的结果上限：根下第一层目录全留（≤ DEPTH1_CAP），更深的只留占用最大的 RECORDS_CAP 个目录，
# 且不小于 MIN_RECORD_BYTES——父目录一定不小于子目录，所以留下的目录总能沿父链挂回树上。
RECORDS_CAP = 30000
DEPTH1_CAP = 5000
MIN_RECORD_BYTES = 64 * 1024 * 1024
TOP_FILES = 200
OWNERS_CAP = 5000
HARDLINK_SEEN_CAP = 500000
MAX_DEPTH = 256
PROGRESS_EVERY_SEC = 2.0
CURRENT_CAP = 300
REPQUOTA_TIMEOUT_SEC = 60

REAL_FS = {
    'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
    'nfs', 'nfs4', 'cifs', 'smb3', 'lustre', 'gpfs', 'beegfs', 'ceph', 'fuse.glusterfs',
}


def emit(record):
    # ensure_ascii：非 UTF-8 文件名经 surrogateescape 变成孤立代理项，转义后 JSON 仍合法。
    sys.stdout.write(json.dumps(record, separators=(',', ':'), ensure_ascii=True) + '\n')
    sys.stdout.flush()


def err(code, **extra):
    record = {'k': 'err', 'v': VERSION, 'code': code}
    record.update(extra)
    emit(record)


def read_args():
    try:
        raw = sys.stdin.read(STDIN_CAP + 1)
    except Exception:
        raw = ''
    if len(raw) > STDIN_CAP:
        return None
    raw = raw.strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def is_abs_normal(p):
    # 绝对、规整（无 . / .. / 重复斜杠 / 结尾斜杠）、不含 NUL、长度有界。
    if not isinstance(p, str) or not p.startswith('/') or len(p) > MAX_PATH or '\x00' in p:
        return False
    return p == '/' or os.path.normpath(p) == p


def load_roots():
    try:
        with open(CONF_PATH, 'r') as fh:
            conf = json.loads(fh.read(STDIN_CAP))
    except Exception:
        return []
    roots = []
    for r in conf.get('roots', []) if isinstance(conf, dict) else []:
        if is_abs_normal(r) and r != '/' and os.path.realpath(r) == r and r not in roots:
            roots.append(r)
        if len(roots) >= ROOTS_CAP:
            break
    return roots


def under(path, root):
    return root == '/' or path == root or path.startswith(root + '/')


def check_path(p, roots):
    # → (路径, None) 或 (None, 错误码)。路径上任何一段是符号链接都拒绝（realpath 必须等于自身）。
    if not is_abs_normal(p):
        return None, 'bad-path'
    if not any(under(p, r) for r in roots):
        return None, 'outside-roots'
    if os.path.realpath(p) != p:
        return None, 'symlink'
    try:
        st = os.lstat(p)
    except OSError:
        return None, 'not-found'
    if not stat.S_ISDIR(st.st_mode):
        return None, 'not-dir'
    return p, None


def user_names():
    names = {}
    try:
        for entry in pwd.getpwall():
            if entry.pw_uid not in names:
                names[entry.pw_uid] = entry.pw_name
    except Exception:
        pass
    return names


def decode_mount_field(s):
    # /proc/mounts 把空格、制表符、换行、反斜杠写成 \040 \011 \012 \134。
    out = []
    i = 0
    while i < len(s):
        if s[i] == '\\' and i + 3 < len(s) and s[i + 1:i + 4].isdigit():
            try:
                out.append(chr(int(s[i + 1:i + 4], 8)))
                i += 4
                continue
            except ValueError:
                pass
        out.append(s[i])
        i += 1
    return ''.join(out)


def read_mounts():
    mounts = {}
    try:
        with open('/proc/self/mounts', 'r') as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 4:
                    continue
                point = decode_mount_field(parts[1])
                mounts[point] = {'device': decode_mount_field(parts[0])[:256], 'fs': parts[2][:32], 'opts': parts[3].split(',')}
    except Exception:
        pass
    return mounts


def quota_enabled(opts):
    return any(o in ('usrquota', 'quota') or o.startswith('usrjquota=') for o in opts)


def mount_view(point, info):
    item = {'mount': point, 'device': info['device'], 'fs': info['fs'], 'quota': quota_enabled(info['opts'])}
    try:
        sv = os.statvfs(point)
        item['size'] = sv.f_blocks * sv.f_frsize
        item['used'] = (sv.f_blocks - sv.f_bfree) * sv.f_frsize
        item['avail'] = sv.f_bavail * sv.f_frsize
        item['inodes'] = sv.f_files
        item['iused'] = sv.f_files - sv.f_ffree
    except OSError:
        item['error'] = 'statvfs'
    return item


def relevant_mounts(roots):
    # 与允许的根相关的真实文件系统：挂载点就是某个根或在某个根之下；某个根本身不是挂载点时，再加上它所在的那个挂载点。
    mounts = read_mounts()
    real = {p: m for p, m in mounts.items() if m['fs'] in REAL_FS}
    picked = []
    for r in roots:
        inside = [p for p in real if under(p, r)]
        if r not in inside:
            containing = [p for p in real if under(r, p)]
            if containing:
                inside.append(max(containing, key=len))
        for p in sorted(inside):
            if p not in picked:
                picked.append(p)
    return [mount_view(p, real[p]) for p in picked]


def children_of(root, names, mount_points):
    out = []
    try:
        with os.scandir(root) as it:
            for entry in it:
                if len(out) >= CHILDREN_CAP:
                    break
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISDIR(st.st_mode):
                    continue
                full = root + '/' + entry.name
                out.append({
                    'name': entry.name[:512], 'uid': st.st_uid, 'owner': names.get(st.st_uid),
                    'mtime': int(st.st_mtime), 'mount': full in mount_points,
                })
    except OSError:
        return None
    out.sort(key=lambda item: item['name'])
    return out


# /var/log/lastlog：按 uid 定长记录（x86_64 / aarch64 的 glibc：int32 时间 + 32 字节终端 + 256 字节来源 = 292 字节）。
# 时间 0 = 从没登录过。读不到文件 → None（界面显示「未知」，不据此判定不活跃）。
LASTLOG_RECORD = 292


def read_lastlog(uids):
    try:
        fh = open(LASTLOG_PATH, 'rb')
    except OSError:
        return None
    out = {}
    with fh:
        for uid in uids:
            try:
                fh.seek(uid * LASTLOG_RECORD)
                raw = fh.read(4)
            except (OSError, OverflowError):
                raw = b''
            t = struct.unpack('<i', raw)[0] if len(raw) == 4 else 0
            out[uid] = t if t > 0 else 0
    return out


def cmd_info(args, roots):
    names = user_names()
    mounts = relevant_mounts(roots)
    for m in mounts:
        if m['fs'] in ('ext2', 'ext3', 'ext4'):
            m['inodeScan'] = ext_info_for(m['mount'], roots)
    mount_points = {m['mount'] for m in mounts}
    users = []
    try:
        for entry in pwd.getpwall():
            if 1000 <= entry.pw_uid < 60000 and len(users) < USERS_CAP:
                users.append({'name': entry.pw_name, 'uid': entry.pw_uid, 'home': entry.pw_dir[:512]})
    except Exception:
        pass
    logins = read_lastlog([u['uid'] for u in users])
    for u in users:
        u['lastLogin'] = logins.get(u['uid']) if logins is not None else None
    repquota = shutil.which('repquota') or ('/usr/sbin/repquota' if os.path.exists('/usr/sbin/repquota') else None)
    emit({
        'k': 'info', 'v': VERSION, 'host': os.uname()[1][:128], 'now': int(time.time()),
        'roots': [{'path': r, 'children': children_of(r, names, mount_points)} for r in roots],
        'mounts': mounts, 'users': users, 'repquota': bool(repquota),
        'jobs': [summary(j) for j in list_jobs()],
    })


def cmd_quota(args, roots):
    mount = args.get('mount')
    allowed = {m['mount']: m for m in relevant_mounts(roots)}
    if not isinstance(mount, str) or mount not in allowed:
        return err('bad-mount')
    if not allowed[mount]['quota']:
        return err('quota-off')
    tool = shutil.which('repquota') or ('/usr/sbin/repquota' if os.path.exists('/usr/sbin/repquota') else None)
    if not tool:
        return err('no-repquota')
    try:
        proc = subprocess.run([tool, '-u', '-n', '-p', mount], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=REPQUOTA_TIMEOUT_SEC)
    except Exception:
        return err('repquota-failed')
    if proc.returncode != 0:
        return err('repquota-failed')
    names = user_names()
    rows = []
    # -n：id 写成 #uid；-p：宽限期一律写 0，列位置固定：#uid 标志 已用KiB 软 硬 宽限 文件数 软 硬 宽限。
    for line in proc.stdout.decode('utf-8', 'replace').splitlines():
        parts = line.split()
        if len(parts) < 7 or not parts[0].startswith('#') or not parts[0][1:].isdigit():
            continue
        try:
            uid = int(parts[0][1:])
            kib = int(parts[2])
            files = int(parts[6])
        except ValueError:
            continue
        if kib <= 0 and files <= 0:
            continue
        rows.append([uid, names.get(uid), kib * 1024, files])
        if len(rows) >= USERS_CAP:
            break
    emit({'k': 'quota', 'v': VERSION, 'mount': mount, 'now': int(time.time()), 'rows': rows})


def cmd_list(args, roots):
    path, code = check_path(args.get('path'), roots)
    if code:
        return err(code)
    names = user_names()
    entries = []
    truncated = False
    try:
        dev = os.lstat(path).st_dev
        with os.scandir(path) as it:
            for entry in it:
                if len(entries) >= LIST_CAP:
                    truncated = True
                    break
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                mode = st.st_mode
                kind = 'd' if stat.S_ISDIR(mode) else 'l' if stat.S_ISLNK(mode) else 'f' if stat.S_ISREG(mode) else 'o'
                entries.append([entry.name[:1024], kind, st.st_blocks * 512, st.st_size, st.st_uid,
                                names.get(st.st_uid), int(st.st_mtime), 1 if (kind == 'd' and st.st_dev != dev) else 0])
    except PermissionError:
        return err('denied')
    except OSError:
        return err('not-found')
    emit({'k': 'list', 'v': VERSION, 'path': path, 'entries': entries, 'truncated': truncated})


# ---------------------------------------------------------------------------
# 扫描任务
# ---------------------------------------------------------------------------

def valid_job_id(job):
    return isinstance(job, str) and 8 <= len(job) <= 40 and all(c.isalnum() or c == '-' for c in job)


def job_path(job):
    return JOBS_DIR + '/' + job + '.json'


def write_json_atomic(path, value):
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        fh.write(json.dumps(value, separators=(',', ':'), ensure_ascii=True))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def pid_is_scanner(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as fh:
            return b'storage-admin' in fh.read(4096)
    except OSError:
        # 没有 /proc（非 Linux 测试环境）：只凭 pid 存活判断。
        return True


def read_job(job):
    try:
        with open(job_path(job), 'r') as fh:
            data = json.load(fh)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get('state') == 'running' and not pid_is_scanner(data.get('pid')):
        # 进程已不在（机器重启 / 被杀）却没写完：按中断处理，不再显示「扫描中」。
        data['state'] = 'lost'
    return data


SUMMARY_KEYS = ('id', 'kind', 'root', 'state', 'startedAt', 'endedAt', 'entries', 'dirs', 'bytes', 'denied', 'errors',
                'otherFs', 'estTotal', 'current', 'partial', 'threshold', 'v')


def summary(data):
    return {k: data.get(k) for k in SUMMARY_KEYS}


def list_jobs():
    try:
        names = [n[:-5] for n in os.listdir(JOBS_DIR) if n.endswith('.json')]
    except OSError:
        return []
    jobs = []
    for name in sorted(names, reverse=True):
        if not valid_job_id(name):
            continue
        data = read_job(name)
        if data:
            jobs.append(data)
    return jobs


def prune_jobs():
    # 只保留最近 JOBS_KEEP 份；运行中的不删。
    try:
        names = sorted((n for n in os.listdir(JOBS_DIR) if n.endswith('.json')), reverse=True)
    except OSError:
        return
    for name in names[JOBS_KEEP:]:
        data = read_job(name[:-5]) if valid_job_id(name[:-5]) else None
        if data and data.get('state') == 'running':
            continue
        try:
            os.unlink(JOBS_DIR + '/' + name)
        except OSError:
            pass


def lower_priority():
    try:
        os.nice(19)
    except Exception:
        pass
    try:
        import ctypes
        import platform
        nr = {'x86_64': 251, 'aarch64': 30}.get(platform.machine())
        if nr is not None:
            libc = ctypes.CDLL(None, use_errno=True)
            libc.syscall(nr, 1, 0, 3 << 13)  # IOPRIO_WHO_PROCESS, 本进程, IOPRIO_CLASS_IDLE
    except Exception:
        pass


def cmd_scan_start(args, roots):
    root, code = check_path(args.get('root'), roots)
    if code:
        return err(code)
    try:
        os.makedirs(JOBS_DIR, mode=0o700, exist_ok=True)
    except OSError:
        return err('state-dir')
    running = busy_job()
    if running:
        return err('busy', job=summary(running))
    est = None
    mounts = read_mounts()
    if root in mounts:
        try:
            sv = os.statvfs(root)
            est = sv.f_files - sv.f_ffree
        except OSError:
            est = None
    job = new_job_id()
    data = {
        'v': VERSION, 'id': job, 'kind': 'tree', 'root': root, 'state': 'running', 'pid': None, 'startedAt': int(time.time()),
        'endedAt': None, 'entries': 0, 'dirs': 0, 'bytes': 0, 'denied': 0, 'errors': 0, 'otherFs': 0,
        'estTotal': est, 'current': '', 'partial': False, 'threshold': MIN_RECORD_BYTES,
    }
    launch_job(data, run_scan)


def busy_job():
    for data in list_jobs():
        if data.get('state') == 'running':
            return data
    return None


def new_job_id():
    return time.strftime('%Y%m%d-%H%M%S') + '-' + os.urandom(3).hex()


def launch_job(data, runner):
    job = data['id']
    write_json_atomic(job_path(job), data)
    prune_jobs()
    # 两次 fork + setsid：任务进程脱离 SSH 会话，SSH 断开不影响它；本进程立刻返回任务号。
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            if os.fork() != 0:
                os._exit(0)
            devnull = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
            data['pid'] = os.getpid()
            write_json_atomic(job_path(job), data)
            runner(data)
        except BaseException:
            try:
                data['state'] = 'error'
                data['endedAt'] = int(time.time())
                write_json_atomic(job_path(job), data)
            except BaseException:
                pass
        os._exit(0)
    os.waitpid(pid, 0)
    # 等孙进程把 pid 写进去（最多约 2 秒），让返回的简表里就有它。
    for _ in range(20):
        current = read_job(job)
        if current and current.get('pid'):
            data = current
            break
        time.sleep(0.1)
    emit({'k': 'started', 'v': VERSION, 'job': summary(data)})


def run_scan(data):
    lower_priority()
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    root = data['root']
    root_st = os.lstat(root)
    root_dev = root_st.st_dev
    names = user_names()
    owners = {}           # uid -> [实际占用, 文件数, 最新修改时间]
    owners_over = [0, 0, 0]
    mtime_limit = time.time() + 86400  # 未来时间（时钟错乱 / 解包出来的怪时间戳）不算作「最近修改」
    top = []              # 小顶堆：(占用, 路径, 逻辑大小, uid, mtime)
    deep = []             # 小顶堆：(占用, 路径, 逻辑大小, 文件数, 目录数, uid, mtime)
    depth1 = []
    seen_links = set()
    root_totals = [0, 0, 0, 0]
    counters = {'entries': 0, 'dirs': 0, 'denied': 0, 'errors': 0, 'otherFs': 0}
    last_write = [time.monotonic()]

    def owner_add(uid, blocks, is_file, mtime=0):
        slot = owners.get(uid)
        if slot is None:
            if len(owners) < OWNERS_CAP:
                slot = owners[uid] = [0, 0, 0]
            else:
                slot = owners_over
        slot[0] += blocks
        if is_file:
            slot[1] += 1
        if slot[2] < mtime <= mtime_limit:
            slot[2] = mtime

    # 帧：[相对路径, 迭代器, 占用, 逻辑大小, 文件数, 目录数, uid, mtime, 深度]
    def open_frame(rel, full, st, depth):
        it = os.scandir(full)
        return [rel, it, st.st_blocks * 512, 0, 0, 0, st.st_uid, int(st.st_mtime), depth]

    def close_frame(frame, parent):
        try:
            frame[1].close()
        except Exception:
            pass
        rel, blocks, size, files, dirs, uid, mtime, depth = frame[0], frame[2], frame[3], frame[4], frame[5], frame[6], frame[7], frame[8]
        counters['dirs'] += 1
        if parent is not None:
            parent[2] += blocks
            parent[3] += size
            parent[4] += files
            parent[5] += dirs + 1
        if depth == 0:
            root_totals[:] = [blocks, size, files, dirs]
            return
        record = (blocks, rel, size, files, dirs, uid, mtime)
        if depth == 1 and len(depth1) < DEPTH1_CAP:
            depth1.append(record)
        elif blocks >= MIN_RECORD_BYTES:
            if len(deep) < RECORDS_CAP:
                heapq.heappush(deep, record)
            elif blocks > deep[0][0]:
                heapq.heapreplace(deep, record)

    def progress(current_rel, bytes_so_far):
        data.update(counters)
        data['bytes'] = bytes_so_far
        data['current'] = current_rel[:CURRENT_CAP]
        write_json_atomic(job_path(data['id']), data)

    frames = []
    try:
        frames.append(open_frame('', root, root_st, 0))
    except PermissionError:
        counters['denied'] += 1
    except OSError:
        counters['errors'] += 1
    owner_add(root_st.st_uid, root_st.st_blocks * 512, False, int(root_st.st_mtime))
    total_blocks = 0

    while frames and not stopping:
        frame = frames[-1]
        try:
            entry = next(frame[1])
        except StopIteration:
            frames.pop()
            close_frame(frame, frames[-1] if frames else None)
            if not frames:
                total_blocks = frame[2]
            continue
        except OSError:
            counters['errors'] += 1
            frames.pop()
            close_frame(frame, frames[-1] if frames else None)
            continue
        counters['entries'] += 1
        if counters['entries'] % 2000 == 0 and time.monotonic() - last_write[0] >= PROGRESS_EVERY_SEC:
            last_write[0] = time.monotonic()
            progress(frame[0], sum(f[2] for f in frames))
        try:
            st = entry.stat(follow_symlinks=False)
        except PermissionError:
            counters['denied'] += 1
            continue
        except OSError:
            counters['errors'] += 1
            continue
        mode = st.st_mode
        blocks = st.st_blocks * 512
        rel = entry.name if frame[0] == '' else frame[0] + '/' + entry.name
        if stat.S_ISDIR(mode):
            if st.st_dev != root_dev:
                counters['otherFs'] += 1
                continue
            owner_add(st.st_uid, blocks, False, int(st.st_mtime))
            if frame[8] + 1 > MAX_DEPTH:
                counters['errors'] += 1
                frame[2] += blocks
                continue
            try:
                frames.append(open_frame(rel, root + '/' + rel, st, frame[8] + 1))
            except PermissionError:
                counters['denied'] += 1
                frame[2] += blocks
            except OSError:
                counters['errors'] += 1
                frame[2] += blocks
            continue
        if stat.S_ISREG(mode) and st.st_nlink > 1:
            key = (st.st_dev, st.st_ino)
            if key in seen_links:
                continue
            if len(seen_links) < HARDLINK_SEEN_CAP:
                seen_links.add(key)
        owner_add(st.st_uid, blocks, True, int(st.st_mtime))
        frame[2] += blocks
        frame[3] += st.st_size
        frame[4] += 1
        if stat.S_ISREG(mode) and blocks > 0:
            item = (blocks, rel, st.st_size, st.st_uid, int(st.st_mtime))
            if len(top) < TOP_FILES:
                heapq.heappush(top, item)
            elif blocks > top[0][0]:
                heapq.heapreplace(top, item)

    partial = bool(frames)
    # 被停止：把还开着的目录逐层收口，已扫到的部分照样累进父目录与总量。
    while frames:
        frame = frames.pop()
        close_frame(frame, frames[-1] if frames else None)
        if not frames:
            total_blocks = frame[2]
    records = sorted(depth1 + deep, key=lambda r: r[1])
    data.update(counters)
    data.update({
        'state': 'stopped' if partial else 'done', 'endedAt': int(time.time()), 'partial': partial,
        'bytes': total_blocks, 'current': '', 'rootTotals': root_totals,
        'records': [[r[1], r[0], r[2], r[3], r[4], r[5], r[6]] for r in records],
        'owners': [[uid, v[0], v[1], v[2]] for uid, v in sorted(owners.items(), key=lambda kv: -kv[1][0])],
        'ownersOver': owners_over[:2],
        'names': {str(uid): names[uid] for uid in owners if uid in names},
        'top': [[t[1], t[0], t[2], t[3], t[4]] for t in sorted(top, reverse=True)],
    })
    write_json_atomic(job_path(data['id']), data)


# ---------------------------------------------------------------------------
# 按用户统计：读 ext4 inode 表（usage-start）
# ---------------------------------------------------------------------------
# 每个 inode 里记着属主 uid 与占用块数（i_blocks，与 du / 配额同一口径）。按组读出 inode 位图与 inode 表，
# 位图里在用、链接数 > 0 的 inode 按 uid 累加——等价于配额统计，但不用开配额、不用遍历目录。
# 只认识的特性才读：不认识的 incompat 特性、bigalloc、快照等一律拒绝，绝不猜。
# 盘是挂载着的：读到的是磁盘上的状态，最近几秒还在缓存里没写回的改动不在其中（对找大户无影响）。

EXT_MAGIC = 0xEF53
INCOMPAT_NAMES = {
    0x1: 'compression', 0x2: 'filetype', 0x4: 'needs_recovery', 0x8: 'journal_dev', 0x10: 'meta_bg',
    0x40: 'extent', 0x80: '64bit', 0x100: 'mmp', 0x200: 'flex_bg', 0x400: 'ea_inode', 0x1000: 'dirdata',
    0x2000: 'metadata_csum_seed', 0x4000: 'large_dir', 0x8000: 'inline_data', 0x10000: 'encrypt', 0x20000: 'casefold',
}
INCOMPAT_OK = 0x2 | 0x4 | 0x10 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x20000
RO_COMPAT_NAMES = {
    0x1: 'sparse_super', 0x2: 'large_file', 0x4: 'btree_dir', 0x8: 'huge_file', 0x10: 'uninit_bg', 0x20: 'dir_nlink',
    0x40: 'extra_isize', 0x80: 'snapshot', 0x100: 'quota', 0x200: 'bigalloc', 0x400: 'metadata_csum', 0x800: 'replica',
    0x1000: 'read-only', 0x2000: 'project', 0x4000: 'shared_blocks', 0x8000: 'verity', 0x10000: 'orphan_present',
}
RO_COMPAT_BAD = 0x80 | 0x200 | 0x4000
EXT4_HUGE_FILE_FL = 0x40000
BG_INODE_UNINIT = 0x1
READ_CHUNK = 8 * 1024 * 1024
BATCH_SPAN_MAX = 32 * 1024 * 1024
MERGE_GAP = 1024 * 1024
DEFAULT_RATE_MB = 150
# 每个 inode 要的字段：mode@0 uid_lo@2 mtime@16 links@26 blocks_lo@28 flags@32 blocks_hi@116 uid_hi@120。
INODE_FIELDS = struct.Struct('<HH12xI6xHII80xH2xH')
BITS = tuple(tuple(i for i in range(8) if b & (1 << i)) for b in range(256))


class ExtError(Exception):
    def __init__(self, code, detail=''):
        Exception.__init__(self, code)
        self.code = code
        self.detail = detail


class BlockReader(object):
    # 只读、对齐的顺序读。direct：O_DIRECT，不经页缓存；否则读完对这段 fadvise(DONTNEED)。
    # rate：每秒最多读这么多字节（0 = 不限），按累计量与已用时间补睡。
    def __init__(self, path, direct=True, rate=0):
        flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0)
        self.direct = False
        self.fd = None
        if direct and hasattr(os, 'O_DIRECT'):
            try:
                self.fd = os.open(path, flags | os.O_DIRECT)
                self.direct = True
            except OSError:
                self.fd = None
        if self.fd is None:
            self.fd = os.open(path, flags)
        self.buf = mmap.mmap(-1, READ_CHUNK)
        self.rate = rate
        self.bytes_read = 0
        self.started = time.monotonic()

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def read(self, off, length):
        out = bytearray()
        pos = off
        end = off + length
        while pos < end:
            aoff = pos - pos % 4096
            want = min(end - aoff, READ_CHUNK)
            alen = (want + 4095) // 4096 * 4096
            if alen > READ_CHUNK:
                alen = READ_CHUNK
            view = memoryview(self.buf)[:alen]
            n = os.preadv(self.fd, [view], aoff)
            if n <= pos - aoff:
                raise ExtError('short-read')
            got = min(n, end - aoff)
            out += self.buf[pos - aoff:got]
            if not self.direct and hasattr(os, 'posix_fadvise'):
                try:
                    os.posix_fadvise(self.fd, aoff, n, os.POSIX_FADV_DONTNEED)
                except OSError:
                    pass
            self.bytes_read += n
            pos = aoff + got
            if self.rate > 0:
                ahead = self.bytes_read / float(self.rate) - (time.monotonic() - self.started)
                if ahead > 0:
                    time.sleep(ahead)
        return bytes(out)


def u16(b, o):
    return b[o] | (b[o + 1] << 8)


def u32(b, o):
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)


def parse_super(raw):
    # raw：设备开头 4096 字节；超级块在偏移 1024。
    sb = raw[1024:2048]
    if len(sb) < 1024 or u16(sb, 56) != EXT_MAGIC:
        raise ExtError('not-ext')
    incompat = u32(sb, 96)
    ro_compat = u32(sb, 100)
    bad = incompat & ~INCOMPAT_OK
    if bad:
        raise ExtError('unsupported-feature', ','.join(INCOMPAT_NAMES.get(1 << i, hex(1 << i)) for i in range(32) if bad & (1 << i)))
    if ro_compat & RO_COMPAT_BAD:
        bad = ro_compat & RO_COMPAT_BAD
        raise ExtError('unsupported-feature', ','.join(RO_COMPAT_NAMES.get(1 << i, hex(1 << i)) for i in range(32) if bad & (1 << i)))
    log_bs = u32(sb, 24)
    if log_bs > 6:
        raise ExtError('bad-super')
    bs = 1024 << log_bs
    is64 = bool(incompat & 0x80)
    blocks = u32(sb, 4) | ((u32(sb, 336) << 32) if is64 else 0)
    info = {
        'inodes': u32(sb, 0), 'blocks': blocks, 'blockSize': bs, 'firstDataBlock': u32(sb, 20),
        'blocksPerGroup': u32(sb, 32), 'inodesPerGroup': u32(sb, 40),
        'firstIno': u32(sb, 84) if u32(sb, 76) >= 1 else 11,
        'inodeSize': u16(sb, 88) if u32(sb, 76) >= 1 else 128,
        'descSize': (u16(sb, 254) or 64) if is64 else 32,
        'firstMetaBg': u32(sb, 260), 'logGroupsPerFlex': sb[372] if incompat & 0x200 else 0,
        'incompat': incompat, 'roCompat': ro_compat, 'compat': u32(sb, 92),
        'is64': is64, 'metaBg': bool(incompat & 0x10), 'sparseSuper': bool(ro_compat & 0x1),
        'hugeFile': bool(ro_compat & 0x8), 'csum': bool(ro_compat & (0x10 | 0x400)),
    }
    if info['inodeSize'] < 128 or info['inodeSize'] > bs or info['inodesPerGroup'] <= 0 or info['blocksPerGroup'] <= 0:
        raise ExtError('bad-super')
    if info['descSize'] < 32 or info['descSize'] > 1024 or info['inodesPerGroup'] > bs * 8:
        raise ExtError('bad-super')
    info['groups'] = (info['inodes'] + info['inodesPerGroup'] - 1) // info['inodesPerGroup']
    info['features'] = sorted(
        [n for bit, n in INCOMPAT_NAMES.items() if incompat & bit] + [n for bit, n in RO_COMPAT_NAMES.items() if ro_compat & bit]
    )
    return info


def is_power(n, base):
    while n > 1 and n % base == 0:
        n //= base
    return n == 1


def group_has_super(g, info):
    if g <= 1 or not info['sparseSuper']:
        return True
    return is_power(g, 3) or is_power(g, 5) or is_power(g, 7)


def desc_block(meta_group, info):
    # 第 meta_group 块组描述符所在的块号。classic：紧跟主超级块；meta_bg：在该元块组第一个组里（有超级块副本时在其后）。
    first = info['firstDataBlock']
    if not info['metaBg'] or meta_group < info['firstMetaBg']:
        return first + 1 + meta_group
    per_block = info['blockSize'] // info['descSize']
    g = meta_group * per_block
    return first + g * info['blocksPerGroup'] + (1 if group_has_super(g, info) else 0)


def read_descriptors(reader, info):
    # → [(inode 位图块, inode 表块, flags, 空闲 inode 数, itable_unused)] 每组一项。
    bs, ds, groups = info['blockSize'], info['descSize'], info['groups']
    per_block = bs // ds
    out = []
    meta_groups = (groups + per_block - 1) // per_block
    mg = 0
    while mg < meta_groups:
        # 连续的描述符块一次读（classic 布局下全部连续）。
        start = desc_block(mg, info)
        run = 1
        while mg + run < meta_groups and desc_block(mg + run, info) == start + run and run * bs < READ_CHUNK:
            run += 1
        raw = reader.read(start * bs, run * bs)
        for k in range(run * per_block):
            if len(out) >= groups:
                break
            o = k * ds
            ibm = u32(raw, o + 4)
            itab = u32(raw, o + 8)
            free = u16(raw, o + 14)
            flags = u16(raw, o + 18)
            unused = u16(raw, o + 28)
            if info['is64'] and ds >= 64:
                ibm |= u32(raw, o + 0x24) << 32
                itab |= u32(raw, o + 0x28) << 32
                free |= u16(raw, o + 0x2E) << 16
                unused |= u16(raw, o + 0x32) << 16
            out.append((ibm, itab, flags, free, unused))
        mg += run
    return out


def merged_ranges(extents):
    # [(偏移, 长度, key)] → [(偏移, 长度, [key…])]：相邻或间隔 < MERGE_GAP 的合成一次顺序读。
    extents = sorted(extents)
    ranges = []
    for off, length, key in extents:
        if ranges and off - (ranges[-1][0] + ranges[-1][1]) < MERGE_GAP and off >= ranges[-1][0] + ranges[-1][1] \
                and off + length - ranges[-1][0] <= BATCH_SPAN_MAX:
            ranges[-1][1] = off + length - ranges[-1][0]
            ranges[-1][2].append(key)
        else:
            ranges.append([off, length, [key]])
    return ranges


def read_extents(reader, extents):
    # → {key: bytes}
    out = {}
    for off, length, keys in merged_ranges(extents):
        raw = reader.read(off, length)
        for k_off, k_len, key in extents:
            if key in keys:
                out[key] = raw[k_off - off:k_off - off + k_len]
    return out


def inode_usage(reader, info, progress=None, stopping=None):
    # → (owners {uid: [占用字节, inode 数, 最新 mtime]}, 统计 {inodes, groupsDone, partial})
    descs = read_descriptors(reader, info)
    bs, isz, ipg = info['blockSize'], info['inodeSize'], info['inodesPerGroup']
    first_ino, huge, csum = info['firstIno'], info['hugeFile'], info['csum']
    unpack = INODE_FIELDS.unpack_from
    owners = {}
    counted = 0
    mtime_limit = int(time.time()) + 86400
    batch = 1 << max(info['logGroupsPerFlex'], 4)
    g0 = 0
    partial = False
    while g0 < len(descs):
        if stopping and stopping():
            partial = True
            break
        groups = []
        for g in range(g0, min(g0 + batch, len(descs))):
            ibm, itab, flags, free, unused = descs[g]
            if flags & BG_INODE_UNINIT or free >= ipg:
                continue
            used = ipg - unused if csum and unused <= ipg else ipg
            if used <= 0:
                continue
            groups.append((g, ibm, itab, used))
        if groups:
            bitmaps = read_extents(reader, [(ibm * bs, (ipg + 7) // 8, g) for g, ibm, _, _ in groups])
            tables = read_extents(reader, [(itab * bs, used * isz, g) for g, _, itab, used in groups])
            for g, _, _, used in groups:
                bm = bitmaps[g]
                tb = tables[g]
                base = g * ipg + 1
                for byte_i in range((used + 7) // 8):
                    b = bm[byte_i]
                    if not b:
                        continue
                    for bit in BITS[b]:
                        i = byte_i * 8 + bit
                        if i >= used:
                            break
                        ino = base + i
                        if ino < first_ino and ino != 2:
                            continue
                        mode, uid_lo, mtime, links, blocks_lo, iflags, blocks_hi, uid_hi = unpack(tb, i * isz)
                        if not links or not mode:
                            continue
                        blocks = blocks_lo
                        if huge:
                            blocks |= blocks_hi << 32
                            size = blocks * bs if iflags & EXT4_HUGE_FILE_FL else blocks * 512
                        else:
                            size = blocks * 512
                        uid = uid_lo | (uid_hi << 16)
                        slot = owners.get(uid)
                        if slot is None:
                            if len(owners) >= OWNERS_CAP:
                                uid = -1
                                slot = owners.get(-1)
                            if slot is None:
                                slot = owners[uid] = [0, 0, 0]
                        slot[0] += size
                        slot[1] += 1
                        if slot[2] < mtime <= mtime_limit:
                            slot[2] = mtime
                        counted += 1
        g0 += batch
        if progress:
            progress(g0, len(descs), counted, owners)
    return owners, {'inodes': counted, 'groupsDone': min(g0, len(descs)), 'partial': partial}


def ext_device_for(mount, roots):
    # 挂载点 → 它的块设备路径；只认允许范围内、ext2/3/4、且设备号对得上的那块盘。
    allowed = {m['mount']: m for m in relevant_mounts(roots)}
    if mount not in allowed:
        raise ExtError('bad-mount')
    if allowed[mount]['fs'] not in ('ext2', 'ext3', 'ext4'):
        raise ExtError('not-ext')
    device = allowed[mount]['device']
    try:
        dst = os.stat(device)
        mst = os.stat(mount)
    except OSError:
        raise ExtError('no-device')
    if not stat.S_ISBLK(dst.st_mode) or dst.st_rdev != mst.st_dev:
        raise ExtError('no-device')
    return device


def ext_probe(device, mount):
    reader = BlockReader(device, direct=True)
    try:
        info = parse_super(reader.read(0, 4096))
    finally:
        reader.close()
    try:
        sv = os.statvfs(mount)
        if sv.f_files != info['inodes']:
            raise ExtError('mismatch')
    except OSError:
        pass
    return info


def ext_summary(info):
    keys = ('blockSize', 'inodeSize', 'inodesPerGroup', 'groups', 'inodes', 'logGroupsPerFlex', 'features')
    return {k: info[k] for k in keys}


def cmd_usage_start(args, roots):
    mount = args.get('mount')
    if not isinstance(mount, str):
        return err('bad-mount')
    try:
        device = ext_device_for(mount, roots)
        info = ext_probe(device, mount)
    except ExtError as e:
        return err(e.code, detail=e.detail[:200])
    try:
        os.makedirs(JOBS_DIR, mode=0o700, exist_ok=True)
    except OSError:
        return err('state-dir')
    running = busy_job()
    if running:
        return err('busy', job=summary(running))
    rate = args.get('rateMB')
    rate = DEFAULT_RATE_MB if not isinstance(rate, int) or isinstance(rate, bool) else max(20, min(rate, 400))
    try:
        sv = os.statvfs(mount)
        est = sv.f_files - sv.f_ffree
    except OSError:
        est = None
    data = {
        'v': VERSION, 'id': new_job_id(), 'kind': 'inode', 'root': mount, 'state': 'running', 'pid': None,
        'startedAt': int(time.time()), 'endedAt': None, 'entries': 0, 'dirs': 0, 'bytes': 0, 'denied': 0, 'errors': 0,
        'otherFs': 0, 'estTotal': est, 'current': '', 'partial': False, 'threshold': 0,
        'device': device, 'rateMB': rate, 'fs': ext_summary(info),
    }
    launch_job(data, run_inode_usage)


def run_inode_usage(data):
    try:
        os.nice(19)
    except Exception:
        pass
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    reader = BlockReader(data['device'], direct=True, rate=data['rateMB'] * 1024 * 1024)
    last = [time.monotonic()]

    def progress(done, total, counted, owners):
        if time.monotonic() - last[0] < PROGRESS_EVERY_SEC:
            return
        last[0] = time.monotonic()
        data['entries'] = counted
        data['bytes'] = sum(v[0] for v in owners.values())
        data['current'] = '第 %d / %d 组 · 已读 %d MB' % (min(done, total), total, reader.bytes_read // (1024 * 1024))
        write_json_atomic(job_path(data['id']), data)

    try:
        info = parse_super(reader.read(0, 4096))
        owners, stats = inode_usage(reader, info, progress=progress, stopping=lambda: bool(stopping))
    finally:
        reader.close()
    names = user_names()
    total = sum(v[0] for v in owners.values())
    over = owners.pop(-1, [0, 0, 0])[:2]
    data.update({
        'state': 'stopped' if stats['partial'] else 'done', 'endedAt': int(time.time()), 'partial': stats['partial'],
        'entries': stats['inodes'], 'bytes': total, 'current': '',
        'rootTotals': [total, 0, stats['inodes'], 0], 'records': [], 'top': [],
        'owners': [[uid, v[0], v[1], v[2]] for uid, v in sorted(owners.items(), key=lambda kv: -kv[1][0])],
        'ownersOver': over, 'names': {str(uid): names[uid] for uid in owners if uid in names},
        'readMB': reader.bytes_read // (1024 * 1024), 'direct': reader.direct,
    })
    write_json_atomic(job_path(data['id']), data)


def ext_info_for(mount, roots):
    # info 里每块 ext 盘附带：能否按 inode 表统计；能的话给出文件系统参数（让管理员看得到我们按什么读）。
    try:
        info = ext_probe(ext_device_for(mount, roots), mount)
        return {'ok': True, 'fs': ext_summary(info)}
    except ExtError as e:
        return {'ok': False, 'code': e.code, 'detail': e.detail[:200]}
    except Exception:
        return {'ok': False, 'code': 'probe-failed'}


def test_inode_usage(image):
    # 非 root 的自测入口：对一个 ext 镜像文件同步跑一遍（集群 /tmp 里 mke2fs 出来的），打印每个 uid 的合计。
    reader = BlockReader(image, direct=False)
    try:
        info = parse_super(reader.read(0, 4096))
        owners, stats = inode_usage(reader, info)
    finally:
        reader.close()
    emit({'k': 'test', 'fs': ext_summary(info), 'stats': stats, 'owners': {str(k): v for k, v in owners.items()}})



def cmd_scan_status(args, roots, full=False):
    job = args.get('job')
    if not valid_job_id(job):
        return err('bad-job')
    data = read_job(job)
    if not data:
        return err('no-job')
    if full:
        emit(dict(data, k='result'))
    else:
        emit({'k': 'status', 'v': VERSION, 'job': summary(data)})


def cmd_scan_stop(args, roots):
    job = args.get('job')
    if not valid_job_id(job):
        return err('bad-job')
    data = read_job(job)
    if not data:
        return err('no-job')
    if data.get('state') == 'running' and pid_is_scanner(data.get('pid')):
        try:
            os.kill(data['pid'], signal.SIGTERM)
        except OSError:
            pass
    emit({'k': 'status', 'v': VERSION, 'job': summary(data)})


def cmd_scan_list(args, roots):
    emit({'k': 'jobs', 'v': VERSION, 'jobs': [summary(j) for j in list_jobs()]})


COMMANDS = {
    'info': cmd_info,
    'quota': cmd_quota,
    'list': cmd_list,
    'scan-start': cmd_scan_start,
    'scan-status': cmd_scan_status,
    'scan-result': lambda a, r: cmd_scan_status(a, r, full=True),
    'scan-stop': cmd_scan_stop,
    'scan-list': cmd_scan_list,
    'usage-start': cmd_usage_start,
}


def main():
    original = os.environ.get('SSH_ORIGINAL_COMMAND')
    if original is not None:
        words = original.split()
        name = words[0] if words else 'info'
    else:
        name = sys.argv[1] if len(sys.argv) > 1 else 'info'
        if name == '--test-inode-usage' and os.geteuid() != 0 and len(sys.argv) == 3:
            return test_inode_usage(sys.argv[2])
    handler = COMMANDS.get(name)
    if handler is None:
        return err('bad-command')
    args = read_args() if name not in ('info', 'scan-list') else {}
    if args is None:
        return err('bad-args')
    roots = load_roots()
    if not roots:
        return err('no-roots')
    handler(args, roots)


if __name__ == '__main__':
    main()
