import { bus, EVENTS } from "./event-bus.mjs";

// 探针调度器：按 TTL 周期性执行注册的探针，带超时保护与 ssh 并发上限。
// 每个探针完成后通过事件总线广播 PROBE_UPDATED，供状态聚合器与 SSE 使用。
//
// 说明：返回对象额外暴露 tick()，方便单测通过注入的假 now 精确驱动调度决策，
//       而无需依赖真实 setInterval 的墙钟时间。
//
// T08 探针隔离（docs/reviews/2026-09-05/implementation/01 §11.2）：
//   - hostKey：SSH 探针按"实际主机"记账，新增每主机并发上限（默认 2，可经
//     CODEX_MONITOR_SSH_PER_HOST 配置且不超过全局上限）——一台慢主机最多占用
//     perHostLimit 个全局槽位，其余主机仍可进入空闲槽位。
//     与设计"默认 1"的偏差：活跃主机上 40s 的 doctor 会拖住 10s 的通道快探针
//     （remotePortOpen 新鲜度依赖它），默认 2 在防霸占与快探针节奏之间取平衡；
//     可配置到 1 恢复设计值。必要调整已记录于实施文档。
//   - 物理记账（A31）：Promise.race 超时只代表"放弃等待结果"，底层 ssh 子进程
//     由 exec 层负责终止；槽位必须等物理执行结算（或有界安全阀）后才释放，
//     绝不在子进程仍运行时把槽位发给别人。
//   - 优先级 + 老化：手动复核(override) > agents 层(故障验证) > 其余探针；
//     等待时长缓慢提升优先级防止饥饿（约 1 点/分钟）。同 rank 保持 FIFO。
//   - 周期抖动 ±10%（rng 可注入）：错开同拍到期，手动请求不受抖动影响。
//   - 插桩：getMetrics() 暴露全局/每主机占用、排队长度、启动/超时/合并计数。
//
// 主机退避（lib/probe-backoff.mjs，可选注入 hostBackoff）：一台主机 SSH 连不上且过了宽限期后，
// 它名下到期的周期探针被按住（不写结果、不顺延——闸门一开立即可发），每到退避时刻只放行一条
// 探路的（优先注册时标了 canary 的探针）。enabled() 门控照旧先于它；forceRun 不受它约束
// （手动复核、通道重启后的刷新、配置切换都是「现在就该探」的理由，结果同样喂给退避状态机）。
const DEFAULT_PER_HOST_LIMIT = 2;
// 门控跳过（enabled() 为假，含通道熔断）的结果 reason。tick 写入的 skipped 结果只此一种，
// listGateSkipped 据此把「被门控跳过」与探针自己 run 出来的 skipped（如仅监控）区分开。
const GATE_SKIP_REASON = "probe disabled";

export function createProbeScheduler({
  tickMs = 1000,
  sshConcurrency = 3,
  perHostSshLimit,
  forceRunDebounceMs = 5000,
  // 库默认 0（确定性，存量测试依赖）；生产装配显式传 0.1 启用设计 §11.2 的 ±10% 周期抖动。
  jitterRatio = 0,
  rng = Math.random,
  now = Date.now,
  hostBackoff = null,
} = {}) {
  const probes = new Map(); // id -> probe 定义
  const results = new Map(); // id -> 最近一次结果
  const inflight = new Map(); // id -> 进行中的 Promise
  const runSeq = new Map(); // id -> 单调递增运行序号（用于丢弃迟到结果）
  // 仅记录由 forceRun 发起且已真实结算的运行。tick 的周期性结果不参与，
  // 否则一次正常轮询会意外吞掉用户/信号的下一次即时请求。
  const recentForceRuns = new Map(); // debounceKey -> { completedAt, result }
  // 已进入 SSH 槽位队列的 forceRun 按常规/人工覆盖两个语义分别合并。
  // 人工覆盖不能被先前的常规等待者降级；反过来常规请求也不能借用人工覆盖。
  const queuedForceRuns = new Map(); // id -> { normal?: Promise, override?: Promise }
  let sshActive = 0; // 当前占用的 ssh 并发槽位数（探针运行 + acquireSshSlot 外部占用）
  const hostActive = new Map(); // hostKey -> 占用数（探针 + 外部借用统一记账）
  // 等待槽位的授予队列：{ grant, rank, queuedAt, hostKey }。drain 按
  // 优先级 + 老化选择，同 rank 保持 FIFO（与升级前行为兼容）。
  const slotWaiters = [];
  let timer = null;

  const effectivePerHostLimit = (() => {
    const raw = perHostSshLimit ?? Number(process.env.CODEX_MONITOR_SSH_PER_HOST);
    const n = Number.isFinite(raw) && Number(raw) > 0 ? Math.trunc(Number(raw)) : DEFAULT_PER_HOST_LIMIT;
    return Math.min(n, sshConcurrency);
  })();

  // 插桩计数（getMetrics 只读快照）。
  const metrics = {
    launches: 0,
    timeouts: 0,
    errors: 0,
    forceRunMerges: 0,
    lastTickLaunched: 0,
    lastTickAt: null,
  };

  function resolveHostKey(probe) {
    const value = typeof probe.hostKey === "function" ? probe.hostKey() : probe.hostKey;
    return value ? String(value).slice(0, 128) : null;
  }

  function hostCount(hostKey) {
    return hostKey ? (hostActive.get(hostKey) || 0) : 0;
  }

  function acquireHost(hostKey) {
    if (!hostKey) return;
    hostActive.set(hostKey, (hostActive.get(hostKey) || 0) + 1);
  }

  function releaseHost(hostKey) {
    if (!hostKey) return;
    const next = (hostActive.get(hostKey) || 0) - 1;
    if (next <= 0) hostActive.delete(hostKey);
    else hostActive.set(hostKey, next);
  }

  // 有空闲槽位时按"优先级 + 老化"唤醒等待者；每个授予回调必须"同步"消费一个槽位
  //（sshActive += 1 且 host 记账），否则视为放弃该次机会，槽位留给下一个等待者。
  function waiterRank(waiter) {
    const ageMs = Math.max(0, now() - waiter.queuedAt);
    return waiter.rank + ageMs / 60000; // 约 1 点/分钟的老化
  }

  function drainSlotWaiters() {
    while (slotWaiters.length && sshActive < sshConcurrency) {
      let bestIdx = -1;
      let bestRank = -Infinity;
      for (let i = 0; i < slotWaiters.length; i += 1) {
        const waiter = slotWaiters[i];
        if (waiter.hostKey && hostCount(waiter.hostKey) >= effectivePerHostLimit) continue;
        const rank = waiterRank(waiter);
        if (rank > bestRank) {
          bestRank = rank;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) return; // 剩余等待者都被各自主机上限挡住
      const [waiter] = slotWaiters.splice(bestIdx, 1);
      waiter.grant();
    }
  }

  function registerProbe({
    id,
    layer,
    intervalMs,
    timeoutMs,
    usesSsh = false,
    hostKey = null,
    enabled = () => true,
    // 主机退避期间优先拿它探路（耗时最短、结论最要紧的那条）。
    canary = false,
    run,
  }) {
    if (!id || typeof run !== "function") {
      throw new Error("registerProbe 需要 id 和 run");
    }
    probes.set(id, { id, layer, intervalMs, timeoutMs, usesSsh, hostKey, enabled, canary: canary === true, run });
  }

  // v2.16 自适应节奏：intervalMs 允许是函数 (justRecordedResult) => ms——探针可按
  // 本轮结果动态决定下次间隔（如 doctor 健康稳态降频）。数字则维持固定间隔旧语义。
  // T08：周期抖动 ±10%（rng 注入）——错开同拍到期；skipped 轮不抖动（便于测试确定性）。
  function intervalFor(probe, result, { jitter = true } = {}) {
    const base = typeof probe.intervalMs !== "function"
      ? probe.intervalMs
      : Number(probe.intervalMs(result));
    const ms = Number.isFinite(base) && base > 0 ? base : 60000;
    if (!jitter || jitterRatio <= 0 || (result && result.level === "skipped")) return ms;
    const factor = 1 + (rng() * 2 - 1) * jitterRatio;
    const jittered = Math.round(ms * factor);
    return Number.isFinite(jittered) && jittered > 0 ? jittered : ms;
  }

  function getResult(id) {
    return results.get(id);
  }

  // 探针当前是否在册（只读）。配置热载会增删 agent 探针，按 id 定向补跑的调用方先查一下。
  function isRegistered(id) {
    return probes.has(id);
  }

  // 最近一次结果是门控跳过的探针 id（注册序）。跳过轮按完整间隔排下一次（agent 90s、
  // 验证 5 分钟）——通道恢复时由调用方据此 forceRun 补跑，不必等间隔走完。只读，不改调度状态。
  function listGateSkipped() {
    return [...probes.keys()].filter((id) => {
      const result = results.get(id);
      return result?.level === "skipped" && result.reason === GATE_SKIP_REASON;
    });
  }

  // 记录结果：仅当该运行序号仍是最新时才写入，避免超时后迟到的真实结果覆盖新值。
  function recordResult(probe, seq, result, durationMs) {
    if (runSeq.get(probe.id) !== seq) return; // 已被更新的运行取代，丢弃
    const checkedAt = now();
    const full = {
      level: result.level,
      reason: result.reason,
      data: result.data,
      probeContext: result.probeContext ?? null,
      checkedAt,
      nextCheckAt: checkedAt + intervalFor(probe, result),
      durationMs,
      error: Boolean(result.error),
    };
    results.set(probe.id, full);
    bus.emit(EVENTS.PROBE_UPDATED, { id: probe.id, layer: probe.layer, result: full });
  }

  // 实际发起一次探针运行；返回结算后的结果 Promise，并登记到 inflight。
  function launch(probe) {
    const existing = inflight.get(probe.id);
    if (existing) return existing;

    const seq = (runSeq.get(probe.id) ?? 0) + 1;
    runSeq.set(probe.id, seq);

    const startedAt = now();
    const isSsh = probe.usesSsh;
    const hostKey = resolveHostKey(probe);
    if (isSsh) {
      sshActive += 1;
      acquireHost(hostKey);
    }
    metrics.launches += 1;

    // 同步调用 run()，保证并发计数在 tick 返回前即已反映真实启动数。
    let runPromise;
    try {
      runPromise = Promise.resolve(probe.run());
    } catch (err) {
      runPromise = Promise.reject(err);
    }
    // run 自身的异常收敛为标记对象，避免 race 直接 reject。
    const guarded = runPromise.then(
      (value) => ({ __value: value }),
      (err) => ({ __error: err }),
    );

    let timeoutHandle;
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ __timeout: true }),
        probe.timeoutMs,
      );
    });

    const settle = (async () => {
      const raced = await Promise.race([guarded, timeoutPromise]);
      clearTimeout(timeoutHandle);

      let result;
      if (raced.__timeout) {
        result = {
          level: "error",
          reason: `timeout after ${probe.timeoutMs}ms`,
          error: true,
        };
      } else if (raced.__error) {
        const err = raced.__error;
        result = {
          level: "error",
          reason: err?.message ? err.message : String(err),
          error: true,
        };
      } else {
        result = raced.__value || {};
      }
      if (result.error) metrics.errors += 1;
      if (result.level === "error" && /timeout/.test(String(result.reason || ""))) metrics.timeouts += 1;

      recordResult(probe, seq, result, now() - startedAt);
      return results.get(probe.id) ?? result;
    })();

    // T08 物理记账：结果在 race 结算即可返回给调用方，但 SSH 槽位必须等底层
    // 执行真正结算后才释放——exec 层有自己的 SIGTERM→SIGKILL 超时预算，
    // 这里的安全阀只是兜底（防止 run 实现遗漏超时导致槽位永久泄漏）。
    if (isSsh) {
      const safetyMs = probe.timeoutMs * 2 + 10000;
      let safetyHandle;
      const safety = new Promise((resolve) => {
        safetyHandle = setTimeout(resolve, safetyMs);
      });
      if (typeof safetyHandle.unref === "function") safetyHandle.unref();
      Promise.race([guarded, safety]).catch(() => {}).then(() => {
        clearTimeout(safetyHandle);
        sshActive -= 1;
        releaseHost(hostKey);
        // 探路探针的「在飞」标记与槽位同一时刻放开：子进程还没结束就不放下一条探路的。
        if (hostBackoff && hostKey) hostBackoff.settle(hostKey, probe.id);
        drainSlotWaiters();
      });
    }

    // 无论成败都要清理 inflight（结果侧），并唤醒排队等待槽位者由物理结算路径负责。
    const cleaned = settle.finally(() => {
      if (inflight.get(probe.id) === cleaned) inflight.delete(probe.id);
    });
    inflight.set(probe.id, cleaned);
    return cleaned;
  }

  // 判断某探针在当前时刻是否到期需要执行。
  function isDue(probe) {
    const prev = results.get(probe.id);
    if (!prev) return true;
    return now() >= prev.nextCheckAt;
  }

  // 主机退避：到了探测时刻的主机各选一条探路探针（到期、未在飞、门控放行；标了 canary 的优先，
  // 其次按注册序）。返回 hostKey -> probeId。
  function pickCanaries() {
    const picks = new Map();
    if (!hostBackoff) return picks;
    const waiting = new Set(hostBackoff.hostsAwaitingCanary());
    if (waiting.size === 0) return picks;
    for (const probe of probes.values()) {
      if (!probe.usesSsh || inflight.has(probe.id) || !isDue(probe)) continue;
      const hostKey = resolveHostKey(probe);
      if (!hostKey || !waiting.has(hostKey)) continue;
      const current = picks.get(hostKey);
      if (current && (current.canary || !probe.canary)) continue;
      if (!probe.enabled()) continue;
      picks.set(hostKey, probe);
    }
    return picks;
  }

  // 一次调度轮询：处理所有到期探针，尊重 enabled、全局 ssh 并发与每主机上限。
  function tick() {
    if (hostBackoff) hostBackoff.beat();
    const canaries = pickCanaries();
    let launched = 0;
    for (const probe of probes.values()) {
      if (inflight.has(probe.id)) continue;
      if (!isDue(probe)) continue;

      if (!probe.enabled()) {
        const checkedAt = now();
        const skipped = {
          level: "skipped",
          reason: GATE_SKIP_REASON,
          data: null,
          checkedAt,
          nextCheckAt: checkedAt + intervalFor(probe, { level: "skipped" }, { jitter: false }),
          durationMs: 0,
          error: false,
        };
        results.set(probe.id, skipped);
        bus.emit(EVENTS.PROBE_UPDATED, { id: probe.id, layer: probe.layer, result: skipped });
        continue;
      }

      // ssh 探针受全局上限与每主机上限双重约束，超额则留待下一轮。
      if (probe.usesSsh) {
        const hostKey = resolveHostKey(probe);
        const holding = Boolean(hostBackoff && hostKey && hostBackoff.isHolding(hostKey));
        // 主机退避中：只有被选中探路的那条往下走，其余按住（保持到期，闸门一开立即可发）。
        if (holding && canaries.get(hostKey) !== probe) {
          hostBackoff.hold(hostKey, probe.id);
          continue;
        }
        // 刚清零的主机：被按住过的探针错开恢复，不在同一拍齐发。
        if (!holding && hostBackoff && hostBackoff.isResumeDeferred(probe.id)) continue;
        if (sshActive >= sshConcurrency) continue;
        if (hostKey && hostCount(hostKey) >= effectivePerHostLimit) continue;
        if (holding && !hostBackoff.admit(hostKey, probe.id)) continue;
      }

      launch(probe);
      launched += 1;
    }
    metrics.lastTickLaunched = launched;
    metrics.lastTickAt = now();
    return launched;
  }

  // 立即运行指定探针（忽略 TTL）；若已在进行中则复用同一 Promise，不双跑。
  // SSH 探针受并发上限约束：槽位满载时排队，待有槽位释放再启动（不再无视上限直接发起）。
  // 熔断门控与 tick 一致：enabled() 为假时不发起（通道断开/手动停止时的手动检测
  // 只会产生必超时的 SSH 命令），以 skipped 结果结算。
  //
  // T02（A09）：contextKey 让 forceRun 防抖缓存按上下文区分——配置热载后立即
  // forceRun 时，旧上下文的 5s 防抖缓存不得吞掉新上下文的真实检查。不传 contextKey
  // 保持既有键形状（旧调用方零回归）。
  function forceRun(id, { overrideBreaker = false, contextKey = "" } = {}) {
    const probe = probes.get(id);
    if (!probe) return Promise.reject(new Error(`未注册的探针: ${id}`));
    const existing = inflight.get(id);
    if (existing) {
      metrics.forceRunMerges += 1;
      return existing;
    }
    const debounceKey = contextKey ? `${id}#${contextKey}` : id;

    // 只拒绝本次手动触发，不写 results、不发事件、不动 nextCheckAt：
    // 覆盖上一次真实结果或顺延 TTL 会让面板卡在"跳过"且推迟熔断恢复后的首次真实探测。
    if (!overrideBreaker && !probe.enabled()) {
      return Promise.resolve({
        level: "skipped",
        reason: GATE_SKIP_REASON,
        data: null,
        checkedAt: now(),
        durationMs: 0,
        error: false,
      });
    }

    // 自动触发在短窗口内合并为最近一次真实 forceRun 的结果，防止日志信号
    // 或配置刷新风暴重复创建 SSH 会话。熔断检查必须先于此处，确保通道断开
    // 后绝不把旧的健康结果伪装成当前可用。显式人工重试既绕过防抖，也可作为
    // 熔断期的恢复通道。
    const recent = recentForceRuns.get(debounceKey);
    const elapsed = recent ? now() - recent.completedAt : Infinity;
    if (!overrideBreaker && recent && elapsed >= 0 && elapsed < forceRunDebounceMs) {
      metrics.forceRunMerges += 1;
      return Promise.resolve(recent.result);
    }

    const hostKey = resolveHostKey(probe);
    const hostFull = Boolean(probe.usesSsh && hostKey && hostCount(hostKey) >= effectivePerHostLimit);
    if (probe.usesSsh && (sshActive >= sshConcurrency || hostFull)) {
      const queueKind = overrideBreaker ? "override" : "normal";
      const queuedForProbe = queuedForceRuns.get(id) || {};
      if (queuedForProbe[queueKind]) {
        metrics.forceRunMerges += 1;
        return queuedForProbe[queueKind];
      }

      let queued;
      queued = new Promise((resolve) => {
        // 授予时同步启动：grant 内的 launchForceRun → launch 会同步 sshActive += 1
        // 并做 host 记账（此处绝不重复计数，否则槽位泄漏、后续等待者饿死），
        // 故 drain 循环不会超发。
        const waiter = {
          rank: overrideBreaker ? 3 : (probe.layer === "agents" ? 2 : 1),
          queuedAt: now(),
          hostKey,
          grant: () => {
            // 等待期间探针可能已被注销（配置重载）；若如此则放弃启动，不消费槽位。
            if (!probes.has(id)) {
              resolve({ level: "skipped", reason: "probe unregistered" });
              return;
            }
            // 等待期间可能已被 tick 启动；若如此则复用其 Promise，不消费本次槽位。
            const again = inflight.get(id);
            if (again) {
              resolve(again);
              return;
            }
            // 等待期间熔断可能已闭合（通道断开/手动停止）；此时放弃启动，不消费槽位——
            // 否则会发起一条必超时的 SSH 命令，占满恢复探测所需的并发额度。
            if (!overrideBreaker && !probe.enabled()) {
              resolve({ level: "skipped", reason: GATE_SKIP_REASON });
              return;
            }
            resolve(launchForceRun(probe, { contextKey }));
          },
        };
        // 标记该等待者归属，供 unregisterProbe 精确剪除（acquireSshSlot 的匿名等待者无此标记）。
        waiter.probeId = id;
        waiter.resolveUnregistered = () =>
          resolve({ level: "skipped", reason: "probe unregistered" });
        slotWaiters.push(waiter);
      });
      queuedForProbe[queueKind] = queued;
      queuedForceRuns.set(id, queuedForProbe);
      queued.finally(() => {
        const current = queuedForceRuns.get(id);
        if (!current || current[queueKind] !== queued) return;
        delete current[queueKind];
        if (!current.normal && !current.override) queuedForceRuns.delete(id);
      });
      return queued;
    }
    return launchForceRun(probe, { contextKey });
  }

  // 将真实 forceRun 的结果写入防抖缓存（按 contextKey 区分）。回调在 launch 返回给
  // 调用方之前挂上，因而 await forceRun() 返回时缓存已经可供紧随其后的自动触发合并
  // 使用；仍然返回 launch 的原 Promise，维持同一探针并发调用的 Promise 身份复用契约。
  function launchForceRun(probe, { contextKey = "" } = {}) {
    const debounceKey = contextKey ? `${probe.id}#${contextKey}` : probe.id;
    const launched = launch(probe);
    launched.then((result) => {
      recentForceRuns.set(debounceKey, { completedAt: now(), result });
    });
    return launched;
  }

  // 注销探针：清除定义、最近结果与运行序号。进行中的运行结算时 seq 已不匹配，迟到结果被自然丢弃。
  // 同时剪除该 id 尚在排队的 forceRun 等待者，否则槽位释放后 drain 会跑一次陈旧探针并重新写入 results / 发出 PROBE_UPDATED。
  function unregisterProbe(id) {
    probes.delete(id);
    results.delete(id);
    runSeq.delete(id);
    recentForceRuns.delete(id);
    queuedForceRuns.delete(id);
    for (let i = slotWaiters.length - 1; i >= 0; i -= 1) {
      if (slotWaiters[i].probeId === id) {
        const [waiter] = slotWaiters.splice(i, 1);
        waiter.resolveUnregistered?.(); // 让排队的 forceRun 调用方以 skipped 结算而非悬挂
      }
    }
  }

  // 外部占用一个 ssh 并发槽位（bootstrap 等直连 SSH 的调用方使用），返回幂等的释放函数。
  // 槽位空闲则同步占用；否则排队，待 drain 按优先级授予。授予与占用同步完成，避免并发过额。
  // T08：可选 hostKey——外部 SSH（bootstrap 向导等）与探针共用每主机记账，
  // 无法归属时仍受全局限流（不漏算真实 SSH）。
  function acquireSshSlot({ hostKey = null } = {}) {
    const normalizedHost = hostKey ? String(hostKey).slice(0, 128) : null;
    return new Promise((resolve) => {
      const grant = () => {
        sshActive += 1;
        acquireHost(normalizedHost);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          sshActive -= 1;
          releaseHost(normalizedHost);
          drainSlotWaiters();
        });
      };
      if (sshActive < sshConcurrency && (!normalizedHost || hostCount(normalizedHost) < effectivePerHostLimit)) grant();
      else slotWaiters.push({ rank: 1, queuedAt: now(), hostKey: normalizedHost, grant });
    });
  }

  // T08 插桩：调度器内部观测（只读快照；不含命令串/URL/用户名等高基数字段）。
  function getMetrics() {
    return {
      sshActive,
      sshConcurrency,
      perHostSshLimit: effectivePerHostLimit,
      hostActive: Object.fromEntries(hostActive),
      queuedWaiters: slotWaiters.length,
      registeredProbes: probes.size,
      inflightProbes: inflight.size,
      launches: metrics.launches,
      timeouts: metrics.timeouts,
      errors: metrics.errors,
      forceRunMerges: metrics.forceRunMerges,
      lastTickLaunched: metrics.lastTickLaunched,
      lastTickAt: metrics.lastTickAt,
      backoff: hostBackoff ? hostBackoff.getMetrics() : null,
    };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        tick();
      } catch {
        // 调度循环必须持续运行，单轮异常不应中断定时器。
      }
    }, tickMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    registerProbe,
    unregisterProbe,
    getResult,
    isRegistered,
    listGateSkipped,
    forceRun,
    acquireSshSlot,
    getMetrics,
    start,
    stop,
    tick,
  };
}
