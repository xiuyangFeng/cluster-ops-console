# 关注作业的只读采集。经 stdin 与 job-forensics.py 的通用路径/有界读取函数一起执行，
# 不 import 远端文件、不落盘；仅登记过的本人作业日志。资源查询保留 .batch / .extern steps。

def watch_resources(ctx, ids):
    user = current_user()
    if not user or not ids:
        return
    fields = 'JobID,User,State,AllocCPUS,ReqMem,MaxRSS,TotalCPU,ElapsedRaw,AllocNodes,ReqTRES,NTasks,TimelimitRaw,TRESUsageInMax'
    raw = run(ctx, ['sacct', '-u', user, '-j', ','.join(ids), '-S', 'now-7days',
                    '-n', '-P', '--units=K', '-o', fields], 1024 * 1024)
    if raw is None and ctx.left() > 1:
        raw = run(ctx, ['sacct', '-u', user, '-j', ','.join(ids), '-S', 'now-7days',
                        '-n', '-P', '--units=K', '-o', fields.rsplit(',', 3)[0]], 1024 * 1024)
    if raw is None:
        return
    groups = {}
    owners = set()
    clipped = set()
    lines = decode(raw).splitlines()
    truncated = len(raw) >= 1024 * 1024 or len(lines) > 1000
    if len(raw) >= 1024 * 1024 and not raw.endswith(b'\n'):
        lines = lines[:-1]
    for line in lines[:1000]:
        f = line.split('|')
        if len(f) in (11, 14) and f[-1] == '':
            f.pop()
        if len(f) not in (10, 13):
            continue
        key = f[0].split('.')[0]
        if key not in ids:
            continue
        if f[0] == key and f[1] == user:
            owners.add(key)
        if f[1] and f[1] != user:
            continue
        if len(groups.get(key, [])) >= 64:
            clipped.add(key)
            continue
        groups.setdefault(key, []).append(dict(zip(
            ('id', 'user', 'state', 'cpus', 'reqMem', 'maxRss', 'totalCpu', 'elapsed', 'nodes', 'reqTres', 'tasks', 'timeLimit', 'tresMax'),
            [v if len(v) <= (4096 if i == 12 else 256) else "" for i, v in enumerate(f)])))
    for key in ids:
        if key in owners:
            emit(ctx, {'k': 'resource', 'id': key, 'rows': groups.get(key, []),
                       'truncated': truncated or key in clipped})


def watch_progress(ctx, jobs):
    # 再查实际归属与 RUNNING，避免关注后作业结束 / 作业号复用时继续读旧日志。
    user = current_user()
    if not user or not jobs:
        return
    raw = run(ctx, ['squeue', '-u', user, '-h', '-j', ','.join(j['id'] for j in jobs),
                    '-o', '%i|%u|%T'], 64 * 1024)
    running = set()
    if raw is not None:
        for line in decode(raw).splitlines():
            f = line.split('|')
            if len(f) == 3 and f[1] == user and f[2] == 'RUNNING':
                running.add(f[0])
    for job in jobs:
        if ctx.left() <= 1:
            break
        key = job['id']
        reg = job.get('reg') or {}
        files = []
        orch = None
        reason = '未能确认作业仍在运行'
        if key in running and reg.get('user') != user:
            reason = '还没有登记到此作业的本人日志路径'
        if key in running and reg.get('user') == user:
            parts = key.split('_', 1)
            info = {'raw': parts[0] if len(parts) > 1 else key, 'arr': parts[0],
                    'task': parts[1] if len(parts) > 1 else None, 'name': reg.get('name'), 'user': user}
            # 数组 %j 是 Slurm 的实际子作业编号；不知道时保留未展开，绝不猜成父作业号。
            if len(parts) > 1:
                info['raw'] = None
                templates = (reg.get('stdout') or '') + (reg.get('stderr') or '')
                if re.search(r'%\d{0,2}[jJ]', templates) and ctx.left() > 1:
                    live = scontrol_job(ctx, key)
                    if live and live.get('user') == user and live.get('arr') == parts[0] and live.get('task') == parts[1]:
                        info['raw'] = live.get('raw')
            pair = resolve_pair(reg.get('stdout'), reg.get('stderr'), info, reg.get('workDir'))
            reason = '登记的日志尚不存在或不可读取'
            for p in dict.fromkeys(pair):
                if not p or not os.path.isabs(p) or '%' in p or len(p) > 1024:
                    continue
                # 只读普通文件；O_NONBLOCK 避免路径在 stat/open 间变成 FIFO。
                try:
                    fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
                    with os.fdopen(fd, 'rb') as handle:
                        st = os.fstat(handle.fileno())
                        if not stat.S_ISREG(st.st_mode):
                            continue
                        handle.seek(max(0, st.st_size - 4096))
                        data = handle.read(4096)
                    if b'\x00' in data:
                        continue
                    files.append({'p': p, 't': decode(data), 'mt': st.st_mtime, 'sz': st.st_size})
                except (OSError, ValueError):
                    continue
            # 编排型作业的子任务事件（job-subruns.py，可选模块）：只读同一个已解析的 stdout。
            if job.get('orch') is not None and 'subrun_collect' in globals():
                orch = (pair[0], info.get('raw'))
        emit(ctx, {'k': 'progress', 'id': key, 'files': files,
                   'remoteNow': time.time(), 'reason': reason if not files else None})
        if orch:
            subrun_collect(ctx, key, job.get('orch'), orch[0], orch[1])


def watch_main():
    try:
        params = json.loads(sys.stdin.readline() or '{}')
    except ValueError:
        params = {}
    if not isinstance(params, dict):
        params = {}
    ctx = Ctx(params)
    ctx.env['LC_ALL'] = 'C.UTF-8'
    ctx.env['LANG'] = 'C.UTF-8'
    jobs = [j for j in (params.get('jobs') or [])[:20]
            if isinstance(j, dict) and isinstance(j.get('id'), str) and ID_RE.fullmatch(j['id'])]
    ids = [v for v in (params.get('resourceIds') or [])[:20]
           if isinstance(v, str) and ID_RE.fullmatch(v)]
    # 活跃关注优先，资源记录下轮可回填。
    watch_progress(ctx, jobs)
    if ctx.left() > 1 and 'subrun_final' in globals():
        subrun_final(ctx, params.get('orchFinal'))
    if ctx.left() > 1:
        watch_resources(ctx, ids)
    sys.stdout.write(json.dumps({'k': 'end', 'complete': ctx.left() > 0}) + '\n')
    sys.stdout.flush()
