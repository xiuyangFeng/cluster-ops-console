// 代理的目标放行策略：非 443 白名单（proxyAllowedTargets，团队层 + 个人层取并集）、默认
// allowTarget，以及拨号前对 DNS 解析结果逐地址复检的 rebinding 闸门。纯函数 + 工厂，不碰
// socket，便于单独测试。地址级的纯判定（authority 解析、端口校验、私网字面量）在叶子模块
// ./address.mjs，这里转出原名，既有调用方与测试不必改 import。
import { isPrivateTarget, parseAllowlistEntry } from "./address.mjs";

export { isPrivateTarget, isValidPort, parseConnectAuthority } from "./address.mjs";

// 默认目标策略只放行的端口；团队可通过 allowTarget 选项整体覆盖。
const ALLOWED_TARGET_PORT = 443;

// 非 443 端口显式白名单（host:port）的内置默认：v2.54 起为空集——公网 443 默认放行已覆盖
// 官方登录与官方 API；中转站等非 443 目标一律由配置层 proxyAllowedTargets 声明（同事在设置页
// 「出网」里加进个人层，或引导填 base URL 时自动加入），代码里不再预烤任何人的站点。
// 导出名保留：配置层没有该字段（或整份配置读不出来）时回落到这里。
export const EXTRA_ALLOWED_TARGETS = new Set();

// 把配置层的 proxyAllowedTargets 数组解析成归一化 Set（host 小写 + 数字端口）。
// 逐条校验：必须 host:port、端口 1..65535、host 不得是私网/loopback 字面量（这类条目
// 无论如何都会被 isPrivateTarget 拦截，启动期就告警跳过，别让同事等到 CONNECT 403 才发现）。
// 非法条目跳过并 log，绝不抛异常——配置烂顶多少几条白名单，不能把代理本身拖死。
export function parseProxyAllowedTargets(entries, { log = (line) => console.warn(line) } = {}) {
  const parsed = new Set();
  if (entries === undefined || entries === null) return parsed; // 字段缺失是正常场景，静默
  if (!Array.isArray(entries)) {
    log(`[proxy-config] proxyAllowedTargets 应为数组，实际 ${typeof entries}，整体忽略`);
    return parsed;
  }
  for (const entry of entries) {
    const result = parseAllowlistEntry(entry);
    if (result.error === "type") {
      log(`[proxy-config] proxyAllowedTargets 条目应为 "host:port" 字符串，跳过: ${JSON.stringify(entry)}`);
    } else if (result.error === "format") {
      log(`[proxy-config] proxyAllowedTargets 条目格式非法（需 host:port，端口 1-65535），跳过: "${entry}"`);
    } else if (result.error === "private") {
      log(`[proxy-config] proxyAllowedTargets 不放行私网/loopback 目标（isPrivateTarget 拦截优先于白名单），跳过: "${entry}"`);
    } else {
      parsed.add(result.entry);
    }
  }
  return parsed;
}

// 配置字段 → 生效白名单的回落语义：
// - 字段缺失（undefined/null）→ 内置默认 EXTRA_ALLOWED_TARGETS（v2.54 起为空集）；
// - 字段显式给出（含空数组）→ 完全以配置为准；
// - 字段类型整体写错 → 告警并回落内置默认（同上，空集）。
export function resolveExtraAllowedTargets(entries, { log = (line) => console.warn(line) } = {}) {
  if (entries === undefined || entries === null) return EXTRA_ALLOWED_TARGETS;
  if (!Array.isArray(entries)) {
    log(`[proxy-config] proxyAllowedTargets 应为数组，实际 ${typeof entries}，回落内置默认白名单`);
    return EXTRA_ALLOWED_TARGETS;
  }
  return parseProxyAllowedTargets(entries, { log });
}

// 解析闸门专用错误码：DNS 解析结果命中私网且未被活动策略显式放行时，以该 code 拒绝拨号，
// 上层错误处理据此走 403 拒绝路径（而非拨号失败的 502/504 路径）。
export const RESOLVED_PRIVATE_ERROR_CODE = "ERR_RESOLVED_PRIVATE_ADDRESS";

// DNS rebinding 兜底闸门：把任意 dns.lookup 兼容函数包一层，在回调里对每一个解析出的
// 地址（单地址形态与 all:true 形态——autoSelectFamily 的全部候选，含 IPv4/IPv6/
// IPv4-mapped ::ffff:x.x.x.x）做 isPrivateTarget 复检。任一地址命中私网/loopback/
// CGNAT/link-local 即整体拒绝——除非活动策略 allowTarget(该IP字面量, 该端口) 显式放行，
// 这与字面量快速路径的语义完全一致：默认策略下私网解析结果必拒，而调用方整体覆盖
// allowTarget（含测试注入、显式放行私网的部署）时闸门尊重同一套策略，不另立山头。
// 解析错误原样透传；闸门拒绝时以带 RESOLVED_PRIVATE_ERROR_CODE 的 Error 回调，
// net.connect/http.request 会照常触发 error 事件，不会让连接悬挂或 socket 泄漏。
export function createRebindGuardedLookup({ lookup, allowTarget, port }) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    lookup(hostname, options, (err, addressOrRecords, family) => {
      if (err) {
        callback(err);
        return;
      }
      const records =
        options?.all
          ? Array.isArray(addressOrRecords)
            ? addressOrRecords
            : []
          : [{ address: addressOrRecords, family }];
      const blocked = records.find(
        (r) => r && isPrivateTarget(r.address) && !allowTarget(String(r.address), port),
      );
      if (blocked) {
        const guardErr = new Error(
          `${hostname} resolved to private address ${blocked.address} (DNS rebinding blocked)`,
        );
        guardErr.code = RESOLVED_PRIVATE_ERROR_CODE;
        guardErr.blockedAddress = blocked.address;
        callback(guardErr);
        return;
      }
      if (options?.all) callback(null, addressOrRecords);
      else callback(null, addressOrRecords, family);
    });
  };
}

// 默认目标校验的工厂：闭包持有生效白名单，而不是模块级可变全局——
// 每个 createProxyServer 实例的策略彼此独立，测试注入互不串台。
// 策略：先拒私网/loopback/link-local（优先级最高，白名单不能放行私网目标），
// 再放行显式白名单 host:port，最后放行 443（常见公网 HTTPS 上游）。
export function makeDefaultAllowTarget(extraAllowedTargets) {
  return function defaultAllowTarget(host, port) {
    if (isPrivateTarget(host)) return false;
    if (extraAllowedTargets.has(`${String(host).toLowerCase()}:${Number(port)}`)) return true;
    return Number(port) === ALLOWED_TARGET_PORT;
  };
}
