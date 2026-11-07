// 诊断与自身故障可见性（v2.64，控制面）：GET /api/diagnostics/bundle 的取数、POST /api/diagnostics/client-error 的落盘。
//
// 诊断包只读：日志与断线账本读文件末尾（每份最多读 256 KB），进程登记直接读 *.pid.json（不经
// process-registry 的 listRuntimeProcesses——那个会顺手清掉死进程的登记，导出不该改任何东西），
// 存储占用复用存储清理器的 measure。任何一块读失败只在那一块写 { error }，整份照样导出。
//
// 页面脚本错误写 runtime/logs/renderer.ndjson，监控服务是这份文件唯一的写入方（desktop.ndjson 只归 Electron 主进程，
// 见 log-sources.mjs）：轮转按本进程记的大小判断，两个进程追加同一份会超出 2 MB、互相盖掉分卷。
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../logger.mjs";
import { isPidAlive } from "../process-registry.mjs";
import { LAUNCHER_NODE_ENV } from "../self-update/restart-code.mjs";
import { TUNNEL_LEDGER_FILENAME } from "../supervisor/tunnel-ledger.mjs";
import { assembleDiagnosticsBundle, LEDGER_TAIL_LINES, LOG_TAIL_LINES, parseTailLine, summarizeProcessRecord } from "./bundle.mjs";
import { createClientErrorGate, normalizeClientError } from "./client-errors.mjs";
import { RENDERER_LOG_SOURCE } from "./log-sources.mjs";
import { secretVariants } from "./redact.mjs";

const TAIL_READ_BYTES = 256 * 1024;
const PID_FILE_MAX_BYTES = 64 * 1024;
const MAX_LOG_SOURCES = 32;
const LOG_FILE_RE = /^[a-z0-9][\w.-]{0,63}\.ndjson$/i;

// 文件末尾的若干行（最多读 maxBytes）。文件不在 → null。开头那半行丢掉。
export async function readTailLines(file, maxLines, { maxBytes = TAIL_READ_BYTES } = {}) {
  let info;
  try { info = await stat(file); } catch { return null; }
  if (!info.isFile()) return null;
  const length = Math.min(info.size, maxBytes);
  const handle = await open(file, "r");
  let text;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (info.size > length) lines.shift();
  const kept = lines.filter((line) => line.trim());
  return { lines: kept.slice(-maxLines), more: kept.length > maxLines || info.size > length, bytes: info.size };
}

// 当前文件不够 maxLines 行时，从轮转出的 .1 末尾补齐（按时间先后：.1 在前）。
export async function readTailWithRotation(file, maxLines) {
  const current = await readTailLines(file, maxLines);
  const lines = current?.lines ?? [];
  let fromRotated = 0;
  let more = current?.more ?? false;
  if (lines.length < maxLines) {
    const rotated = await readTailLines(`${file}.1`, maxLines - lines.length).catch(() => null);
    if (rotated?.lines.length) {
      lines.unshift(...rotated.lines);
      fromRotated = rotated.lines.length;
      more = rotated.more;
    }
  }
  if (!current && !fromRotated) return null;
  return { entries: lines.map(parseTailLine), more, ...(fromRotated ? { fromRotated } : {}) };
}

export function createDiagnosticsService({
  runtimeDir,
  logsDir = path.join(runtimeDir, "logs"),
  version = "",
  getConfig = async () => null,
  getBuildInfo = async () => null,
  incidentStore = null,
  storageSweeper = null,
  // 已知秘密原文（本机鉴权令牌、保管库令牌、代理口令……）与拼 Basic 认证时用的用户名；每次导出现取。
  getSecrets = () => ({ secrets: [], users: [] }),
  fixtureMode = false,
  packaged = false,
  env = process.env,
  now = Date.now,
  rendererLogger = null,
  pidAlive = isPidAlive,
}) {
  let logger = rendererLogger;
  const gate = createClientErrorGate({ now });
  const getLogger = () => {
    logger ||= createLogger(RENDERER_LOG_SOURCE, { dir: logsDir });
    return logger;
  };

  async function safely(work) {
    try {
      return await work();
    } catch (err) {
      return { error: String(err?.message || err).slice(0, 300) };
    }
  }

  async function readLogs() {
    let names = [];
    try { names = await readdir(logsDir); } catch { return {}; }
    const sources = names.filter((name) => LOG_FILE_RE.test(name)).sort().slice(0, MAX_LOG_SOURCES);
    const out = {};
    for (const name of sources) {
      const source = name.slice(0, -".ndjson".length);
      out[source] = await safely(async () => (await readTailWithRotation(path.join(logsDir, name), LOG_TAIL_LINES)) ?? { entries: [] });
    }
    return out;
  }

  async function readProcesses() {
    const names = (await readdir(runtimeDir)).filter((name) => name.endsWith(".pid.json")).sort().slice(0, 64);
    const out = [];
    for (const file of names) {
      const name = file.slice(0, -".pid.json".length);
      try {
        const info = await stat(path.join(runtimeDir, file));
        if (!info.isFile() || info.size > PID_FILE_MAX_BYTES) { out.push({ name, error: "登记文件异常" }); continue; }
        const meta = JSON.parse(await readFile(path.join(runtimeDir, file), "utf8"));
        out.push(summarizeProcessRecord(name, meta, { alive: Number.isInteger(meta?.pid) ? pidAlive(meta.pid) : null }));
      } catch {
        out.push({ name, error: "读不出登记文件" });
      }
    }
    return out;
  }

  async function readStorage() {
    if (!storageSweeper) return null;
    const measured = await storageSweeper.measure();
    const state = storageSweeper.getState?.() ?? {};
    return { usedBytes: measured?.usedBytes ?? null, byKind: measured?.byKind ?? null, budgetBytes: state.budgetBytes ?? null, lastSweepAt: state.lastSweepAt ?? null };
  }

  // status：调用方（路由）给的当前状态快照；取不到时传 { error }。
  async function buildBundle({ status = null } = {}) {
    const generatedAt = now();
    const parts = {
      app: await safely(async () => ({ name: "集群运维工作台", version, packaged, fixtureMode, build: await getBuildInfo() })),
      platform: await safely(async () => ({
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        osVersion: typeof os.version === "function" ? os.version() : null,
        cpus: os.cpus().length,
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        uptimeSec: Math.round(os.uptime()),
      })),
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        v8: process.versions.v8,
        launcherNode: typeof env?.[LAUNCHER_NODE_ENV] === "string" ? env[LAUNCHER_NODE_ENV].slice(0, 40) : null,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
      },
      config: await safely(() => getConfig()),
      status,
      openIncidents: await safely(async () => incidentStore?.query({ state: "open", limit: 200 })?.incidents ?? null),
      logs: await safely(readLogs),
      tunnelLedger: await safely(async () => (await readTailWithRotation(path.join(runtimeDir, TUNNEL_LEDGER_FILENAME), LEDGER_TAIL_LINES)) ?? { entries: [] }),
      processes: await safely(readProcesses),
      storage: await safely(readStorage),
    };
    let secrets = [];
    try {
      const known = getSecrets() || {};
      secrets = secretVariants(known.secrets || [], { users: known.users || [] });
    } catch {}
    return assembleDiagnosticsBundle(parts, { generatedAt, secrets });
  }

  // 页面脚本错误：规整 → 限流去重 → 写 renderer.ndjson。→ { ok, reason }，reason：invalid / duplicate / rate-limited。
  function recordClientError(body) {
    const entry = normalizeClientError(body);
    if (!entry) return { ok: false, reason: "invalid" };
    const verdict = gate.accept(entry);
    if (!verdict.ok) return verdict;
    try {
      getLogger().error(`页面脚本错误（${entry.kind === "error" ? "未捕获异常" : "未处理的 Promise 拒绝"}）：${entry.message}`, {
        event: "renderer-error",
        ...entry,
        ...(verdict.droppedBefore ? { droppedBefore: verdict.droppedBefore } : {}),
      });
    } catch {}
    return { ok: true };
  }

  return { buildBundle, recordClientError, dispose: () => logger?.dispose?.() };
}
