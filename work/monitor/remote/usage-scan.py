# usage-scan.py —— Agent 用量只读增量扫描（经 stdin 送达远端执行，服务器上不落任何文件）。
#
# 调用方式（本机 lib/usage/scan.mjs 组装）：
#   ssh host "python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),\"usage-scan\",\"exec\"))'"
#   stdin 第 1 行：本脚本源码的 JSON 字符串；其余：参数 JSON（游标、时间窗、预算）。
#
# 只读：遍历 Codex / Claude 会话日志目录，从上次的字节偏移继续读完整行，只取用量相关字段，
# 输出精简 NDJSON（每行一条记录）。不读写任何别的文件，不发起网络请求。
# 兼容 Python 3.6+（集群上是系统 python3）。
#
# 输出记录（k = 类型）：
#   s    会话：a(agent) sid cwd m(模型) w(上下文窗口，Codex 才有) t(首次时间)
#   c    调用：a sid rid t m st(ok|err) code in(普通输入) cw(缓存写入) cr(缓存读取) o(输出) p(输入合计) tid sc(子 Agent)
#        em(仅失败调用，v2.51 起)：错误原文摘要——单行、≤300 字符、已粗脱敏；日志里没有文本时为 ""
#   t    轮次：a sid tid t0 t1（Codex 的开始/结束分两条到达，本机合并）
#   x    上下文压缩：a sid t
#   cur  游标：f(路径) i(inode) o(偏移) mt(mtime) s(该文件的解析状态)
#   end  收尾：complete(是否扫完) files pending bytes sec roots home(远端家目录，用于显示 ~/ 路径)
#
# 输出总量不超过参数 maxOutBytes（UTF-8 字节，含游标与 end）；放不下时停在某条日志之前，
# 该文件的游标停在那里、complete=false，本机 5s 后接着下一轮。
import calendar
import glob
import json
import os
import re
import sqlite3
import sys
import time
from urllib.parse import quote, unquote

CODEX_MARKERS = (b'"token_usage_record"', b'"token_count"', b'"session_meta"', b'"turn_context"',
                 b'"task_started"', b'"task_complete"', b'"type":"error"')
CLAUDE_MARKERS = (b'"usage":', b'"turn_duration"', b'"compact_boundary"', b'"isApiErrorMessage"')
GEMINI_MARKERS = (b'"tokens":', b'"usageMetadata":', b'"sessionId":', b'"type":"gemini"', b'"type": "gemini"', b'"type":"user"', b'"type": "user"', b'"type":"error"', b'"type": "error"')
CURSOR_MARKERS = (b'"role":', b'"usage":', b'"tokens":')
CUSTOM_MARKERS = (b'"usage":', b'"tokens":', b'"input_tokens":', b'"prompt_tokens":', b'"output_tokens":', b'"st":"err"', b'"error":')
CODE_RE = re.compile(r'\b([45]\d\d)\b')
URI_RE = re.compile(rb'file://(/[A-Za-z0-9._%~/-]+)')
MAX_STR = {'sid': 128, 'rid': 160, 'm': 80, 'cwd': 512, 'tid': 128}
MAX_ERROR_TEXT = 300
MAX_NUM = 10 ** 15  # 计数类数值的上限：远超任何真实 Token 数（本机入库还会再钳到 1e10），只防病态数据
# 错误原文的粗脱敏（本机入库前还会再过一遍 redactSensitive）：Bearer 令牌、sk- 密钥、
# key=value 形式的凭据、URL 里的 user:pass@。实测（2026-10）错误文本里没有凭据，这里只兜底。
SECRET_RES = (
    (re.compile(r'(?i)\b(Bearer)\s+[^\s"\']+'), r'\1 [REDACTED]'),
    (re.compile(r'\bsk-[A-Za-z0-9_-]{16,}'), '[REDACTED]'),
    (re.compile(r'(?i)\b((?:api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|token|password|secret)\s*[:=]\s*)[^\s,"\']+'), r'\1[REDACTED]'),
    (re.compile(r'(?i)\b(https?://)[^\s/@:]+:[^\s/@]+@'), r'\1[REDACTED]@'),
)


def ts(value):
    # '2026-10-02T07:32:46.885Z' 或 epoch 秒/毫秒 → epoch 秒（float）；解析失败 → None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value <= 0:
            return None
        sec = value / 1000.0 if value > 1e11 else float(value)
        return round(sec, 3) if 0 < sec < 4e9 else None
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        base = calendar.timegm(time.strptime(value[:19], '%Y-%m-%dT%H:%M:%S'))
    except ValueError:
        return None
    frac = 0.0
    if len(value) > 20 and value[19] == '.':
        digits = ''
        for ch in value[20:]:
            if not ch.isdigit():
                break
            digits += ch
        if digits:
            frac = float('0.' + digits)
    return round(base + frac, 3)


def num(value):
    # 计数类数值：非正 / 非数 → 0；钳到 MAX_NUM（含 Infinity 与超长整数字面量——Python 3.8 的整数没有位数
    # 上限，不钳的话一个病态数值就能把单条记录撑到任意长）。
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if not value > 0:
        return 0
    return MAX_NUM if value >= MAX_NUM else int(value)


def text(value, key):
    if not isinstance(value, str) or not value:
        return None
    return value[:MAX_STR.get(key, 256)]


def error_text(value):
    # 错误原文摘要：Claude 是 message.content 的 text 块（实测错误记录都是单个 text 块），
    # Codex 是 payload.message 字符串。先截一段再脱敏（防超长），折叠空白成单行，最后限长。
    if isinstance(value, list):
        parts = [b.get('text') for b in value if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str)]
        value = ' '.join(parts)
    elif isinstance(value, dict):
        value = str(value.get('message') or value.get('error') or '')
    if not isinstance(value, str):
        return ''
    value = ' '.join(value[:MAX_ERROR_TEXT * 4].split())
    for pattern, repl in SECRET_RES:
        value = pattern.sub(repl, value)
    return value[:MAX_ERROR_TEXT]


def version_lt(ver, target):
    try:
        parts = tuple(int(p) for p in str(ver).split('.')[:3])
    except ValueError:
        return True
    return parts < target


# 输出预算（v2.57）：按 UTF-8 字节、在记录边界执行。
#   · 每处理一行日志之前先确认「已写出 + 待写出 + 这一行最多能产出的字节 + 游标 + end」放得下，
#     放不下就停在这一行之前——游标只推进到已完整输出的记录，下一轮从这里接着读。
#   · 一行日志最多产出 2 条记录（会话 + 调用），各字段都有长度上限；按 ensure_ascii=False 的最坏情况
#     （控制字符转义成 \uXXXX = 6 字节/字符）估上界，宁可提前停几 KB，也不让收尾被本机截断。
#     上界成立的前提是「每个字段都有界」：字符串一律经 text() / error_text() 截断（拼出来的 rid 也是），
#     数值一律经 num() 钳位。新增字段时照此办，否则病态日志的单条记录会超出 LINE_MAX_BYTES。
#   · 旧实现读完整块（默认 32 MiB）才检查预算、按字符数计量，输出可远超本机接收上限，
#     游标与 end 被截掉，下一轮又从旧位置读，大日志永远追不平。
ESCAPED = 6  # 单个字符经 JSON 转义后的最大字节数
LINE_MAX_BYTES = (sum(MAX_STR.values()) + MAX_ERROR_TEXT + 256) * ESCAPED * 2
STATE_MAX_BYTES = (MAX_STR['sid'] + MAX_STR['cwd'] + MAX_STR['m'] * 2) * ESCAPED + 512  # 解析状态 s 的上界
END_RESERVE_BYTES = 4096  # end 记录：计数 + roots + installed + home（≤256 字符）


def dumps(record):
    return json.dumps(record, separators=(',', ':'), ensure_ascii=False)


def record_bytes(record):
    return len(dumps(record).encode('utf-8', 'replace')) + 1


class Emitter:
    def __init__(self, max_bytes):
        self.max_bytes = max_bytes
        self.bytes = 0
        # 直接写字节：计量与本机接收口径一致（UTF-8 字节），也不受远端 locale 的 stdout 编码影响。
        self.out = getattr(sys.stdout, 'buffer', sys.stdout)

    def emit(self, record):
        data = (dumps(record) + '\n').encode('utf-8', 'replace')
        self.bytes += len(data)
        self.out.write(data)

    def room(self, need):
        # 再写 need 字节后，是否仍给 end 记录留得出位置
        return self.bytes + need + END_RESERVE_BYTES <= self.max_bytes


class SizedDict(dict):
    # Claude 的调用 / 会话要在一块读完后按 requestId 去重再输出：待写出的字节数随替换增减。
    def __init__(self):
        dict.__init__(self)
        self.size = 0

    def __setitem__(self, key, value):
        old = self.get(key)
        if old is not None:
            self.size -= record_bytes(old)
        self.size += record_bytes(value)
        dict.__setitem__(self, key, value)


# ── Protobuf 轻量无依赖解析（供 Antigravity conversations/*.db 使用） ──

def pb_varint(buf, pos):
    val = 0
    shift = 0
    n = len(buf)
    while pos < n:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
        if shift > 70:
            break
    return None, n


def pb_iter(buf):
    pos = 0
    n = len(buf)
    while pos < n:
        tag, pos = pb_varint(buf, pos)
        if tag is None:
            break
        fn, wt = tag >> 3, tag & 7
        if fn <= 0:
            break
        if wt == 0:
            val, pos = pb_varint(buf, pos)
            if val is None:
                break
            yield fn, wt, val
        elif wt == 1:
            if pos + 8 > n:
                break
            yield fn, wt, buf[pos:pos + 8]
            pos += 8
        elif wt == 2:
            ln, pos = pb_varint(buf, pos)
            if ln is None or ln < 0 or pos + ln > n:
                break
            yield fn, wt, buf[pos:pos + ln]
            pos += ln
        elif wt == 5:
            if pos + 4 > n:
                break
            yield fn, wt, buf[pos:pos + 4]
            pos += 4
        else:
            break


def pb_ts(buf):
    sec = 0
    nanos = 0
    for fn, wt, val in pb_iter(buf):
        if fn == 1 and wt == 0:
            sec = val
        elif fn == 2 and wt == 0:
            nanos = val
    if sec <= 0 or sec >= 4e9:
        return None
    return round(sec + nanos / 1e9, 3)


def scan_codex_line(line, st, emit):
    try:
        d = json.loads(line.decode('utf-8', 'replace'))
    except ValueError:
        return
    if not isinstance(d, dict):
        return
    kind = d.get('type')
    p = d.get('payload') if isinstance(d.get('payload'), dict) else {}
    t = ts(d.get('timestamp'))
    if kind == 'session_meta':
        st['sid'] = text(p.get('id') or p.get('session_id'), 'sid')
        st['cwd'] = text(p.get('cwd'), 'cwd')
        st['ver'] = text(p.get('cli_version'), 'm')
        if st['sid']:
            emit({'k': 's', 'a': 'codex', 'sid': st['sid'], 'cwd': st['cwd'], 't': t})
        return
    if kind == 'turn_context':
        st['model'] = text(p.get('model'), 'm') or st.get('model')
        if p.get('cwd'):
            st['cwd'] = text(p.get('cwd'), 'cwd')
        return
    sid = st.get('sid')
    if not sid:
        return
    if kind == 'token_usage_record':
        st['rec'] = True
        u = p.get('usage') if isinstance(p.get('usage'), dict) else {}
        rid = text(p.get('response_id'), 'rid')
        if not rid or t is None:
            return
        total_in = num(u.get('input_tokens'))
        cr = min(num(u.get('cached_input_tokens')), total_in)
        cw = min(num(u.get('cache_write_input_tokens')), total_in - cr)
        emit({'k': 'c', 'a': 'codex', 'sid': text(p.get('session_id'), 'sid') or sid, 'rid': rid, 't': t,
              'm': st.get('model'), 'st': 'ok', 'code': None, 'in': total_in - cr - cw, 'cw': cw, 'cr': cr,
              'o': num(u.get('output_tokens')), 'p': total_in, 'tid': text(p.get('turn_id'), 'tid')})
        return
    if kind != 'event_msg':
        return
    ptype = p.get('type')
    if ptype == 'task_started' and t is not None:
        emit({'k': 't', 'a': 'codex', 'sid': sid, 'tid': text(p.get('turn_id'), 'tid'), 't0': t})
    elif ptype == 'task_complete' and t is not None:
        emit({'k': 't', 'a': 'codex', 'sid': sid, 'tid': text(p.get('turn_id'), 'tid'), 't1': t})
    elif ptype == 'token_count':
        info = p.get('info') if isinstance(p.get('info'), dict) else {}
        window = num(info.get('model_context_window'))
        if window and window != st.get('w'):
            st['w'] = window
            emit({'k': 's', 'a': 'codex', 'sid': sid, 'cwd': st.get('cwd'), 'w': window})
        # 旧版 Codex（无 token_usage_record）：按累计值差分，同一文件只走一种算法，避免重复计数。
        if st.get('rec') or not version_lt(st.get('ver'), (0, 158)) or t is None:
            return
        total = info.get('total_token_usage') if isinstance(info.get('total_token_usage'), dict) else None
        if not total:
            return
        prev = st.get('tot') or {}
        cur = {key: num(total.get(key)) for key in ('input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens')}
        st['tot'] = cur
        d_in = cur['input_tokens'] - num(prev.get('input_tokens'))
        d_cr = cur['cached_input_tokens'] - num(prev.get('cached_input_tokens'))
        d_out = cur['output_tokens'] - num(prev.get('output_tokens'))
        if d_in <= 0 and d_out <= 0:
            return
        d_in, d_cr, d_out = max(d_in, 0), max(min(d_cr, d_in), 0), max(d_out, 0)
        last = info.get('last_token_usage') if isinstance(info.get('last_token_usage'), dict) else {}
        emit({'k': 'c', 'a': 'codex', 'sid': sid, 'rid': 'tc:%s:%d' % (sid, cur['total_tokens']), 't': t,
              'm': st.get('model'), 'st': 'ok', 'code': None, 'in': d_in - d_cr, 'cw': 0, 'cr': d_cr, 'o': d_out,
              'p': num(last.get('input_tokens')) or d_in, 'tid': None})
    elif ptype == 'error' and t is not None:
        match = CODE_RE.search(str(p.get('message') or ''))
        # rid 里的时间戳是日志原文：ts() 只校验前 19 个字符，后面可以任意长。整个 rid 截到 MAX_STR['rid']
        # （与其它 rid、本机入库的截断同一上限；正常时间戳 24 字符，输出不变），LINE_MAX_BYTES 才是真上限。
        rid = text('err:%s:%s' % (sid, str(d.get('timestamp') or '')[:MAX_STR['rid']]), 'rid')
        emit({'k': 'c', 'a': 'codex', 'sid': sid, 'rid': rid, 't': t,
              'm': st.get('model'), 'st': 'err', 'code': int(match.group(1)) if match else None,
              'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0, 'tid': None, 'em': error_text(p.get('message'))})


def scan_claude_line(line, calls, sessions, emit):
    try:
        d = json.loads(line.decode('utf-8', 'replace'))
    except ValueError:
        return
    if not isinstance(d, dict):
        return
    sid = text(d.get('sessionId'), 'sid')
    t = ts(d.get('timestamp'))
    if not sid or t is None:
        return
    if sid not in sessions and d.get('cwd'):
        sessions[sid] = {'k': 's', 'a': 'claude', 'sid': sid, 'cwd': text(d.get('cwd'), 'cwd'), 't': t}
    kind = d.get('type')
    if kind == 'system':
        sub = d.get('subtype')
        if sub == 'turn_duration':
            dur = num(d.get('durationMs')) / 1000.0
            emit({'k': 't', 'a': 'claude', 'sid': sid, 'tid': text(d.get('uuid'), 'tid'), 't0': round(t - dur, 3), 't1': t})
        elif sub == 'compact_boundary':
            emit({'k': 'x', 'a': 'claude', 'sid': sid, 't': t})
        return
    if kind != 'assistant':
        return
    m = d.get('message') if isinstance(d.get('message'), dict) else {}
    model = text(m.get('model'), 'm')
    side = 1 if d.get('isSidechain') else 0
    # 错误判断放在「没有 usage 就跳过」之前：错误记录的 usage 是合成的全 0（实测都有），
    # 但不依赖它——没有 usage 字段的错误同样要记一次失败。
    if d.get('isApiErrorMessage') or model == '<synthetic>':
        status = d.get('apiErrorStatus')
        rid = text('err:' + (text(d.get('uuid'), 'rid') or str(t)), 'rid')
        calls[rid] = {'k': 'c', 'a': 'claude', 'sid': sid, 'rid': rid, 't': t, 'm': None, 'st': 'err',
                      'code': status if isinstance(status, int) and abs(status) < MAX_NUM else None,
                      'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0, 'tid': None, 'sc': side,
                      'em': error_text(m.get('content'))}
        return
    u = m.get('usage') if isinstance(m.get('usage'), dict) else None
    if u is None:
        return
    rid = text(d.get('requestId') or m.get('id'), 'rid')
    if not rid:
        return
    fresh, cw, cr = num(u.get('input_tokens')), num(u.get('cache_creation_input_tokens')), num(u.get('cache_read_input_tokens'))
    out = num(u.get('output_tokens'))
    # 同一 requestId 会出现多次，且只有用量最大的那次是最终值（实测 2026-10）：
    #   按内容块写多行时 output 逐行增长；会话分叉 / 恢复复制进新文件的副本 usage 全为 0；
    #   子 Agent 文件里复制的父消息是中间值。所以保留总量最大的一次；总量相同取时间最早的
    #   （恢复会话的副本时间戳是复制那一刻，原始调用总是更早）。本机入库同一规则。
    prev = calls.get(rid)
    if prev:
        prev_total, total = prev['in'] + prev['cw'] + prev['cr'] + prev['o'], fresh + cw + cr + out
        if prev_total > total or (prev_total == total and prev['t'] <= t):
            return
    calls[rid] = {'k': 'c', 'a': 'claude', 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'ok', 'code': None,
                  'in': fresh, 'cw': cw, 'cr': cr, 'o': out, 'p': fresh + cw + cr,
                  'tid': None, 'sc': side}


def scan_gemini_line(line, st, emit):
    try:
        d = json.loads(line.decode('utf-8', 'replace'))
    except ValueError:
        return
    if not isinstance(d, dict):
        return
    sid = text(d.get('sessionId') or st.get('sid'), 'sid')
    if sid and sid != st.get('sid'):
        st['sid'] = sid
        st['se'] = 0
    t = ts(d.get('timestamp') or d.get('startTime') or d.get('time'))
    cwd = text(d.get('cwd') or d.get('projectRoot') or st.get('cwd'), 'cwd')
    if cwd:
        st['cwd'] = cwd
    if not sid:
        return
    if not st.get('se') and t is not None:
        emit({'k': 's', 'a': 'gemini', 'sid': sid, 'cwd': st.get('cwd'), 't': t})
        st['se'] = 1
    kind = d.get('type') or d.get('role')
    if kind == 'user' and t is not None:
        tid = text(d.get('id') or ('turn-%s' % t), 'tid')
        st['tid'] = tid
        st['t0'] = t
        emit({'k': 't', 'a': 'gemini', 'sid': sid, 'tid': tid, 't0': t})
        return
    if kind == 'error' and t is not None:
        msg = d.get('message') or d.get('content') or d.get('error')
        match = CODE_RE.search(str(msg or ''))
        rid = text('err:gm:%s:%s' % (sid[:40], d.get('id') or t), 'rid')
        emit({'k': 'c', 'a': 'gemini', 'sid': sid, 'rid': rid, 't': t, 'm': st.get('m'), 'st': 'err',
              'code': int(match.group(1)) if match else None, 'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0,
              'tid': st.get('tid'), 'em': error_text(msg)})
        return
    u = d.get('tokens') if isinstance(d.get('tokens'), dict) else (d.get('usageMetadata') if isinstance(d.get('usageMetadata'), dict) else None)
    if not u or t is None:
        return
    model = text(d.get('model'), 'm') or st.get('m')
    if model:
        st['m'] = model
    raw_in = num(u.get('input') if 'input' in u else u.get('promptTokenCount'))
    raw_cr = num(u.get('cached') if 'cached' in u else u.get('cachedContentTokenCount'))
    raw_cw = num(u.get('cacheWrite') or u.get('cache_creation_input_tokens'))
    out = num(u.get('output') if 'output' in u else u.get('candidatesTokenCount')) + num(u.get('thoughts') or u.get('thoughtsTokenCount')) + num(u.get('tool') or u.get('toolUsePromptTokenCount'))
    raw_total = num(u.get('total') or u.get('totalTokenCount'))
    if raw_in < raw_cr + raw_cw or (raw_total > 0 and raw_cr + raw_cw > 0 and abs((raw_in + raw_cr + raw_cw + out) - raw_total) < abs((raw_in + out) - raw_total)):
        in_fresh, cr, cw = raw_in, raw_cr, raw_cw
        total_in = in_fresh + cr + cw
    else:
        total_in = raw_in
        cr = min(raw_cr, total_in)
        cw = min(raw_cw, total_in - cr)
        in_fresh = total_in - cr - cw
    if total_in <= 0 and out <= 0:
        return
    rid = text(d.get('id') or ('gm:%s:%s:%d' % (sid[:40], t, total_in + out)), 'rid')
    emit({'k': 'c', 'a': 'gemini', 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'ok', 'code': None,
          'in': in_fresh, 'cw': cw, 'cr': cr, 'o': out, 'p': total_in, 'tid': st.get('tid')})
    if st.get('tid') and st.get('t0') is not None:
        emit({'k': 't', 'a': 'gemini', 'sid': sid, 'tid': st['tid'], 't0': st['t0'], 't1': t})


def scan_generic_line(agent, line, st, emit, fallback_mtime):
    # 通用 JSONL 解析（用于 Cursor agent-transcripts 与 custom 自定义 AI 日志）
    try:
        d = json.loads(line.decode('utf-8', 'replace'))
    except ValueError:
        return
    if not isinstance(d, dict):
        return
    sid = text(d.get('sessionId') or d.get('session_id') or d.get('sid') or st.get('sid'), 'sid')
    if not sid:
        return
    st['sid'] = sid
    cwd = text(d.get('cwd') or d.get('directory') or d.get('project') or st.get('cwd'), 'cwd')
    if cwd:
        st['cwd'] = cwd
    t = ts(d.get('timestamp') or d.get('time') or d.get('created_at') or d.get('t'))
    if t is None:
        step = num(st.get('n')) + 1
        st['n'] = step
        t = round(max(1.0, fallback_mtime - 1.0 + step * 0.001), 3)
    if not st.get('se'):
        emit({'k': 's', 'a': agent, 'sid': sid, 'cwd': st.get('cwd'), 'w': num(d.get('window')) or None, 't': t})
        st['se'] = 1
    role = d.get('role') or d.get('type')
    msg = d.get('message') if isinstance(d.get('message'), dict) else d
    model = text(d.get('model') or msg.get('model') or st.get('m'), 'm')
    if model:
        st['m'] = model
    if d.get('st') == 'err' or d.get('error') or d.get('isApiErrorMessage'):
        err_val = d.get('em') or d.get('error') or msg.get('content')
        code_val = d.get('code') or d.get('status')
        match = CODE_RE.search(str(err_val or ''))
        code = code_val if isinstance(code_val, int) and 100 <= code_val <= 599 else (int(match.group(1)) if match else None)
        rid = text(d.get('rid') or d.get('requestId') or d.get('id') or ('err:%s:%s' % (sid[:40], t)), 'rid')
        emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'err',
              'code': code, 'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0, 'tid': text(d.get('tid') or d.get('turn_id'), 'tid'),
              'em': error_text(err_val)})
        return
    u = d.get('usage') if isinstance(d.get('usage'), dict) else (msg.get('usage') if isinstance(msg.get('usage'), dict) else (d.get('tokens') if isinstance(d.get('tokens'), dict) else None))
    if u is not None:
        raw_in = num(u.get('input_tokens') if 'input_tokens' in u else (u.get('prompt_tokens') if 'prompt_tokens' in u else u.get('input')))
        cr = num(u.get('cache_read_input_tokens') or u.get('cached_input_tokens') or u.get('cached_tokens') or u.get('cached') or u.get('cr'))
        cw = num(u.get('cache_creation_input_tokens') or u.get('cache_write_input_tokens') or u.get('cw'))
        out = num(u.get('output_tokens') if 'output_tokens' in u else (u.get('completion_tokens') if 'completion_tokens' in u else (u.get('output') if 'output' in u else u.get('o'))))
        if 'in' in u and 'input_tokens' not in u:
            in_fresh = num(u.get('in'))
            prompt = num(u.get('p')) or (in_fresh + cw + cr)
        elif raw_in >= cr + cw and ('cached_input_tokens' in u or 'cached_tokens' in u or 'cached' in u):
            in_fresh = raw_in - cr - cw
            prompt = raw_in
        else:
            in_fresh = raw_in
            prompt = in_fresh + cw + cr
        if prompt <= 0 and out <= 0:
            return
        rid = text(d.get('rid') or d.get('requestId') or d.get('request_id') or d.get('response_id') or d.get('id') or ('%s:%s:%s' % (agent[:2], sid[:40], t)), 'rid')
        emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'ok', 'code': None,
              'in': in_fresh, 'cw': cw, 'cr': cr, 'o': out, 'p': prompt, 'tid': text(d.get('tid') or d.get('turn_id'), 'tid')})
        return
    # Cursor agent-transcripts：若行内只有 user / assistant 消息内容而无显式 usage 字段，按字符数估算每次 assistant 回复
    if agent == 'cursor':
        content = msg.get('content')
        chars = 0
        if isinstance(content, str):
            chars = len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get('text'), str):
                    chars += len(part['text'])
        if role == 'user':
            st['u_tok'] = num(st.get('u_tok')) + max(1, chars // 4)
        elif role == 'assistant' and chars > 0:
            idx = num(st.get('a_idx')) + 1
            st['a_idx'] = idx
            in_tok = max(1, num(st.get('u_tok')))
            out_tok = max(1, chars // 4)
            st['u_tok'] = in_tok + out_tok
            rid = text('cur:%s:%d' % (sid[:40], idx), 'rid')
            emit({'k': 'c', 'a': 'cursor', 'sid': sid, 'rid': rid, 't': t, 'm': model or 'cursor-agent', 'st': 'ok',
                  'code': None, 'in': in_tok, 'cw': 0, 'cr': 0, 'o': out_tok, 'p': in_tok, 'tid': None})


# ── SQLite 只读增量扫描（Antigravity & ZCode / OpenCode） ──

def sqlite_stat(path):
    st = os.stat(path)
    mtime = st.st_mtime
    size = st.st_size
    for suffix in ('-wal', '-shm'):
        try:
            wst = os.stat(path + suffix)
            if wst.st_mtime > mtime:
                mtime = wst.st_mtime
            if suffix == '-wal':
                size += wst.st_size
        except OSError:
            pass
    return str(st.st_ino), mtime, size


def open_sqlite_ro(path):
    uri = 'file:' + quote(os.path.abspath(path), safe='/:@') + '?mode=ro'
    return sqlite3.connect(uri, uri=True, timeout=2.0)


def extract_antigravity_cwd(conn, db_path, sid):
    try:
        row = conn.execute('SELECT data FROM trajectory_metadata_blob LIMIT 1').fetchone()
        if row and row[0]:
            for match in URI_RE.findall(bytes(row[0])):
                decoded = unquote(match.decode('utf-8', 'replace')).rstrip('/')
                if decoded and '/.gemini' not in decoded and '/.antigravity' not in decoded:
                    return text(decoded, 'cwd')
    except sqlite3.Error:
        pass
    summary_db = os.path.join(os.path.dirname(os.path.dirname(db_path)), 'conversation_summaries.db')
    if os.path.isfile(summary_db):
        try:
            sconn = open_sqlite_ro(summary_db)
            try:
                srow = sconn.execute('SELECT workspace_uris FROM conversation_summaries WHERE id = ? LIMIT 1', (sid,)).fetchone()
                if srow and srow[0]:
                    uris = json.loads(srow[0]) if isinstance(srow[0], str) else []
                    for u in uris:
                        if isinstance(u, str) and u.startswith('file:///'):
                            return text(unquote(u[7:]).rstrip('/'), 'cwd')
            finally:
                sconn.close()
        except (sqlite3.Error, ValueError, OSError):
            pass
    return None


def parse_ag_gen_metadata(blob):
    # 返回 (in_fresh, cw, cr, out_tok, model, window, bot_id, last_step_idx)
    in_fresh = cw = cr = out_tok = window = 0
    model = None
    bot_id = None
    last_step_idx = None
    for f1, w1, v1 in pb_iter(blob):
        if f1 != 1 or w1 != 2:
            continue
        for fn, wt, val in pb_iter(v1):
            if fn == 4 and wt == 2:
                for ufn, uwt, uval in pb_iter(val):
                    if ufn == 2 and uwt == 0:
                        in_fresh = num(uval)
                    elif ufn == 3 and uwt == 0:
                        out_tok = num(uval)
                    elif ufn == 4 and uwt == 0:
                        cw = num(uval)
                    elif ufn == 5 and uwt == 0:
                        cr = num(uval)
                    elif ufn == 7 and uwt == 2:
                        bot_id = uval.decode('utf-8', 'replace')
            elif fn == 9 and wt == 2:
                for cfn, cwt, cval in pb_iter(val):
                    if cfn == 10 and cwt == 2:
                        for wfn, wwt, wval in pb_iter(cval):
                            if wfn == 4 and wwt == 0:
                                window = num(wval)
            elif fn == 19 and wt == 2:
                model = text(val.decode('utf-8', 'replace'), 'm')
            elif fn == 20 and wt == 2:
                k = v = None
                for kfn, kwt, kval in pb_iter(val):
                    if kfn == 1 and kwt == 2:
                        k = kval.decode('utf-8', 'replace')
                    elif kfn == 2 and kwt == 2:
                        v = kval.decode('utf-8', 'replace')
                if k == 'last_step_index' and v and v.isdigit():
                    last_step_idx = int(v)
    return in_fresh, cw, cr, out_tok, model, window, bot_id, last_step_idx


def scan_antigravity_db(path, st, out, cursor_reserve, fallback_mtime):
    sid = text(os.path.splitext(os.path.basename(path))[0], 'sid')
    if not sid:
        return True
    try:
        conn = open_sqlite_ro(path)
    except sqlite3.Error:
        return True
    stopped = False
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'gen_metadata' not in tables:
            return True
        if not st.get('cwd') and 'trajectory_metadata_blob' in tables:
            cwd = extract_antigravity_cwd(conn, path, sid)
            if cwd:
                st['cwd'] = cwd

        last_s_idx = int(st.get('st')) if isinstance(st.get('st'), int) else -1
        last_g_idx = int(st.get('g')) if isinstance(st.get('g'), int) else -1
        max_row = conn.execute('SELECT MAX(idx) FROM gen_metadata').fetchone()
        max_g = max_row[0] if max_row and isinstance(max_row[0], int) else -1
        if max_g < last_g_idx:
            # 数据库被重建过：游标归零
            last_s_idx = -1
            last_g_idx = -1
            st['se'] = 0

        bot_map = {}
        step_t = {}
        cur_tid = None
        cur_t0 = None
        last_t = st.get('lt') if isinstance(st.get('lt'), (int, float)) else None

        if 'steps' in tables:
            for idx, step_type, status, meta, err_blob in conn.execute('SELECT idx, step_type, status, metadata, error_details FROM steps ORDER BY idx'):
                t0 = t1 = None
                bot_id = None
                if meta:
                    for fn, wt, val in pb_iter(bytes(meta)):
                        if fn == 1 and wt == 2:
                            t0 = pb_ts(val)
                        elif fn == 7 and wt == 2:
                            t1 = pb_ts(val)
                        elif fn == 9 and wt == 2:
                            for sfn, swt, sval in pb_iter(val):
                                if sfn == 7 and swt == 2:
                                    bot_id = sval.decode('utf-8', 'replace')
                t = t1 or t0 or last_t
                if t is not None:
                    last_t = t
                if step_type == 14 and t is not None:
                    if idx > last_s_idx and cur_tid and cur_t0 is not None:
                        if not out.room(LINE_MAX_BYTES * 2 + cursor_reserve):
                            stopped = True
                            break
                        out.emit({'k': 't', 'a': 'antigravity', 'sid': sid, 'tid': cur_tid, 't0': cur_t0, 't1': t})
                    cur_tid = text('turn-%d' % idx, 'tid')
                    cur_t0 = t0 or t
                    if idx > last_s_idx:
                        if not out.room(LINE_MAX_BYTES * 2 + cursor_reserve):
                            stopped = True
                            break
                        out.emit({'k': 't', 'a': 'antigravity', 'sid': sid, 'tid': cur_tid, 't0': cur_t0})
                if t is not None:
                    step_t[idx] = (t, cur_tid)
                    if bot_id:
                        bot_map[bot_id] = (t, cur_tid)
                if idx > last_s_idx:
                    if status in (4, 5) and t is not None:
                        if not out.room(LINE_MAX_BYTES + cursor_reserve):
                            stopped = True
                            break
                        err_str = ''
                        if err_blob:
                            for efn, ewt, eval_ in pb_iter(bytes(err_blob)):
                                if ewt == 2:
                                    err_str += ' ' + eval_.decode('utf-8', 'replace')
                        match = CODE_RE.search(err_str)
                        rid = text('err:ag:%s:%d' % (sid[:40], idx), 'rid')
                        out.emit({'k': 'c', 'a': 'antigravity', 'sid': sid, 'rid': rid, 't': t,
                                  'm': st.get('m'), 'st': 'err', 'code': int(match.group(1)) if match else None,
                                  'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0, 'tid': cur_tid,
                                  'em': error_text(err_str)})
                    last_s_idx = idx

        st['st'] = last_s_idx
        if last_t is not None:
            st['lt'] = last_t

        if not stopped:
            for idx, blob in conn.execute('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx', (last_g_idx,)):
                if not out.room(LINE_MAX_BYTES + cursor_reserve):
                    stopped = True
                    break
                if not blob:
                    last_g_idx = idx
                    continue
                in_fresh, cw, cr, out_tok, model, window, bot_id, last_step_idx = parse_ag_gen_metadata(bytes(blob))
                if model:
                    st['m'] = model
                if window and window != st.get('w'):
                    st['w'] = window
                    st['se'] = 0
                if in_fresh <= 0 and cw <= 0 and cr <= 0 and out_tok <= 0:
                    last_g_idx = idx
                    continue
                t_tid = (bot_map.get(bot_id) if bot_id else None) or (step_t.get(last_step_idx) if last_step_idx is not None else None)
                t = t_tid[0] if t_tid else (last_t or round(fallback_mtime, 3))
                tid = t_tid[1] if t_tid else cur_tid
                if not st.get('se'):
                    out.emit({'k': 's', 'a': 'antigravity', 'sid': sid, 'cwd': st.get('cwd'), 'w': st.get('w'), 't': t})
                    st['se'] = 1
                rid = text('ag:%s:%d' % (sid[:40], idx), 'rid')
                prompt = num(in_fresh + cw + cr)
                out.emit({'k': 'c', 'a': 'antigravity', 'sid': sid, 'rid': rid, 't': t,
                          'm': model or st.get('m'), 'st': 'ok', 'code': None,
                          'in': in_fresh, 'cw': cw, 'cr': cr, 'o': out_tok, 'p': prompt, 'tid': tid})
                last_g_idx = idx

            if not stopped and cur_tid and cur_t0 is not None and last_t is not None and last_t >= cur_t0:
                if out.room(LINE_MAX_BYTES + cursor_reserve):
                    out.emit({'k': 't', 'a': 'antigravity', 'sid': sid, 'tid': cur_tid, 't0': cur_t0, 't1': last_t})

        st['g'] = last_g_idx
        return not stopped
    except sqlite3.Error:
        return True
    finally:
        conn.close()


def scan_zcode_opencode_db(agent, path, st, out, cursor_reserve, since, deadline=None):
    try:
        conn = open_sqlite_ro(path)
    except sqlite3.Error:
        return True
    stopped = False
    if deadline is not None:
        conn.set_progress_handler(lambda: 1 if time.time() >= deadline else 0, 1000)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if agent == 'opencode':
            st['ocv'] = 1
        sess_map = {}
        last_s_row = int(st.get('sr')) if isinstance(st.get('sr'), int) else 0
        if 'session' in tables:
            cols = {r[1] for r in conn.execute('PRAGMA table_info(session)')}
            dir_col = 'directory' if 'directory' in cols else ('path' if 'path' in cols else 'NULL')
            tc_col = 'time_created' if 'time_created' in cols else 'NULL'
            for rowid, raw_sid, raw_dir, raw_tc in conn.execute('SELECT rowid, id, %s, %s FROM session ORDER BY rowid' % (dir_col, tc_col)):
                sid = text(str(raw_sid or ''), 'sid')
                if not sid:
                    continue
                cwd = text(str(raw_dir or ''), 'cwd')
                t = ts(raw_tc)
                sess_map[sid] = (cwd, t)
                if rowid > last_s_row:
                    if not out.room(LINE_MAX_BYTES + cursor_reserve) or (deadline is not None and time.time() >= deadline):
                        stopped = True
                        break
                    out.emit({'k': 's', 'a': agent, 'sid': sid, 'cwd': cwd, 't': t})
                    last_s_row = rowid
        st['sr'] = last_s_row
        if stopped:
            return False

        last_t_row = int(st.get('tr')) if isinstance(st.get('tr'), int) else 0
        if 'turn_usage' in tables:
            for rowid, raw_sid, raw_tid, t0_ms, t1_ms in conn.execute('SELECT rowid, session_id, turn_id, started_at, completed_at FROM turn_usage WHERE rowid > ? ORDER BY rowid', (last_t_row,)):
                if not out.room(LINE_MAX_BYTES + cursor_reserve) or (deadline is not None and time.time() >= deadline):
                    stopped = True
                    break
                sid = text(str(raw_sid or ''), 'sid')
                tid = text(str(raw_tid or ''), 'tid')
                t0 = ts(t0_ms)
                t1 = ts(t1_ms)
                if sid and tid and (t0 is not None or t1 is not None):
                    if (t0 or t1) >= since:
                        out.emit({'k': 't', 'a': agent, 'sid': sid, 'tid': tid, 't0': t0, 't1': t1})
                last_t_row = rowid
        st['tr'] = last_t_row
        if stopped:
            return False

        last_m_row = int(st.get('mr')) if isinstance(st.get('mr'), int) else 0
        if 'model_usage' in tables:
            max_row = conn.execute('SELECT MAX(rowid) FROM model_usage').fetchone()
            if max_row and isinstance(max_row[0], int) and max_row[0] < last_m_row:
                last_m_row = 0
            query = ('SELECT rowid, id, session_id, turn_id, model_id, status, started_at, completed_at, '
                     'input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, '
                     'cache_read_input_tokens, error_code, error_message, query_source '
                     'FROM model_usage WHERE rowid > ? ORDER BY rowid')
            for row in conn.execute(query, (last_m_row,)):
                if not out.room(LINE_MAX_BYTES + cursor_reserve) or (deadline is not None and time.time() >= deadline):
                    stopped = True
                    break
                rowid, raw_id, raw_sid, raw_tid, raw_model, status, t0_ms, t1_ms, in_tok, out_tok, reas_tok, cw_tok, cr_tok, err_code, err_msg, q_src = row
                sid = text(str(raw_sid or ''), 'sid')
                t = ts(t1_ms) or ts(t0_ms)
                if not sid or t is None or t < since:
                    last_m_row = rowid
                    continue
                if sid not in sess_map:
                    out.emit({'k': 's', 'a': agent, 'sid': sid, 'cwd': None, 't': t})
                    sess_map[sid] = (None, t)
                rid = text(str(raw_id or ('%s:%d' % (agent[:2], rowid))), 'rid')
                model = text(str(raw_model or ''), 'm')
                tid = text(str(raw_tid or ''), 'tid')
                side = 1 if str(q_src or '').startswith('subagent') else 0
                ok = status == 'completed' or (status != 'error' and not err_code and not err_msg)
                if not ok:
                    err_str = '%s %s' % (err_code or '', err_msg or '')
                    match = CODE_RE.search(err_str)
                    out.emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'err',
                              'code': int(match.group(1)) if match else None,
                              'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0, 'tid': tid, 'sc': side,
                              'em': error_text(err_msg or err_code)})
                else:
                    raw_in = num(in_tok)
                    cr = num(cr_tok)
                    cw = num(cw_tok)
                    if raw_in >= cr + cw:
                        in_fresh = raw_in - cr - cw
                        prompt = raw_in
                    else:
                        in_fresh = raw_in
                        prompt = in_fresh + cw + cr
                    out_v = max(num(out_tok), num(reas_tok))
                    out.emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'ok', 'code': None,
                              'in': in_fresh, 'cw': cw, 'cr': cr, 'o': out_v, 'p': prompt, 'tid': tid, 'sc': side})
                last_m_row = rowid
        elif 'message' in tables:
            # OpenCode streams into an existing row: rowid alone loses the final usage.
            # Page by (time_updated, rowid); replay the last timestamp after a complete
            # pass so equal-millisecond updates are safe. Store deduplication absorbs
            # replay. Old rowid-only cursors backfill once; no writes/indexes remotely.
            cols = {r[1] for r in conn.execute('PRAGMA table_info(message)')}
            updated = 'time_updated' in cols
            mu = int(st.get('mu') or 0)
            mi = int(st.get('mi') or 0)
            if updated:
                query = ('SELECT rowid, id, session_id, time_created, data, time_updated FROM message '
                         'WHERE time_updated > ? OR (time_updated = ? AND rowid > ?) '
                         'ORDER BY time_updated, rowid')
                rows = conn.execute(query, (mu, mu, mi))
            else:
                rows = conn.execute('SELECT rowid, id, session_id, time_created, data, 0 FROM message WHERE rowid > ? ORDER BY rowid', (last_m_row,))
            for rowid, raw_id, raw_sid, tc_ms, raw_data, tu_ms in rows:
                if not out.room(LINE_MAX_BYTES + cursor_reserve) or (deadline is not None and time.time() >= deadline):
                    stopped = True
                    break
                if updated:
                    st['mu'], st['mi'] = tu_ms, rowid
                sid = text(str(raw_sid or ''), 'sid')
                t = ts(tc_ms)
                if not sid or not raw_data:
                    last_m_row = rowid
                    continue
                try:
                    d = json.loads(raw_data)
                except ValueError:
                    last_m_row = rowid
                    continue
                if not isinstance(d, dict) or d.get('role') != 'assistant':
                    last_m_row = rowid
                    continue
                t = ts(d.get('time', {}).get('completed') if isinstance(d.get('time'), dict) else None) or t
                if t is None or t < since:
                    last_m_row = rowid
                    continue
                u = d.get('tokens') if isinstance(d.get('tokens'), dict) else {}
                cache = u.get('cache') if isinstance(u.get('cache'), dict) else {}
                in_fresh = num(u.get('input'))
                cr = num(cache.get('read'))
                cw = num(cache.get('write'))
                out_v = num(u.get('output')) + num(u.get('reasoning'))
                err = d.get('error')
                if not err and in_fresh <= 0 and cr <= 0 and cw <= 0 and out_v <= 0:
                    last_m_row = rowid
                    continue
                rid = text(str(raw_id or d.get('id') or ('oc:%d' % rowid)), 'rid')
                model = text(str(d.get('modelID') or d.get('model') or ''), 'm')
                if err:
                    msg = err.get('data') if isinstance(err, dict) else err
                    match = CODE_RE.search(str(msg or ''))
                    out.emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'err',
                              'code': int(match.group(1)) if match else None, 'in': 0, 'cw': 0, 'cr': 0, 'o': 0, 'p': 0,
                              'tid': None, 'em': error_text(msg)})
                else:
                    out.emit({'k': 'c', 'a': agent, 'sid': sid, 'rid': rid, 't': t, 'm': model, 'st': 'ok', 'code': None,
                              'in': in_fresh, 'cw': cw, 'cr': cr, 'o': out_v, 'p': in_fresh + cw + cr, 'tid': None})
                last_m_row = rowid
            if updated and not stopped:
                st['mi'] = 0
        st['mr'] = last_m_row
        return not stopped
    except sqlite3.Error:
        return False if deadline is not None and time.time() >= deadline else True
    finally:
        conn.close()


def list_files(root, suffix='.jsonl'):
    found = []
    for base, dirs, files in os.walk(root):
        for name in files:
            if name.endswith(suffix):
                found.append(os.path.join(base, name))
    return found


def read_gemini_project_root(jsonl_path):
    # ~/.gemini/tmp/<proj>/chats/session-*.jsonl → ~/.gemini/tmp/<proj>/.project_root
    parent = os.path.dirname(os.path.dirname(jsonl_path))
    marker = os.path.join(parent, '.project_root')
    try:
        with open(marker, 'rb') as fh:
            raw = fh.read(512).decode('utf-8', 'replace').strip()
            return text(raw.splitlines()[0].strip(), 'cwd') if raw else None
    except OSError:
        return None


def read_chunk(path, cursor, chunk_bytes):
    # 返回 (完整行列表, 新偏移, skip 标记)；文件被截断/替换（inode 变化或变短）时从头重读。
    # 行列表的每项是 (该行起始偏移, 行内容)：输出预算可能让本轮停在任意一行之前，游标就落在那一行的起点。
    with open(path, 'rb') as fh:
        fh.seek(cursor['o'])
        data = fh.read(chunk_bytes)
    skip = cursor.get('skip', False)
    if not data:
        return [], cursor['o'], skip
    end = data.rfind(b'\n')
    if end == -1:
        if len(data) < chunk_bytes:
            return [], cursor['o'], skip  # 末行还没写完，下轮再读
        return [], cursor['o'] + len(data), True  # 超长单行：跳过到下一个换行
    lines = []
    pos = cursor['o']
    for line in data[:end + 1].split(b'\n')[:-1]:
        lines.append((pos, line))
        pos += len(line) + 1
    if skip and lines:
        lines = lines[1:]  # 超长行的残段：丢弃（游标随后一行的起点越过它）
    return lines, cursor['o'] + end + 1, False


def detect_installed_agents(home, root_info):
    # 自动扫描远端安装了哪些 AI 工具（不启动子进程，只查可执行文件与安装目录 + 已存在的会话目录）
    bin_dirs = [
        os.path.join(home, '.local', 'bin'),
        os.path.join(home, 'bin'),
        os.path.join(home, '.npm-global', 'bin'),
        os.path.join(home, '.local', 'share', 'pnpm'),
        os.path.join(home, '.yarn', 'bin'),
        os.path.join(home, '.bun', 'bin'),
        os.path.join(home, '.volta', 'bin'),
        os.path.join(home, '.zcode', 'bin'),
        os.path.join(home, '.opencode', 'bin'),
        os.path.join(home, '.cursor', 'bin'),
    ]
    for pattern in ('.nvm/versions/node/*/bin', 'miniconda3/bin', 'anaconda3/bin', 'miniforge3/bin'):
        bin_dirs.extend(glob.glob(os.path.join(home, pattern)))
    for p in (os.environ.get('PATH') or '').split(os.pathsep):
        if p and p not in bin_dirs:
            bin_dirs.append(p)

    def has_bin(*names):
        for d in bin_dirs:
            for name in names:
                cand = os.path.join(d, name)
                if os.path.isfile(cand) and os.access(cand, os.X_OK):
                    return True
        return False

    checks = (
        ('codex', lambda: root_info.get('codex') or has_bin('codex') or os.path.isdir(os.path.join(home, '.codex', 'packages'))),
        ('claude', lambda: root_info.get('claude') or has_bin('claude', 'reclaude') or os.path.isdir(os.path.join(home, '.local', 'share', 'claude'))),
        ('antigravity', lambda: root_info.get('antigravity') or has_bin('agy', 'antigravity') or os.path.isdir(os.path.join(home, '.antigravity-server'))),
        ('gemini', lambda: root_info.get('gemini') or has_bin('gemini')),
        ('zcode', lambda: root_info.get('zcode') or has_bin('zcode') or os.path.isdir(os.path.join(home, '.zcode'))),
        ('opencode', lambda: root_info.get('opencode') or has_bin('opencode') or os.path.isdir(os.path.join(home, '.local', 'share', 'opencode'))),
        ('cursor', lambda: root_info.get('cursor') or has_bin('cursor') or os.path.isdir(os.path.join(home, '.cursor-server'))),
        ('custom', lambda: bool(root_info.get('custom'))),
    )
    return [agent for agent, fn in checks if fn()]


def main():
    args = json.loads(sys.stdin.read() or '{}')
    started = time.time()
    budget = float(args.get('budgetSec') or 12)
    since = float(args.get('since') or 0)
    chunk_bytes = int(args.get('chunkBytes') or 32 * 1024 * 1024)
    cursors = args.get('cursors') if isinstance(args.get('cursors'), dict) else {}
    # 预算下限：至少放得下一行的上界 + 游标 + end，保证每轮都能前进
    out = Emitter(max(int(args.get('maxOutBytes') or 4 * 1024 * 1024), 64 * 1024))
    home = os.path.expanduser('~')
    codex_home = os.environ.get('CODEX_HOME') or os.path.join(home, '.codex')
    claude_home = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(home, '.claude')

    # 1. JSONL 会话日志目录
    jsonl_sources = [
        ('codex', [os.path.join(codex_home, 'sessions')]),
        ('claude', [os.path.join(claude_home, 'projects')]),
        ('gemini', [os.path.join(home, '.gemini', 'tmp')]),
        ('cursor', [os.path.join(home, '.cursor', 'projects')]),
    ]
    custom_dirs = [os.path.join(home, '.config', 'cluster-workbench', 'usage-logs')]
    raw_custom = args.get('customDirs')
    if isinstance(raw_custom, list):
        for item in raw_custom[:16]:
            if isinstance(item, str) and item.strip():
                p = item.strip()
                if p.startswith('~/'):
                    p = os.path.join(home, p[2:])
                if os.path.isabs(p) and '..' not in p.split('/'):
                    custom_dirs.append(p)
    jsonl_sources.append(('custom', custom_dirs))

    # 2. SQLite 会话数据库源
    ag_dirs = [
        os.path.join(home, '.gemini', 'antigravity-cli', 'conversations'),
        os.path.join(home, '.gemini', 'antigravity', 'conversations'),
    ]
    zcode_dbs = [os.path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')]
    opencode_dbs = [
        os.path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
        os.path.join(home, '.opencode', 'db.sqlite'),
    ]

    pending = []
    root_info = {}

    for agent, dirs in jsonl_sources:
        has_dir = False
        for root in dirs:
            if not os.path.isdir(root):
                continue
            if agent == 'gemini':
                files = [p for p in list_files(root, '.jsonl') if '/chats/' in p.replace('\\', '/')]
                if files:
                    has_dir = True
            elif agent == 'cursor':
                files = [p for p in list_files(root, '.jsonl') if '/agent-transcripts/' in p.replace('\\', '/')]
                if files:
                    has_dir = True
            else:
                has_dir = True
                files = list_files(root, '.jsonl')
            for path in files:
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                ino = str(stat.st_ino)
                cur = cursors.get(path)
                if cur and cur.get('i') == ino and cur.get('o') == stat.st_size:
                    continue
                if not cur and stat.st_mtime < since:
                    continue
                if not cur or cur.get('i') != ino or stat.st_size < (cur.get('o') or 0):
                    cur = {'i': ino, 'o': 0, 's': {}}
                pending.append((stat.st_mtime, 'jsonl', agent, path, cur, stat.st_size))
        root_info[agent] = has_dir

    # Antigravity SQLite 目录
    ag_files = []
    for d in ag_dirs:
        if os.path.isdir(d):
            ag_files.extend(list_files(d, '.db'))
    root_info['antigravity'] = bool(ag_files)
    for path in ag_files:
        try:
            ino, mtime, size = sqlite_stat(path)
        except OSError:
            continue
        cur = cursors.get(path)
        if cur and cur.get('i') == ino and cur.get('o') == size and round(mtime, 3) == cur.get('mt'):
            continue
        if not cur and mtime < since:
            continue
        if not cur or cur.get('i') != ino:
            cur = {'i': ino, 'o': 0, 's': {}}
        pending.append((mtime, 'ag_sqlite', 'antigravity', path, cur, size))

    # ZCode / OpenCode SQLite 单文件
    for agent, db_paths in (('zcode', zcode_dbs), ('opencode', opencode_dbs)):
        existing = [p for p in db_paths if os.path.isfile(p)]
        root_info[agent] = bool(existing)
        for path in existing:
            try:
                ino, mtime, size = sqlite_stat(path)
            except OSError:
                continue
            cur = cursors.get(path)
            cursor_state = (cur or {}).get('s')
            migrated = agent != 'opencode' or (isinstance(cursor_state, dict) and cursor_state.get('ocv') == 1)
            if cur and migrated and cur.get('i') == ino and cur.get('o') == size and round(mtime, 3) == cur.get('mt'):
                continue
            if not cur and mtime < since:
                continue
            if not cur or cur.get('i') != ino:
                cur = {'i': ino, 'o': 0, 's': {}}
            pending.append((mtime, 'zc_sqlite', agent, path, cur, size))

    pending.sort(key=lambda item: -item[0])  # 最近改动的先读：首轮回填时今天的数据最先出现

    files = 0
    scanned = 0
    complete = True
    for mtime, kind, agent, path, cur, total_size in pending:
        cursor_reserve = len(dumps(path).encode('utf-8', 'replace')) * 2 + STATE_MAX_BYTES + 256
        if time.time() - started > budget or not out.room(cursor_reserve + LINE_MAX_BYTES):
            complete = False
            break

        if kind in ('ag_sqlite', 'zc_sqlite'):
            st = cur.get('s') if isinstance(cur.get('s'), dict) else {}
            if kind == 'ag_sqlite':
                done = scan_antigravity_db(path, st, out, cursor_reserve, mtime)
            else:
                done = scan_zcode_opencode_db(agent, path, st, out, cursor_reserve, since, started + budget)
            new_offset = total_size if done else 0
            scanned += max(0, total_size - (cur.get('o') or 0))
            files += 1
            out.emit({'k': 'cur', 'f': path, 'i': cur['i'], 'o': new_offset, 'mt': round(mtime, 3), 's': st})
            if not done:
                complete = False
                break
            continue

        stopped = False  # 输出预算用完：停在某一行之前
        while True:
            try:
                lines, offset, skip = read_chunk(path, cur, chunk_bytes)
            except OSError:
                break
            st = cur.get('s') if isinstance(cur.get('s'), dict) else {}
            if agent == 'gemini':
                if not st.get('cwd'):
                    proj_root = read_gemini_project_root(path)
                    if proj_root:
                        st['cwd'] = proj_root
                if not st.get('sid'):
                    st['sid'] = text(os.path.splitext(os.path.basename(path))[0], 'sid')
            elif agent in ('cursor', 'custom') and not st.get('sid'):
                st['sid'] = text(os.path.splitext(os.path.basename(path))[0], 'sid')

            calls, sessions = SizedDict(), SizedDict()  # Claude：本块内按 requestId 去重后再输出
            markers = (CODEX_MARKERS if agent == 'codex'
                       else CLAUDE_MARKERS if agent == 'claude'
                       else GEMINI_MARKERS if agent == 'gemini'
                       else CURSOR_MARKERS if agent == 'cursor'
                       else CUSTOM_MARKERS)
            for start, line in lines:
                if not any(marker in line for marker in markers):
                    continue
                if not out.room(calls.size + sessions.size + LINE_MAX_BYTES + cursor_reserve):
                    offset, skip, stopped = start, False, True
                    break
                if agent == 'codex':
                    scan_codex_line(line, st, out.emit)
                elif agent == 'claude':
                    scan_claude_line(line, calls, sessions, out.emit)
                elif agent == 'gemini':
                    scan_gemini_line(line, st, out.emit)
                else:
                    scan_generic_line(agent, line, st, out.emit, mtime)
            for record in sessions.values():
                out.emit(record)
            for record in calls.values():
                out.emit(record)
            scanned += offset - cur['o']
            moved = offset != cur['o']
            cur = {'i': cur['i'], 'o': offset, 's': st, 'skip': skip}
            if stopped or not moved or offset >= total_size or time.time() - started > budget:
                break
        files += 1
        record = {'k': 'cur', 'f': path, 'i': cur['i'], 'o': cur['o'], 'mt': round(mtime, 3), 's': cur['s']}
        if cur.get('skip'):
            record['skip'] = True
        out.emit(record)
        if cur['o'] < total_size:
            complete = False
        if stopped:
            break

    installed = detect_installed_agents(home, root_info)
    out.emit({'k': 'end', 'complete': complete, 'files': files, 'pending': len(pending), 'bytes': scanned,
              'sec': round(time.time() - started, 2), 'roots': root_info, 'installed': installed, 'home': home[:256]})


main()
