// 代理拨号用的 DNS 正缓存。与目标策略无关（放行判定在 ./target-policy.mjs，解析结果的
// 私网复检由 createRebindGuardedLookup 包在它外面），单独成模块便于各改各的。
import dns from "node:dns";

// dns.lookup 兼容签名的内存缓存：始终按 all:true 解析并缓存全量地址，
// 单地址调用取首条。解析失败不缓存（避免负缓存放大故障）。
export function createCachedLookup({
  ttlMs = 60000,
  baseLookup = dns.lookup,
  now = Date.now,
  maxEntries = 256,
} = {}) {
  const cache = new Map(); // hostname -> { records, expiresAt }

  function deliver(records, options, callback) {
    if (options?.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  }

  function cachedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const hit = cache.get(hostname);
    if (hit && hit.expiresAt > now()) {
      deliver(hit.records, options, callback);
      return;
    }
    baseLookup(hostname, { all: true, verbatim: true }, (err, records) => {
      if (err) {
        callback(err);
        return;
      }
      if (cache.size >= maxEntries) cache.clear(); // 目标域名个位数，上限纯防御
      cache.set(hostname, { records, expiresAt: now() + ttlMs });
      deliver(records, options, callback);
    });
  }

  cachedLookup.has = (hostname) => {
    const hit = cache.get(hostname);
    return Boolean(hit && hit.expiresAt > now());
  };
  cachedLookup.cache = cache;
  return cachedLookup;
}
