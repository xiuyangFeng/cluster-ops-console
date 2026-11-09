import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { normalizeProcessCommand, windowsCommandArgs } from "./processes/query.mjs";

const defaultExecFile = promisify(execFile);

// 进程存活探测（signal 0）。EPERM（进程存在但属于别的用户）同样按不存活处理：
// 对本项目的 pid 记录而言，别人的进程不可信，也不该被当成自家进程去管。
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 轮询等待 pid 退出，最多等待 budgetMs（每 intervalMs 探测一次）。
// 进程一旦消失即刻返回 true，避免固定 sleep 造成的串行退出拖延。
// 独立导出：registry 内部与 channel-supervisor 的 shutdown 共用同一实现。
export async function waitForPidExit(pid, budgetMs, intervalMs = 100) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true; // 已退出
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isPidAlive(pid);
}

// 确认 pid 已退出，未退出则升级 SIGKILL。
// 调用方负责先发温和信号（SIGTERM）；本函数只做"等 → 不收手就升级 → 再确认"。
//
// 为什么必须有升级：ssh 卡在网络半开的 -R 远端转发建立过程、或代理卡在不可中断的
// syscall 时不会响应 SIGTERM。而调用方（隧道/代理重建）紧接着就要占用同一个远端
// 端口或本地端口——旧进程还活着时，新进程必然失败：
//   ssh: remote port forwarding failed for listen port NNNN
//   Error: listen EADDRINUSE :::PORT
// 表现为"重启后仍旧连不上"，且日志里没有任何线索说明旧进程没死。
// stopAdopted 早已是这个语义（SIGTERM → 等不到就 SIGKILL），此处统一成共享实现。
//
// 返回 true 表示 pid 已消失。SIGKILL 之后仍可能因为僵尸/内核清理延迟而短暂存活，
// 因此升级后只给一小段宽限预算复查，返回真实结果而不假装成功。
export async function ensurePidExited(pid, budgetMs, { killImpl, waitImpl, killGraceMs = 1000, intervalMs = 100 } = {}) {
  if (!pid) return true;
  const wait = waitImpl || waitForPidExit;
  if (await wait(pid, budgetMs, intervalMs)) return true;
  const kill = killImpl || ((target, signal) => process.kill(target, signal));
  try {
    kill(pid, "SIGKILL");
  } catch {
    // ESRCH：等待期间已经退出；EPERM：无权——都交给下面的复查判定。
  }
  return wait(pid, killGraceMs, intervalMs);
}

// ps 的区域设置：打包 .app 从 Finder/launchd 启动时没有 LANG/LC_*，macOS 的 ps 在 C/POSIX
// 区域下会把非 ASCII 字节转义成 "M-i..."——安装路径含中文（如 "集群codex连接"）时，命令行
// 与登记的 command 永远对不上，校验失败 → 60s GC 删掉活进程的记录。所有用 ps 做命令行
// 匹配的调用都带上 UTF-8 区域：darwin 用 en_US.UTF-8（系统必有），其它 POSIX 用 C.UTF-8
// （glibc ≥2.35 / musl / Debian 系内置；缺失时 setlocale 失败退回 C，行为同旧版）。
// win32 不走 ps，原样返回。
export function utf8LocaleEnv(platformName = process.platform, baseEnv = process.env) {
  if (platformName === "win32") return { ...baseEnv };
  return { ...baseEnv, LC_ALL: platformName === "darwin" ? "en_US.UTF-8" : "C.UTF-8" };
}

// 单实例让位判定（纯函数，便于测试）：注册表里登记的同名进程仍存活、
// 命令行含预期特征、且不是自己 → 新实例应让位退出，避免双实例互踩。
export function shouldYieldToExisting({ meta, selfPid, alive, cmdline, expect } = {}) {
  if (!meta || !Number.isInteger(meta.pid) || meta.pid <= 0) return false;
  if (meta.pid === selfPid) return false;
  if (!alive) return false;
  return typeof cmdline === "string" && Boolean(expect) && normalizeProcessCommand(cmdline).includes(normalizeProcessCommand(expect));
}

// D1：平台感知的 cmdline 查询构造。win32 没有 POSIX 的 ps，硬编码 ps 会让
// verify/stop/GC 在 Windows 下全部失效（每次查询都因命令不存在而报错）。
// darwin/linux 继续用一直在用的 `ps -o pid=,command= -p <pid>`；
// win32 改用 PowerShell 的 Get-CimInstance Win32_Process 按 pid 过滤取 CommandLine。
function buildCmdlineQuery(platformName, pid) {
  if (platformName === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
    };
  }
  return {
    command: "ps",
    args: ["-o", "pid=,command=", "-p", String(pid)],
  };
}

// 从查询命令的原始 stdout 中抽出 cmdline。POSIX 的 `ps -o pid=,command=` 输出形如
// "12345 node work/x.mjs"，需要剥掉前导 pid 字段；PowerShell 的
// Get-CimInstance ... CommandLine 直接就是命令行本身，无需剥离。
function extractCmdline(platformName, stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return "";
  if (platformName === "win32") return trimmed;
  const firstSpace = trimmed.indexOf(" ");
  return firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";
}

// 批量 cmdline 查询（POSIX）。实测（macOS 26，~600 进程）：`ps -o pid=,command= -p a,b`
// 只要给出 ≥2 个 pid，macOS 的 ps 就会退回全表扫描（~47ms，与 `ps -ax` 同量级），
// 单 pid 查询只要 ~2ms——所以 darwin 按 pid 拆成并行的单 pid 查询；linux procps
// 按 /proc/<pid> 逐个读取，逗号列表一条命令即可。win32 不走这里（调用方回落各自旧路径）。
export function buildBatchCmdlineQueries(platformName, pids) {
  const list = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (list.length === 0 || platformName === "win32") return [];
  if (platformName === "linux") {
    return [{ command: "ps", args: ["-o", "pid=,command=", "-p", list.join(",")], pids: list }];
  }
  return list.map((pid) => ({ command: "ps", args: ["-o", "pid=,command=", "-p", String(pid)], pids: [pid] }));
}

// 解析 `ps -o pid=,command=` 的多行输出为 Map<pid, cmdline>。
export function parseCmdlineRows(stdout) {
  const rows = new Map();
  for (const raw of String(stdout || "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(raw);
    if (match?.[2]) rows.set(Number(match[1]), match[2]);
  }
  return rows;
}

// 执行 buildBatchCmdlineQueries 的查询集，返回 Map<pid, cmdline>（缺席 = ps 未报告该 pid）。
// runQuery(command, args) 须返回 { stdout, failed }（失败时 stdout 取失败输出里已有的部分或 ""）。
// 单 pid 查询沿用 verifyProcess 的 extractCmdline 语义（剥首字段，不校对 pid 列）；
// 多 pid 查询按 pid 列归属，若命令失败（procps 对任一越界 pid 可能整条报错不输出），
// 对缺席的 pid 逐个单查兜底——绝不让一个坏 pid 连坐其余进程被判"不存在"。
export async function queryCmdlines(platformName, pids, runQuery, { concurrency = 8 } = {}) {
  const queries = buildBatchCmdlineQueries(platformName, pids);
  const found = new Map();
  const single = async (pid) => {
    const [query] = buildBatchCmdlineQueries("darwin", [pid]);
    const { stdout } = await runQuery(query.command, query.args);
    const cmdline = extractCmdline(platformName, stdout);
    if (cmdline) found.set(pid, cmdline);
  };
  const pending = [...queries];
  const worker = async () => {
    while (pending.length) {
      const query = pending.shift();
      if (query.pids.length === 1) {
        await single(query.pids[0]);
        continue;
      }
      const { stdout, failed } = await runQuery(query.command, query.args);
      const rows = parseCmdlineRows(stdout);
      for (const pid of query.pids) if (rows.has(pid)) found.set(pid, rows.get(pid));
      if (failed) {
        for (const pid of query.pids) if (!found.has(pid)) await single(pid);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queries.length)) }, worker));
  return found;
}

// D1：查询命令本身跑不起来（命令不存在/权限/意外异常等，不细分原因）与
// "查询正常执行、明确确认没有这个 pid" 是两回事——前者应保守判"无法验证"
// （indeterminate:true，保留登记、不杀不删），后者才是"确认进程不存在"。
// POSIX 的 ps 是系统级基础工具，极为可靠，沿用既有行为：查询失败即视为进程确认
// 不存在。win32 目前依赖较新的 PowerShell/CIM 支持，稳妥起见查询失败一律按
// "无法验证"处理，避免把 60s 周期 GC 变成"把所有活进程记录清空"的定时炸弹。
function isQueryFailureIndeterminate(platformName) {
  return platformName === "win32";
}

// D2：旗标型短参（如 -o/-N/-R/-x）极易作为子串偶然出现在完全无关的命令行里
// （grep -o、tar -N……），单独拿它们做"匹配"依据形同虚设——pid 复用给这类无关
// 进程也会被误判为 verified。旗标本身的形态是"1~2 个前导 - 后跟至多 3 个单词
// 字符"，例如 -o / -N / -R / --x。
function isWeakFlagArg(arg) {
  return /^-{1,2}\w{1,3}$/.test(arg);
}

// 判定查询得到的 cmdline 是否与登记的进程特征吻合。导出为独立纯函数（不依赖
// registry 闭包状态）便于直接单测。
//
// D2：优先使用调用方显式提供的精确签名（meta.signature）——要求 cmdline 同时
// 包含签名里的每一个强特征片段（按空白切分，例如隧道的 "-R <转发串> <host>"
// 拆成转发串与 host 两段都必须命中），而不是退化成"任意一个旗标型短参子串
// 命中"就判定匹配。
//
// 没有 signature 时退回旧的宽松匹配（command 子串 或 非旗标型 arg 子串），
// 对尚未升级到 signature 的既有调用方保持向后兼容——这也是为什么 recordProcess
// 默认不会凭空派生 signature：贸然收紧所有调用方的匹配语义会让本就宽松注册的
// 记录（例如仅注册了 command 而未强调强特征 arg 的场景）意外从"能校验通过"
// 变成"校验失败"，可能引发 GC/stopProcess 侧的连带回归。
export function cmdlineMatches(cmdline, meta) {
  if (!cmdline || !meta) return false;
  if (meta.configIdentity) {
    if (/^[A-Za-z]:[\\/]/.test(meta.cwd || "") && Array.isArray(meta.args) && meta.args.length) {
      const [exe, ...args] = windowsCommandArgs(cmdline);
      return /(?:^|[\\/])ssh(?:\.exe)?$/i.test(exe || "") && args.length === meta.args.length && args.every((arg, i) => arg === meta.args[i]);
    }
    // New tunnel records contain the complete argv used at spawn. A reused PID
    // or another user's ssh with only the same -R substring is not ownership.
    const canonicalSsh = (value) => {
      const match = /^\s*(?:"([^"]+)"|(\S+))\s+(.+)$/.exec(String(value || ""));
      if (!match || !/(?:^|[\\/])ssh(?:\.exe)?$/i.test(match[1] || match[2])) return null;
      return match[3].trim().replace(/\s+/g, " ");
    };
    const expected = canonicalSsh(meta.command);
    return expected != null && canonicalSsh(cmdline) === expected;
  }
  if (typeof meta.signature === "string" && meta.signature.trim()) {
    const segments = normalizeProcessCommand(meta.signature).split(/\s+/).filter(Boolean);
    return segments.length > 0 && segments.every((seg) => normalizeProcessCommand(cmdline).includes(seg));
  }
  if (meta.command && cmdline.includes(meta.command)) return true;
  if (Array.isArray(meta.args)) {
    const strongArgs = meta.args.filter((arg) => arg && !isWeakFlagArg(arg));
    if (strongArgs.some((arg) => normalizeProcessCommand(cmdline).includes(normalizeProcessCommand(arg)))) return true;
  }
  return false;
}

// 进程注册表：把托管进程的元数据落盘为 <name>.pid.json，
// 并在杀进程前用平台感知的查询校验 pid 仍是"我们记录的那个命令"，防止 pid 复用误杀。
// onReclaim({ name, pid, reason })：GC 删除死进程 pid.json 时的可观测性回调——
// 此前 unlink 是静默的，生产上无法回答"这条记录是谁、何时、为何被删"；调用方
// （monitor-server 巡检 / supervisor 启动清扫）借它记一条日志。判死与否完全由
// verifyProcess 决定（含 pid 复用防护与 D1 indeterminate 保守保留），回调不参与判定。
export function createProcessRegistry({ runtimeDir, execFileImpl = defaultExecFile, platform = process.platform, onReclaim,
  killProcess = (pid, signal) => process.kill(pid, signal), waitForPidExitImpl = waitForPidExit,
} = {}) {
  function pidFile(name) {
    return join(runtimeDir, `${name}.pid.json`);
  }

  // 每次现算（而非构造时冻结）：env 由调用方进程决定，测试里也能按需改 process.env。
  function execOptions() {
    return platform === "win32" ? { windowsHide: true, timeout: 10000 } : { env: utf8LocaleEnv(platform, process.env) };
  }

  function recordProcess(name, pid, { command, args, cwd, parentPid, signature, configIdentity, adopted } = {}) {
    const meta = {
      name,
      pid,
      command,
      args: args || [],
      cwd,
      startedAt: new Date().toISOString(),
      parentPid,
      rootDir: cwd,
      // D2：调用方可传入精确签名（如隧道的 -R 转发串 + host）供 cmdlineMatches
      // 优先使用；不传就不落这个字段——不凭空派生，见 cmdlineMatches 顶部注释。
      ...(signature ? { signature } : {}),
      ...(typeof configIdentity === "string" && configIdentity.length > 0 && configIdentity.length <= 8192 ? { configIdentity } : {}),
      ...(adopted === true ? { adopted: true } : {}),
    };
    // tmp+rename 原子写：写一半崩溃不会留下半截 JSON（readMeta 解析失败会退化为"无记录"）。
    // 临时文件名带 pid+时间戳，同名的并发登记者互不覆盖对方的临时文件；pid.json 为 0600。
    // 不改已有 runtimeDir 的权限（开发模式下它在仓库里）。
    writePrivateFileAtomicSync(pidFile(name), JSON.stringify(meta, null, 2), { chmodDir: false });
    return meta;
  }

  function readMeta(name) {
    try {
      return JSON.parse(readFileSync(pidFile(name), "utf8"));
    } catch {
      return null;
    }
  }

  async function verifyProcess(name) {
    const meta = readMeta(name);
    if (!meta) return { verified: false, reason: "缺少 pid 元数据", meta: null, indeterminate: false };

    const query = buildCmdlineQuery(platform, meta.pid);
    let stdout = "";
    try {
      const res = await execFileImpl(query.command, query.args, execOptions());
      stdout = res?.stdout ? res.stdout : "";
    } catch {
      // 查询命令本身跑不起来（D1：典型如 win32 下没有 ps）——无法判断，保守
      // 返回 indeterminate，绝不能当成"进程不存在"处理（那会导致误删/误杀）。
      if (isQueryFailureIndeterminate(platform)) {
        return { verified: false, reason: `无法校验进程 ${meta.pid}（查询命令执行失败）`, meta, indeterminate: true };
      }
      // POSIX：ps 以非零退出（通常是进程已不存在）会走到这里，沿用既有行为。
      return { verified: false, reason: `进程 ${meta.pid} 不存在`, meta, indeterminate: false };
    }

    return judgeCmdline(meta, extractCmdline(platform, stdout));
  }

  function judgeCmdline(meta, cmdline) {
    if (!cmdline) return { verified: false, reason: `进程 ${meta.pid} 不存在`, meta, indeterminate: false };
    if (!cmdlineMatches(cmdline, meta)) {
      return { verified: false, reason: `命令行不匹配: ${cmdline}`, meta, indeterminate: false };
    }
    return { verified: true, reason: "ok", meta, indeterminate: false };
  }

  // 批量版 verifyProcess：一次（linux）或按 pid 并行单查（darwin）拿到全部 cmdline，
  // 逐条判定语义与 verifyProcess 完全一致（缺元数据 / 不存在 / 命令行不匹配 / ok）。
  // supervisor 每拍 N 条隧道各 fork 一次 ps → 合并为一轮查询；GC 巡检同样受益。
  // win32 回落逐条 verifyProcess（PowerShell 路径与 D1 indeterminate 语义原样保留）。
  // POSIX 查询命令失败沿用既有语义：ps 未报告的 pid 即"进程不存在"。
  async function verifyProcesses(names) {
    const unique = [...new Set(names || [])];
    const results = new Map();
    if (platform === "win32") {
      for (const name of unique) results.set(name, await verifyProcess(name));
      return results;
    }
    const metas = new Map();
    for (const name of unique) {
      const meta = readMeta(name);
      if (!meta) results.set(name, { verified: false, reason: "缺少 pid 元数据", meta: null, indeterminate: false });
      else metas.set(name, meta);
    }
    const cmdlines = await queryCmdlines(platform, [...metas.values()].map((meta) => meta.pid), async (command, args) => {
      try {
        const res = await execFileImpl(command, args, execOptions());
        return { stdout: res?.stdout ? String(res.stdout) : "", failed: false };
      } catch (error) {
        // promisify(execFile) 非零退出会 reject，但 error.stdout 仍带着已找到的行。
        return { stdout: error?.stdout ? String(error.stdout) : "", failed: true };
      }
    });
    for (const [name, meta] of metas) {
      results.set(name, judgeCmdline(meta, cmdlines.get(Number(meta.pid)) || ""));
    }
    return results;
  }

  async function stopProcess(name, { forceAfterMs = 2000, expectedPid, expectedConfigIdentity } = {}) {
    const { verified, reason, meta } = await verifyProcess(name);
    if (!verified) {
      // 校验不通过时坚决拒绝杀进程，避免 pid 复用误伤无关进程。
      return { stopped: false, reason: `拒绝停止：进程校验失败（${reason}）` };
    }
    if ((expectedPid != null && meta.pid !== expectedPid)
      || (expectedConfigIdentity != null && meta.configIdentity !== expectedConfigIdentity)) {
      return { stopped: false, reason: "拒绝停止：登记的进程身份已改变" };
    }
    if (expectedPid != null) {
      const latest = readMeta(name);
      if (latest?.pid !== expectedPid || (expectedConfigIdentity != null && latest.configIdentity !== expectedConfigIdentity)) {
        return { stopped: false, reason: "拒绝停止：登记的进程身份已改变" };
      }
    }

    try {
      killProcess(meta.pid, "SIGTERM");
    } catch {
      // 目标已退出，视为已停止并清理登记。
      try {
        unlinkSync(pidFile(name));
      } catch {}
      return { stopped: true, reason: "进程已退出" };
    }

    const exited = await waitForPidExitImpl(meta.pid, forceAfterMs);
    if (!exited) {
      if (expectedPid != null) {
        const again = await verifyProcess(name);
        if (!again.verified || again.meta?.pid !== expectedPid
          || (expectedConfigIdentity != null && again.meta?.configIdentity !== expectedConfigIdentity)) {
          return { stopped: false, reason: "拒绝强制停止：进程身份已改变" };
        }
      }
      try {
        killProcess(meta.pid, "SIGKILL");
      } catch {}
      if (expectedPid != null && !(await waitForPidExitImpl(meta.pid, forceAfterMs))) {
        return { stopped: false, reason: "进程退出未确认，保留登记" };
      }
    }

    try {
      unlinkSync(pidFile(name));
    } catch {}
    return { stopped: true, reason: "已停止" };
  }

  async function listRuntimeProcesses() {
    if (!existsSync(runtimeDir)) return [];
    let files;
    try {
      files = readdirSync(runtimeDir);
    } catch {
      return [];
    }
    const names = files
      .filter((f) => f.endsWith(".pid.json"))
      .map((f) => f.slice(0, -".pid.json".length));

    const result = [];
    const verifications = await verifyProcesses(names);
    for (const name of names) {
      const verification = verifications.get(name);
      const meta = verification?.meta;
      if (!meta) continue;
      const { verified, indeterminate, reason } = verification;
      if (!verified && !indeterminate) {
        // 确认进程已不存在（非"查询失败"）：GC 掉陈旧登记，避免死条目长期堆积。
        // 注意"确认不存在"包含两种死法：pid 真没了，以及 pid 复用给了无关进程
        // （命令行不匹配）——两者都由 verifyProcess 统一判定，这里不重复判。
        try {
          unlinkSync(pidFile(name));
        } catch {}
        if (typeof onReclaim === "function") {
          try {
            onReclaim({ name, pid: meta.pid, reason });
          } catch {
            // 回收日志回调抛异常不能中断 GC：可观测性是附加品，不是回收的前置条件。
          }
        }
        continue;
      }
      // verified===true，或 indeterminate===true（D1：无法判断时保守保留记录，不 GC）。
      result.push({ name, meta, verified, indeterminate: Boolean(indeterminate), reason });
    }
    return result;
  }

  return { recordProcess, verifyProcess, verifyProcesses, stopProcess, listRuntimeProcesses, readMeta };
}

// supervisor 每拍预取：主循环在 ensure 各隧道之前用一轮批量查询校验全部隧道记录，
// 控制器拿到的是这个视图而不是裸 registry。视图的 verifyProcess(name)：
//   - 本拍预取里有该 name、未被消费、未过期（maxAgeMs），且此刻磁盘上的元数据与预取时
//     逐字一致 → 返回预取结果（一次性消费）；
//   - 否则（受控重启已改写 pid.json、预取过期、二次复核）→ 透传到实时 verifyProcess。
// 一次性消费保证 ensure 在远端探测之后的 A6 复核仍拿到实时结果，语义与逐条查询一致。
export function createVerifyPrefetcher(registry, { now = Date.now, maxAgeMs = 5000 } = {}) {
  let prefetched = new Map(); // name -> { result, metaJson, at }

  async function prefetch(names) {
    prefetched = new Map();
    if (!registry || typeof registry.verifyProcesses !== "function") return prefetched;
    const at = now();
    const results = await registry.verifyProcesses(names);
    for (const [name, result] of results) {
      prefetched.set(name, { result, metaJson: JSON.stringify(result?.meta ?? null), at });
    }
    return prefetched;
  }

  async function verifyProcess(name) {
    const entry = prefetched.get(name);
    if (entry) {
      prefetched.delete(name);
      const fresh = now() - entry.at <= maxAgeMs;
      const current = typeof registry.readMeta === "function" ? registry.readMeta(name) : undefined;
      if (fresh && JSON.stringify(current ?? null) === entry.metaJson) return entry.result;
    }
    return registry.verifyProcess(name);
  }

  // registry 的方法都是闭包（不依赖 this），浅拷贝后只替换 verifyProcess 即可。
  return { prefetch, registry: { ...registry, verifyProcess } };
}
