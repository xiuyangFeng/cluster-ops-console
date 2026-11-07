// 有界、只读采集：沿用取证的路径模板和 SSH 参数；参数全走 stdin。
import { readFileSync } from "node:fs";

import { buildProbeSshArgs } from "../ssh-args.mjs";
import { FORENSICS_JOB_ID_RE, loadForensicsScript } from "./forensics.mjs";
import { parseSubrunRecord, subrunPayload } from "./subrun-model.mjs";

export const JOB_WATCH_TIMEOUT_MS = 20000;
export const WATCH_BATCH_MAX = 20;
export const WATCH_REMOTE_COMMAND = `LC_ALL=C.UTF-8 LANG=C.UTF-8 python3 -c 'import sys,json; p=json.loads(sys.stdin.readline()); ns={"__name__":"job_watch"}; exec(compile(p["helpers"],"job-forensics","exec"),ns); exec(compile(p.get("subruns",""),"job-subruns","exec"),ns); exec(compile(p["script"],"job-watch","exec"),ns); ns["watch_main"]()'`;
let script = null;
let subrunScript = null;
const text = (v, max = 256) => typeof v === "string" ? v.slice(0, max) : null;
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function buildWatchInvocation({ server, parsed, knownHostsPath, jobs = [], resourceIds = [], orchFinal = [], platform = process.platform }) {
  script ??= readFileSync(new URL("../../remote/job-watch.py", import.meta.url), "utf8");
  subrunScript ??= readFileSync(new URL("../../remote/job-subruns.py", import.meta.url), "utf8");
  const payload = {
    jobs: jobs.filter((j) => FORENSICS_JOB_ID_RE.test(j.id)).slice(0, WATCH_BATCH_MAX).map((j) => ({
      id: j.id,
      reg: j.reg ? Object.fromEntries(["workDir", "stdout", "stderr", "name", "user"].map((k) => [k, text(j.reg[k], 1024)])) : null,
      ...(j.orch ? { orch: subrunPayload(j.orch) } : {}),
    })),
    resourceIds: resourceIds.filter((id) => FORENSICS_JOB_ID_RE.test(id)).slice(0, WATCH_BATCH_MAX),
    orchFinal: orchFinal.filter((f) => FORENSICS_JOB_ID_RE.test(f?.id || "") && typeof f.cursor?.path === "string").slice(0, 10)
      .map((f) => ({ id: f.id, p: text(f.cursor.path, 1024), cur: subrunPayload(f).cur })),
    budgetSec: 12, maxOutBytes: 512 * 1024,
  };
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), WATCH_REMOTE_COMMAND],
    input: `${JSON.stringify({ helpers: loadForensicsScript(), subruns: subrunScript, script })}\n${JSON.stringify(payload)}\n`,
    timeoutMs: JOB_WATCH_TIMEOUT_MS,
    maxOutputBytes: 600 * 1024,
  };
}

export function parseWatchOutput(stdout) {
  const progress = [];
  const resources = [];
  const subruns = [];
  let complete = false;
  for (const line of String(stdout || "").slice(0, 650 * 1024).split("\n")) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.k === "end") { complete = r.complete === true; continue; }
    if (!r || !FORENSICS_JOB_ID_RE.test(String(r.id || ""))) continue;
    if (r.k === "progress" && progress.length < WATCH_BATCH_MAX) {
      const files = (Array.isArray(r.files) ? r.files : []).slice(0, 2).filter((f) => typeof f?.p === "string" && f.p.startsWith("/") && typeof f.t === "string").map((f) => ({ path: text(f.p, 1024), tail: f.t.slice(-4096), mtime: finite(f.mt), size: finite(f.sz) }));
      progress.push({ id: r.id, files, remoteNow: finite(r.remoteNow), reason: text(r.reason) });
    }
    if ((r.k === "subruns" || r.k === "subruns-final") && subruns.length < WATCH_BATCH_MAX + 10) {
      const record = parseSubrunRecord(r);
      if (record) subruns.push(record);
    }
    if (r.k === "resource" && resources.length < WATCH_BATCH_MAX) {
      const rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, 64).filter((row) => row && typeof row === "object").map((row) => Object.fromEntries(["id", "state", "cpus", "reqMem", "maxRss", "totalCpu", "elapsed", "nodes", "reqTres", "tasks", "timeLimit", "tresMax"].map((k) => [k, typeof row[k] === "string" && row[k].length <= (k === "tresMax" ? 4096 : 256) ? row[k] : null])));
      resources.push({ id: r.id, rows, truncated: r.truncated === true || (Array.isArray(r.rows) && r.rows.length > 64) });
    }
  }
  return { progress, resources, subruns, complete };
}
