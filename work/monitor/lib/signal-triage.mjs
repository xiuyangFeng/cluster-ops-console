// 卡顿信号根因分类器（纯函数、无 IO）：把排障 SOP 代码化。
//
// 历史教训：通道"经常卡"曾长期按隧道问题排查，最终根因是账号层
// （device_revoked / account_banned）。红条此前只报现象（如"网关不健康"），
// 用户还得自己分诊；而分诊所需的三份数据系统里全有——卡顿信号条目、
// 账号层状态（agentsStatus 的 accountFault/loggedIn、凭证 expiry）、
// 通道各层状态（state-store 的 layers）。本模块把它们合成一个结论。
//
// 输入：
//   signal   —— log-signals 引擎的信号条目（{ id, category, severity, ... }）
//   snapshot —— 信号发生当拍的状态快照：
//     { layers: stateStore.getLayers() 结果, agentsStatus, health }
//     三块都可缺省/残缺（快照缺字段一律按"证据不足"处理，绝不抛错）。
// 输出：{ rootCause, label, advice, severity }
//
// TRIAGE_RULES 按优先级从高到低排列——这个顺序就是排障 SOP 的分诊顺序，
// 首个命中即结论（如账号故障与通道断同时存在时判 account：账号层故障常
// 伴随通道探测异常，先修根因）。末条 unknown 恒真兜底。规则表是数据结构，
// 追加新根因只需插入一条 { rootCause, label, severity, advice, match }。

// ---- 证据视图推导（防御性：任何字段缺失都归位为"无证据"） ----

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

// 快照 + 信号条目 → 归一化证据视图。规则的 match 只面向这个视图，
// 不直接触碰原始快照，保证缺字段兜底集中在这一处。
export function deriveTriageView(signal, snapshot) {
  const sig = asObject(signal);
  const snap = asObject(snapshot);
  const layers = asObject(snap.layers);
  const channelDetail = asObject(asObject(layers.channel).detail);
  const agentsStatus = Object.values(asObject(snap.agentsStatus));
  const layerAgents = Object.values(asObject(layers.agents));

  const accountFaults = new Set();
  for (const status of agentsStatus) {
    const fault = asObject(status).accountFault;
    if (fault === "revoked" || fault === "banned") accountFaults.add(fault);
  }
  for (const agent of layerAgents) {
    const health = asObject(agent).health;
    if (health === "revoked" || health === "banned") accountFaults.add(health);
  }
  // 信号条目自身就是账号层证据：account-revoked/banned 信号来自日志原文的
  // device_revoked/account_banned 命中（与 detectAccountFault 同规则）。日志信号
  // 先于 reclaude 探针复核到达（onSignals 才触发 forceRun），此时 agentsStatus
  // 还没跟上——不吃这份证据就会把账号层故障误判为 channel/unknown，恰恰重演
  // 当年"排查很久才发现是账号层"的老路。
  if (sig.id === "account-revoked") accountFaults.add("revoked");
  if (sig.id === "account-banned") accountFaults.add("banned");

  const credentialExpired = [...agentsStatus, ...layerAgents]
    .some((entry) => asObject(asObject(entry).expiry).level === "expired");

  const authPending = agentsStatus.some((status) => asObject(status).loggedIn === false)
    || layerAgents.some((agent) => asObject(agent).health === "auth-required");

  // 还没领反向端口（通道层 setupPending，v2.54）：隧道本来就不会建，"隧道不通"是配置未完成的
  // 必然结果而非故障——归 setup，绝不算通道断（否则自动修复会对着它反复重启通道直到预算耗尽）。
  // 本地代理没起来仍是真故障，照常算通道断。
  const setupPending = asObject(layers.channel).setupPending === true || channelDetail.setupPending === true;

  // 通道断：隧道/本地代理/远端口任一明确为 false 才算（缺字段不算断，兜底走 unknown）。
  // 另一台 Mac 在承载、本机待命（v2.88）：本机没有隧道进程不是断开。
  const handoverStandby = asObject(layers.channel).handoverStandby === true || channelDetail.handoverStandby === true;
  const channelDown = channelDetail.localProxyUp === false
    || (!setupPending && ((channelDetail.tunnelUp === false && !handoverStandby) || channelDetail.remotePortOpen === false));
  const channelOk = asObject(layers.channel).level === "ok"
    || (channelDetail.localProxyUp === true
      && channelDetail.tunnelUp === true
      && channelDetail.remotePortOpen === true);

  // 上游退化：agent 端点探测失败在两侧都收敛为 health === "degraded"
  // （codex: endpoint.ok=false；reclaude: gatewayOk=false/claudeEndpoint 失败），
  // 全局 health 的 degraded 同义（classifyHealth 对 endpoint 失败的收敛值）。
  const upstreamDegraded = agentsStatus.some((status) => asObject(status).health === "degraded")
    || layerAgents.some((agent) => asObject(agent).health === "degraded")
    || snap.health === "degraded";

  const rateLimited = sig.id === "rate-limited";
  const http5xx = sig.id === "http-5xx";

  return { accountFaults, credentialExpired, authPending, setupPending, channelDown, channelOk, upstreamDegraded, rateLimited, http5xx };
}

// ---- 规则表（顺序即 SOP 优先级，高→低） ----
// match(view)：返回真值即命中；返回 { advice } 可覆写本条默认 advice（account
// 按 revoked/banned/expired 给差异化处置建议）。

export const TRIAGE_RULES = [
  {
    rootCause: "account",
    label: "账号层故障",
    severity: "error",
    advice: "账号层异常，请在服务器上检查 reclaude/codex 登录与凭证状态",
    match(view) {
      if (view.accountFaults.has("revoked")) return { advice: "设备已解绑，需在服务器重新登录" };
      if (view.accountFaults.has("banned")) return { advice: "绑定账号被封禁，需更换账号" };
      if (view.credentialExpired) return { advice: "凭证已过期，需在服务器重新登录刷新凭证" };
      return null;
    },
  },
  {
    rootCause: "auth",
    label: "登录授权未完成",
    severity: "warn",
    advice: "等待设备登录授权",
    match: (view) => view.authPending,
  },
  {
    // 排在 channel 之前：没领端口时隧道不通是必然的，先说清"配置没完成"。本地代理没起来的
    // 真故障不受影响（setupPending 时 channelDown 只看本地代理，见 deriveTriageView）。
    rootCause: "setup",
    label: "未领取反向端口",
    severity: "info",
    advice: "还没领取反向端口，隧道不会建立（不是故障）；运行配置向导领取端口后再启动",
    match: (view) => view.setupPending && !view.channelDown,
  },
  {
    rootCause: "channel",
    label: "通道断开",
    severity: "error",
    advice: "通道断开，等待自愈或点一键修复",
    match: (view) => view.channelDown,
  },
  {
    rootCause: "upstream",
    label: "上游 API 不可达",
    severity: "warn",
    advice: "上游 API 不可达，通常是服务端抖动，稍候重试",
    match(view) {
      if (!view.channelOk) return null;
      if (view.rateLimited) return { advice: "链路与出网正常，触发上游 API 限流（429 / 配额限制），稍后自行恢复，无需重启隧道" };
      if (view.http5xx) return { advice: "链路与出网正常，上游 API 返回 5xx 服务端异常，稍后重试，无需重启隧道" };
      if (view.upstreamDegraded) return true;
      return null;
    },
  },
  {
    rootCause: "unknown",
    label: "根因未定位",
    severity: "info",
    advice: "根因未定位，查看日志与 Doctor 输出",
    match: () => true,
  },
];

export function classifySignal(signal, snapshot) {
  const view = deriveTriageView(signal, snapshot);
  for (const rule of TRIAGE_RULES) {
    let matched = null;
    try {
      matched = rule.match(view);
    } catch {
      // 规则自身抛错按未命中处理：分类器绝不反噬信号落盘主流程。
    }
    if (!matched) continue;
    const advice = typeof matched === "object" && typeof matched.advice === "string"
      ? matched.advice
      : rule.advice;
    return { rootCause: rule.rootCause, label: rule.label, advice, severity: rule.severity };
  }
  // 到不了这里：TRIAGE_RULES 末条 unknown 规则恒真。
}
