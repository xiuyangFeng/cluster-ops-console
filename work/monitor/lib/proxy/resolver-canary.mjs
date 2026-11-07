// 本机解析器健康金丝雀（v2.54 终审）。上游模式（system / manual）下目标域名在本机解析失败时，
// 要分清两种情况：
//   - 本机 DNS 整体不可用（只能靠代理软件解析的网络）：解析失败的目标照常交给上游——这正是要上游的原因；
//   - 本机 DNS 正常、只有这一个域名解析不了 / 超时：很可能是有人故意让它对本机解析器失败，借上游
//     （Clash 对私网规则 DIRECT）绕过私网闸门打到同事的局域网——必须拒绝。
// 判别办法：解析一个固定公网域（缺省 api.openai.com，可注入）。金丝雀成功 = 本机解析器健康，
// 目标解析失败按拒；金丝雀也失败 = 本机 DNS 整体不可用，才允许转给上游。
// 懒触发：只在目标解析失败时才问；结论缓存 intervalMs（缺省 60 秒），同一时刻只跑一次探测。
import dns from "node:dns";

export const RESOLVER_CANARY_HOST = "api.openai.com";
export const RESOLVER_CANARY_INTERVAL_MS = 60_000;
export const RESOLVER_CANARY_BUDGET_MS = 2000;

function lookupProbe(lookup, host) {
  return new Promise((resolve, reject) => {
    try {
      lookup(host, { all: true }, (err, records) => {
        if (err) reject(err);
        else if (Array.isArray(records) ? records.length > 0 : Boolean(records)) resolve();
        else reject(new Error("empty answer"));
      });
    } catch (err) {
      reject(err);
    }
  });
}

// 缺省探测：系统解析（getaddrinfo，与目标同一条路径）与 c-ares 直查（A / AAAA）并行，任一成功即健康。
// 只靠 getaddrinfo 不够：dns.lookup 跑在 libuv 线程池（缺省 4 线程）上，节点上的人可以用一批
// 永不应答的域名把线程池占满，让金丝雀排队超时、被"打成不健康"，从而重新打开放行口子；
// c-ares 走自己的 socket，不占线程池，攻击者够不着它。
export function createDefaultCanaryResolve({ lookup = dns.lookup, budgetMs = RESOLVER_CANARY_BUDGET_MS } = {}) {
  return async function resolveCanary(host) {
    const resolver = new dns.promises.Resolver({ timeout: budgetMs, tries: 1 });
    try {
      await Promise.any([lookupProbe(lookup, host), resolver.resolve4(host), resolver.resolve6(host)]);
    } finally {
      resolver.cancel();
    }
  };
}

// dns.lookup 兼容函数 → 金丝雀探测（测试注入 lookup 时用同一个函数做金丝雀，保持封闭）。
export function canaryResolveFromLookup(lookup) {
  return (host) => lookupProbe(lookup, host);
}

// isHealthy() → Promise<boolean>，永不 reject。探测超出 budgetMs 按失败算。
export function createResolverCanary({
  host = RESOLVER_CANARY_HOST,
  resolve = createDefaultCanaryResolve(),
  intervalMs = RESOLVER_CANARY_INTERVAL_MS,
  budgetMs = RESOLVER_CANARY_BUDGET_MS,
  now = Date.now,
} = {}) {
  let last = null; // { healthy, at }
  let inflight = null;

  function probe() {
    return new Promise((done) => {
      const timer = setTimeout(() => done(false), budgetMs);
      let pending;
      try {
        pending = Promise.resolve(resolve(host));
      } catch {
        pending = Promise.reject(new Error("canary resolve threw"));
      }
      pending.then(
        () => {
          clearTimeout(timer);
          done(true);
        },
        () => {
          clearTimeout(timer);
          done(false);
        },
      );
    });
  }

  function isHealthy() {
    if (last && now() - last.at < intervalMs) return Promise.resolve(last.healthy);
    if (!inflight) {
      inflight = probe().then((healthy) => {
        last = { healthy, at: now() };
        inflight = null;
        return healthy;
      });
    }
    return inflight;
  }

  return { isHealthy };
}
