// 卡顿反馈信号引擎（纯函数、无 IO）：统一签名规则表 + 冷却/行级去重。
// 设计：docs/superpowers/specs/2026-07-23-log-signal-detection-design.md
//
// 规则匹配语义：
//   lineRe: RegExp[] —— 数组内每条正则都命中"同一行"才判定（多正则 AND，
//     沿用 detectAccountFault 的"code 字段 + status 数字"双匹配防误报策略）。
//   matchState: (stateObj) => boolean —— 仅 snapshot 源、JSON 可解析时调用。
// 注意：规则正则一律不带 g 标志（lastIndex 状态会串轮次）。

import { redactSensitive } from "./operation-context.mjs";

export const SIGNAL_RULES = [
  {
    id: "account-revoked",
    category: "account",
    severity: "error",
    title: "账号被解绑",
    advice: "在节点上重新登录 reclaude（reclaude login）后通道自动恢复",
    lineRe: [/device_revoked|此设备已被解绑/, /\bstatus[":\s]*401\b/],
  },
  {
    id: "account-banned",
    category: "account",
    severity: "error",
    title: "账号被封禁",
    advice: "当前绑定账号暂不可用，请更换绑定账号或联系管理员",
    lineRe: [/account_banned|账号暂不可用/, /\bstatus[":\s]*403\b/],
  },
  {
    id: "rate-limited",
    category: "request",
    severity: "warn",
    title: "请求被限流 (429)",
    advice: "上游限流，稍后自行恢复；频繁出现请降低并发",
    lineRe: [/\b429\b|rate.?limit/i, /status|error|http|request|limit/i],
  },
  {
    id: "request-timeout",
    category: "request",
    severity: "warn",
    title: "请求超时",
    advice: "上游或链路响应超时；持续出现请检查通道验证面板",
    lineRe: [/\btimed?\s?out\b|\btimeout\b/i, /request|stream|response|connect|upstream|gateway/i],
  },
  {
    id: "connection-reset",
    category: "request",
    severity: "warn",
    title: "连接被重置",
    advice: "链路连接中断；偶发可忽略，密集出现请检查隧道",
    lineRe: [/ECONNRESET|connection reset|broken pipe|socket hang ?up/i],
  },
  {
    id: "http-5xx",
    category: "request",
    severity: "warn",
    title: "上游 5xx 错误",
    advice: "上游服务异常；持续出现请检查网关与账号状态",
    lineRe: [/(unexpected status|status|http)[":\s]*5\d\d\b/i],
  },
  {
    // :30 抖动采样（2026-07-02 v2 终审跟进）：生产观察每小时 :30 (CST) 出现一次
    // 约 6s 的探测超时抖动——单次、下轮即恢复、来源未查明。这条规则是"取证"不是
    // "告警"：info 级（本表最低级，红条只认 error、log-tail 探针 level 结算也忽略
    // info），samplePrefix 把命中时刻的本地分钟数固化进 sample，攒一段时间后人工
    // 统计分钟分布即可验证是否集中在 :30±2。类目刻意不用 account——account 类新
    // 信号会触发 reclaude 探针 forceRun，采样规则绝不能有这种副作用。
    // 双正则 AND：超时字样 + 探测上下文限定词，避免任意业务超时行淹没取证样本。
    id: "probe-timeout-sample",
    category: "sampling",
    severity: "info",
    title: "探测超时采样（:30 抖动取证）",
    advice: "采样取证用：观察 sample 前缀 [minute=NN] 的分布是否集中在 :30±2",
    lineRe: [/\btimed?\s?out\b|\btimeout\b|超时/i, /probe|探测|primary-remote|remote-port|load[:\s]/i],
    // 固化命中时刻的本地分钟数（生产机与观察基准同为 CST，用本地时区即可对齐 :30）。
    samplePrefix: (ts) => `[minute=${String(new Date(ts).getMinutes()).padStart(2, "0")}] `,
  },
  {
    id: "gateway-unhealthy",
    category: "gateway",
    severity: "error",
    title: "网关不健康",
    advice: "reclaude daemon 自报网关异常，请检查节点网关进程",
    matchState: (state) => state?.gateway?.healthy === false,
  },
  {
    // 仅匹配 local_http_connect_proxy.mjs 的真实结构化输出；不能因文档、普通报错或
    // 某条请求里提到 "connect-deny" 就亮红条。supervisor 转发子进程 stdout 时固定
    // 加 [proxy] 前缀，裸前缀兼容直接采集代理 stdout 的部署方式。
    id: "connect-deny",
    category: "connect",
    severity: "error",
    title: "CONNECT 目标被拒绝",
    advice: "确认 proxyAllowedTargets 含该 host:port，更新配置后重启本地代理",
    lineRe: [/^(?:\[proxy\]\s+)?connect-deny host=(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\]) port=[1-9]\d{0,4}\s*$/],
  },
];

const RULE_BY_ID = new Map(SIGNAL_RULES.map((r) => [r.id, r]));

// 兼容导出：与旧 monitor-core 实现语义逐字一致——对"logs+state 整段拼接文本"
// 做 code 字段与 status 数字双正则匹配（可跨行），宁可漏报不可误报。
export function detectAccountFault(logsOutput = "", stateOutput = "") {
  const text = `${logsOutput || ""}\n${stateOutput || ""}`;
  if (RULE_BY_ID.get("account-revoked").lineRe.every((re) => re.test(text))) return "revoked";
  if (RULE_BY_ID.get("account-banned").lineRe.every((re) => re.test(text))) return "banned";
  return null;
}

// info 是采样级：排序垫底，绝不抢占 error/warn 的告警展示位。
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

// 冷却：同一规则同一来源 5 分钟内不重复上报为"新信号"（所有规则同一口径）。
const SIGNAL_COOLDOWN_MS = 300000;
// 活跃信号 10 分钟没再命中即过期；每个来源的行级去重最多记 2000 行（FIFO 淘汰）。
const ACTIVE_TTL_MS = 600000;
const MAX_SEEN_LINES = 2000;

export function createSignalEngine({ now = Date.now } = {}) {
  const seenBySource = new Map(); // sourceId -> { set: Set<line>, queue: string[] }（FIFO 淘汰）
  const lastFired = new Map(); // `${ruleId}:${sourceId}` -> 最近一次上报时间戳（用于冷却判定）
  // active 刻意只按 rule.id 归并（非 ruleId:sourceId）：所有日志源都是同一台主服务器上
  // 同一故障的不同观察面，同一故障类型在前端红条只应显示一条。跨源命中同一规则时，
  // 条目的 sourceId 语义是"最近一次命中的源"，firstSeenAt 是"跨源最早命中时刻"。
  // 这是明示契约（有测试固定），不是遗漏——冷却才需要区分源，归并展示不需要。
  const active = new Map(); // ruleId -> SignalHit

  function markSeen(sourceId, line) {
    let store = seenBySource.get(sourceId);
    if (!store) {
      store = { set: new Set(), queue: [] };
      seenBySource.set(sourceId, store);
    }
    if (store.set.has(line)) return false;
    store.set.add(line);
    store.queue.push(line);
    while (store.queue.length > MAX_SEEN_LINES) {
      store.set.delete(store.queue.shift());
    }
    return true;
  }

  // 命中登记：更新 active 表；冷却窗口内不重复上报为"新信号"。
  // 跨源归并契约：prev 可能来自另一个源——firstSeenAt 继承跨源最早值（"该故障最早
  // 何时被看见"），sourceId/sample/lastSeenAt 覆盖为本次命中（"最近一次在哪看见"）。
  function fire(rule, sourceId, sample, ts) {
    const prev = active.get(rule.id);
    const hit = {
      id: rule.id,
      category: rule.category,
      severity: rule.severity,
      title: rule.title,
      advice: rule.advice,
      sourceId,
      // sample 是远端日志原文，直接流入 layers.signals.active[]/lite.activeSignals[]，
      // 由未鉴权的 GET /api/status、/api/status-lite、SSE status 事件原样输出——必须在
      // 这里就脱敏，不能指望调用方记得脱敏。同一内容走 signalLogger 落盘时经
      // createLogger 的 redactSensitive 脱敏，这里保持两条路径一致。
      sample: redactSensitive(sample.slice(0, 400)),
      firstSeenAt: prev ? prev.firstSeenAt : ts,
      lastSeenAt: ts,
    };
    active.set(rule.id, hit);
    const key = `${rule.id}:${sourceId}`;
    const last = lastFired.get(key);
    if (last != null && ts - last <= SIGNAL_COOLDOWN_MS) return null;
    lastFired.set(key, ts);
    return hit;
  }

  function scan(sourceId, text, { snapshot = false } = {}) {
    const ts = now();
    const newSignals = [];
    let newLineCount = 0;
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      // snapshot 源是"状态快照"而非追加日志：整体每轮重扫，不做行级去重（靠冷却窗口限频）。
      const isNew = snapshot ? true : markSeen(sourceId, line);
      if (!isNew) continue;
      if (!snapshot) newLineCount += 1;
      for (const rule of SIGNAL_RULES) {
        if (!rule.lineRe) continue;
        if (!rule.lineRe.every((re) => re.test(line))) continue;
        // samplePrefix：采样类规则把命中时刻的派生信息（如分钟数）固化进 sample。
        // 在 fire 之前拼接，保证前缀与原文一起经过 fire 内的 redactSensitive。
        const sample = typeof rule.samplePrefix === "function" ? rule.samplePrefix(ts) + line : line;
        const hit = fire(rule, sourceId, sample, ts);
        if (hit) newSignals.push(hit);
      }
    }

    if (snapshot) {
      let stateObj = null;
      try {
        stateObj = JSON.parse(text);
      } catch {}
      if (stateObj) {
        for (const rule of SIGNAL_RULES) {
          if (!rule.matchState) continue;
          if (!rule.matchState(stateObj)) continue;
          const hit = fire(rule, sourceId, "state.json 快照命中", ts);
          if (hit) newSignals.push(hit);
        }
      }
    }
    return { newSignals, newLineCount };
  }

  function getActiveSignals() {
    const ts = now();
    const out = [];
    for (const [id, hit] of active) {
      if (hit.lastSeenAt + ACTIVE_TTL_MS < ts) {
        active.delete(id);
        continue;
      }
      out.push({ ...hit });
    }
    out.sort((a, b) =>
      (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.lastSeenAt - a.lastSeenAt));
    return out;
  }

  return { scan, getActiveSignals };
}
