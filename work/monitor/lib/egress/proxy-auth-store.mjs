// 代理口令的本机存储（v2.62，控制面）：<runtimeDir>/proxy-auth.json 的读与写。
//
// 这份文件是口令的唯一副本：0600，不进钥匙串（避免 ad-hoc 签名的弹框）、不进 config.local.json、
// 不出现在任何接口响应、日志、报告里。代理进程只读它（lib/proxy/policy-reload.mjs，约 2 秒内热载）；
// 这里是唯一的写入方。写法是临时文件 + 改名：代理永远读不到半截文件。
//
// 口令原文只从 getCredential() / read() 出去，只有三处会用：本机经代理的自测带上它、把它写到集群、
// 工作台自己发到集群的探测经标准输入带上它。其余代码拿到的都是 getPublicState() 那几项不含口令的事实。
//
// 不放进 lib/proxy/：那个目录整个在代理的热更新指纹闭包里，这里改一行不该让数据面走一次交接。
// 文件形状的校验只有一份，在 lib/proxy/auth.mjs——写出去的就是代理读得进来的。
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";

import { writePrivateFileAtomicSync } from "../atomic-file.mjs";
import { archiveCorruptFileSync } from "../corrupt-archive.mjs";
import { PROXY_AUTH_FILE_MAX_BYTES, PROXY_AUTH_MODES, PROXY_AUTH_USER, PROXY_AUTH_VERSION, validateProxyAuthDocument } from "../proxy/auth.mjs";
import { fileStamp } from "../stat-cache.mjs";
import { statusError } from "../status-error.mjs";

export const PROXY_TOKEN_LENGTH = 32; // 32 个 [A-Za-z0-9] ≈ 190 位
// 换口令后旧口令继续接受多久。
export const PROXY_ROTATION_GRACE_MS = 24 * 3600_000;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 随机口令：拒绝采样，每个字符在 62 个里均匀（直接取模会让前 8 个字符略多）。
export function generateProxyToken({ length = PROXY_TOKEN_LENGTH, randomBytesImpl = randomBytes } = {}) {
  const limit = 256 - (256 % ALPHABET.length); // 248：丢掉 248..255
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytesImpl(length * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

// log：ops 日志（appendLog 的形状）。只用来记「口令文件损坏、已留档」那一条警告，不含口令。
export function createProxyAuthStore({ filePath, now = Date.now, fs = nodeFs, randomBytesImpl = randomBytes, log = () => {} } = {}) {
  let cached = null; // { stamp, result }

  // → { state, doc, reason }
  //   state "missing"     没有这个文件（从没打开过）——等同于关
  //         "ok"          doc 是校验过的内容（含口令原文）
  //         "invalid"     文件在，但不是我们认识的形状（reason 是固定代号）
  //         "unreadable"  读不出来（权限等；reason 是错误码）
  // 按文件戳缓存：探针每次发命令前都会问一句「要不要带口令」，平时只多一次 stat。
  function read() {
    if (!filePath) return { state: "missing", doc: null, reason: null };
    const stamp = fileStamp(filePath, { statSync: fs.statSync });
    if (cached && cached.stamp === stamp) return cached.result;
    let result;
    if (stamp === "missing") {
      result = { state: "missing", doc: null, reason: null };
    } else {
      try {
        if (fs.statSync(filePath).size > PROXY_AUTH_FILE_MAX_BYTES) {
          result = { state: "invalid", doc: null, reason: "too-large" };
        } else {
          let parsed;
          try {
            parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch (err) {
            if (err instanceof SyntaxError) parsed = undefined;
            else throw err;
          }
          const checked = parsed === undefined ? { ok: false, reason: "not-json" } : validateProxyAuthDocument(parsed);
          result = checked.ok ? { state: "ok", doc: checked.doc, reason: null } : { state: "invalid", doc: null, reason: checked.reason };
        }
      } catch (err) {
        result = { state: "unreadable", doc: null, reason: err?.code || "error" };
      }
    }
    cached = { stamp, result };
    return result;
  }

  function write(doc) {
    const checked = validateProxyAuthDocument(doc);
    if (!checked.ok) throw new Error(`refusing to write an invalid proxy-auth document (${checked.reason})`);
    const body = {
      v: PROXY_AUTH_VERSION,
      mode: checked.doc.mode,
      user: PROXY_AUTH_USER,
      ...(checked.doc.token ? { token: checked.doc.token } : {}),
      ...(checked.doc.previousToken ? { previousToken: checked.doc.previousToken, previousUntil: checked.doc.previousUntil } : {}),
      updatedAt: checked.doc.updatedAt,
    };
    // 运行目录在源码模式下是仓库里的 work/runtime：只建目录，不改已有目录的权限。
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(body, null, 2)}\n`, { fs, chmodDir: false });
    cached = null;
    return checked.doc;
  }

  // 现有内容里还作数的部分：过渡期已过的上一个口令不再带着（下次写盘时顺手清掉）。
  function current() {
    const result = read();
    if (result.state === "unreadable") {
      throw statusError(`口令文件读不出来（${result.reason}），没有改动任何设置`, 500, { code: "proxy-auth-unreadable" });
    }
    const doc = result.state === "ok" ? result.doc : null;
    const previousLive = Boolean(doc?.previousToken) && now() < doc.previousUntil;
    return {
      // 文件损坏时原来的口令已经取不回来：按「没有口令」重新开始，调用方会告诉用户要重新写到集群。
      // 下一次写入之前先把坏文件留档（见 setMode），万一要找回原来的口令还有个出处。
      reset: result.state === "invalid",
      reason: result.state === "invalid" ? result.reason : null,
      mode: doc?.mode ?? "off",
      token: doc?.token ?? null,
      previousToken: previousLive ? doc.previousToken : null,
      previousUntil: previousLive ? doc.previousUntil : 0,
    };
  }

  // 改模式。第一次打开时生成口令；关掉时口令留着（再打开不用重新写到集群）。
  // → { doc, created: 这次新生成了口令, reset: 原文件损坏、口令是重新生成的 }
  function setMode(mode) {
    if (!PROXY_AUTH_MODES.includes(mode)) throw statusError(`不认识的口令模式: ${mode}`, 400, { code: "bad-mode" });
    const base = current();
    // 损坏的口令文件不直接盖掉：先改名留档（<名字>.corrupt-<北京时间>，0600，最多 2 份）并记一条警告，再写新的。
    // 留档失败（比如文件刚被删）也照常往下走——这一步只为留个出处，不该挡住用户改设置。
    if (base.reset) {
      archiveCorruptFileSync(filePath, { fs, now, log, label: "代理口令", problem: `认不出（${base.reason || "invalid"}）`, action: mode === "off" ? "按「关」重写" : "重新生成口令" });
      cached = null;
    }
    const created = mode !== "off" && !base.token;
    const token = created ? generateProxyToken({ randomBytesImpl }) : base.token;
    const doc = write({ v: PROXY_AUTH_VERSION, mode, user: PROXY_AUTH_USER, token, previousToken: base.previousToken, previousUntil: base.previousUntil, updatedAt: now() });
    return { doc, created, reset: base.reset && created };
  }

  // 换口令：新口令立即生效，旧口令再接受 graceMs。过渡期内再换一次会让「上上个」口令立刻失效，
  // 所以默认拒绝，force 才放行。
  function rotate({ force = false, graceMs = PROXY_ROTATION_GRACE_MS } = {}) {
    const base = current();
    if (!base.token) throw statusError("还没有口令：先把口令模式打开", 409, { code: "no-token" });
    if (base.previousToken && !force) {
      throw statusError("上一次换口令的过渡期还没结束：这时再换，仍在用上一个口令的程序会立刻断网", 409, { code: "rotation-in-progress", previousUntil: base.previousUntil });
    }
    return write({ v: PROXY_AUTH_VERSION, mode: base.mode, user: PROXY_AUTH_USER, token: generateProxyToken({ randomBytesImpl }), previousToken: base.token, previousUntil: now() + graceMs, updatedAt: now() });
  }

  // 提前结束过渡期（集群侧都换成新口令之后）：上一个口令立刻失效。
  function retirePrevious() {
    const base = current();
    if (!base.token) throw statusError("还没有口令", 409, { code: "no-token" });
    return write({ v: PROXY_AUTH_VERSION, mode: base.mode, user: PROXY_AUTH_USER, token: base.token, previousToken: null, previousUntil: 0, updatedAt: now() });
  }

  // 不含口令的事实，可以进接口响应。
  function getPublicState() {
    const result = read();
    const doc = result.state === "ok" ? result.doc : null;
    const rotating = Boolean(doc?.previousToken) && now() < doc.previousUntil;
    return {
      mode: doc?.mode ?? "off",
      hasToken: Boolean(doc?.token),
      updatedAt: doc?.updatedAt || null,
      rotation: rotating ? { until: doc.previousUntil } : null,
      // 文件有问题时这里说明；模式按关显示（代理那边读不出这份文件时也是保留它上一份设置或按关）。
      issue: result.state === "invalid" || result.state === "unreadable" ? { state: result.state, reason: result.reason } : null,
    };
  }

  // 要带口令的地方用：口令模式不是关、且有口令时返回 { user, password }，否则 null（调用方照旧不带）。
  // 关着的时候即使文件里留着口令也返回 null——关 = 一切照旧。
  function getCredential() {
    const result = read();
    if (result.state !== "ok" || result.doc.mode === "off" || !result.doc.token) return null;
    return { user: result.doc.user, password: result.doc.token };
  }

  // 「把口令写到集群」用：只要有口令就给（包括模式是关的时候——用户可以先写好再打开）。
  function getStoredCredential() {
    const result = read();
    if (result.state !== "ok" || !result.doc.token) return null;
    return { user: result.doc.user, password: result.doc.token };
  }

  // 还在过渡期内的上一个口令（判断「集群上现在是哪一个」用）。
  function getPreviousCredential() {
    const result = read();
    if (result.state !== "ok" || !result.doc.previousToken || now() >= result.doc.previousUntil) return null;
    return { user: result.doc.user, password: result.doc.previousToken };
  }

  return { read, setMode, rotate, retirePrevious, getPublicState, getCredential, getStoredCredential, getPreviousCredential };
}
