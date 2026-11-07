// tunnel-egress-model.js —— 服务器页「经隧道出网的程序」的纯模型（无 DOM，Node 可测）。
// 数据：layers.resources[id].tunnelEgress（slow 采集的 tunnel-egress 段，lib/tunnel-egress.mjs 解析）——
// 这台服务器上此刻连着 127.0.0.1:<remotePort> 的连接，按程序名汇总的连接数与已收发字节。
// 口径：字节是这些连接建立以来的累计，只覆盖此刻还开着的连接，不是一段时间的流量；
// 非 root 的 ss 只给当前账号的进程标出名字，别的账号的连接只能算进「看不到进程」。
// HTML 在 tunnel-egress-view.js，DOM 接线在 load-panel.js。
import { formatBytes } from "../store.js";

export const TUNNEL_EGRESS_EMPTY_TEXT = "此刻没有程序经隧道出网";

const OTHERS_TITLE = "这些连接的进程不属于当前账号（ss 只给本账号的进程标出名字），多半是同一台机器上别的账号在用这条隧道";
const BYTES_TITLE = "↑ 发出、↓ 收到：这些连接建立以来的累计（只算此刻还开着的连接）";

const finiteCount = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const finiteBytes = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

// 「↑1.2 MiB ↓18 MiB」：哪一边没有就不写哪一边；两边都没有（老内核不给字节）给空串。
export function egressBytesText(sentBytes, recvBytes) {
  const up = finiteBytes(sentBytes);
  const down = finiteBytes(recvBytes);
  const parts = [];
  if (up != null) parts.push(`↑${formatBytes(up)}`);
  if (down != null) parts.push(`↓${formatBytes(down)}`);
  return parts.join(" ");
}

function rowFrom(entry, { name, other = false, title = "" } = {}) {
  const conns = finiteCount(entry?.conns) ?? 0;
  const bytes = egressBytesText(entry?.sentBytes, entry?.recvBytes);
  const connsText = `${conns} 条连接`;
  return {
    name,
    other,
    conns,
    connsText,
    bytesText: bytes,
    text: [name, connsText, bytes].filter(Boolean).join(" · "),
    title: [title, bytes ? BYTES_TITLE : "这台服务器的内核没给出连接上的字节数"].filter(Boolean).join("\n"),
  };
}

const HIDDEN = Object.freeze({ visible: false });

// egress：layers.resources[id].tunnelEgress；server：正在看的服务器条目（tunnel: false = 不建隧道，整块不显示）。
// 返回 { visible, state, portText, notice, rows, total, more }：
//   state  ok（有程序行）/ basic（只有连接数）/ empty（没有连接）/ unsupported（没有 ss）/ error（这一轮没查到）
//   rows   [{ name, other, conns, connsText, bytesText, text, title }]，「看不到进程」的一行排在最后（other: true）
//   total  { text, title } 合计一行（含未列出的程序与看不到进程的连接）
//   more   程序多于列出的 20 个时「另有 N 个程序未列出」
// 段缺失（旧采集脚本 / 还没采到）、没有可查的端口（skip）→ 不显示，不给空状态。
export function buildTunnelEgressModel(egress, server = null) {
  if (server && typeof server === "object" && server.tunnel === false) return HIDDEN;
  if (!egress || typeof egress !== "object") return HIDDEN;
  const state = egress.state;
  if (state !== "ok" && state !== "absent" && state !== "error") return HIDDEN;
  const port = Number.isInteger(egress.port) ? egress.port : null;
  const base = {
    visible: true,
    state,
    portText: port == null ? "" : `连着 127.0.0.1:${port} 的连接`,
    notice: "",
    rows: [],
    total: null,
    more: "",
  };
  if (state === "absent") {
    return { ...base, state: "unsupported", notice: "不支持：这台服务器上没有 ss 命令，看不到哪些程序在经隧道出网" };
  }
  if (state === "error") {
    return { ...base, notice: "这一轮没查到（ss 查询失败或超时），每分钟会自动重试" };
  }

  const total = egress.total && typeof egress.total === "object" ? egress.total : null;
  const totalConns = finiteCount(total?.conns) ?? 0;
  if (totalConns === 0) return { ...base, state: "empty", notice: TUNNEL_EGRESS_EMPTY_TEXT };

  const totalBytes = egressBytesText(total?.sentBytes, total?.recvBytes);
  const totalRow = {
    text: ["合计", `${totalConns} 条连接`, totalBytes].filter(Boolean).join(" · "),
    title: totalBytes ? BYTES_TITLE : "",
  };
  if (egress.detail === "basic") {
    return {
      ...base,
      state: "basic",
      notice: "这台服务器的 ss 不支持列出进程，只能看到连接数",
      total: totalRow,
    };
  }

  const programs = (Array.isArray(egress.programs) ? egress.programs : [])
    .filter((p) => p && typeof p.name === "string" && p.name && finiteCount(p.conns));
  const rows = programs.map((p) => rowFrom(p, { name: p.name }));
  const others = egress.others && typeof egress.others === "object" ? egress.others : null;
  if (finiteCount(others?.conns) > 0) rows.push(rowFrom(others, { name: "看不到进程", other: true, title: OTHERS_TITLE }));
  const programCount = finiteCount(egress.programCount) ?? programs.length;
  const hiddenPrograms = Math.max(0, programCount - programs.length);
  return {
    ...base,
    rows,
    total: totalRow,
    more: hiddenPrograms > 0 ? `另有 ${hiddenPrograms} 个程序未列出（只列连接最多的 ${programs.length} 个）` : "",
  };
}
