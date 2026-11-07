// 识别本机"系统代理"（出网方式 system 用，v2.54）：很多同事的代理软件只开"系统代理"而不开
// TUN——浏览器能上网，本机代理直接拨号却不通。这里读出系统里登记的 HTTP(S) 代理当上游。
//   macOS   `scutil --proxy`（只看顶层字典，HTTPS 优先，再 HTTP）
//   Windows `reg query HKCU\...\Internet Settings` 的 ProxyEnable / ProxyServer / AutoConfigURL
//           （ProxyServer 支持 "host:port" 与 "http=…;https=…;socks=…" 分协议写法）
//   其余    https_proxy / HTTPS_PROXY / http_proxy / HTTP_PROXY 环境变量
// 只取 HTTP 代理当上游；SOCKS 与 PAC 只报告不使用（首版上游只支持 HTTP CONNECT）。
// 解析是纯函数；取数经可注入 exec，结果缓存 30 秒（system 模式下代理每 30 秒复查一次）。
import { execFile } from "node:child_process";

import { isPlausibleHost, isValidPort } from "./address.mjs";

export const SYSTEM_PROXY_CACHE_MS = 30_000;
// scutil / reg 平时十几毫秒返回；代理启动时要等首次识别完才监听，上限压在 supervisor 的
// 4 秒启动宽限之内，卡住就按"没识别到"先直连，30 秒后的复查再纠正。
const EXEC_TIMEOUT_MS = 2000;
export const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

const EMPTY = Object.freeze({ proxy: null, socks: null, pac: null });

// "host:port" / "http://host:port/" / "[::1]:7890" → { host, port }；缺端口取 defaultPort
// （Windows 的 ProxyServer 不写端口时按 80）。主机名形态不对或端口非法返回 null。
export function parseHostPort(text, { defaultPort = null } = {}) {
  const v = String(text || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  if (!v || /[\s/@]/.test(v)) return null;
  let host;
  let port;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end === -1) return null;
    host = v.slice(1, end);
    port = v.slice(end + 1).replace(/^:/, "");
  } else {
    const idx = v.lastIndexOf(":");
    host = idx === -1 ? v : v.slice(0, idx);
    port = idx === -1 ? "" : v.slice(idx + 1);
  }
  const h = host.toLowerCase();
  if (!port && defaultPort) port = String(defaultPort);
  if (!isPlausibleHost(h) || !isValidPort(port)) return null;
  return { host: h, port: Number(port) };
}

function httpProxy(hostPort, scheme) {
  if (!hostPort) return null;
  const { host, port } = hostPort;
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  return { host, port, url: `http://${authority}`, scheme };
}

// macOS `scutil --proxy` 输出 → { proxy, socks, pac }。只收顶层（深度 1）的 "键 : 值"，
// 嵌套的 ExceptionsList 数组与 __SCOPED__ 分接口字典一律跳过。
export function parseScutilProxy(text) {
  const top = {};
  let depth = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kv = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (depth === 1 && kv && !kv[2].endsWith("{")) top[kv[1]] = kv[2].trim();
    if (line.endsWith("{")) depth += 1;
    else if (line === "}") depth -= 1;
  }
  const enabled = (key) => top[key] === "1";
  const pick = (prefix) => (enabled(`${prefix}Enable`) && top[`${prefix}Proxy`]
    ? parseHostPort(`${top[`${prefix}Proxy`]}:${top[`${prefix}Port`] || ""}`)
    : null);
  const https = pick("HTTPS");
  const http = pick("HTTP");
  return {
    proxy: https ? httpProxy(https, "https") : httpProxy(http, "http"),
    socks: pick("SOCKS"),
    pac: enabled("ProxyAutoConfigEnable") && top.ProxyAutoConfigURLString ? top.ProxyAutoConfigURLString : null,
  };
}

// Windows `reg query "<Internet Settings>"` 输出 → { proxy, socks, pac }。
// 值行形如 "    ProxyServer    REG_SZ    127.0.0.1:7890"（名字里可以有空格，如 "User Agent"），
// 按 REG_ 类型列切分；子键行（HKEY_ 开头）与空行跳过。ProxyEnable=0 时 ProxyServer 不生效，
// AutoConfigURL 不受 ProxyEnable 控制，单独报告。
export function parseWindowsInternetSettings(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.match(/^\s+(.+?)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/);
    if (m) values[m[1].trim()] = { type: m[2], data: (m[3] || "").trim() };
  }
  const enableRaw = values.ProxyEnable?.data || "";
  const enabled = /^0x0*1$/i.test(enableRaw) || enableRaw === "1";
  const pac = values.AutoConfigURL?.data || null;
  const server = values.ProxyServer?.data || "";
  if (!enabled || !server) return { proxy: null, socks: null, pac };
  // 分协议写法："http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"；
  // 不带 "=" 的单值写法对所有协议生效。
  if (server.includes("=")) {
    const byProto = {};
    for (const part of server.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      byProto[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
    }
    const https = parseHostPort(byProto.https, { defaultPort: 80 });
    const http = parseHostPort(byProto.http, { defaultPort: 80 });
    return {
      proxy: https ? httpProxy(https, "https") : httpProxy(http, "http"),
      socks: parseHostPort(byProto.socks, { defaultPort: 1080 }),
      pac,
    };
  }
  // 单值写法也可能带 scheme（部分工具写 "socks5://…"）：socks 开头的只报告。
  if (/^socks/i.test(server)) return { proxy: null, socks: parseHostPort(server, { defaultPort: 1080 }), pac };
  return { proxy: httpProxy(parseHostPort(server, { defaultPort: 80 }), "http"), socks: null, pac };
}

// 环境变量（Linux 等其余平台）→ { proxy, socks, pac }。小写优先（curl 惯例）；
// 只认 http:// 代理当上游，socks*:// 只报告。
export function parseProxyEnv(env = {}) {
  const read = (...names) => names.map((n) => env[n]).find((v) => typeof v === "string" && v.trim());
  const candidates = [["https", read("https_proxy", "HTTPS_PROXY")], ["http", read("http_proxy", "HTTP_PROXY")]];
  let proxy = null;
  let socks = null;
  for (const [scheme, value] of candidates) {
    if (!value) continue;
    const v = value.trim();
    if (/^socks/i.test(v)) {
      socks ||= parseHostPort(v, { defaultPort: 1080 });
      continue;
    }
    if (/^https:\/\//i.test(v)) continue; // HTTPS 上游首版不支持
    proxy ||= httpProxy(parseHostPort(v, { defaultPort: 80 }), scheme);
  }
  const all = read("all_proxy", "ALL_PROXY");
  if (!socks && all && /^socks/i.test(all.trim())) socks = parseHostPort(all, { defaultPort: 1080 });
  return { proxy, socks, pac: null };
}

// 默认取数：execFile + 超时，永不 reject（失败给 { stdout:"", error }）。
function defaultExec(file, args, { timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
        resolve({ stdout: String(stdout || ""), error: err ? (err.code || err.message || "exec failed") : null });
      });
    } catch (err) {
      resolve({ stdout: "", error: err?.code || err?.message || "exec failed" });
    }
  });
}

// 识别器：detect() 返回 { source, proxy, socks, pac, error, detectedAt }，30 秒内复用上次结果
// （force:true 强制重查）；并发调用合并成一次取数。任何失败都折算成"没识别到"，不抛。
export function createSystemProxyDetector({
  platform = process.platform,
  env = process.env,
  exec = defaultExec,
  now = Date.now,
  ttlMs = SYSTEM_PROXY_CACHE_MS,
} = {}) {
  let cached = null; // { at, value }
  let inflight = null;

  async function read() {
    if (platform === "darwin") {
      const { stdout, error } = await exec("/usr/sbin/scutil", ["--proxy"], { timeoutMs: EXEC_TIMEOUT_MS });
      return { source: "scutil", ...(error && !stdout ? { ...EMPTY, error: String(error) } : { ...parseScutilProxy(stdout), error: null }) };
    }
    if (platform === "win32") {
      const { stdout, error } = await exec("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS_KEY], { timeoutMs: EXEC_TIMEOUT_MS });
      return { source: "registry", ...(error && !stdout ? { ...EMPTY, error: String(error) } : { ...parseWindowsInternetSettings(stdout), error: null }) };
    }
    return { source: "env", ...parseProxyEnv(env), error: null };
  }

  async function detect({ force = false } = {}) {
    if (!force && cached && now() - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      let value;
      try {
        value = await read();
      } catch (err) {
        value = { source: platform === "darwin" ? "scutil" : platform === "win32" ? "registry" : "env", ...EMPTY, error: err?.message || String(err) };
      }
      value = { ...value, detectedAt: new Date(now()).toISOString() };
      cached = { at: now(), value };
      return value;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { detect };
}
