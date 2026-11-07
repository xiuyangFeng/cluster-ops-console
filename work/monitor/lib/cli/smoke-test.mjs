// 测试对话（v2.89）：接入引导最后一步，在集群上用同事平时的方式（受管 env.sh：代理 + keys/*.env）真的发一条
// 很短的请求，确认「隧道 → 本机 → 官方 / 中转站」这条路、Key、额度与模型权限都是通的。
//   codex：`codex exec --skip-git-repo-check --sandbox read-only --color never "<提示>"`（只读沙箱，不改任何文件；
//          最终回复在 stdout，过程在 stderr）
//   claude：`claude -p "<提示>" --output-format text --max-turns 1`
// 只在空的临时目录里跑，跑完删掉；有 timeout 命令时限 90 秒（前端为这个接口把请求超时放宽到 3 分钟）。会消耗一次很小的调用额度，所以由用户主动点、可跳过。
//
// 判定：stdout 里出现约定的回复词（提示词本身只在命令行参数里，不会回显到 stdout）= 通过；否则按 stderr/stdout
// 的尾巴归类成几种常见原因给出下一步。远端输出一律当不可信数据：只取 key=value 行，回本机后再把像密钥的串打码。
import { parseRemoteKv, REMOTE_ENV_FILE } from "./remote-scripts.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export const SMOKE_TOKEN = "WORKBENCH-OK";
export const SMOKE_PROMPT = `This is a connectivity test. Reply with exactly ${SMOKE_TOKEN} and nothing else.`;
export const SMOKE_TIMEOUT_SEC = 90;
// SSH 本身的时限：命令时限 + 连接与清理余量。
export const SMOKE_SSH_TIMEOUT_MS = (SMOKE_TIMEOUT_SEC + 30) * 1000;
const MAX_TAIL_LINES = 12;

const COMMANDS = Object.freeze({
  codex: `codex exec --skip-git-repo-check --sandbox read-only --color never "${SMOKE_PROMPT}"`,
  claude: `claude -p "${SMOKE_PROMPT}" --output-format text --max-turns 1`,
});

export function buildSmokeTestCommand(cli) {
  const run = COMMANDS[cli];
  if (!run) throw Object.assign(new Error(`未知 CLI: ${cli}`), { code: "EARG" });
  const bin = cli === "codex" ? "codex" : "claude";
  return wrapSh([
    "echo \"v=1\"",
    `if [ -f "${REMOTE_ENV_FILE}" ]; then echo "envsh=1"; . "${REMOTE_ENV_FILE}"; else echo "envsh=0"; fi`,
    "PATH=\"$HOME/.local/bin:$PATH\"; export PATH",
    `if ! command -v ${bin} >/dev/null 2>&1; then echo "smoke=missing"; echo "end=1"; exit 0; fi`,
    "T=$(mktemp -d 2>/dev/null) || T=",
    "if [ -z \"$T\" ]; then echo \"smoke=tmp\"; echo \"end=1\"; exit 0; fi",
    "cd \"$T\" || { echo \"smoke=tmp\"; echo \"end=1\"; exit 0; }",
    `if command -v timeout >/dev/null 2>&1; then TO="timeout ${SMOKE_TIMEOUT_SEC}"; else TO=; fi`,
    "s0=$(date +%s)",
    `$TO ${run} > "$T/out" 2> "$T/err" < /dev/null; rc=$?`,
    "echo \"rc=$rc\"",
    "echo \"secs=$(( $(date +%s) - s0 ))\"",
    `if grep -q "${SMOKE_TOKEN}" "$T/out"; then echo "smoke=ok"; else echo "smoke=fail"; fi`,
    "head -n 3 \"$T/out\" | tr -cd '[:print:]\\n' | cut -c1-200 | sed 's/^/reply=/'",
    `cat "$T/err" "$T/out" | tail -n ${MAX_TAIL_LINES} | tr -cd '[:print:]\\n' | cut -c1-240 | sed 's/^/tail=/'`,
    "rm -f \"$T/out\" \"$T/err\"",
    "cd /",
    "rmdir \"$T\" 2>/dev/null",
    "echo \"end=1\"",
  ]);
}

// 像密钥 / 令牌的串打码（远端输出偶尔会回显请求头或配置）。
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/\b(sk-[A-Za-z0-9]{0,8}-?)[A-Za-z0-9_-]{8,}/g, "$1…")
    .replace(/\b(Bearer\s+)\S+/gi, "$1…")
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, "…");
}

// 常见失败 → { code, message, hint }。顺序有讲究：先认认证 / 额度 / 模型，再认网络（网络错误的文案里也常带 4xx 字样以外的词）。
const RULES = [
  { code: "auth", re: /\b401\b|unauthori[sz]ed|invalid[ _-]?(api[ _-]?key|x-api-key|token|authentication)|incorrect api key|authentication[ _-]?(error|failed)/i, message: "API Key 无效或已过期", hint: "核对 Key 是否抄全、是否属于这个中转站；改好后在上面「选择登录方式」里重新保存。" },
  { code: "quota", re: /\b429\b|rate[ _-]?limit|quota|insufficient|billing|balance|余额|额度|exceeded/i, message: "额度不足或被限流", hint: "到服务商后台看余额 / 套餐；限流的话过一会再测。" },
  { code: "forbidden", re: /\b403\b|forbidden|permission denied for model|not allowed/i, message: "这个 Key 没有权限", hint: "Key 可能没开通该模型或被限制了来源 IP，问一下发 Key 的人。" },
  { code: "model", re: /model[^\n]{0,60}(not[ _-]?found|does not exist|not supported|unavailable|invalid)|unknown model|no such model|\b404\b/i, message: "模型不存在或中转站不支持", hint: "检查配置里的模型名，或换一个中转站支持的模型。" },
  { code: "login", re: /not logged in|please (run|use) .{0,20}login|login required|run \/login|no api key/i, message: "还没有登录或没配置 Key", hint: "回到上面「选择登录方式」，用中转站地址 + Key 或官方 API Key 保存一次。" },
  { code: "network", re: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|could not resolve|proxy|tunnel|connection (refused|reset|error|closed)|stream disconnected|network|timed? ?out|502|503|504/i, message: "连不到服务", hint: "确认这台电脑联网、工作台开着、隧道是绿的；中转站在校外时要经隧道，校内的要能被集群直连。" },
];

export function classifySmokeOutput(text) {
  for (const rule of RULES) if (rule.re.test(text)) return { code: rule.code, message: rule.message, hint: rule.hint };
  return { code: "unknown", message: "没有收到预期的回复", hint: "看下面的输出尾巴；拿不准就截图发给维护者。" };
}

// 远端输出 → { ok, code, message, hint, reply, tail, seconds, envSh }。
export function parseSmokeTest(cli, res) {
  const { complete, values, lists } = parseRemoteKv(res?.stdout);
  const reply = redactSecrets((lists.reply || []).join("\n")).trim().slice(0, 400);
  const tail = (lists.tail || []).map(redactSecrets);
  const seconds = /^\d{1,6}$/.test(values.secs || "") ? Number(values.secs) : null;
  const base = { cli, reply, tail, seconds, envSh: values.envsh === "1" };
  if (!complete) {
    return { ...base, ok: false, code: "ssh", message: res?.timedOut ? "等待超时（SSH 没有及时返回）" : "连不上服务器", hint: "确认能连上集群后再试。" };
  }
  if (values.smoke === "ok") return { ...base, ok: true, code: "ok", message: `收到回复，${cli === "codex" ? "Codex" : "Claude Code"} 可以正常使用`, hint: "" };
  if (values.smoke === "missing") return { ...base, ok: false, code: "missing", message: "集群上找不到这个命令", hint: "先在上面「选择并安装工具」里装好。" };
  if (values.smoke === "tmp") return { ...base, ok: false, code: "tmp", message: "集群上建不了临时目录", hint: "可能 /tmp 满了，联系管理员。" };
  if (values.rc === "124") return { ...base, ok: false, code: "timeout", message: `${SMOKE_TIMEOUT_SEC} 秒内没有回复`, hint: "隧道可能很慢或中转站卡住了，稍后再测；一直这样就看隧道状态。" };
  const judged = classifySmokeOutput(`${tail.join("\n")}\n${reply}`);
  const envHint = base.envSh ? "" : "（集群上没有受管 env.sh，命令没有经隧道出网：先在引导里完成「写集群侧配置」。）";
  return { ...base, ok: false, ...judged, hint: `${judged.hint}${envHint}` };
}
