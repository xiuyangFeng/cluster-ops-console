// CLI 最新版本（第 2 期 P-D，设计稿 §5.D「最新版」）：本机每 6 小时取一次
// `https://registry.npmjs.org/-/package/<pkg>/dist-tags`（几百字节），按本机出网设置走（./net.mjs）。
// codex 与 Claude 都跟 `latest`（Claude 自更新的默认通道就是 latest；codex 官方安装器的 latest 通道
// 与 npm latest 同步发布，2026-10-07 核对两者都是 0.160.1 / 2.1.292）。
//
// 只在内存里缓存：几百字节、重启后重取一次无所谓。取失败时保留上一次成功的结果并标 error，
// 失败后 10 分钟内不重试（离线 / 出网没配好时不每次打开界面都卡一下）。同一时刻只有一个在途请求。
// getLatest({ wait }) 从不 reject：拿不到就是 latest:null + error。
import { CLI_IDS, getCli } from "./catalog.mjs";
import { fetchJson as defaultFetchJson } from "./net.mjs";

export const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
export const LATEST_RETRY_MS = 10 * 60 * 1000;
export const LATEST_FETCH_TIMEOUT_MS = 15000;
// 界面首次打开、缓存还空着时最多等这么久；超时就先回 null，后台继续取。
export const LATEST_WAIT_MS = 8000;

const STRICT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
export const isStrictVersion = (v) => typeof v === "string" && v.length <= 64 && STRICT_VERSION.test(v);

export function distTagsUrl(pkg) {
  // 作用域包的 / 要编码成 %2F（registry 的 /-/package/ 接口要求）。
  return `https://registry.npmjs.org/-/package/${String(pkg).replace("/", "%2F")}/dist-tags`;
}

// dist-tags 文档 → latest 版本号（格式不对按没有处理，绝不把任意字符串当版本号往下传）。
export function pickLatest(distTags, tag = "latest") {
  const v = distTags && typeof distTags === "object" ? distTags[tag] : null;
  return isStrictVersion(v) ? v : null;
}

// getUpstream()：→ 上游 { host, port } 或 null（直连），每次取新值（出网设置可能刚改过）。
export function createCliVersionsService({
  getUpstream = async () => null,
  fetchJson = defaultFetchJson,
  now = Date.now,
  ttlMs = LATEST_TTL_MS,
  retryMs = LATEST_RETRY_MS,
  log = null,
} = {}) {
  let cache = null; // { checkedAt, clis: { id: { latest, error } } }
  let lastAttemptAt = -Infinity;
  let inflight = null;

  async function fetchOne(id, upstream) {
    const pkg = getCli(id).npmPackage;
    try {
      const tags = await fetchJson(distTagsUrl(pkg), { upstream, timeoutMs: LATEST_FETCH_TIMEOUT_MS, idleTimeoutMs: LATEST_FETCH_TIMEOUT_MS, maxBytes: 256 * 1024 });
      const latest = pickLatest(tags);
      return latest ? { latest, error: null } : { latest: null, error: "npm dist-tags 里没有合法的 latest" };
    } catch (err) {
      return { latest: null, error: String(err?.message || err) };
    }
  }

  function refresh() {
    if (inflight) return inflight;
    lastAttemptAt = now();
    inflight = (async () => {
      let upstream = null;
      try {
        upstream = await getUpstream();
      } catch {
        upstream = null;
      }
      const results = await Promise.all(CLI_IDS.map((id) => fetchOne(id, upstream)));
      const clis = {};
      CLI_IDS.forEach((id, i) => {
        const r = results[i];
        // 失败时沿用上一次成功取到的版本号（标出错误与旧的取得时间）。
        const prev = cache?.clis?.[id];
        clis[id] = r.latest
          ? { latest: r.latest, checkedAt: now(), error: null }
          : { latest: prev?.latest ?? null, checkedAt: prev?.checkedAt ?? null, error: r.error };
        if (r.error) log?.(`cli latest ${id}: ${r.error}`, { level: "warn", event: "cli" });
      });
      const ok = results.every((r) => r.latest);
      cache = { checkedAt: ok ? now() : cache?.checkedAt ?? null, attemptedAt: now(), clis };
      return cache;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function isStale() {
    if (!cache) return now() - lastAttemptAt >= retryMs || lastAttemptAt === -Infinity;
    const allOk = CLI_IDS.every((id) => cache.clis[id]?.latest && !cache.clis[id]?.error);
    if (allOk) return now() - (cache.checkedAt ?? 0) >= ttlMs;
    return now() - lastAttemptAt >= retryMs;
  }

  function view() {
    const out = {};
    for (const id of CLI_IDS) out[id] = cache?.clis?.[id] ?? { latest: null, checkedAt: null, error: null };
    return out;
  }

  // wait：缓存为空时最多等 waitMs 拿首个结果；有缓存时从不等（过期就后台刷新）。
  async function getLatest({ wait = true, waitMs = LATEST_WAIT_MS, force = false } = {}) {
    if (force || isStale()) {
      const p = refresh().catch(() => null);
      if (!cache && wait) {
        let timer;
        await Promise.race([p, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
        clearTimeout(timer);
      } else if (force && wait) {
        await p;
      }
    }
    return view();
  }

  return { getLatest, refresh, isStale };
}
