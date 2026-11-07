// 代理用到的地址纯判定（叶子模块，只依赖 node:net）：CONNECT authority 解析、端口校验、
// 私网/loopback 字面量判定、白名单条目解析、上游代理地址（http://host:port）解析。
//
// 刻意保持叶子：config-loader.mjs 也 import 这里做个人层白名单 / 出网地址的写入校验，而
// config-loader 同时在 supervisor 的热更新指纹闭包里——若改从 target-policy.mjs / server.mjs
// 引入，代理策略的每次改动都会连带 supervisor 走一次平滑交接。只放稳定的纯函数，别在这里
// 引入代理实现。
import net from "node:net";

// 解析 CONNECT authority（`req.url`，形如 `host:port`）。
// 支持 IPv6 字面量的中括号形式（`[::1]:443`），否则从最后一个 ':' 切分，
// 无端口时按历史行为默认 443。解析不出合法结构时返回 null（调用方应回 400）。
export function parseConnectAuthority(url) {
  if (!url) return null;
  if (url.startsWith("[")) {
    const closeIdx = url.indexOf("]");
    if (closeIdx === -1) return null;
    const host = url.slice(1, closeIdx);
    const rest = url.slice(closeIdx + 1);
    if (!host) return null;
    if (rest === "") return { host, port: "443" };
    if (!rest.startsWith(":")) return null; // "]" 后除端口外的多余字符视为畸形
    return { host, port: rest.slice(1) };
  }
  const idx = url.lastIndexOf(":");
  if (idx === -1) return { host: url, port: "443" };
  const host = url.slice(0, idx);
  const port = url.slice(idx + 1);
  if (!host) return null;
  return { host, port };
}

// 端口必须是 1..65535 的十进制整数，否则一律判无效（拒绝 dial，绝不让
// net.connect 收到越界/非数字端口——那会同步抛 ERR_SOCKET_BAD_PORT 崩全进程）。
export function isValidPort(portStr) {
  if (typeof portStr !== "string" || !/^\d+$/.test(portStr)) return false;
  const p = Number(portStr);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

// 判定 host 是否为 loopback/私网段/CGNAT/link-local 字面量（IPv4/IPv6）或 "localhost"。
// 这里只识别字面量地址与固定主机名，是"连 lookup 都不必发起"的快速拒绝路径；
// 主机名经 DNS 解析出的地址（rebind 类穿透，如 localtest.me 公共解析到 127.0.0.1）
// 由 target-policy.mjs 的 createRebindGuardedLookup 在拨号前逐地址复检兜底。
export function isPrivateTarget(host) {
  if (!host) return true; // 保守：拿不到 host 一律当不安全
  const h = String(host).replace(/^\[|\]$/g, "").split("%")[0]; // 去中括号与 IPv6 zone id
  if (h.toLowerCase() === "localhost") return true;

  if (net.isIP(h) === 4) {
    const parts = h.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
    const [a, b] = parts;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8，防御性
    return false;
  }

  if (net.isIP(h) === 6) {
    const groups = ipv6Groups(h.toLowerCase());
    if (!groups) return true; // 保守：合法 IPv6 却展不开（不该发生），按不安全处理
    // IPv4-mapped / -compatible（::ffff:0:0/96 与 ::/96，含 :: 与 ::1）：取末 32 位重建 IPv4 走 v4 判定。
    // 各种写法一视同仁——::ffff:7f00:0001、::ffff:127.0.0.1，以及非压缩 / 混合写法
    // 0:0:0:0:0:ffff:127.0.0.1、0::ffff:127.0.0.1（v2.54 终审前这两种会漏判，CONNECT 直打 Mac 环回）。
    const v4 = embeddedIPv4(groups);
    if (v4) return isPrivateTarget(v4);
    const firstHextet = groups[0];
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 ULA
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
    return false;
  }

  // inet_aton 数字简写（127.1、2130706433、0x7f000001）：getaddrinfo 与上游代理都会把它当 IPv4。
  // 直连时解析闸门也能拦下，但上游模式在本机 DNS 整体不可用时不做本地解析，必须在字面量这一关拦住。
  const numeric = parseNumericIPv4(h.toLowerCase());
  if (numeric) return isPrivateTarget(numeric);

  return false; // 普通主机名：非私网字面量，交给 allowTarget 的端口策略把关
}

// 展开压缩形式的 IPv6 地址为 8 组十六进制字符串（不做完整合法性校验；末尾点分 IPv4 由 ipv6Groups 先换算）。
function expandIPv6Groups(addr) {
  if (addr.includes("::")) {
    const [head, tail] = addr.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail ? tail.split(":").filter(Boolean) : [];
    const missing = Math.max(0, 8 - headParts.length - tailParts.length);
    return [...headParts, ...new Array(missing).fill("0"), ...tailParts];
  }
  return addr.split(":");
}

// 合法 IPv6 字面量（调用方已用 net.isIP 确认）→ 8 个 16 位整数；支持 :: 压缩与末尾点分 IPv4 的混合写法。
// 形态对不上时返回 null。
function ipv6Groups(addr) {
  let text = addr;
  const dotted = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const groups = expandIPv6Groups(text).map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

// IPv4-mapped（::ffff:a.b.c.d）/ -compatible（::a.b.c.d，含 :: 与 ::1）→ 内嵌的点分 IPv4；否则 null。
function embeddedIPv4(groups) {
  if (!groups.slice(0, 5).every((g) => g === 0) || (groups[5] !== 0xffff && groups[5] !== 0)) return null;
  const [g6, g7] = [groups[6], groups[7]];
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

// inet_aton 风格的数字 IPv4 简写（127.1、2130706433、0x7f000001、0177.0.0.1）→ 点分四段；不是返回 null。
// getaddrinfo 会把这类"主机名"直接当 IPv4 地址解释，net.isIP 却不认，字面量判定得自己认。
function parseNumericIPv4(host) {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    if (/^0x[0-9a-f]+$/i.test(part)) nums.push(parseInt(part.slice(2), 16));
    else if (/^0[0-7]*$/.test(part)) nums.push(parseInt(part, 8));
    else if (/^[1-9]\d*$/.test(part)) nums.push(Number(part));
    else return null;
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255) || !Number.isSafeInteger(last) || last >= 2 ** (8 * (4 - nums.length))) return null;
  const bytes = [...nums];
  for (let i = 3 - nums.length; i >= 0; i -= 1) bytes.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return bytes.join(".");
}

const isLoopbackOrUnspecifiedV4 = (v4) => v4.startsWith("127.") || v4.startsWith("0.");

// 指向本机自己的地址：环回（127/8、::1）、"本机任意地址"（0.0.0.0/8、::——作为目的地址时内核
// 会连到本机）、它们的 IPv4-mapped 与非压缩 / 混合写法、inet_aton 数字简写（127.1 等），以及
// localhost（含结尾点）。只用于"上游是不是本代理自己"的环路判定（policy-reload 加载策略、
// dialViaUpstream 拨号前、控制面保存手动地址时）。写法再怎么绕过这里，拨号时还有落点复检兜底
// （upstream.mjs 的 landedOnSelf）。
export function isLoopbackHost(host) {
  const h = String(host || "").trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "localhost.") return true;
  const family = net.isIP(h);
  if (family === 4) return isLoopbackOrUnspecifiedV4(h);
  if (family === 6) {
    const groups = ipv6Groups(h);
    if (!groups) return false;
    const v4 = embeddedIPv4(groups);
    if (!v4) return false;
    // IPv4-mapped（::ffff:x）按 IPv4 判；IPv4-compatible（::x，已废弃、内核不按 IPv4 路由）只认
    // ::（未指定）、::1（环回）与内嵌 127/8，免得把 ::2 这类普通地址也算成"自己"。
    if (groups[5] === 0xffff) return isLoopbackOrUnspecifiedV4(v4);
    return v4 === "0.0.0.0" || v4 === "0.0.0.1" || v4.startsWith("127.");
  }
  const numeric = parseNumericIPv4(h);
  return numeric ? isLoopbackOrUnspecifiedV4(numeric) : false;
}

// 主机名形态校验（写入口径，比读取严格）：IPv4 / IPv6 字面量，或由字母数字、连字符、下划线
// 组成的点分标签。挡住空白、引号、路径等明显不是主机名的输入。
const HOST_LABEL_RE = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/i;
export function isPlausibleHost(host) {
  const h = String(host || "");
  if (!h || h.length > 253) return false;
  if (net.isIP(h)) return true;
  return h.split(".").every((label) => HOST_LABEL_RE.test(label));
}

// 白名单条目（"host:port"，端口必须显式写出）→ { host, port, entry } 或 { error }。
// error："type"（不是字符串）/ "format"（缺端口、端口非法、空 host）/ "private"（私网/loopback
// 字面量——isPrivateTarget 拦截优先于白名单，写进去也永远不会放行）。
// 复用 CONNECT authority 解析器（支持 [::1]:9443 形态），但 parseConnectAuthority 缺端口时默认 443，
// 而白名单专为非 443 端口存在，缺端口按畸形处理。entry 归一化为 host 小写 + 数字端口，与
// makeDefaultAllowTarget 的查表键同一形态。
export function parseAllowlistEntry(raw) {
  if (typeof raw !== "string") return { error: "type" };
  const trimmed = raw.trim();
  const authority = parseConnectAuthority(trimmed);
  const hasExplicitPort = trimmed.includes(":") && (!trimmed.startsWith("[") || /\]:\d/.test(trimmed));
  if (!authority?.host || !hasExplicitPort || !isValidPort(authority.port)) return { error: "format" };
  if (isPrivateTarget(authority.host)) return { error: "private" };
  const host = authority.host.toLowerCase();
  const port = Number(authority.port);
  return { host, port, entry: `${host}:${port}` };
}

// 上游 HTTP 代理地址：只接受 `http://host:port`（端口必须显式，可带结尾 "/"）。
// 不接受 https / socks 上游、账号密码、路径与查询串——首版上游只支持 HTTP CONNECT。
// 上游通常就在本机或局域网（Clash 的 127.0.0.1:7890），所以这里不做私网拦截。
// 返回 { host, port, url }（url 为归一化形态），不合法返回 null。
export function parseHttpProxyUrl(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^http:\/\/(\[[0-9a-fA-F:.]+\]|[^/:@?#\s[\]]+):(\d{1,5})\/?$/i);
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, "").toLowerCase();
  if (m[1].startsWith("[") ? net.isIP(host) !== 6 : !isPlausibleHost(host)) return null;
  if (!isValidPort(m[2])) return null;
  const port = Number(m[2]);
  return { host, port, url: `http://${formatAuthority(host, port)}` };
}

// host + port → authority 串（IPv6 字面量加中括号）。
export function formatAuthority(host, port) {
  const h = String(host);
  return `${net.isIP(h) === 6 ? `[${h}]` : h}:${port}`;
}
