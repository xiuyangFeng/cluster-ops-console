# log-segment.py —— 日志按段向前读取（v2.51，经 stdin 送达远端执行，服务器上不落任何文件）。
#
# 调用方式（本机 lib/jobs/log-segment.mjs 组装，与 job-forensics.py 同一零残留模式）：
#   ssh host "python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),\"log-segment\",\"exec\"))'"
#   stdin 第 1 行：本脚本源码的 JSON 字符串；第 2 行：参数 JSON。
#
# 只读：只打开一个本机已解析好的绝对路径（来自本机登记表 / 诊断记录，不在这里展开模板），读一个
# 有界字节区间；不跑任何命令、不创建或修改文件、不发起网络请求。兼容 Python 3.6+。
#
# 参数：{ path, end | skip, max, expect: { ino, size, mtimeMs, sig } }
#   end   区间右端（不含），通常是上一段的起点；skip = 从当前文件末尾往前跳过的字节数（end 缺省时用）
#   max   单段上限（1KB–32KB）
#   expect 上一段（或本机采集时）记下的文件身份：inode 不同 = 轮转 / 重建；变短 = 截断；
#          大小不变但修改时刻变了 = 原地改写；sig = 区间右端之后若干字节的 sha1（原地重写后又写长的情况）。
# 只读普通文件（O_NONBLOCK 防 FIFO 挂住）、只读当前用户自己的文件。区间从中间开始时丢掉首个不完整的行，
# 回报丢掉的字节数（下一段会把它读回来）；整段没有换行时原样保留并注明。含 NUL 的视为二进制，不回传。
#
# 输出（一行 JSON）：
#   {"k":"seg","start","end","dropped","noBreak","size","ino","mt","sig","t"}
#   {"k":"err","code": missing|unreadable|notRegular|notOwner|rotated|truncated|rewritten|binary}
import errno
import hashlib
import json
import os
import stat
import sys

SIG_BYTES = 64


def clamp(value, lo, hi, default):
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(lo, min(hi, value))


def offset(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def out(record):
    sys.stdout.write(json.dumps(record, separators=(',', ':'), ensure_ascii=False) + '\n')
    sys.stdout.flush()


def fail(code):
    out({'k': 'err', 'code': code})


def sig_of(handle, at, length):
    if length <= 0:
        return None
    handle.seek(at)
    data = handle.read(length)
    return '%d-%s' % (len(data), hashlib.sha1(data).hexdigest())


def read_segment(params):
    path = params.get('path')
    if not isinstance(path, str) or not path.startswith('/') or '\x00' in path or len(path) > 1024:
        return fail('unreadable')
    limit = clamp(params.get('max'), 1024, 32768, 32768)
    expect = params.get('expect') if isinstance(params.get('expect'), dict) else {}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as err:
        return fail('missing' if getattr(err, 'errno', None) in (errno.ENOENT, errno.ENOTDIR) else 'unreadable')
    # 先在 fd 上核对类型与属主（目录 / FIFO 不进 fdopen），再包成文件对象读。
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        return fail('unreadable')
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        return fail('notRegular')
    if st.st_uid != os.getuid():
        os.close(fd)
        return fail('notOwner')
    try:
        handle = os.fdopen(fd, 'rb')
    except (OSError, ValueError):
        os.close(fd)
        return fail('unreadable')
    with handle:
        size = st.st_size
        mtime_ms = int(st.st_mtime_ns // 1000000)
        ino = str(st.st_ino)
        want_ino = expect.get('ino')
        if isinstance(want_ino, str) and want_ino and want_ino != ino:
            return fail('rotated')
        want_size = offset(expect.get('size'))
        if want_size is not None and size < want_size:
            return fail('truncated')
        want_mt = offset(expect.get('mtimeMs'))
        if want_size is not None and want_mt is not None and size == want_size and mtime_ms != want_mt:
            return fail('rewritten')
        end = offset(params.get('end'))
        if end is None:
            skip = offset(params.get('skip')) or 0
            end = max(0, size - skip)
        if end > size:
            return fail('truncated')
        try:
            want_sig = expect.get('sig')
            if isinstance(want_sig, str) and '-' in want_sig:
                length = int(want_sig.split('-', 1)[0])
                if length > 0 and sig_of(handle, end, min(length, SIG_BYTES)) != want_sig:
                    return fail('rewritten')
            start = max(0, end - limit)
            handle.seek(start)
            data = handle.read(end - start)
        except (OSError, ValueError):
            return fail('unreadable')
        dropped = 0
        no_break = False
        if start > 0:
            cut = data.find(b'\n')
            if cut >= 0:
                dropped = cut + 1
                data = data[dropped:]
            else:
                no_break = True
        if b'\x00' in data:
            return fail('binary')
        first = start + dropped
        try:
            sig = sig_of(handle, first, min(SIG_BYTES, end - first))
        except (OSError, ValueError):
            sig = None
    out({'k': 'seg', 'start': first, 'end': end, 'dropped': dropped, 'noBreak': no_break,
         'size': size, 'ino': ino, 'mt': mtime_ms, 'sig': sig, 't': data.decode('utf-8', 'replace')})


def main():
    try:
        params = json.loads(sys.stdin.readline() or '{}')
    except ValueError:
        params = {}
    read_segment(params if isinstance(params, dict) else {})


if __name__ == '__main__':
    main()
