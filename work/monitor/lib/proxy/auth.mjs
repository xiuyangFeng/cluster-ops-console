// 代理口令（v2.62，设计稿 2026-10-07 §5.I / 2026-10-12 W4）：口令文件的校验，与 Proxy-Authorization 的判定。
// 纯函数，不碰 socket、不读盘；读盘与热重载在 ./policy-reload.mjs，拦截在 ./server.mjs。
//
// 为什么要它：反向端口监听在集群登录节点的 127.0.0.1，节点上任何账号都能连上来、经这台电脑出网。
// 口令每台安装一份，与模式一起存 <runtimeDir>/proxy-auth.json（0600，控制面 lib/egress/proxy-auth-store.mjs 写）：
//   { v: 1, mode: "off" | "observe" | "enforce", user: "cwb", token, previousToken?, previousUntil?, updatedAt }
//     off      不看这个头，行为与没有这项功能时完全相同（缺省；文件不存在也是它）
//     observe  全部放行，只记「带对了 / 没带 / 带错了」
//     enforce  CONNECT 与明文转发没带对的口令一律 407；/proxy-health 不受影响
//   换口令时旧口令留在 previousToken，previousUntil（毫秒时间戳）之前两个都接受。
//
// 两条底线：
//   - 代理进程里不留口令原文。校验成功即把口令换算成 sha256 摘要（buildAuthPolicy），请求来了比摘要；
//     日志、异常、策略对象里都没有原文可漏。原文只有控制面在「写到集群」「本机自测」时才读。
//   - 判定不泄露口令「接近正确」的程度。无论请求头是缺了、形状不对还是口令错了，都走同一次摘要与
//     同样两次常数时间比较（timingSafeEqual，定长 32 字节）；407 的字节对这几种情况完全相同。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PROXY_AUTH_FILE = "proxy-auth.json";
export const PROXY_AUTH_VERSION = 1;
// 用户名固定：它出现在集群侧的代理地址里（http://cwb:<口令>@127.0.0.1:<端口>），撤销与不一致检测按这个形状认。
export const PROXY_AUTH_USER = "cwb";
export const PROXY_AUTH_REALM = "cluster-workbench";
export const PROXY_AUTH_MODES = Object.freeze(["off", "observe", "enforce"]);
// 口令只用 [A-Za-z0-9]：放进代理地址的 userinfo、env.sh 的双引号、JSON 字符串都不需要转义。
// 22 个字符 ≈ 131 位（log2(62) ≈ 5.95），是「不少于 128 位」的下限；生成时用 32 个字符。
export const PROXY_AUTH_TOKEN_RE = /^[A-Za-z0-9]{22,128}$/;
// 正常的口令文件两三百字节；超过这个大小的不是我们写的，不解析。
export const PROXY_AUTH_FILE_MAX_BYTES = 4096;

// 407 的两种写法：CONNECT 走裸 socket（与同文件里 403 / 502 的写法一致，多一个质询头）；明文转发走 res.writeHead。
export const PROXY_AUTHENTICATE_VALUE = `Basic realm="${PROXY_AUTH_REALM}"`;
export const PROXY_AUTH_REQUIRED_HEADERS = Object.freeze({ "proxy-authenticate": PROXY_AUTHENTICATE_VALUE });
export const CONNECT_AUTH_REQUIRED_RESPONSE =
  `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${PROXY_AUTHENTICATE_VALUE}\r\nContent-Length: 0\r\n\r\n`;

// 关闭态。server.mjs 只看 mode：是 off（或策略里根本没有 auth）就一行都不多走。
export const AUTH_OFF = Object.freeze({ mode: "off", user: PROXY_AUTH_USER, current: null, previous: null, previousUntil: 0 });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isToken = (value) => typeof value === "string" && PROXY_AUTH_TOKEN_RE.test(value);

// 口令文件的内容校验（控制面写之前、代理读之后都过这一个函数，写出去的就是读得进来的）。
// → { ok: true, doc } | { ok: false, reason }。reason 是固定代号，绝不带文件内容——它会进日志。
// 认不得的多余字段忽略（以后加字段不必两边同时升级）；版本号不认识的整体不认。
export function validateProxyAuthDocument(value) {
  if (!isPlainObject(value)) return { ok: false, reason: "not-object" };
  if (value.v !== PROXY_AUTH_VERSION) return { ok: false, reason: "bad-version" };
  if (!PROXY_AUTH_MODES.includes(value.mode)) return { ok: false, reason: "bad-mode" };
  if (value.user !== PROXY_AUTH_USER) return { ok: false, reason: "bad-user" };
  // 关着的时候可以还没有口令（从没打开过）；打开了就必须有。
  const hasToken = value.token !== undefined && value.token !== null;
  if (hasToken ? !isToken(value.token) : value.mode !== "off") return { ok: false, reason: "bad-token" };
  const hasPrevious = value.previousToken !== undefined && value.previousToken !== null;
  if (hasPrevious) {
    if (!isToken(value.previousToken)) return { ok: false, reason: "bad-previous" };
    if (!Number.isFinite(value.previousUntil) || value.previousUntil < 0) return { ok: false, reason: "bad-previous" };
  }
  return {
    ok: true,
    doc: {
      v: PROXY_AUTH_VERSION,
      mode: value.mode,
      user: PROXY_AUTH_USER,
      token: hasToken ? value.token : null,
      previousToken: hasPrevious ? value.previousToken : null,
      previousUntil: hasPrevious ? value.previousUntil : 0,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    },
  };
}

// 「用户名:口令」的摘要。请求头解出来的也是这个形状的字节串，两边比摘要。
export function credentialDigest(user, token) {
  return createHash("sha256").update(`${user}:${token}`, "utf8").digest();
}

// 校验过的文档 → 代理用的策略（只有摘要，没有原文）。
export function buildAuthPolicy(doc) {
  if (!doc || doc.mode === "off" || !doc.token) return AUTH_OFF;
  return Object.freeze({
    mode: doc.mode,
    user: doc.user,
    current: credentialDigest(doc.user, doc.token),
    previous: doc.previousToken ? credentialDigest(doc.user, doc.previousToken) : null,
    previousUntil: doc.previousToken ? doc.previousUntil : 0,
  });
}

// 口令文件全文 → { ok: true, policy } | { ok: false, reason }。
export function parseProxyAuthFile(text) {
  const raw = String(text ?? "");
  if (Buffer.byteLength(raw, "utf8") > PROXY_AUTH_FILE_MAX_BYTES) return { ok: false, reason: "too-large" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  const checked = validateProxyAuthDocument(parsed);
  return checked.ok ? { ok: true, policy: buildAuthPolicy(checked.doc) } : checked;
}

// Proxy-Authorization 的值上限：正常是 "Basic " + 四十多个字符。超过的不解码。
const HEADER_VALUE_MAX = 1024;
// 只认 Basic。base64 两种字母表都收（Node 的解码器本来就都认），末尾填充可有可无。
const BASIC_RE = /^basic[ \t]+([A-Za-z0-9+/_-]+={0,2})$/i;
const EMPTY = Buffer.alloc(0);
// 没有上一个口令时拿它垫着比一次：进程内随机，谁也对不上，只为让两种情况走同样的步骤。
const NEVER_MATCHES = createHash("sha256").update(randomBytes(32)).digest();
// timingSafeEqual 两边长度不等会抛错；判定跑在每个请求的处理路径上，绝不能抛。策略里的摘要不是 32 字节
// （只可能是别处手搓的策略对象）时按「谁也对不上」处理。
const isDigest = (value) => Buffer.isBuffer(value) && value.length === NEVER_MATCHES.length;
const digestOrNever = (value) => (isDigest(value) ? value : NEVER_MATCHES);

function decodeBasic(value) {
  if (value.length > HEADER_VALUE_MAX) return null;
  const match = BASIC_RE.exec(value.trim());
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length > 0 ? decoded : null;
}

// 请求头里的 Proxy-Authorization → "ok" | "missing" | "bad"。auth 是 buildAuthPolicy 的非 off 结果。
//   missing  没有这个头（或是空的）
//   bad      有，但不是 Basic、解不出来，或口令不对（含已过期的上一个口令）
//   ok       当前口令，或还在有效期内的上一个口令
// 结论只用于计数与放行；对外的 407 不区分 missing 与 bad。
export function classifyProxyAuthorization(auth, headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== "string" || headerValue.trim() === "") return "missing";
  const presented = decodeBasic(headerValue);
  const digest = createHash("sha256").update(presented ?? EMPTY).digest();
  const matchesCurrent = timingSafeEqual(digest, digestOrNever(auth?.current));
  const matchesPrevious = timingSafeEqual(digest, digestOrNever(auth?.previous));
  const previousLive = isDigest(auth?.previous) && nowMs < auth.previousUntil;
  return presented !== null && (matchesCurrent || (matchesPrevious && previousLive)) ? "ok" : "bad";
}
