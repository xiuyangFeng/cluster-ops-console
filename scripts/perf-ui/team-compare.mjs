// 对比两份 team-bench 结果：node scripts/perf-ui/team-compare.mjs base.json cur.json
import fs from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const val = (x) => (x && typeof x === "object" && "median" in x ? x.median : x);
const rows = [];
for (const sec of ["startup", "latency", "switch", "scroll", "interact", "idle", "memory"]) {
  const A = a[sec] || {};
  const B = b[sec] || {};
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const va = val(A[k]);
    const vb = val(B[k]);
    if (typeof va !== "number" && typeof vb !== "number") continue;
    const pct = typeof va === "number" && typeof vb === "number" && va !== 0 ? `${(((vb - va) / Math.abs(va)) * 100).toFixed(0)}%` : "";
    rows.push([`${sec}.${k}`, va ?? "—", vb ?? "—", pct]);
  }
}
const w = [30, 12, 12, 8];
console.log(["指标", "基线", "当前", "变化"].map((h, i) => String(h).padEnd(w[i])).join(""));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join(""));
