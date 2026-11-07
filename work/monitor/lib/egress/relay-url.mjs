// 中转站 base URL 的出网归类（v2.54，供设置页白名单输入与第 2 期登录引导共用）。
// 本机代理的策略是"公网 443 默认放行、私网一律拒、其余端口要白名单"，所以一个 base URL 落在哪类
// 决定了要不要动白名单：
//   none              https 且端口 443：零配置
//   allowlist         公网主机、非 443 端口（含 http:// 的 80）：把 entry（host:port）加进个人白名单
//   direct-candidate  内网 / 校内地址：本机代理不会放行，应从集群直连（写进 NO_PROXY，不走隧道）
//   invalid           不是 http(s) URL
// warnings：["plaintext-http"]——http:// 时本机到中转站这一段（含 API key）是明文。
// 不放在 lib/proxy/：那里的模块都要进代理的热更新指纹闭包，而这是控制面专用的纯函数。
import { isPlausibleHost, isPrivateTarget } from "../proxy/address.mjs";

// 只在内网解析的常见后缀与单标签主机名（没有点）：大概率是校内 / 局域网服务，归 direct-candidate。
const INTERNAL_SUFFIXES = [".local", ".lan", ".internal", ".intranet", ".corp", ".home.arpa"];

function isLikelyInternalHost(host) {
  if (isPrivateTarget(host)) return true;
  const h = host.toLowerCase();
  if (!h.includes(".") && !h.includes(":")) return true;
  return INTERNAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

export function classifyRelayBaseUrl(value) {
  const invalid = (reason) => ({ action: "invalid", reason, warnings: [] });
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return invalid("empty");
  let url;
  try {
    url = new URL(text);
  } catch {
    return invalid("not-a-url");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return invalid("unsupported-scheme");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || !isPlausibleHost(host)) return invalid("bad-host");
  const port = Number(url.port || (scheme === "https" ? 443 : 80));
  const warnings = scheme === "http" ? ["plaintext-http"] : [];
  const base = { scheme, host, port, warnings };
  if (isLikelyInternalHost(host)) return { action: "direct-candidate", ...base };
  if (scheme === "https" && port === 443) return { action: "none", ...base };
  // entry 与白名单归一化同形（host 小写 + 数字端口，IPv6 不带中括号），可直接写进个人层。
  return { action: "allowlist", entry: `${host}:${port}`, ...base };
}
