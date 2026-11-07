// 集群侧受管配置跟随反向端口：检测「env.sh 指向的端口 ≠ 隧道端口」，并在端口变更后自动改过去。
//
// 背景：界面「重新分配端口」与「服务器管理」改端口只改本机配置、重建隧道；集群上的 env.sh 仍指向旧端口，
// 新开的 shell 里 codex / claude 全部连不上，而探针按新端口测连通性是通的——界面看不出来。
//
// 两条规则（都只对团队服务器；个人服务器没有受管配置）：
//   自动同步  只由「本进程亲眼看到这台服务器的反向端口从 A 变成 B」触发（onConfigRefreshed，所有写路径与
//             磁盘 mtime 热载都经过它），且只在 env.sh 当前指向 A 时才改写——指向别的端口说明不是这次变更
//             留下的（另一台电脑、手改），不擅自覆盖，只报不一致。
//   定期检测  只读。发现不一致只上报（/api/status.clusterEnv），由用户点「同步到集群」（sync 的 force）。
//             绝不因为"检测到不一致"就自动写：同一账号的两台电脑会互相覆盖。
//
// 同步内容：整体重写 env.sh（与向导第 4 步同一条原子命令，NO_PROXY 的内网直连名单照带）；
// ~/.claude/settings.json 的代理键只在仍等于旧端口的地址时才改到新端口（用户改过、reclaude 接管的不动）。
// 没有 env.sh（没跑过向导）时什么都不建——没有配套的引入块，建了也不生效。
// 只影响新开的 shell：已在运行的进程环境变量里还是旧端口，这一点无法从外面修正，由界面文案说明。
// reclaude 的 systemd drop-in 与 zcode 的设置文件不在这里处理（前者要重启服务，v2.31 起由用户手动做）。
//
// 代理口令（v2.62）：
//   - 只读检测顺带看 env.sh 的代理地址带没带口令、是哪一个（集群回报的是指纹，不是口令；见
//     getCredentialState——它不进 /api/status，只给出网设置页的「代理口令」一节用）。
//   - 任何一次重写 env.sh（端口变更的自动同步、用户点的同步）都保住口令：集群上原来带着口令、本机也有
//     口令，就按本机当前的口令写回去——否则「强制」模式下一次端口同步就能让集群上新开的终端全部断网。
//     端口变更的自动同步（后台、没人点）不会把原来不带的顺手加上。
//   - 用户发起的整体重写（接入引导重跑、登录引导改 NO_PROXY；v2.64 起与命令行向导同一条规则，
//     见 cluster-env.mjs 的 credentialForEnvRewrite）：本机口令模式打开着就一并写入当前口令，是关时只保住原来带着的。
//   - 口令全程不进命令行：带口令的 env.sh 与 settings.json 都经标准输入送达。
import {
  buildClusterEnvSteps,
  buildEnvPortReadCommand,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_SETTINGS_READ_COMMAND,
  CLUSTER_ENV_PATH,
  credentialFingerprint,
  credentialForEnvRewrite,
  isManagedProxyUrl,
  noProxyExtraFor,
  parseClaudeSettingsRead,
  parseEnvCredentialRead,
  parseEnvPortRead,
  planClaudeSettingsMerge,
  readClaudeSettingsEnv,
} from "./cluster-env.mjs";
import { toPort } from "./validators.mjs";

export const CLUSTER_ENV_CHECK_INTERVAL_MS = 10 * 60000;
// 上一轮没查成（SSH 不通）时的重试间隔：比正常节奏短，但不跟着状态轮询一起打。
export const CLUSTER_ENV_RETRY_INTERVAL_MS = 2 * 60000;
const SSH_READ_TIMEOUT_MS = 15000;
const SSH_WRITE_TIMEOUT_MS = 20000;

// 有受管配置可言的服务器：团队服务器、未禁用、建隧道。
export function isClusterEnvEligible(server) {
  return Boolean(server) && server.source !== "personal" && server.disabled !== true && server.tunnel !== false;
}

const sshDetail = (res) => String(res?.stderr || res?.error?.message || "").trim().split("\n").at(-1) || `退出码 ${res?.code ?? "未知"}`;

export function createClusterEnvSync({
  getConfig,
  getPersonalConfig = () => ({}),
  runRemote,
  acquireSshSlot = null,
  now = Date.now,
  log = () => {},
  // fixture / 测试：关掉 getState 里的后台定期检测。
  autoCheck = true,
  // 本机存着的代理口令 { user, password }（没有 → null）。缺省 = 没有这项功能，一切照旧。
  getProxyCredential = () => null,
  // 本机的口令模式 "off" | "observe" | "enforce"（v2.64，只给 credentialForRewrite 用）。缺省 = 关：只保住、不新加。
  getProxyAuthMode = () => "off",
}) {
  // serverId → { state, envPort, expectedPort, checkedAt, attemptedAt, error, lastSync }
  //   state: "in-sync" | "drift" | "absent" | "unknown"（还没查成）
  //   lastSync: { at, ok, from, to, trigger: "port-change" | "manual", changed: string[], error } | null
  const states = new Map();
  // serverId → { fingerprint, checkedAt }：env.sh 里口令的指纹（"none" = 没带，"nohash" = 带了但集群上算不出
  // 指纹，null = 不知道）。单独放，不并进上面的 state——那份会原样进 /api/status。
  const credentials = new Map();
  const knownPorts = new Map();
  const queues = new Map();

  const serialized = (serverId, task) => {
    const next = (queues.get(serverId) || Promise.resolve()).then(task, task);
    queues.set(serverId, next.catch(() => {}));
    return next;
  };

  async function context(serverId) {
    const config = await getConfig();
    const server = (config?.servers || []).find((s) => s?.id === serverId);
    if (!isClusterEnvEligible(server)) return null;
    return { config, server, port: toPort(server.remotePort) };
  }

  async function remote(ctx, command, options) {
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: ctx.server.host }) : () => {};
    try {
      return await runRemote(ctx.server, ctx.config, command, options);
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error) };
    } finally {
      release();
    }
  }

  const update = (serverId, patch) => {
    const next = { state: "unknown", envPort: null, expectedPort: null, checkedAt: null, attemptedAt: null, error: null, lastSync: null, ...states.get(serverId), ...patch };
    states.set(serverId, next);
    return next;
  };

  // 只读：env.sh 现在指向哪个端口。→ 最新状态；服务器不在范围内 → null。
  async function inspect(serverId, ctx) {
    if (ctx.port === null) return update(serverId, { state: "unknown", expectedPort: null, attemptedAt: now(), error: null });
    const res = await remote(ctx, buildEnvPortReadCommand(), { timeoutMs: SSH_READ_TIMEOUT_MS });
    const parsed = res?.code === 0 ? parseEnvPortRead(res.stdout) : null;
    if (!parsed) return update(serverId, { expectedPort: ctx.port, attemptedAt: now(), error: `读取集群配置失败（${sshDetail(res)}）` });
    credentials.set(serverId, { fingerprint: parsed.present ? parseEnvCredentialRead(res.stdout) : "none", checkedAt: now() });
    const state = !parsed.present ? "absent" : parsed.port === ctx.port ? "in-sync" : "drift";
    return update(serverId, { state, envPort: parsed.port, expectedPort: ctx.port, checkedAt: now(), attemptedAt: now(), error: null });
  }

  // 重写 env.sh 时要不要带口令：集群上那一份原来带着、且本机有口令 → 带。原来明确不带（"none"）→ 不带。
  // 读不出带没带（极少见：输出被截断）时宁可带上——多带一个口令在任何模式下都不影响出网，少带一个在
  // 「强制」下会让集群上新开的终端全部断网。mode 给了且是打开着的（用户发起的重写）→ 原来不带也带上。
  function keepCredential(serverId, { mode } = {}) {
    return credentialForEnvRewrite({ stored: storedCredential(), mode, clusterCredential: credentials.get(serverId)?.fingerprint ?? null });
  }

  function proxyAuthMode() {
    try {
      return getProxyAuthMode() ?? "off";
    } catch {
      return "off";
    }
  }

  function storedCredential() {
    try {
      const credential = getProxyCredential();
      return credential?.user && credential?.password ? credential : null;
    } catch {
      return null;
    }
  }

  function noteCredentialWritten(serverId, credential) {
    credentials.set(serverId, { fingerprint: credentialFingerprint(credential), checkedAt: now() });
  }

  // 整体重写 env.sh。带口令时步骤带 input（全文经标准输入送达）。
  async function writeEnv(ctx, opts) {
    const step = buildClusterEnvSteps(opts).find((s) => s.id === "write-env");
    const written = await remote(ctx, step.command, { timeoutMs: SSH_WRITE_TIMEOUT_MS, ...(step.input != null ? { input: step.input } : {}) });
    if (written?.code !== 0) throw new Error(`改写 ~/${CLUSTER_ENV_PATH} 失败（${sshDetail(written)}），原文件未改动`);
  }

  function check(serverId) {
    return serialized(serverId, async () => {
      const ctx = await context(serverId);
      if (!ctx) {
        states.delete(serverId);
        return null;
      }
      return inspect(serverId, ctx);
    });
  }

  // settings.json：代理地址仍是旧端口的才改（合并写法与向导一致，其余键原样保留）。→ 改了哪些键。
  async function syncClaudeSettings(ctx, fromPort, opts) {
    const read = await remote(ctx, CLAUDE_SETTINGS_READ_COMMAND, { timeoutMs: SSH_READ_TIMEOUT_MS });
    const parsed = read?.code === 0 ? parseClaudeSettingsRead(read.stdout) : null;
    if (!parsed) throw new Error(`读取 ~/${CLAUDE_SETTINGS_FILE} 失败（${sshDetail(read)}）`);
    if (!parsed.present) return [];
    const env = readClaudeSettingsEnv(parsed.text);
    // 仍是我们为那个端口写的地址（带不带口令都算）才改；用户改过的、别的端口的不动。
    if (!env || fromPort === null || !isManagedProxyUrl(env.HTTPS_PROXY, fromPort)) return [];
    const plan = planClaudeSettingsMerge(read.stdout, opts);
    if (plan.action !== "write") return [];
    const res = await remote(ctx, plan.command, { input: plan.input, timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.code !== 0) throw new Error(`改写 ~/${CLAUDE_SETTINGS_FILE} 失败（${sshDetail(res)}），原文件未改动`);
    return plan.changedKeys;
  }

  // 把集群侧受管配置改到当前端口。
  //   fromPort  自动同步时传变更前的端口：env.sh 不指向它就不写。
  //   force     用户点的「同步到集群」：env.sh 在就整体重写。
  // → { status: "synced" | "in-sync" | "absent" | "foreign" | "failed" | "ineligible" | "no-port", state }
  function sync(serverId, { fromPort = null, force = false, trigger = force ? "manual" : "port-change" } = {}) {
    return serialized(serverId, async () => {
      const ctx = await context(serverId);
      if (!ctx) {
        states.delete(serverId);
        return { status: "ineligible", state: null };
      }
      if (ctx.port === null) return { status: "no-port", state: update(serverId, { state: "unknown", expectedPort: null }) };
      const before = await inspect(serverId, ctx);
      if (before.error) return { status: "failed", state: before };
      if (before.state === "absent") return { status: "absent", state: before };
      if (before.state === "in-sync") return { status: "in-sync", state: before };
      if (!force && before.envPort !== toPort(fromPort)) {
        log(`cluster env on ${ctx.server.host} points at ${before.envPort ?? "an unrecognized value"}, not the previous port ${fromPort}; left untouched`);
        return { status: "foreign", state: before };
      }
      const record = (ok, extra) => ({ at: now(), ok, from: before.envPort, to: ctx.port, trigger, changed: [], error: null, ...extra });
      try {
        // 集群上原来带着口令就带着当前的口令写回去（见文件头）。
        const credential = keepCredential(serverId);
        const opts = { port: ctx.port, noProxyExtra: noProxyExtraFor(getPersonalConfig(), serverId), ...(credential ? { credential } : {}) };
        await writeEnv(ctx, opts);
        if (credential) noteCredentialWritten(serverId, credential);
        const changed = [`~/${CLUSTER_ENV_PATH}`];
        let warning = null;
        try {
          if ((await syncClaudeSettings(ctx, before.envPort, opts)).length) changed.push(`~/${CLAUDE_SETTINGS_FILE}`);
        } catch (err) {
          // env.sh 已经改好：settings.json 没跟上只算提醒，不把整次同步记成失败。
          warning = err.message;
        }
        log(`cluster env on ${ctx.server.host} moved from port ${before.envPort ?? "?"} to ${ctx.port} (${trigger})`);
        const state = update(serverId, { state: "in-sync", envPort: ctx.port, expectedPort: ctx.port, checkedAt: now(), error: null, lastSync: record(true, { changed, error: warning }) });
        return { status: "synced", state };
      } catch (err) {
        log(`cluster env sync on ${ctx.server.host} failed: ${err.message}`);
        return { status: "failed", state: update(serverId, { lastSync: record(false, { error: err.message }) }) };
      }
    });
  }

  // 「把口令写到集群」里 settings.json 怎么处理：只改已经是我们为这台服务器写的代理键（端口是现在的、或
  // env.sh 原来指向的那个；带不带口令都算）。没有 claude、被 reclaude 接管、用户改成了别的地址——都不动。
  // → planClaudeSettingsMerge 的结果，或 { action: "skip" | "error", reason }。
  async function planCredentialSettings(ctx, ports, opts) {
    const read = await remote(ctx, CLAUDE_SETTINGS_READ_COMMAND, { timeoutMs: SSH_READ_TIMEOUT_MS });
    const parsed = read?.code === 0 ? parseClaudeSettingsRead(read.stdout) : null;
    if (!parsed) return { action: "error", reason: `读取失败（${sshDetail(read)}）` };
    if (!parsed.present) return { action: "skip", reason: "no-claude" };
    const env = readClaudeSettingsEnv(parsed.text);
    if (!env) return { action: "skip", reason: "invalid-json" };
    if (!ports.some((port) => port !== null && isManagedProxyUrl(env.HTTPS_PROXY, port))) return { action: "skip", reason: "not-managed" };
    return planClaudeSettingsMerge(read.stdout, opts);
  }

  // 用户点的「把口令写到集群」：把 env.sh（与 settings.json 里我们管的代理键）改成带当前口令的地址。
  //   preview  只读：回报会改哪几个文件、各改什么，不写任何东西。界面先给人看这个，确认了才真写。
  // → { status, plan?, changed?, warning?, error? }
  //   status: "preview" | "synced" | "up-to-date" | "absent"（集群上没有受管 env.sh）| "no-token"（本机还没有口令）
  //           | "failed" | "ineligible" | "no-port"
  //   plan:   { env: { path, action: "write" | "unchanged", credential: "add" | "replace" | "keep", port: { from, to } | null },
  //             claude: { path, action: "write" | "unchanged" | "skip" | "error", reason, changedKeys } }
  // 返回值里没有口令，也没有任何文件的内容。
  function syncCredential(serverId, { preview = false } = {}) {
    return serialized(serverId, async () => {
      const ctx = await context(serverId);
      if (!ctx) return { status: "ineligible" };
      if (ctx.port === null) return { status: "no-port" };
      const credential = storedCredential();
      if (!credential) return { status: "no-token" };
      const before = await inspect(serverId, ctx);
      if (before.error) return { status: "failed", error: before.error };
      if (before.state === "absent") return { status: "absent" };
      const known = credentials.get(serverId)?.fingerprint ?? null;
      const envPlan = {
        path: `~/${CLUSTER_ENV_PATH}`,
        credential: known === credentialFingerprint(credential) ? "keep" : known === "none" ? "add" : "replace",
        port: before.envPort === ctx.port ? null : { from: before.envPort, to: ctx.port },
      };
      envPlan.action = envPlan.credential === "keep" && !envPlan.port ? "unchanged" : "write";
      const opts = { port: ctx.port, noProxyExtra: noProxyExtraFor(getPersonalConfig(), serverId), credential };
      const settings = await planCredentialSettings(ctx, [ctx.port, before.envPort], opts);
      const plan = {
        env: envPlan,
        claude: { path: `~/${CLAUDE_SETTINGS_FILE}`, action: settings.action, reason: settings.reason ?? null, changedKeys: settings.changedKeys ?? [] },
      };
      if (preview) return { status: "preview", plan };
      if (envPlan.action === "unchanged" && settings.action !== "write") return { status: "up-to-date", plan };
      try {
        const changed = [];
        if (envPlan.action === "write") {
          await writeEnv(ctx, opts);
          noteCredentialWritten(serverId, credential);
          changed.push(envPlan.path);
        }
        // env.sh 已经改好：settings.json 没跟上只算提醒（与端口同步同一取舍）。
        let warning = null;
        if (settings.action === "write") {
          const res = await remote(ctx, settings.command, { input: settings.input, timeoutMs: SSH_WRITE_TIMEOUT_MS });
          if (res?.code === 0) changed.push(plan.claude.path);
          else warning = `改写 ~/${CLAUDE_SETTINGS_FILE} 失败（${sshDetail(res)}），原文件未改动`;
        } else if (settings.action === "error") {
          warning = `~/${CLAUDE_SETTINGS_FILE} ${settings.reason}，这次没有改它`;
        }
        log(`proxy credential written to cluster env on ${ctx.server.host} (${changed.length} file(s))`);
        // 顺带把端口也对齐了的话，按一次手动同步记账；端口本来就对的不动 lastSync。
        const patch = { state: "in-sync", envPort: ctx.port, expectedPort: ctx.port, checkedAt: now(), error: null };
        if (envPlan.port) patch.lastSync = { at: now(), ok: true, from: before.envPort, to: ctx.port, trigger: "manual", changed, error: warning };
        update(serverId, patch);
        return { status: "synced", plan, changed, warning };
      } catch (err) {
        log(`writing proxy credential to cluster env on ${ctx.server.host} failed: ${err.message}`);
        return { status: "failed", plan, error: err.message };
      }
    });
  }

  // 出网设置页「代理口令」一节用：env.sh 里口令的指纹与查到它的时刻；没查过为 null。不发 SSH。
  function getCredentialState(serverId) {
    const entry = credentials.get(serverId);
    return entry ? { ...entry } : null;
  }

  // 别处要整体重写 env.sh 时（接入引导重跑、登录引导改 NO_PROXY）先问这一句：现读一次集群上那一份，再按
  // credentialForEnvRewrite 的规则回答——本机口令模式打开着、或集群上原来带着口令，就返回本机当前的口令
  // （调用方照着带上）；否则 null。不在范围内的服务器返回 null。调用方写完后再 check 一次，「集群上是哪一个口令」
  // 就跟着变成当前的（出网设置页据此显示已写入）。
  async function credentialForRewrite(serverId) {
    try {
      await check(serverId);
    } catch {}
    return states.has(serverId) ? keepCredential(serverId, { mode: proxyAuthMode() }) : null;
  }

  // 配置（重新）载入后调用：记下每台服务器的端口，发现变化就在后台同步。首次见到只记不动。
  function onConfigRefreshed(config) {
    const live = new Set();
    for (const server of config?.servers || []) {
      if (!isClusterEnvEligible(server)) continue;
      live.add(server.id);
      const port = toPort(server.remotePort);
      const previous = knownPorts.get(server.id);
      knownPorts.set(server.id, port);
      if (previous == null || port === null || previous === port) continue;
      sync(server.id, { fromPort: previous }).catch(() => {});
    }
    for (const id of [...knownPorts.keys()]) {
      if (!live.has(id)) {
        knownPorts.delete(id);
        states.delete(id);
        credentials.delete(id);
      }
    }
  }

  // /api/status 用：返回当前快照；过期时在后台补查一轮（没人看界面就不发 SSH）。
  function getState(serverId) {
    const current = states.get(serverId) || null;
    if (autoCheck && serverId && knownPorts.has(serverId)) {
      const last = current?.attemptedAt ?? 0;
      const interval = current?.error ? CLUSTER_ENV_RETRY_INTERVAL_MS : CLUSTER_ENV_CHECK_INTERVAL_MS;
      if (now() - last >= interval) {
        update(serverId, { attemptedAt: now() });
        check(serverId).catch(() => {});
      }
    }
    return current ? structuredClone(current) : null;
  }

  return { check, sync, syncCredential, onConfigRefreshed, getState, getCredentialState, credentialForRewrite };
}
