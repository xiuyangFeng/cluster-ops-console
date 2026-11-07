# dir-usage.py —— 本人目录占用的有界只读扫描（经 stdin 送达远端执行，服务器上不落任何文件）。
#
# 调用方式（本机 lib/dir-usage/scan.mjs 组装）：
#   ssh host "python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),\"dir-usage\",\"exec\"))'"
#   stdin 第 1 行：本脚本源码的 JSON 字符串；其余：参数 JSON（扫描根、游标、预算）。
#
# 只读：os.scandir + lstat 遍历 $HOME 下的一个目录，不跟随符号链接、不跨文件系统（比较 st_dev），
# 不打开任何文件内容，不发起网络请求。真正限制每轮的条目数（≤ 2 万）与时长（≤ 8 秒）：
# 到达任一上限立即停下，把「待扫目录栈 + 当前目录已处理条目数」作为游标交回本机，下一轮从游标接着扫
# （本机可以一轮接一轮自动续扫，也可以手动）。
# 顺序：深度优先，扫描根下的目录一个扫完再扫下一个——先扫名字不以 . 开头的（自己的数据），再扫隐藏目录
# （各种工具的缓存），同组按名字。否则顺序取决于目录项的存放次序，常常一上来就钻进 .npm 之类又深又碎的缓存。
# 只回传本轮增量（本机负责累加），输出单行 JSON，体积有界。兼容 Python 3.6+。
#
# 集群实测（2026-10-06，/public 单块 ext4）：冷缓存约 1700–7000 条目/秒，单线程顺序 lstat
# 同一时刻只有一个读请求在途（平均读延迟 5–7ms，无排队放大）；热缓存 1 万条目 < 0.1 秒、零读盘。
#
# 输出（一行）：
#   {"k":"end", ...}  本轮结果：agg1（扫描根下一层目录的累计）、agg2（第二层）、rootFiles（直接位于
#                     扫描根的文件）、top（本轮最大的文件）、pending（续扫游标）、计数与停止原因
#   {"k":"err","code":...}  扫描根不合法（越出 $HOME / 不是目录 / 路径含符号链接 / 另一个文件系统）
import heapq
import json
import os
import stat
import sys
import time

MAX_ENTRIES_CAP = 20000
MAX_SEC_CAP = 8.0
TOP_N = 30
AGG1_CAP = 2000
AGG2_CAP = 4000
PENDING_CAP = 5000
PENDING_BYTES_CAP = 1024 * 1024
OTHER_FS_CAP = 20
HARDLINK_SEEN_CAP = 100000
MAX_REL = 4096


def emit(record):
    # ensure_ascii：非 UTF-8 文件名经 surrogateescape 变成孤立代理项，转义后 JSON 仍合法、可原样回传。
    sys.stdout.write(json.dumps(record, separators=(',', ':'), ensure_ascii=True) + '\n')
    sys.stdout.flush()


def valid_rel(rel):
    # 相对路径：'' 表示扫描根本身；否则逐段非空、不是 . / ..、不含 NUL。
    if not isinstance(rel, str) or len(rel) > MAX_REL or '\x00' in rel:
        return False
    if rel == '':
        return True
    if rel.startswith('/') or rel.endswith('/'):
        return False
    for part in rel.split('/'):
        if part in ('', '.', '..'):
            return False
    return True


def lower_priority():
    # 尽力降低 CPU / IO 优先级：nice 10；ioprio 设为 idle 类（只有 BFQ/CFQ 等调度器会理会，
    # mq-deadline 在旧内核上忽略）。任何失败都静默——优先级只是礼貌，不是安全边界。
    try:
        os.nice(10)
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


def main():
    started = time.monotonic()
    try:
        args = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        args = None
    if not isinstance(args, dict):
        emit({'k': 'err', 'code': 'bad-args'})
        return
    lower_priority()

    home = os.path.realpath(os.path.expanduser('~'))
    root_rel = args.get('root') if isinstance(args.get('root'), str) else ''
    if not valid_rel(root_rel):
        emit({'k': 'err', 'code': 'bad-root', 'home': home})
        return
    root = home if root_rel == '' else home + '/' + root_rel
    # realpath 逐段解析符号链接：结果不等于自身 = 路径上有符号链接（可能指向 $HOME 之外）。
    if os.path.realpath(root) != root or not (root == home or root.startswith(home + '/')):
        emit({'k': 'err', 'code': 'outside-home', 'home': home})
        return
    try:
        root_st = os.lstat(root)
        home_dev = os.lstat(home).st_dev
    except OSError:
        emit({'k': 'err', 'code': 'not-found', 'home': home})
        return
    if not stat.S_ISDIR(root_st.st_mode):
        emit({'k': 'err', 'code': 'not-dir', 'home': home})
        return
    if root_st.st_dev != home_dev:
        emit({'k': 'err', 'code': 'other-fs', 'home': home})
        return
    root_dev = root_st.st_dev

    try:
        max_entries = int(args.get('maxEntries') or MAX_ENTRIES_CAP)
    except (TypeError, ValueError):
        max_entries = MAX_ENTRIES_CAP
    max_entries = max(1, min(max_entries, MAX_ENTRIES_CAP))
    try:
        max_sec = float(args.get('maxSec') or MAX_SEC_CAP)
    except (TypeError, ValueError):
        max_sec = MAX_SEC_CAP
    max_sec = max(0.5, min(max_sec, MAX_SEC_CAP))

    # 游标：[[相对扫描根的目录, 已处理条目数], ...]，栈底 → 栈顶。缺省 = 从扫描根开始。
    stack = []
    pending_bytes = 0
    dropped = 0
    cursor = args.get('pending')
    if isinstance(cursor, list):
        for item in cursor:
            if (isinstance(item, list) and len(item) == 2 and valid_rel(item[0])
                    and isinstance(item[1], int) and not isinstance(item[1], bool) and item[1] >= 0):
                if len(stack) >= PENDING_CAP or pending_bytes + len(item[0]) > PENDING_BYTES_CAP:
                    dropped += 1
                    continue
                stack.append((item[0], item[1], True))
                pending_bytes += len(item[0])
    else:
        stack.append(('', 0, False))

    entries = 0
    dirs_done = 0
    denied = 0
    errors = 0
    other_fs = 0
    other_fs_names = []
    hardlinks = 0
    seen_links = set()
    agg1 = {}
    agg2 = {}
    agg1_over = [0, 0, 0, 0]
    root_files = [0, 0, 0]
    top = []
    stop = 'done'

    def add(child, blocks, size, is_dir):
        # agg 值：[实际占用字节, 逻辑大小, 文件数, 子目录数]；目录自身的块计入它自己（与 du 一致），
        # 不计入它自己的文件/目录数。
        parts = child.split('/', 2)
        if len(parts) == 1 and not is_dir:
            root_files[0] += blocks
            root_files[1] += size
            root_files[2] += 1
            return
        k1 = parts[0]
        slot = agg1.get(k1)
        if slot is None:
            if len(agg1) < AGG1_CAP:
                slot = agg1[k1] = [0, 0, 0, 0]
            else:
                slot = agg1_over
        slot[0] += blocks
        slot[1] += size
        if len(parts) > 1:
            slot[3 if is_dir else 2] += 1
            # 第二层只记目录：直接位于第一层目录里的文件不单列（本机按「父目录 − 子目录之和」显示）。
            if len(parts) == 2 and not is_dir:
                return
            k2 = parts[0] + '/' + parts[1]
            slot2 = agg2.get(k2)
            if slot2 is None and len(agg2) < AGG2_CAP and slot is not agg1_over:
                slot2 = agg2[k2] = [0, 0, 0, 0]
            if slot2 is not None:
                slot2[0] += blocks
                slot2[1] += size
                if len(parts) > 2:
                    slot2[3 if is_dir else 2] += 1

    while stack:
        if time.monotonic() - started > max_sec:
            stop = 'time'
            break
        rel, skip, from_cursor = stack.pop()
        pending_bytes -= len(rel)
        full = root if rel == '' else root + '/' + rel
        if from_cursor:
            # 游标来自上一轮：两轮之间目录可能被换成符号链接或挂载点，重新核对再进入。
            try:
                st = os.lstat(full)
            except OSError:
                errors += 1
                continue
            if os.path.realpath(full) != full or not stat.S_ISDIR(st.st_mode) or st.st_dev != root_dev:
                errors += 1
                continue
        try:
            it = os.scandir(full)
        except PermissionError:
            denied += 1
            continue
        except OSError:
            errors += 1
            continue
        index = 0
        halted = False
        # 扫描根这一层的子目录先攒着，列完（或到上限停下）后按顺序一起入栈。
        root_dirs = [] if rel == '' else None
        with it:
            for entry in it:
                index += 1
                if index <= skip:
                    continue
                if entries >= max_entries or time.monotonic() - started > max_sec:
                    stop = 'entries' if entries >= max_entries else 'time'
                    stack.append((rel, index - 1, False))
                    pending_bytes += len(rel)
                    halted = True
                    break
                entries += 1
                try:
                    st = entry.stat(follow_symlinks=False)
                except PermissionError:
                    denied += 1
                    continue
                except OSError:
                    errors += 1
                    continue
                child = entry.name if rel == '' else rel + '/' + entry.name
                mode = st.st_mode
                if stat.S_ISDIR(mode):
                    if st.st_dev != root_dev:
                        other_fs += 1
                        if len(other_fs_names) < OTHER_FS_CAP:
                            other_fs_names.append(child[:512])
                        continue
                    queued = len(stack) + (len(root_dirs) if root_dirs is not None else 0)
                    if len(child) <= MAX_REL and queued < PENDING_CAP and pending_bytes + len(child) <= PENDING_BYTES_CAP:
                        if root_dirs is not None:
                            root_dirs.append(child)
                        else:
                            stack.append((child, 0, False))
                        pending_bytes += len(child)
                    else:
                        dropped += 1
                    add(child, st.st_blocks * 512, 0, True)
                    continue
                if stat.S_ISREG(mode) and st.st_nlink > 1:
                    # 硬链接：本轮内同一 inode 只计一次（跨轮无法去重，本机文案注明）。
                    key = (st.st_dev, st.st_ino)
                    if key in seen_links:
                        hardlinks += 1
                        continue
                    if len(seen_links) < HARDLINK_SEEN_CAP:
                        seen_links.add(key)
                blocks = st.st_blocks * 512
                add(child, blocks, st.st_size, False)
                if stat.S_ISREG(mode) and blocks > 0:
                    item = (blocks, child[:MAX_REL], st.st_size, int(st.st_mtime))
                    if len(top) < TOP_N:
                        heapq.heappush(top, item)
                    elif item[0] > top[0][0]:
                        heapq.heapreplace(top, item)
        if root_dirs:
            # 栈后进先出：倒着排，非隐藏的按名字先出栈。本层没列完时它的游标留在栈顶（下一轮先把它列完），
            # 所以轮到列本层时栈里只有本层此前列出的目录——连同这一批一起重排，分几轮列完顺序也一样。
            resume = stack.pop() if halted else None
            stack.extend((name, 0, False) for name in root_dirs)
            stack.sort(key=lambda item: (item[0].startswith('.'), item[0]), reverse=True)
            if resume is not None:
                stack.append(resume)
        if halted:
            break
        dirs_done += 1

    pending = [[rel, skip] for rel, skip, _ in stack]
    emit({
        'k': 'end', 'v': 1, 'home': home, 'root': root_rel,
        'complete': not stack, 'stop': 'done' if not stack else stop,
        'entries': entries, 'dirsDone': dirs_done, 'denied': denied, 'errors': errors,
        'otherFs': other_fs, 'otherFsNames': other_fs_names, 'dropped': dropped, 'hardlinks': hardlinks,
        'sec': round(time.monotonic() - started, 3),
        'agg1': agg1, 'agg1Over': agg1_over, 'agg2': agg2, 'rootFiles': root_files,
        'top': sorted(top, reverse=True), 'pending': pending,
    })


main()
