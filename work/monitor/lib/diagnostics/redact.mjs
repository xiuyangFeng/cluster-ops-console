// 诊断包的脱敏（v2.64）：深拷贝一份可以直接发给发布方排障的数据。
//
// 与排障报告（lib/reports/model.mjs 的 redactReport）口径不同，所以不共用：排障报告是给外人看的 Markdown，
// 主机地址、IP、用户名、家目录一律隐藏；诊断包是发给发布方排查「这台工作台自己出了什么事」的，
// 主机名、账号名、路径都要留着，只把能拿去登录 / 调接口的东西去掉：
//   - 键名里含 secret / token / password / passwd / passphrase / auth / credential / cookie / apikey / privatekey /
//     accesskey、或以 vault 开头的字段（见 isSecretKey；authRef、authMethod 这类引用 / 枚举与用量计数在明确的允许名单里），
//     值是字符串或对象时整个换成占位；数字与布尔照留（hasToken: true、maxTokens: 4096 这类不是凭据）。
//   - 任何字符串里的：私钥块、Authorization / Cookie / X-Auth-Token 头、Bearer / Basic 凭据、URL 里 user:pass@ 的口令
//     与 http(s) 地址里只有令牌的 TOKEN@、--password / --token 之类的命令行参数、curl -u / -U / --user 的口令、
//     「像凭据的键 = 值」（引号没有收尾的也算——截断过的文本）、常见服务商密钥（sk- / ghp_ / github_pat_ / xox?- /
//     AKIA / hf_ / glpat- / AIza / JWT / cr_）。
//   - 调用方给出的已知秘密原文（本机鉴权令牌、保管库令牌、代理口令及其 Basic 编码），出现在哪里都换掉。
// 纯函数，不读盘；返回替换次数，诊断包把它写进 summary。

export const REDACTED = "[已隐藏]";
const PRIVATE_KEY_REDACTED = "[私钥已隐藏]";

// 键名归一（小写、去掉非字母数字）后判定：含下面任何一个词就算凭据（secretKey、AWS_SECRET_ACCESS_KEY、auth、
// oauth_token、previousToken……）。
const SECRET_KEY_WORDS = /secret|token|password|passwd|passphrase|auth|credential|cookie|apikey|privatekey|accesskey/;
const SECRET_KEY_EXACT = new Set(["pwd", "pass", "proxyuser"]);
// 明确的允许名单（归一后的键名）：含上面的词、但值不是秘密——凭据的引用、认证方式等枚举、状态与路径、作者。
// 数字与布尔本来就不换，这里只需要列「值是字符串或对象」的那些。
const NON_SECRET_KEYS = new Set([
  "authref", "authmethod", "authmode", "authtype", "authkind", "authsource", "authstate", "authstatus", "authpath", "authfile", "authstamp",
  "authed", "authorized", "authority", "author", "authors",
  "proxyauth", "proxyauthmode", "proxyauthresult", "proxyauthstate",
  "credentialref", "credentialstate", "credentialstatus", "credentialsource",
]);
// 用量计数：input_tokens、cache_read_input_tokens、total_token_usage、tokenCount……（复数 tokens 或 usage / count 结尾）。
const TOKEN_COUNTER = /tokens|tokenusage|tokencount$/;

export function isSecretKey(key) {
  const k = String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k || NON_SECRET_KEYS.has(k) || TOKEN_COUNTER.test(k)) return false;
  return SECRET_KEY_EXACT.has(k) || k.startsWith("vault") || SECRET_KEY_WORDS.test(k);
}

// 值的写法：带引号的整段（引号没有收尾时到行尾——截断过的文本），或到空白 / 分隔符为止。
// true / false / null 不是凭据，已经换成占位的不再换。
const VALUE = String.raw`(?!(?:true|false|null|undefined)\b|\[(?:已隐藏|私钥已隐藏)\])("[^"\r\n]*(?:"|(?=[\r\n])|$)|'[^'\r\n]*(?:'|(?=[\r\n])|$)|[^\s&,;"'}\]\)]+)`;
// 带引号的值换掉引号里面的，引号留着（JSON 文本仍然像 JSON；没收尾的补上收尾引号）。
const keepQuotes = (value) => (/^["']/.test(value) ? `${value[0]}${REDACTED}${value[0]}` : REDACTED);

const TEXT_RULES = [
  // 私钥块（没有 END 时到文本末尾）。
  [/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, () => PRIVATE_KEY_REDACTED],
  // 请求头：Authorization / Proxy-Authorization / Cookie / Set-Cookie / X-Auth-Token。带引号只换引号内，不带引号换到行尾。
  [/\b((?:proxy-)?authorization|set-cookie|cookie|x-auth-token)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi,
    (_m, name, sep, value) => `${name}${sep}${keepQuotes(value)}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // URL 里的 user:pass@：口令换掉，用户名留着（账号名保留）。
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`],
  // http(s) / ws(s) 地址里只有一段、没有冒号的 TOKEN@（GitHub 之类拿令牌当用户名）：整段换掉。ssh:// 的 user@ 是账号名，不动。
  [/\b((?:git\+)?(?:https?|wss?):\/\/)([^\s/@:[\]]+)@/gi, (match, scheme, userinfo) => (userinfo === REDACTED ? match : `${scheme}${REDACTED}@`)],
  // curl -u / -U / --user 的 user:pass：口令换掉、用户名留着；值里没有冒号（只给了用户名）的不动。
  [/(^|[\s'"])(-[uU]|--user)(\s+|=)?("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/g, (match, lead, flag, sep, value) => {
    const quote = /^["']/.test(value) ? value[0] : "";
    const inner = quote ? value.slice(1, -1) : value;
    const colon = inner.indexOf(":");
    if (colon < 0 || inner.slice(colon + 1) === REDACTED) return match;
    return `${lead}${flag}${sep ?? ""}${quote}${inner.slice(0, colon)}:${REDACTED}${quote}`;
  }],
  // 命令行参数：--password x / --token=x / --proxy-user u:p …
  [/(--(?:password|passwd|pass|token|auth-token|access-token|api-key|apikey|secret|proxy-user|proxy-password)(?:\s+|=))("[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi,
    (_m, flag, value) => `${flag}${keepQuotes(value)}`],
  // 「像凭据的键 = 值 / 键: 值」，含 JSON 文本里的 "token":"…" 与查询串里的 ?token=…。键名判定与对象字段同一套
  //（isSecretKey：authMethod: oauth、input_tokens=12 这类不换）。
  [new RegExp(String.raw`((?:\b|_)([A-Za-z0-9_-]*?(?:token|secret|password|passwd|passphrase|auth|credential|cookie|api[_-]?key|private[_-]?key|access[_-]?key|proxy[_-]?user|pwd)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)${VALUE}`, "gi"),
    (match, prefix, key, value) => (isSecretKey(key) ? `${prefix}${keepQuotes(value)}` : match)],
  // 常见服务商密钥的固定前缀。
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, () => REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => REDACTED],
  [/\b(?:hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|cr_[A-Za-z0-9]{32,})/g, () => REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 已知秘密的各种写法：原文、URL 编码、与给定用户名拼成 Basic 认证的 base64。太短的（< 8）不当秘密，免得误伤。
export function secretVariants(secrets = [], { users = [] } = {}) {
  const out = new Set();
  for (const raw of secrets) {
    if (typeof raw !== "string" || raw.length < 8) continue;
    out.add(raw);
    out.add(encodeURIComponent(raw));
    for (const user of users) {
      if (typeof user === "string" && user) out.add(Buffer.from(`${user}:${raw}`).toString("base64"));
    }
  }
  return [...out].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
}

export function createRedactor({ secrets = [] } = {}) {
  const known = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 8))].sort((a, b) => b.length - a.length);
  const knownRe = known.length ? new RegExp(known.map(escapeRegExp).join("|"), "g") : null;
  let count = 0;

  function text(value) {
    let out = String(value);
    if (knownRe) {
      out = out.replace(knownRe, () => {
        count += 1;
        return REDACTED;
      });
    }
    for (const [pattern, replace] of TEXT_RULES) {
      out = out.replace(pattern, (...args) => {
        const next = replace(...args);
        if (next !== args[0]) count += 1;
        return next;
      });
    }
    return out;
  }

  function value(input, key = "", depth = 0) {
    if (depth > 64) return "[层级过深已省略]";
    if (key && isSecretKey(key) && input != null && (typeof input === "string" ? input.length > 0 : typeof input === "object")) {
      count += 1;
      return REDACTED;
    }
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map((item) => value(item, "", depth + 1));
    if (!input || typeof input !== "object") return input;
    const copy = {};
    for (const [childKey, childValue] of Object.entries(input)) copy[childKey] = value(childValue, childKey, depth + 1);
    return copy;
  }

  return { text, value, count: () => count };
}

// 一次性：返回 { value, count }。
export function redactDiagnostics(input, { secrets = [] } = {}) {
  const redactor = createRedactor({ secrets });
  const value = redactor.value(input);
  return { value, count: redactor.count() };
}
