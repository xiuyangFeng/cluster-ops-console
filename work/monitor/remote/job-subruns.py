# job-subruns.py —— 编排型作业的子任务事件与子任务日志尾部（v2.51，经 stdin 与 job-forensics.py、job-watch.py
# 一起送达远端执行，不 import 远端文件、不落盘）。只读：只读本人（st_uid == 当前 uid）的普通文件，不跑任何命令。
#
# 认的格式是 2026-10-06 只读核实过的作业内调度器（training_wss_min/xp/dispatch.py，复制进快照为 xp_dispatch.py）：
#   stdout 每行：<ISO 时间±HHMM> LAUNCH <run> <phase> <GPU>   /   <ISO 时间±HHMM> END <run> <phase> <退出码>
#   退出码是 Popen.poll()：0 正常、正数为进程退出码、负数为被信号终止；调度器被 SIGTERM 时直接杀子任务，不打印 END。
#   子任务日志：stdout 同目录下 <run>_<phase>_<SLURM_JOB_ID>.log（sbatch 的 --output 与 --logs 是同一个目录）。
# 其它形如 LAUNCH ["cmd", ...] 的行（别的提交脚本）一律不认，宁可不显示也不猜。
#
# stdout 用增量游标：本机记下 文件身份(dev:ino) 与偏移，这里只读新增的完整行；身份变了 / 文件变短 / 首次就很大
# 时标出覆盖缺口（gap），由本机决定清空还是保留。只回传匹配的事件行（带文件内字节偏移，供本机按位置去重），
# 不回传原文。子任务日志每个只读尾部，只回传含 epoch 的行与最后一行原文，条数、字节都有上限。
#
# 输出（NDJSON）：
#   subruns  id p cid from off sz mt gap more ev[[偏移, 时间, L|E, run, phase, 退出码|null]] logs[{r s mt sz ep[] last}|{r s miss}]
#   subruns-final  同上但没有 logs（父作业结束后的一次收尾读取，只补最后的 END）

SUBRUN_EVENT_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}) (LAUNCH|END) '
    r'([A-Za-z0-9][A-Za-z0-9._+-]{0,79}) ([A-Za-z0-9][A-Za-z0-9._-]{0,39}) (\S{1,128})$')
SUBRUN_CODE_RE = re.compile(r'^-?\d{1,4}$')
SUBRUN_TOKEN_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$')
SUBRUN_READ_MAX = 1024 * 1024          # 单个 stdout 每轮最多读的新增字节
SUBRUN_ROUND_READ_MAX = 4 * 1024 * 1024  # 一轮所有 stdout 合计
SUBRUN_FIRST_MAX = 4 * 1024 * 1024     # 首次看到的 stdout 超过它：只从末尾 SUBRUN_READ_MAX 起读，并标出「缺开头」
SUBRUN_EVENTS_MAX = 300                # 每个作业每轮最多回传的事件，多了留到下一轮（游标停在最后一条之后）
SUBRUN_LOGS_PER_JOB = 6
SUBRUN_LOGS_PER_ROUND = 16
SUBRUN_LOG_TAIL = 16 * 1024
SUBRUN_LOG_LINES = 8
SUBRUN_LINE_MAX = 600
SUBRUN_OUT_MAX = 256 * 1024            # 本模块合计输出上限：给同一轮其它作业的进度记录留足预算
_SUBRUN = {'read': 0, 'logs': 0, 'out': 0}


def subrun_open(path):
    # 只读本人普通文件；O_NONBLOCK 防止路径在 stat/open 之间被换成 FIFO。调用方负责关闭。
    if not isinstance(path, str) or not os.path.isabs(path) or '%' in path or '\x00' in path or len(path) > 1024:
        return None, None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except (OSError, ValueError):
        return None, None
    try:
        handle = os.fdopen(fd, 'rb')
    except (OSError, ValueError):
        os.close(fd)
        return None, None
    try:
        st = os.fstat(handle.fileno())
        if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid():
            return handle, st
    except OSError:
        pass
    handle.close()
    return None, None


def subrun_scan(handle, st, cursor, first):
    """从游标读 stdout 新增的完整行，返回 (结果, 本轮新出现的事件)。cursor: {'cid': 'dev:ino', 'off': int} 或 None。"""
    cid = '%d:%d' % (st.st_dev, st.st_ino)
    size = st.st_size
    gap = None
    start = 0
    if isinstance(cursor, dict) and isinstance(cursor.get('off'), int) and cursor['off'] >= 0:
        if cursor.get('cid') != cid:
            gap = 'replaced'
        elif cursor['off'] > size:
            gap = 'truncated'
        else:
            start = cursor['off']
    elif first and size > SUBRUN_FIRST_MAX:
        start = size - SUBRUN_READ_MAX
        gap = 'head'
    room = max(0, min(SUBRUN_READ_MAX, SUBRUN_ROUND_READ_MAX - _SUBRUN['read']))
    result = {'cid': cid, 'from': start, 'off': start, 'sz': size, 'mt': st.st_mtime, 'gap': gap, 'more': False, 'ev': []}
    if room <= 0 or start >= size:
        result['more'] = start < size
        return result
    try:
        handle.seek(start)
        data = handle.read(room)
    except (OSError, ValueError):
        return result
    _SUBRUN['read'] += len(data)
    pos = 0
    if gap == 'head':
        # 从文件中间起读：第一行是残片，丢掉。
        cut = data.find(b'\n')
        if cut < 0:
            result['off'] = start + len(data)
            result['more'] = True
            return result
        pos = cut + 1
    end = data.rfind(b'\n')
    if end < pos:
        if len(data) >= room and room == SUBRUN_READ_MAX:
            # 一整块都没有换行：超长行（多半是进度条或二进制），整块跳过，标出缺口。
            result['off'] = start + len(data)
            result['gap'] = gap or 'skipped'
        result['more'] = start + len(data) < size
        return result
    consumed = end + 1
    while pos < consumed:
        nl = data.find(b'\n', pos, consumed)
        line = data[pos:nl]
        offset = start + pos
        pos = nl + 1
        if len(result['ev']) >= SUBRUN_EVENTS_MAX:
            consumed = offset - start
            result['more'] = True
            break
        if len(line) > 400 or (b' LAUNCH ' not in line and b' END ' not in line):
            continue
        m = SUBRUN_EVENT_RE.match(decode(line).rstrip('\r'))
        if not m:
            continue
        code = None
        if m.group(2) == 'END':
            if not SUBRUN_CODE_RE.match(m.group(5)):
                continue
            code = int(m.group(5))
        result['ev'].append([offset, m.group(1), 'L' if m.group(2) == 'LAUNCH' else 'E', m.group(3), m.group(4), code])
    result['off'] = start + consumed
    result['more'] = result['more'] or result['off'] < size
    return result


def subrun_log(path, run, phase):
    handle, st = subrun_open(path)
    if handle is None:
        return {'r': run, 's': phase, 'miss': True}
    try:
        offset = max(0, st.st_size - SUBRUN_LOG_TAIL)
        handle.seek(offset)
        data = handle.read(SUBRUN_LOG_TAIL)
    except (OSError, ValueError):
        return {'r': run, 's': phase, 'miss': True}
    finally:
        handle.close()
    if b'\x00' in data[:4096]:
        return {'r': run, 's': phase, 'miss': True}
    lines = decode(data).splitlines()
    if offset > 0 and lines:
        lines = lines[1:]
    lines = [v.rstrip('\r') for v in lines if v.strip()]
    epochs = [v[:SUBRUN_LINE_MAX] for v in lines if 'epoch' in v][-SUBRUN_LOG_LINES:]
    return {'r': run, 's': phase, 'mt': st.st_mtime, 'sz': st.st_size, 'ep': epochs,
            'last': lines[-1][:300] if lines else ''}


def subrun_emit(ctx, record):
    size = len(json.dumps(record, separators=(',', ':'), ensure_ascii=False).encode('utf-8')) + 1
    if _SUBRUN['out'] + size > SUBRUN_OUT_MAX:
        return False
    if emit(ctx, record):
        _SUBRUN['out'] += size
        return True
    return False


def subrun_collect(ctx, key, orch, path, raw):
    """运行中的关注作业：增量读 stdout 事件，并读「正在跑」的子任务日志尾部。

    orch = {'cur': 游标或 None, 'open': [[run, phase], ...]（本机已知正在跑、按最久未采样排序）}。
    raw 是 Slurm 实际作业号（%j / SLURM_JOB_ID）；不知道时不读子任务日志，绝不拿父作业号去猜。
    """
    if not isinstance(orch, dict) or ctx.left() <= 1 or _SUBRUN['out'] >= SUBRUN_OUT_MAX:
        return
    handle, st = subrun_open(path)
    if handle is None:
        return
    try:
        result = subrun_scan(handle, st, orch.get('cur'), orch.get('cur') is None)
    finally:
        handle.close()
    # 正在跑的集合 = 本机已知的 + 本轮新 LAUNCH − 本轮 END；新启动的从未采样，排最前。
    known = [] if result['gap'] in ('replaced', 'truncated') else [
        (t[0], t[1]) for t in (orch.get('open') or [])[:64]
        if isinstance(t, list) and len(t) == 2 and all(isinstance(v, str) for v in t)]
    fresh = []
    for ev in result['ev']:
        pair = (ev[3], ev[4])
        if ev[2] == 'L':
            if pair not in fresh and pair not in known:
                fresh.append(pair)
        else:
            if pair in fresh:
                fresh.remove(pair)
            if pair in known:
                known.remove(pair)
    logs = []
    if raw and str(raw).isdigit():
        folder = os.path.dirname(path)
        for run, phase in (list(reversed(fresh)) + known)[:SUBRUN_LOGS_PER_JOB]:
            if _SUBRUN['logs'] >= SUBRUN_LOGS_PER_ROUND or ctx.left() <= 1:
                break
            if not SUBRUN_TOKEN_RE.match(run) or not SUBRUN_TOKEN_RE.match(phase):
                continue
            _SUBRUN['logs'] += 1
            logs.append(subrun_log(os.path.join(folder, '%s_%s_%s.log' % (run, phase, raw)), run, phase))
    record = dict(result, k='subruns', id=key, p=path, logs=logs, rn=time.time())
    if not subrun_emit(ctx, record) and logs:
        record['logs'] = []
        subrun_emit(ctx, record)


def subrun_final(ctx, items):
    """父作业已结束：对本机给的游标做一次有限收尾读取，只认同一个文件身份。"""
    for item in (items or [])[:10]:
        if ctx.left() <= 1 or _SUBRUN['out'] >= SUBRUN_OUT_MAX:
            break
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not ID_RE.match(item['id']):
            continue
        cursor = item.get('cur')
        if not isinstance(cursor, dict):
            continue
        handle, st = subrun_open(item.get('p'))
        if handle is None:
            subrun_emit(ctx, {'k': 'subruns-final', 'id': item['id'], 'p': item.get('p'), 'miss': True})
            continue
        try:
            result = subrun_scan(handle, st, cursor, False)
        finally:
            handle.close()
        if result['gap'] in ('replaced', 'truncated'):
            # 作业已结束后文件被换掉 / 截断：不读别的文件，只告诉本机。
            result['ev'] = []
            result['off'] = result['from']
        subrun_emit(ctx, dict(result, k='subruns-final', id=item['id'], p=item.get('p'), rn=time.time()))
