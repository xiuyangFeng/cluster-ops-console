# job-forensics.py —— 失败作业取证（v2.49，经 stdin 送达远端执行，服务器上不落任何文件）。
#
# 调用方式（本机 lib/jobs/forensics.mjs 组装，与 usage-scan.py 同一零残留模式）：
#   ssh host "python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),\"job-forensics\",\"exec\"))'"
#   stdin 第 1 行：本脚本源码的 JSON 字符串；第 2 行：参数 JSON（作业号、登记表里的路径模板、上限）。
#
# 只读：只跑 sacct / scontrol show job / scontrol write batch_script <id> -（写到 stdout），
# 只读日志与脚本文件的头尾；不提交、不取消、不创建或修改任何文件，不发起网络请求。
# 兼容 Python 3.6+（集群上是系统 python3）。
#
# 每个作业的日志路径按优先级找（第一个找到日志文件的来源胜出，记为 src）：
#   registry   本机登记表（作业排队 / 运行时 squeue 记下的 StdOut / StdErr 模板）
#   scontrol   scontrol show job（作业结束 MinJobAge 秒内仍可查，路径已展开）
#   submitline sacct SubmitLine 里的 -o/-e，以及提交脚本里的 #SBATCH -o/-e（命令行优先）
#   default    WorkDir/slurm-%j.out（数组作业 slurm-%A_%a.out）
#   none       以上都没有找到文件
# 模板展开 %% %j %J %A %a %x %u（可带补零宽度，如 %4a）；含反斜杠的模板按 Slurm 规则不展开；
# 相对路径以 WorkDir 为基准。
#
# 日志：每个文件读末尾 TAIL 字节；另在日志所在目录与 WorkDir（及其 logs/）里找文件名含作业号的
# 其它文件（实测根因常在 arm_*_<id>.log 里，.out 只有启动信息），最多 SIBLINGS 个、同样读末尾。
# 兄弟文件多于 SIBLINGS 个时按修改时间取最新的；编排型作业（一个作业几十个子任务，主日志每个子任务
# 一行 `END <run> <phase> <退出码>`，格式见 job-subruns.py）先取退出码非 0 的子任务自己的日志
# （文件名含 <run>_<phase>）——报错的子任务往往不是最后结束的那几个，只按时间取会漏掉它。
# 脚本：作业仍在 scontrol 视野内时用 write batch_script 取一份，否则读提交脚本文件（若还在），≤ SCRIPT 字节。
# 状态文件：编排脚本在日志目录或其上一级写的 status.json（schema 为 xp_status_v1 且 job_id 是本作业才认）。
# 被拒绝启动的子任务（例如 run 目录已有内容）在主日志里一行都没有，原因只记在这里。
# 远端只回传原文，不做分类（分类在本机 lib/jobs/diagnose.mjs）。
#
# 输出（NDJSON，每行一条）：
#   job  id raw arr task name user wd src tool live files[{p r(stdout|stderr|sibling) sz t}] sc scs(scontrol|file)
#        sub{n bad fail[[run, phase, 退出码]]}（仅编排型作业：主日志里 END 的条数、其中退出码非 0 的条数与前几条）
#        st{n bad arms[[名字, 状态, 原因|null]]}（编排脚本自己的状态文件：子任务总数、没跑完的个数与前几个）
#   end  n(处理的作业数) complete(是否全部处理完) sec
import json
import os
import pwd
import re
import shlex
import stat
import subprocess
import sys
import time

ID_RE = re.compile(r'^\d{1,12}(?:_\d{1,9})?$')
NO_VAL_TASK = '4294967294'  # 非数组作业的 %a（Slurm 的 NO_VAL）
SLURM_DIRS = ('/public/slurm/bin', '/opt/slurm/bin', '/usr/local/slurm/bin')
PATTERN_RE = re.compile(r'%(\d{0,2})([%jJAaxu])')
SCRIPT_EXTS = ('.slurm', '.sbatch', '.sh', '.bash', '.job', '.pbs')
SHORT_WITH_ARG = set('AabcDdeFGiJLMmNnopqSTtwxCBr')
LONG_FLAGS = set((
    'parsable', 'hold', 'wait', 'requeue', 'no-requeue', 'overcommit', 'exclusive', 'contiguous',
    'spread-job', 'test-only', 'use-min-nodes', 'verbose', 'quiet', 'ignore-pbs', 'no-kill', 'oversubscribe',
    'reboot', 'propagate', 'get-user-env', 'nice', 'help', 'usage', 'version', 'label', 'unbuffered', 'pty',
    'x11', 'disable-status', 'no-allocate', 'kill-on-bad-exit', 'preserve-env', 'exact', 'overlap', 'whole',
    'immediate', 'mpi-bind', 'export-file-none', 'no-shell', 'bell', 'no-bell', 'test', 'quit-on-interrupt',
))
SHORT_NAMES = {'o': 'output', 'e': 'error', 'J': 'job-name', 'D': 'chdir', 'a': 'array'}
SCONTROL_KEYS = ('JobId', 'ArrayJobId', 'ArrayTaskId', 'JobName', 'UserId', 'WorkDir', 'StdOut', 'StdErr', 'Command', 'JobState')
SCONTROL_SPLIT = re.compile(r' (?=[A-Za-z][A-Za-z0-9_:/]*=)')
SCAN_DIR_MAX = 5000
# 同目录兄弟文件只看日志类扩展名（或无扩展名）：同号的 .pt / .csv / .npz 不是日志。
LOG_EXTS = ('.log', '.out', '.err', '.txt', '.stdout', '.stderr')
# 与 job-subruns.py 的 SUBRUN_EVENT_RE 同一行格式，这里只认 END。
SUBRUN_END_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} END '
    r'([A-Za-z0-9][A-Za-z0-9._+-]{0,79}) ([A-Za-z0-9][A-Za-z0-9._-]{0,39}) (-?\d{1,4})$')
SUBRUN_READ_MAX = 1024 * 1024
FAILED_SUBRUN_MAX = 8
STATUS_FILE_MAX = 2 * 1024 * 1024


class Ctx:
    def __init__(self, params):
        self.tail = clamp(params.get('tailBytes'), 1024, 65536, 16384)
        self.siblings = clamp(params.get('siblingMax'), 0, 8, 4)
        self.script = clamp(params.get('scriptBytes'), 0, 131072, 32768)
        self.budget = clamp(params.get('budgetSec'), 1, 60, 15)
        self.max_out = clamp(params.get('maxOutBytes'), 65536, 8 * 1024 * 1024, 3 * 1024 * 1024)
        self.started = time.time()
        self.out_bytes = 0
        env = dict(os.environ)
        env['PATH'] = env.get('PATH', '/usr/bin:/bin') + ':' + ':'.join(SLURM_DIRS)
        env['LC_ALL'] = 'C'
        self.env = env

    def left(self):
        return self.budget - (time.time() - self.started)


def clamp(value, lo, hi, default):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(lo, min(hi, int(value)))


def text_or_none(value, limit=1024):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or value.lower() in ('n/a', '(null)', 'none', 'unknown'):
        return None
    return value[:limit]


def run(ctx, args, limit):
    timeout = min(6.0, max(0.5, ctx.left()))
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                              timeout=timeout, env=ctx.env)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout[:limit]


def decode(data):
    return data.decode('utf-8', 'replace')


# ---- 路径模板 ----

def expand(template, info):
    if not template:
        return None
    if '\\' in template:
        # Slurm：文件名里有反斜杠时整串不做 % 展开（反斜杠本身去掉）。
        return template.replace('\\', '')
    values = {
        'j': info.get('raw'), 'J': info.get('raw'),
        'A': info.get('arr') or info.get('raw'),
        'a': info.get('task') if info.get('task') is not None else NO_VAL_TASK,
        'x': info.get('name'), 'u': info.get('user'),
    }

    def repl(match):
        pad, key = match.group(1), match.group(2)
        if key == '%':
            return '%'
        value = values.get(key)
        if value is None:
            return match.group(0)
        if pad and key in 'jJAa' and value.isdigit():
            value = value.zfill(min(int(pad), 10))
        return value

    return PATTERN_RE.sub(repl, template)


def absolute(path, workdir):
    if not path:
        return None
    if os.path.isabs(path):
        return path
    return os.path.join(workdir, path) if workdir else None


def resolve_pair(stdout_tpl, stderr_tpl, info, workdir):
    out = absolute(expand(stdout_tpl, info), workdir)
    err = absolute(expand(stderr_tpl, info), workdir) if stderr_tpl else out
    return out, err


# ---- sacct / scontrol ----

def sacct_batch(ctx, ids):
    # SubmitLine 放最后：它是自由文本、可能含 |，按前 5 段定长切分后剩余部分整体归它。
    raw = run(ctx, ['sacct', '-j', ','.join(ids), '-X', '-n', '-P', '-o', 'JobID,JobIDRaw,JobName,User,WorkDir,SubmitLine'], 4 * 1024 * 1024)
    rows = {}
    if raw is None:
        return rows
    for line in decode(raw).split('\n'):
        parts = line.split('|', 5)
        if len(parts) != 6 or not ID_RE.match(parts[0].strip()):
            continue
        rows[parts[0].strip()] = {
            'raw': parts[1].strip() if parts[1].strip().isdigit() else None,
            'name': text_or_none(parts[2], 256),
            'user': text_or_none(parts[3], 64),
            'wd': text_or_none(parts[4]),
            'submit': text_or_none(parts[5], 8192),
        }
    return rows


def scontrol_job(ctx, job_id):
    raw = run(ctx, ['scontrol', 'show', 'job', '-o', job_id], 256 * 1024)
    if raw is None:
        return None
    line = decode(raw).split('\n')[0].strip()
    if not line.startswith('JobId='):
        return None
    fields = {}
    for token in SCONTROL_SPLIT.split(line):
        key, _, value = token.partition('=')
        if key in SCONTROL_KEYS and key not in fields:
            fields[key] = value.strip()
    user = fields.get('UserId', '')
    return {
        'raw': fields.get('JobId') if (fields.get('JobId') or '').isdigit() else None,
        'arr': fields.get('ArrayJobId') if (fields.get('ArrayJobId') or '').isdigit() else None,
        'task': fields.get('ArrayTaskId') if (fields.get('ArrayTaskId') or '').isdigit() else None,
        'name': text_or_none(fields.get('JobName'), 256),
        'user': text_or_none(user.split('(')[0], 64),
        'wd': text_or_none(fields.get('WorkDir')),
        'stdout': text_or_none(fields.get('StdOut')),
        'stderr': text_or_none(fields.get('StdErr')),
        'command': text_or_none(fields.get('Command')),
    }


def batch_script(ctx, job_id):
    raw = run(ctx, ['scontrol', 'write', 'batch_script', job_id, '-'], ctx.script + 1)
    if not raw:
        return None
    text = decode(raw[:ctx.script])
    # 作业不存在 / 不是批处理作业时 scontrol 也可能返回 0 并打印说明，脚本得像脚本。
    if not (text.startswith('#!') or '#SBATCH' in text[:4096]):
        return None
    return text


# ---- 提交命令行与脚本指令 ----

def split_words(line):
    try:
        return shlex.split(line)
    except ValueError:
        return line.split()


def parse_options(words, stop_at_positional=True):
    # 返回 (options, positional)。长选项不带 = 且不在 LONG_FLAGS 里的，按「下一个词是参数」处理。
    opts = {}
    positional = []
    i = 0
    while i < len(words):
        word = words[i]
        if word == '--':
            positional.extend(words[i + 1:])
            break
        if word.startswith('--') and len(word) > 2:
            name, eq, value = word[2:].partition('=')
            if not eq and name not in LONG_FLAGS:
                i += 1
                value = words[i] if i < len(words) else ''
            opts[name] = value
        elif word.startswith('-') and len(word) > 1:
            letter = word[1]
            if letter in SHORT_WITH_ARG:
                value = word[2:]
                if not value:
                    i += 1
                    value = words[i] if i < len(words) else ''
                opts[SHORT_NAMES.get(letter, letter)] = value
        else:
            if stop_at_positional:
                positional.extend(words[i:])
                break
            positional.append(word)
        i += 1
    return opts, positional


def parse_submit_line(line):
    words = split_words(line or '')
    if not words:
        return None
    tool = os.path.basename(words[0])
    opts, positional = parse_options(words[1:])
    return {'tool': tool, 'opts': opts, 'positional': positional}


def script_directives(text):
    # #SBATCH 只在第一条非注释、非空行之前有效（与 sbatch 一致）；行内 # 之后视为注释。
    opts = {}
    for index, line in enumerate((text or '').split('\n')[:2000]):
        stripped = line.strip()
        if index == 0 and stripped.startswith('#!'):
            continue
        if stripped.startswith('#SBATCH'):
            body = stripped[len('#SBATCH'):]
            cut = body.find(' #')
            if cut >= 0:
                body = body[:cut]
            more, _ = parse_options(split_words(body), stop_at_positional=False)
            opts.update(more)
            continue
        if not stripped or stripped.startswith('#'):
            continue
        break
    return opts


def pick_script_path(positional, workdir):
    # SubmitLine 丢了原始引号（--export=A,B="x y" 会被拆开），第一个位置参数未必是脚本：
    # 先找真实存在的文件，再找脚本扩展名，最后才退回第一个。
    candidates = [absolute(p, workdir) for p in positional[:8]]
    candidates = [c for c in candidates if c]
    for path in candidates:
        if is_regular(path):
            return path
    for path in candidates:
        if path.endswith(SCRIPT_EXTS):
            return path
    return candidates[0] if candidates else None


# ---- 文件 ----

def is_regular(path):
    try:
        return stat.S_ISREG(os.stat(path).st_mode)
    except (OSError, ValueError):
        return False


def read_tail(path, limit):
    # 只读普通文件（FIFO / 设备文件读了会挂住）；从中间开始读时丢掉第一行的残片。
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return None
        with open(path, 'rb') as handle:
            offset = max(0, info.st_size - limit)
            handle.seek(offset)
            data = handle.read(limit)
    except (OSError, ValueError):
        return None
    if offset > 0:
        cut = data.find(b'\n')
        data = data[cut + 1:] if cut >= 0 else data
    if b'\x00' in data[:4096]:
        return None  # 二进制文件（checkpoint 等）不是日志
    return {'p': path, 'sz': info.st_size, 't': decode(data), 'mt': info.st_mtime}


def read_head(path, limit):
    try:
        if not is_regular(path):
            return None
        with open(path, 'rb') as handle:
            data = handle.read(limit)
    except (OSError, ValueError):
        return None
    if b'\x00' in data[:4096]:
        return None
    return decode(data)


def subrun_ends(path):
    # 主日志里的 END 行 → (条数, 退出码非 0 的条数, 前 FAILED_SUBRUN_MAX 条非 0 的 [run, phase, 退出码])，
    # 按失败先后（最先失败的多半是根因）。不是编排型作业的日志返回 (0, 0, [])。
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return 0, 0, []
        with open(path, 'rb') as handle:
            handle.seek(max(0, info.st_size - SUBRUN_READ_MAX))
            data = handle.read(SUBRUN_READ_MAX)
    except (OSError, ValueError):
        return 0, 0, []
    total = 0
    bad = 0
    failures = []
    for line in data.split(b'\n'):
        if len(line) > 400 or b' END ' not in line:
            continue
        m = SUBRUN_END_RE.match(decode(line).rstrip('\r'))
        if not m:
            continue
        total += 1
        code = int(m.group(3))
        if code == 0:
            continue
        bad += 1
        if len(failures) < FAILED_SUBRUN_MAX:
            failures.append([m.group(1), m.group(2), code])
    return total, bad, failures


def dispatch_status(dirs, job_raw):
    # → {'n': 子任务总数, 'bad': 状态不是 complete 的个数, 'arms': 前几个 [名字, 状态, 原因]}；没有可认的状态文件 → None。
    seen = set()
    for directory in dirs:
        for base in (directory, os.path.dirname(directory)):
            path = os.path.join(base, 'status.json')
            if not base or path in seen:
                continue
            seen.add(path)
            try:
                info = os.stat(path)
                if not stat.S_ISREG(info.st_mode) or info.st_size > STATUS_FILE_MAX:
                    continue
                with open(path, 'rb') as handle:
                    data = json.loads(decode(handle.read(STATUS_FILE_MAX)))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or data.get('schema') != 'xp_status_v1' or str(data.get('job_id')) != job_raw:
                continue
            arms = data.get('arms')
            if not isinstance(arms, dict):
                continue
            bad = 0
            listed = []
            for name, arm in arms.items():
                if not isinstance(arm, dict) or arm.get('status') == 'complete':
                    continue
                bad += 1
                if len(listed) < FAILED_SUBRUN_MAX:
                    listed.append([str(name)[:80], text_or_none(arm.get('status'), 32), text_or_none(arm.get('reason'), 300)])
            return {'n': len(arms), 'bad': bad, 'arms': listed}
    return None


def siblings(dirs, tokens, exclude, limit, tail, prefer=()):
    if limit <= 0 or not tokens:
        return []
    pattern = re.compile(r'(?<!\d)(?:' + '|'.join(re.escape(t) for t in tokens) + r')(?!\d)')
    # prefer 里的名字按整段匹配（前后不是字母数字），A_f1_train 不会认到 BA_f1_train 头上。
    preferred = [re.compile(r'(?<![A-Za-z0-9])' + re.escape(name) + r'(?![A-Za-z0-9])') for name in prefer]

    def rank(name):
        for index, regex in enumerate(preferred):
            if regex.search(name):
                return index
        return len(preferred)

    found = []
    seen = set(exclude)
    for directory in dirs:
        try:
            iterator = os.scandir(directory)
        except (OSError, ValueError):
            continue
        with iterator:
            for count, entry in enumerate(iterator):
                if count >= SCAN_DIR_MAX:
                    break
                if not pattern.search(entry.name) or ('.' in entry.name and not entry.name.lower().endswith(LOG_EXTS)):
                    continue
                path = os.path.join(directory, entry.name)
                if path in seen:
                    continue
                try:
                    if not entry.is_file():
                        continue
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                seen.add(path)
                found.append((mtime, path, rank(entry.name)))
    found.sort(reverse=True)
    found.sort(key=lambda item: item[2])
    result = []
    for _, path, _ in found:
        if len(result) >= limit:
            break
        item = read_tail(path, tail)
        if item and item['sz'] > 0:
            item['r'] = 'sibling'
            result.append(item)
    return result


ARRAY_SED_RE = re.compile(
    r'([A-Za-z_]\w*)=\\?\$\(\s*sed\s+-n\s+\\?["\']?\\?\$(?:\(\(\s*SLURM_ARRAY_TASK_ID(?:\s*\+\s*(\d+))?\s*\)\)|\{?SLURM_ARRAY_TASK_ID\}?)p\\?["\']?\s+\\?["\']?([^\s"\');&|]+)\\?["\']?\s*\)'
)
REDIRECT_TARGET_RE = re.compile(r'(?:^|[\s;&|()])1?>>?\s*\\?["\']?([^\s"\';&|)>]+)\\?["\']?')


def extract_wrap_script(submit_line, submit):
    if not submit or 'wrap' not in submit.get('opts', {}):
        return None
    opt_val = submit['opts'].get('wrap') or ''
    raw = submit_line or ''
    m = re.search(r'--wrap(?:=|\s+)(.*)$', raw)
    if m:
        tail = m.group(1).strip()
        if len(tail) >= 2 and tail[0] == tail[-1] and tail[0] in ('"', "'"):
            tail = tail[1:-1]
        if len(tail) > len(opt_val):
            return tail
    return opt_val or None


def redirected_siblings(script_text, info, workdir, exclude, limit, tail):
    if limit <= 0 or not script_text:
        return []
    var_map = {}
    home = os.environ.get('HOME')
    if home:
        var_map['HOME'] = home
    if workdir:
        var_map['SLURM_SUBMIT_DIR'] = workdir
    task_str = info.get('task')
    if task_str and task_str.isdigit():
        for m in ARRAY_SED_RE.finditer(script_text):
            var_name, offset_str, list_file = m.group(1), m.group(2), m.group(3)
            list_path = absolute(list_file, workdir)
            content = read_head(list_path, 512 * 1024) if list_path else None
            if not content:
                continue
            idx = int(task_str) + (int(offset_str) if offset_str else 0)
            lines = content.splitlines()
            if 1 <= idx <= len(lines):
                resolved = absolute(lines[idx - 1].strip(), workdir)
                if resolved:
                    var_map[var_name] = resolved
    seen = set(exclude)
    result = []
    for raw_line in script_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        for m in REDIRECT_TARGET_RE.finditer(stripped):
            target = m.group(1).rstrip('\\"\'')
            if not target or target.startswith('&') or target == '/dev/null':
                continue
            for k, v in var_map.items():
                target = (
                    target
                    .replace('\\${' + k + '}', v)
                    .replace('\\$' + k, v)
                    .replace('${' + k + '}', v)
                    .replace('$' + k, v)
                )
            target = expand(target, info) or target
            if '$' in target or '%' in target:
                continue
            path = absolute(target, workdir)
            if not path or path in seen:
                continue
            seen.add(path)
            item = read_tail(path, tail)
            if item and item['sz'] > 0:
                item['r'] = 'sibling'
                result.append(item)
                if len(result) >= limit:
                    return result
    return result


# ---- 单个作业 ----

def investigate(ctx, job, acct):
    job_id = job['id']
    reg = job.get('reg') if isinstance(job.get('reg'), dict) else None
    row = acct.get(job_id) or {}
    match = re.match(r'^(\d+)_(\d+)$', job_id)
    info = {
        'raw': row.get('raw') or (None if match else job_id),
        'arr': match.group(1) if match else None,
        'task': match.group(2) if match else None,
        'name': row.get('name') or (reg or {}).get('name'),
        'user': row.get('user') or (reg or {}).get('user') or current_user(),
    }
    sc = scontrol_job(ctx, job_id) if ctx.left() > 1 else None
    if sc:
        for key in ('raw', 'arr', 'task', 'name', 'user'):
            if sc.get(key):
                info[key] = sc[key]
    if info['raw'] is None and match is None:
        info['raw'] = job_id
    workdir = (sc or {}).get('wd') or row.get('wd') or text_or_none((reg or {}).get('workDir'))

    script_text = None
    script_from = None
    if sc and ctx.script > 0:
        script_text = batch_script(ctx, job_id)
        if script_text is not None:
            script_from = 'scontrol'

    submit = parse_submit_line(row.get('submit'))
    script_path = None
    if submit and submit['tool'] in ('sbatch',) and 'wrap' not in submit['opts']:
        script_path = pick_script_path(submit['positional'], workdir)
    reg_command = text_or_none((reg or {}).get('command'))
    if not script_path and reg_command and os.path.isabs(reg_command):
        script_path = reg_command
    if not script_path and sc and sc.get('command') and os.path.isabs(sc['command']):
        script_path = sc['command']
    if script_text is None and script_path and ctx.script > 0:
        script_text = read_head(script_path, ctx.script)
        if script_text is not None:
            script_from = 'file'
    if script_text is None and submit and ctx.script > 0:
        wrap_script = extract_wrap_script(row.get('submit'), submit)
        if wrap_script:
            script_text = wrap_script[:ctx.script]
            script_from = 'file'

    candidates = []  # (src, stdout, stderr)
    if reg and (reg.get('stdout') or reg.get('stderr')):
        reg_wd = text_or_none(reg.get('workDir')) or workdir
        candidates.append(('registry',) + resolve_pair(text_or_none(reg.get('stdout')), text_or_none(reg.get('stderr')), info, reg_wd))
    if sc and (sc.get('stdout') or sc.get('stderr')):
        candidates.append(('scontrol',) + resolve_pair(sc.get('stdout'), sc.get('stderr'), info, workdir))
    tool = submit['tool'] if submit else None
    if submit:
        directives = script_directives(script_text) if script_text else {}
        merged = dict(directives)
        merged.update(submit['opts'])
        if merged.get('output') or merged.get('error'):
            out_tpl = merged.get('output') or None
            err_tpl = merged.get('error') or None
            if out_tpl is None and tool == 'sbatch':
                out_tpl = 'slurm-%A_%a.out' if info['arr'] else 'slurm-%j.out'
            candidates.append(('submitline',) + resolve_pair(out_tpl, err_tpl, info, workdir))
    # srun / salloc 不写 slurm-%j.out（输出回到提交终端），不给默认路径。
    if tool not in ('srun', 'salloc') and workdir:
        default = 'slurm-%A_%a.out' if info['arr'] else 'slurm-%j.out'
        candidates.append(('default',) + resolve_pair(default, None, info, workdir))

    files = []
    source = 'none'
    for src, out_path, err_path in candidates:
        got = []
        for role, path in (('stdout', out_path), ('stderr', err_path)):
            if not path or any(f['p'] == path for f in got):
                continue
            item = read_tail(path, ctx.tail)
            if item:
                item['r'] = role
                got.append(item)
        if got:
            files = got
            source = src
            break

    dirs = []
    for _, out_path, err_path in candidates:
        for path in (out_path, err_path):
            if path:
                directory = os.path.dirname(path)
                if directory not in dirs:
                    dirs.append(directory)
    if workdir:
        for directory in (workdir, os.path.join(workdir, 'logs')):
            if directory not in dirs:
                dirs.append(directory)
    tokens = [t for t in (info['raw'], job_id if match else None) if t]
    sub = None
    for item in files:
        total, bad, failures = subrun_ends(item['p'])
        if total:
            sub = {'n': total, 'bad': bad, 'fail': failures}
            break
    if ctx.left() > 1:
        prefer = []
        for run, phase, _ in (sub or {}).get('fail', ()):
            if run + '_' + phase not in prefer:
                prefer.append(run + '_' + phase)
        sibs = siblings(dirs[:4], tokens, [f['p'] for f in files], ctx.siblings, ctx.tail, prefer)
        files.extend(sibs)
        rem = ctx.siblings - len(sibs)
        if rem > 0 and script_text:
            files.extend(redirected_siblings(script_text, info, workdir, [f['p'] for f in files], rem, ctx.tail))
    status = dispatch_status(dirs[:4], info['raw']) if info['raw'] else None

    return {
        'k': 'job', 'id': job_id, 'raw': info['raw'], 'arr': info['arr'], 'task': info['task'],
        'name': info['name'], 'user': info['user'], 'wd': workdir, 'src': source, 'tool': tool,
        'live': sc is not None,
        'files': [{'p': f['p'], 'r': f['r'], 'sz': f['sz'], 't': f['t']} for f in files],
        'sc': script_text, 'scs': script_from, 'sub': sub, 'st': status,
    }


_USER = []


def current_user():
    if not _USER:
        try:
            _USER.append(pwd.getpwuid(os.getuid()).pw_name)
        except (KeyError, OSError):
            _USER.append(None)
    return _USER[0]


def emit(ctx, record):
    line = json.dumps(record, separators=(',', ':'), ensure_ascii=False)
    size = len(line.encode('utf-8')) + 1
    if ctx.out_bytes + size > ctx.max_out:
        return False
    ctx.out_bytes += size
    sys.stdout.write(line + '\n')
    return True


def main():
    try:
        params = json.loads(sys.stdin.readline() or '{}')
    except ValueError:
        params = {}
    if not isinstance(params, dict):
        params = {}
    ctx = Ctx(params)
    jobs = []
    for job in params.get('jobs') or []:
        if isinstance(job, dict) and isinstance(job.get('id'), str) and ID_RE.match(job['id']) and len(jobs) < 32:
            jobs.append(job)
    acct = sacct_batch(ctx, [j['id'] for j in jobs]) if jobs else {}
    done = 0
    complete = True
    for job in jobs:
        if ctx.left() <= 1:
            complete = False
            break
        record = investigate(ctx, job, acct)
        if not emit(ctx, record):
            complete = False
            break
        done += 1
    sys.stdout.write(json.dumps({'k': 'end', 'n': done, 'complete': complete, 'sec': round(time.time() - ctx.started, 3)}) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
