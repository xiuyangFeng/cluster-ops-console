// team-galaxy-model.js —— 团队星图与成员名单共用的纯逻辑（无 DOM，Node 可直接单测）。
// 语义：恒星 = 集群；行星 = 成员；轨道由内到外 = 隧道在线 / 仅 SSH / 离线；行星大小 = 今日 token；
// 卫星 = 占用的 GPU 卡；连线 = 隧道链路（成员→集群）、同节点算力、同一份下发配置。

// 每个账号一颗固定颜色的行星：[高光, 本色, 暗面]。深空版亮、纸面版是低饱和的水彩色。
export const PLANET_HUES = {
  dark: [
    ["#dce9ff", "#8fb8ff", "#24386e"], ["#fff1dc", "#f2c38b", "#6f421b"], ["#efe6ff", "#c3a8ff", "#3b2a70"],
    ["#dcfff6", "#7fd8c4", "#18504a"], ["#ffe6ec", "#ff9fb4", "#6e2a3f"], ["#fbf6e8", "#e3d6b4", "#5f5034"],
    ["#e1f3ff", "#89c9f5", "#1b4670"], ["#ffe7da", "#ffad85", "#6e331b"], ["#e9fbe3", "#a5df98", "#2a5626"],
  ],
  light: [
    ["#e3e8f3", "#5b6fa3", "#2c3a63"], ["#f4e6cb", "#b8843d", "#6b4a1a"], ["#ebe2f1", "#83679e", "#43305a"],
    ["#dfeee8", "#558e7f", "#284d44"], ["#f3dee2", "#b45e72", "#6b2c3c"], ["#f1ebdb", "#a39268", "#5c5038"],
    ["#dfeaf3", "#5687ad", "#284a66"], ["#f4e0d2", "#b86a43", "#6b3519"], ["#e5f0de", "#6f9554", "#36522a"],
  ],
};

export const ORBIT_KEYS = ["tunnel-online", "ssh-only", "offline"];
// 账号名排序共用一个比较器：localeCompare(…, "en") 每次比较都会新建一个 collator
export const compareUser = new Intl.Collator("en").compare;
export const ORBIT_NAMES = ["隧道在线", "仅 SSH", "离线"];
// 秒/圈：慢到几乎察觉不到，只留"在动"的感觉
export const ORBIT_PERIODS = [300, 440, 760];

export function strHash(text) {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hueIdxCache = new Map();
export function hueIndexOf(user) {
  const key = String(user ?? "");
  let idx = hueIdxCache.get(key);
  if (idx !== undefined) return idx;
  idx = strHash(key) % PLANET_HUES.dark.length;
  if (hueIdxCache.size >= 512) hueIdxCache.delete(hueIdxCache.keys().next().value);
  hueIdxCache.set(key, idx);
  return idx;
}

export function planetHue(user, theme = "dark") {
  return PLANET_HUES[theme === "light" ? "light" : "dark"][hueIndexOf(user)];
}

// 名单 / 信息卡里的迷你行星：两套主题的颜色都写进内联变量，team-admin.css 按 body[data-theme]
// 把 --hue-* 指到其中一套——切主题不用重渲名单。
const hueStyleCache = new Map();
export function hueStyle(user) {
  const key = String(user ?? "");
  let s = hueStyleCache.get(key);
  if (s !== undefined) return s;
  const [dh, db, dl] = planetHue(key, "dark");
  const [lh, lb, ll] = planetHue(key, "light");
  s = `--hd-hi:${dh};--hd-base:${db};--hd-lo:${dl};--hl-hi:${lh};--hl-base:${lb};--hl-lo:${ll}`;
  if (hueStyleCache.size >= 512) hueStyleCache.delete(hueStyleCache.keys().next().value);
  hueStyleCache.set(key, s);
  return s;
}

export function orbitIndexOf(member) {
  const i = ORBIT_KEYS.indexOf(member?.onlineState);
  return i < 0 ? 2 : i;
}

export function isOnlineMember(member) {
  return member?.onlineState === "tunnel-online" || member?.onlineState === "ssh-only";
}

// 时间字段兼容毫秒数与 ISO 字符串（模型里 lastSeenAt / checkedAt 是毫秒数）。
export function toMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const EGRESS_REASON_LABELS = {
  "upstream-timeout": "上游代理超时",
  "upstream-refused": "上游代理拒绝连接",
  "target-failures": "部分目标站点连续失败",
  "proxy-down": "本机代理未运行",
};

export function egressReasonLabel(reason) {
  return EGRESS_REASON_LABELS[reason] || (reason ? String(reason) : "");
}

// 成员身上的问题，按严重程度排好：crit（红）> warn（琥珀）> info（蓝）。
// 名单行只露第一条，其余进详情；星图上的虚线环取第一条的色调。
const memberFlagsCache = new WeakMap();
export function memberFlags(m) {
  if (!m || typeof m !== "object") return [];
  const cached = memberFlagsCache.get(m);
  if (cached) return cached;
  const flags = [];
  const errors = Number(m.usage?.todayErrors) || 0;
  if (errors > 0) flags.push({ tone: "crit", text: `今日 ${errors} 次失败` });
  if (m.egress?.state === "error") flags.push({ tone: "crit", text: "出网异常", title: egressReasonLabel(m.egress.reason) });
  if (m.assignment?.state === "error") flags.push({ tone: "crit", text: "配置同步异常", title: m.assignment.message || "" });
  const loginGpus = Number(m.compute?.loginGpuCount) || 0;
  if (loginGpus > 0) {
    flags.push({ tone: "warn", text: `登录节点占卡 ×${loginGpus}`, title: "在登录节点直接占用 GPU，建议改用 srun / sbatch 提交到计算节点" });
  }
  const unmanagedGpus = Math.max(0, (Number(m.compute?.unmanagedGpuCount) || 0) - loginGpus);
  if (unmanagedGpus > 0) {
    flags.push({ tone: "warn", text: `非 Slurm 占卡 ×${unmanagedGpus}`, title: "在计算节点绕过 Slurm 队列直接占用 GPU，可能与调度作业冲突" });
  }
  const idleGpus = Number(m.compute?.idleGpuCount) || 0;
  if (idleGpus > 0) {
    flags.push({ tone: "warn", text: `GPU 0% 空占 ×${idleGpus}`, title: "占用显存 ≥1 GiB 但所在 GPU 利用率为 0%，建议检查是否进程挂起未释放" });
  }
  if (m.portDrift) {
    const reg = Array.isArray(m.registeredPorts) ? m.registeredPorts : [];
    flags.push({ tone: "warn", text: "端口漂移", title: `实际登记 :${reg.join(", :")}，预分配 :${m.assignedPort}` });
  }
  if (m.versionOutdated) flags.push({ tone: "warn", text: "版本偏旧", title: m.clientVersion ? `客户端 v${m.clientVersion}` : "" });
  if (m.assignment?.state === "pending-pubkey") flags.push({ tone: "warn", text: "待公钥上报", title: "成员尚未上报公钥，配置已加密暂存在管理员本机" });
  if (m.assignment?.state === "pending-sync") flags.push({ tone: "info", text: "配置待同步", title: "已写入集群，等成员工作台在线同步" });
  memberFlagsCache.set(m, flags);
  return flags;
}

export function memberTone(m) {
  return memberFlags(m)[0]?.tone || "";
}

const maxTokCache = new WeakMap();
export function maxTodayTokens(members) {
  if (!Array.isArray(members)) return 0;
  let max = maxTokCache.get(members);
  if (max !== undefined) return max;
  max = 0;
  for (const m of members) max = Math.max(max, Number(m?.usage?.todayTokens) || 0);
  maxTokCache.set(members, max);
  return max;
}

// 行星半径：sqrt 刻度（面积 ∝ 用量）；人多时整体收小，免得挤成一团。
export function planetRadius(member, maxTokens, crowded = false) {
  const t = Math.max(0, Number(member?.usage?.todayTokens) || 0);
  const base = crowded ? 4.2 : 5;
  const span = crowded ? 8.5 : 11;
  return base + span * Math.sqrt(maxTokens > 0 ? Math.min(1, t / maxTokens) : 0);
}

// 三条轨道上的成员，各自按账号名排序：同一批人每次刷新都落在同一个槽位，不跳。
export function assignOrbits(members) {
  const orbits = [[], [], []];
  for (const m of Array.isArray(members) ? members : []) {
    if (m && typeof m.user === "string") orbits[orbitIndexOf(m)].push(m);
  }
  for (const o of orbits) o.sort((a, b) => compareUser(a.user, b.user));
  return orbits;
}

// 星座：同节点（只看正在算的：有运行作业或占着 GPU）与同一份配置（assignment.groupKey）。
// 少于 2 人不成星座。
export function buildConstellations(members) {
  const list = Array.isArray(members) ? members : [];
  const node = new Map();
  const config = new Map();
  for (const m of list) {
    if (!m || typeof m.user !== "string") continue;
    const busy = (Number(m.compute?.runningJobs) || 0) > 0 || (Number(m.compute?.gpuCount) || 0) > 0;
    if (busy) {
      for (const n of Array.isArray(m.compute?.nodes) ? m.compute.nodes : []) {
        if (!node.has(n)) node.set(n, []);
        if (!node.get(n).includes(m.user)) node.get(n).push(m.user);
      }
    }
    const key = m.assignment?.state && m.assignment.state !== "none" ? m.assignment.groupKey : null;
    if (key) {
      if (!config.has(key)) config.set(key, { label: m.assignment.groupLabel || "统一配置", users: [] });
      config.get(key).users.push(m.user);
    }
  }
  return {
    node: [...node].filter(([, users]) => users.length >= 2).map(([key, users]) => ({ kind: "node", key, label: key, users })),
    config: [...config].filter(([, g]) => g.users.length >= 2).map(([key, g]) => ({ kind: "config", key, label: g.label, users: g.users })),
  };
}

// 和某位成员同一星座的人（含本人）。
export function relatedUsers(user, constellations) {
  const out = new Set(user ? [user] : []);
  if (!user || !constellations) return out;
  for (const g of [...(constellations.node || []), ...(constellations.config || [])]) {
    if (g.users.includes(user)) for (const u of g.users) out.add(u);
  }
  return out;
}

// 结构签名：只有这些变了星图才重建（今日用量按对数分档，免得每次轮询都重建）。
export function galaxySignature(members) {
  const parts = [];
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.user !== "string") continue;
    const tok = Number(m.usage?.todayTokens) || 0;
    parts.push([
      m.user,
      m.displayName || "",
      orbitIndexOf(m),
      tok > 0 ? Math.round(Math.log2(tok) * 2) : 0,
      Math.min(8, Number(m.compute?.gpuCount) || 0),
      (m.compute?.nodes || []).join(","),
      (Number(m.compute?.runningJobs) || 0) > 0 ? 1 : 0,
      m.assignment?.state === "none" ? "" : m.assignment?.groupKey || "",
      memberTone(m),
      m.isSelf ? 1 : 0,
      m.activePort || "",
      Math.min(9, Math.floor(Math.log10(1 + (Number(m.usage?.todayCalls) || 0)) * 3)),
    ].join("~"));
  }
  return parts.sort().join("|");
}

// 轨道几何：星图高度扣掉顶部 HUD 与底部读数带，外轨撑满剩余高度，宽窗里压扁成更"电影感"的椭圆。
export function orbitGeometry(width, height, { paper = false } = {}) {
  const readoutH = paper ? 86 : 78;
  const padTop = 76;
  const padBottom = readoutH + 30;
  const usable = Math.max(120, height - padTop - padBottom);
  const ryOuter = usable / 2 - 6;
  const rxOuter = Math.max(ryOuter, Math.min(width / 2 - 78, ryOuter * 3.1));
  const fractions = [0.47, 0.74, 1];
  return {
    cx: width / 2,
    cy: padTop + usable / 2 + 4,
    orbits: fractions.map((f, i) => ({ rx: rxOuter * f, ry: ryOuter * f, speed: (Math.PI * 2) / ORBIT_PERIODS[i] })),
  };
}

// 一条轨道上 n 个成员的均分相位。
export function evenPhases(n, base = 0) {
  const out = [];
  for (let j = 0; j < n; j += 1) out.push(base + (j / Math.max(1, n)) * Math.PI * 2);
  return out;
}
