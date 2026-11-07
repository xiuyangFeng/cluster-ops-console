// 对比 bench.mjs 的结果：node scripts/perf-ui/compare.mjs base.json new.json（两份时多一列变化百分比）；KEYS=正则 只看匹配的指标。
import fs from "node:fs";
const files = process.argv.slice(2); const rs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === "object" && !Array.isArray(v)) { if ("median" in v) out[p + k] = v.median; else flat(v, `${p}${k}.`, out); } else if (typeof v === "number") out[p + k] = v; } return out; };
const fl = rs.map((r) => flat({ api: r.api, startup: r.startup, switch: r.switch, scroll: r.scroll, idle: r.idle, oldLogs: r.oldLogs, heapMb: r.heapMb, domNodes: r.domNodes }));
const keys = [...new Set(fl.flatMap((f) => Object.keys(f)))];
const filt = process.env.KEYS ? new RegExp(process.env.KEYS) : null;
console.log("".padEnd(52), files.map((f) => f.split("/").pop().replace(".json", "").slice(-12).padStart(12)).join(""), files.length === 2 ? "     Δ%" : "");
for (const k of keys) { if (filt && !filt.test(k)) continue; const vals = fl.map((f) => f[k]); const d = files.length === 2 && vals[0] ? `${(((vals[1] - vals[0]) / vals[0]) * 100).toFixed(0).padStart(6)}%` : "";
  console.log(k.padEnd(52), vals.map((v) => String(v == null ? "-" : Math.round(v * 10) / 10).padStart(12)).join(""), d); }
for (const r of rs) if (r.errors?.length) console.log("ERRORS", r.errors);
