// 「我的作业」采集：本机侧的远端脚本与 SSH 调用组装（只读，服务器上不落文件）。
//
// 与 collect.sh 同一零残留原则：远端命令是常量 `sh -s`，脚本源码走 stdin，不含任何插值。
// 慢采集的 ct_slurm 只拍 squeue/sinfo 全员快照、看不到已结束的作业；这里单独低频跑一次
// sacct，只查当前 SSH 用户近 2 天的作业（含已完成 / 失败 / 运行 / 排队）。
//
// 远端输出（逐行，key=value；解析见 parse.mjs）：
//   now=<epoch 秒>   tz=<date +%z，如 +0800>   user=<id -un>
//   state=ok|absent|error   error=no-user|sacct-timeout|sacct-failed   detail=<sacct 首行报错，≤200 字节>
//   rows=<sacct 输出的总行数>（在作业行之前；本机据此发现被截断，不再默默少算）
//   job=JobID|JobName|State|ExitCode|Submit|Start|End|Elapsed|NodeList|Partition
// 体量：sacct 按作业号升序输出，tail 保留最新 JOBS_MAX（6000）行、每行截到 480 字节；
// 实测单人近 48 小时约 1,100 行、每行约 100 字节（一轮 ≈110KB），上限打满也不到 3MB。
// 被截的超长行字段数不对会在解析时整行丢弃，不会产出半截记录。
// sacct 的 stderr 并进 stdout：成功时混入的告警行不是 10 段格式、解析时自然丢弃；
// 失败时首行就是报错原因（记账未启用 / slurmdbd 连不上等）。

import { buildProbeSshArgs } from "../ssh-args.mjs";
import { JOBS_MAX } from "./parse.mjs";

// 远端 sacct 自限 15s（coreutils timeout 存在时），本机整轮超时留出 SSH 握手余量。
export const JOBS_SCAN_TIMEOUT_MS = 20000;
export const JOBS_REMOTE_COMMAND = "sh -s";
export const JOBS_SACCT_FIELDS = "JobID,JobName,State,ExitCode,Submit,Start,End,Elapsed,NodeList,Partition";
// 本机接收上限：exec 默认 1MB 装不下打满的一轮（6000 行 × 480 字节 ≈ 2.9MB）。
export const JOBS_SCAN_MAX_OUT_BYTES = 4 * 1024 * 1024;

// 远端脚本按 sacct 的选择参数生成：定期采集固定 `-S now-2days`（JOBS_REMOTE_SCRIPT，与参数化之前逐字相同）；
// 按需回查（v2.51，lookup.mjs）换成 jobsLookupSelector 给出的日期窗口 / 作业号。选择参数只能来自
// jobsLookupSelector——那里按严格正则重验，插进脚本的只有数字、连字符、冒号、下划线与 T，不可能带引号或 $。
function buildJobsRemoteScript(selector = "-S now-2days") {
  return `PATH="$PATH:/public/slurm/bin:/opt/slurm/bin:/usr/local/slurm/bin"
LC_ALL=C.UTF-8
LANG=C.UTF-8
export PATH LC_ALL LANG
cj_user=$(id -un 2>/dev/null)
printf 'now=%s\\n' "$(date +%s 2>/dev/null)"
printf 'tz=%s\\n' "$(date +%z 2>/dev/null)"
printf 'user=%s\\n' "$cj_user"
if ! command -v sacct >/dev/null 2>&1; then
  printf 'state=absent\\n'
  exit 0
fi
if [ -z "$cj_user" ]; then
  printf 'state=error\\nerror=no-user\\n'
  exit 0
fi
cj_to=
if command -v timeout >/dev/null 2>&1; then cj_to="timeout 15"; fi
cj_out=$($cj_to sacct -u "$cj_user" -X -n -P ${selector} -o ${JOBS_SACCT_FIELDS} 2>&1)
cj_rc=$?
if [ "$cj_rc" -eq 0 ]; then
  printf 'state=ok\\n'
  printf 'rows=%s\\n' "$(printf '%s\\n' "$cj_out" | grep -c -v '^$')"
  printf '%s\\n' "$cj_out" | grep -v '^$' | tail -n ${JOBS_MAX} | cut -c 1-480 | sed 's/^/job=/'
elif [ "$cj_rc" -eq 124 ]; then
  printf 'state=error\\nerror=sacct-timeout\\n'
else
  printf 'state=error\\nerror=sacct-failed\\n'
  printf 'detail=%s\\n' "$(printf '%s\\n' "$cj_out" | grep -v '^$' | head -n 1 | cut -c 1-200)"
fi
exit 0
`;
}

export const JOBS_REMOTE_SCRIPT = buildJobsRemoteScript();

export function buildJobsScanInvocation({ server = {}, parsed = {}, knownHostsPath, platform = process.platform } = {}) {
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), JOBS_REMOTE_COMMAND],
    input: JOBS_REMOTE_SCRIPT,
    timeoutMs: JOBS_SCAN_TIMEOUT_MS,
    maxOutputBytes: JOBS_SCAN_MAX_OUT_BYTES,
  };
}

// ---- 按需回查（v2.51）：日期窗口 / 作业号，远端仍是常量 sh -s、脚本走 stdin ----

export const JOBS_LOOKUP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 作业号：48213 / 48213_7（数组任务）。查数组本体（48213）时 sacct 会列出全部任务。
export const JOBS_LOOKUP_ID_RE = /^\d{1,12}(?:_\d{1,9})?$/;

// 回查条件 → sacct 选择参数；不合法一律抛错（路由层已校验，这里是插进脚本前的最后一道）。
//   { kind: "job", job }         → -j <作业号>（sacct 对 -j 不加时间下限，记账里还在就查得到）
//   { kind: "range", from, to }  → -S <from>T00:00:00 -E <to>T23:59:59（远端本地时间；窗口内「存在过」的作业，
//                                   含之前提交、窗口内结束的；按结束日归段在本机 lookup.mjs 里做）
export function jobsLookupSelector(query = {}) {
  if (query.kind === "job" && JOBS_LOOKUP_ID_RE.test(String(query.job ?? ""))) return `-j ${query.job}`;
  if (query.kind === "range" && JOBS_LOOKUP_DATE_RE.test(String(query.from ?? "")) && JOBS_LOOKUP_DATE_RE.test(String(query.to ?? ""))) {
    return `-S ${query.from}T00:00:00 -E ${query.to}T23:59:59`;
  }
  throw new Error("invalid jobs lookup query");
}

export function buildJobsLookupInvocation({ server = {}, parsed = {}, knownHostsPath, query, platform = process.platform } = {}) {
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), JOBS_REMOTE_COMMAND],
    input: buildJobsRemoteScript(jobsLookupSelector(query)),
    timeoutMs: JOBS_SCAN_TIMEOUT_MS,
    maxOutputBytes: JOBS_SCAN_MAX_OUT_BYTES,
  };
}
