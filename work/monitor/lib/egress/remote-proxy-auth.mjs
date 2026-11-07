// 工作台自己发到集群、要经反向端口出网的命令怎么带代理口令（v2.62，纯函数）。
//
// 铁律：口令不出现在任何命令行里。集群的 /proc 没有 hidepid，节点上任何账号都能用 ps 看到别人进程的
// 完整命令行——`ssh 主机 '命令'` 里的命令文本、`sh -c '…'` 的参数、`curl -x http://用户:口令@…`、
// `VAR=值 命令` 这种前缀，全在里面；而要防的正是这些人。进程的环境变量（/proc/<pid>/environ）与标准输入
// 只有本人读得到，所以口令只走这两条路：
//
//   curl          命令行照旧只有 `-x http://127.0.0.1:<端口>`，另加 `-K -`；口令作为一行 curl 配置
//                 （proxy-user = "用户:口令"）经标准输入送达。-x 仍在命令行上，所以对方 ~/.curlrc 里写的
//                 代理地址盖不过它。没给标准输入时 -K - 读到空文件，等于没写。
//   其它命令      （codex doctor 这类靠环境变量找代理的）口令作为标准输入的第一行送达，远端 shell 用 read
//                 读进变量、拼成带口令的代理地址，再以环境变量交给子进程。命令文本里只有变量名。
//   sh -s 的脚本  脚本本身就是标准输入：在脚本正文前面加一行赋值（见 withProxyAuthPrelude）。
//
// 这里的每个函数在「没有口令」（credential 为 null：口令模式是关，或还没生成）时都返回与以前逐字相同的
// 命令、不带标准输入——关着的时候工作台发到集群的每一条命令都没有变化。
import { PROXY_AUTH_TOKEN_RE, PROXY_AUTH_USER } from "../proxy/auth.mjs";
import { isPort } from "../validators.mjs";

// 能安全拼进上面那几种写法的口令：固定用户名 + [A-Za-z0-9] 的口令，不含任何需要转义的字符。
export function isProxyCredential(credential) {
  return Boolean(credential) && credential.user === PROXY_AUTH_USER && typeof credential.password === "string" && PROXY_AUTH_TOKEN_RE.test(credential.password);
}

const usable = (credential) => (isProxyCredential(credential) ? credential : null);

// ---- curl ----

export const CURL_STDIN_CONFIG_FLAG = "-K -";

// curl 的标准输入内容（一行配置）；没有口令时为 null（调用方不给标准输入）。
export function curlProxyAuthInput(credential) {
  const cred = usable(credential);
  return cred ? `proxy-user = "${cred.user}:${cred.password}"\n` : null;
}

// 给一条 curl 命令补上「从标准输入读口令」。只认两种我们自己写的形状——命令以 curl 开头，且带着
// `-x http://127.0.0.1:<这个端口>`——认不出来的原样返回（{ command, input: null }），不去猜别人写的命令。
// → { command, input, applied }
export function curlWithProxyAuth(command, { port, credential } = {}) {
  const cred = usable(credential);
  const text = String(command ?? "");
  const proxyFlag = `-x http://127.0.0.1:${Number(port)}`;
  const recognizable = isPort(port) && /^\s*curl\s/.test(text) && new RegExp(`(^|\\s)${proxyFlag.replaceAll(".", "\\.")}(\\s|$)`).test(text) && !/(^|\s)-K\s/.test(text);
  if (!cred || !recognizable) return { command: text, input: null, applied: false };
  return { command: text.replace(proxyFlag, `${proxyFlag} ${CURL_STDIN_CONFIG_FLAG}`), input: curlProxyAuthInput(cred), applied: true };
}

// ---- 靠环境变量找代理的命令 ----

const BASE_NO_PROXY = "localhost,127.0.0.1,::1";

// 没有口令时的环境变量前缀：与 lib/proxy-config.mjs 的 tunnelProxyEnv 逐字相同（那边的测试钉着它）。
function plainEnvPrefix(port, keys) {
  const p = `http://127.0.0.1:${port}`;
  return `${keys.map((key) => `${key}=${p}`).join(" ")} `;
}

// 远端命令的代理环境变量：
//   { prelude, prefix, input }
//   prelude  放在整条命令最前面的片段（读标准输入第一行、拼出代理地址）；没有口令时为空串
//   prefix   紧贴在要执行的命令前面的 `VAR=值 ` 前缀
//   input    标准输入内容（口令一行）；没有口令时为 null
// keys：要设哪些变量（顺序即输出顺序）；noProxy 为真时再带上 NO_PROXY。
// 要求对方登录 shell 是 sh 系（bash / zsh / dash）——这些命令本来就是 `VAR=值 命令` 的写法，前提没变。
export function remoteProxyEnv(port, { credential = null, keys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"], noProxy = true } = {}) {
  if (!isPort(port)) throw new Error(`invalid proxy port: ${port}`);
  const tail = noProxy ? `NO_PROXY=${BASE_NO_PROXY} ` : "";
  const cred = usable(credential);
  if (!cred) return { prelude: "", prefix: `${plainEnvPrefix(port, keys)}${tail}`, input: null };
  return {
    // 读不到（标准输入是空的）时变量为空，拼出来的地址口令为空，代理按「带错」处理——不会卡住，也不会漏。
    prelude: `IFS= read -r __cwb_t || true; __cwb_p="http://${cred.user}:\${__cwb_t}@127.0.0.1:${port}"; unset __cwb_t; `,
    prefix: `${keys.map((key) => `${key}="$__cwb_p"`).join(" ")} ${tail}`,
    input: `${cred.password}\n`,
  };
}

// ---- 经标准输入送达的脚本（sh -s） ----

// 脚本里读这个变量名（remote/cli-probe.sh）。值是「用户:口令」，脚本那边还会再校验一次字符。
export const SCRIPT_PROXY_AUTH_VAR = "CT_PROXY_AUTH";

// 在脚本正文前面加一行赋值。没有口令时原样返回脚本。
export function withProxyAuthPrelude(script, credential) {
  const cred = usable(credential);
  if (!cred) return script;
  return `${SCRIPT_PROXY_AUTH_VAR}='${cred.user}:${cred.password}'\n${script}`;
}
