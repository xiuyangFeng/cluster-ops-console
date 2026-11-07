// M1 批次共享 fixture（T00 交付）：三服务器、多 Agent、旧 supervisor、旧 metrics 的
// 可复用输入。全部主机使用 fixture.invalid、端口取测试段、token 形如 test-token-*，
// 不含任何真实集群地址 / 用户名 / 凭证。纯数据构造器，无 IO、无副作用。
//
// 事实背景（docs/reviews/2026-09-05/implementation/01 §3.1）：
//   - 三台服务器配置各自的 remotePort 与 configured localPort，但所有 -R 都指向
//     supervisor 首拍钉死的同一个本地代理端口（effectiveProxyPort）。
//   - 旧版 /api/status.remotePort 是探针结论对象 { ok, code, output }，不是端口数字。
//     复制入口若把它当端口拼命令，就会产出 [object Object]（A01 的注入源）。

// 端口段：本批隔离测试统一用 28xxx / 38xxx 测试段，避开生产 8877/8888/7891。
export const FIXTURE_HOSTS = ["fixture-a.invalid", "fixture-b.invalid", "fixture-c.invalid"];

// 三服务器：不同反向端口（17891/17892/17893）+ 不同 configured localPort
//（28801/28802/28803），实际共享代理端口固定 28888（A01/A02 的核心场景）。
export function buildThreeServerConfig({ activeServerId = "fixture-a" } = {}) {
  return {
    activeServerId,
    activeAgentId: "codex",
    sshUser: "fixture-user",
    proxyAllowedTargets: ["fixture-a.invalid"],
    servers: [
      { id: "fixture-a", name: "Fixture A", host: "fixture-a.invalid", remotePort: 17891, localPort: 28801, source: "team" },
      { id: "fixture-b", name: "Fixture B", host: "fixture-b.invalid", remotePort: 17892, localPort: 28802, source: "team" },
      // fixture-c 声明 tunnel:false（"只监控不建隧道"）：复制入口必须把它标注为
      // 配置示例而不是当前可用连接。
      { id: "fixture-c", name: "Fixture C", host: "fixture-c.invalid", remotePort: 17893, localPort: 28803, source: "personal", tunnel: false },
    ],
    agents: [
      { id: "codex", name: "Codex", kind: "codex", command: "codex" },
      { id: "claude-codewing", name: "Claude CodeWing", kind: "reclaude", command: "reclaude" },
    ],
  };
}

// supervisor 运行快照（v2.20 新契约，schemaVersion 1）。
// effectiveProxyPort = 28888：与三台服务器的 configured localPort 全部不同，
// 模拟"共享代理端口在 supervisor 首拍钉死"的现网事实。
export function buildRuntimeSnapshot({ observedAt = 1788576005000, stale = false } = {}) {
  return {
    schemaVersion: 1,
    instanceId: "fixture-supervisor-instance",
    pid: 12345,
    startedAt: observedAt - 600000,
    observedAt: stale ? observedAt - 10 * 60 * 1000 : observedAt,
    configRevision: "fixture-revision-0001",
    build: { version: "9.9.9-test", gitCommit: "fixture0000000000000000000000000000000000" },
    capabilities: { scopedTunnelRestart: true, controlProtocol: 1 },
    effectiveProxyPort: 28888,
    targets: {
      "fixture-a": { host: "fixture-a.invalid", remotePort: 17891, localPort: 28888, signature: "-R 127.0.0.1:17891:127.0.0.1:28888 fixture-a.invalid" },
      "fixture-b": { host: "fixture-b.invalid", remotePort: 17892, localPort: 28888, signature: "-R 127.0.0.1:17892:127.0.0.1:28888 fixture-b.invalid" },
    },
  };
}

// 旧版 /api/status 形状的 remotePort 探针对象（保持旧语义：ok/code/output）。
export function buildLegacyRemotePortProbe({ open = true } = {}) {
  return open
    ? { ok: true, code: 0, output: "open" }
    : { ok: false, code: 1, output: "closed" };
}

// 旧 metrics 历史（v2.19 及更早）：样本只有 cpu/ram/disk，cpu 是 load1/核数的
// 归一化负载百分比，不是 CPU busy%。旧数据在 T03 之后必须按 legacyLoad 展示，
// 不得被重新解释成 CPU 使用率。
export function buildLegacyMetricSamples({ count = 3, startTs = 1788570000000, intervalMs = 60000 } = {}) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: startTs + i * intervalMs,
      serverId: "fixture-a",
      kind: "resource",
      cpu: 12 + i,
      ram: 40 + i,
      disk: 80 + i,
      tunnelUp: true,
    });
  }
  return samples;
}

// /proc/stat 聚合行 fixture（T03 差分计算用）。guest/guest_nice 已含在 user/nice 里，
// 输出列：user nice system idle iowait irq softirq steal guest guest_nice。
export function procStatLine({ user = 100, nice = 0, system = 50, idle = 800, iowait = 20, irq = 0, softirq = 10, steal = 0, guest = 0, guest_nice = 0 } = {}) {
  return `cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} ${guest} ${guest_nice}`;
}

export const FIXTURE_BOOT_ID = "fixture-boot-id-0000-0000";
export const FIXTURE_MOUNT = "/fixture/home";
