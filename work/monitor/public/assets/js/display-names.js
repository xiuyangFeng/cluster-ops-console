// display-names.js —— 界面用名（纯函数，Node 可直接 import 测试）。
// 事件、时间线、链路、隧道稳定性、托盘通知等处统一用这里的名字，界面上不再外露
// server-01、claude-codewing 这类内部 id。新增展示位置时 import 这里，不要各处再写一份。

// 「主集群服务器 (myserver)」→「主集群」：去掉括号里的主机名与末尾的「服务器」。
export function shortServerName(name) {
  const text = String(name || "");
  return text.replace(/\s*\(.*\)\s*$/, "").replace(/服务器$/, "") || text;
}

// 服务器 id → 短名。名字取 /api/status 的 serversBrief[id].displayName（配置里的 name），
// 没有时退到主机别名；状态里查不到这台服务器（已删除 / 快照还没到）时原样返回 id。
export function serverShortName(status, serverId) {
  const id = String(serverId || "");
  const brief = status?.serversBrief?.[id];
  const name = brief?.displayName || brief?.name;
  return name ? shortServerName(name) : id;
}

// Agent id → 显示名（/api/status 的 agents[].name，如 claude-codewing →「Claude CodeWing」）；查不到时原样返回 id。
export function agentDisplayName(status, agentId) {
  const id = String(agentId || "");
  const list = Array.isArray(status?.agents) ? status.agents : [];
  const hit = list.find((agent) => agent && agent.id === id);
  return hit?.name ? String(hit.name) : id;
}
