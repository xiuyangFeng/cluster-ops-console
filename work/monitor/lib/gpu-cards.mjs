// gpu-cards.mjs —— nvidia-smi 采集行的解析。主采集的 gpu 段（collector.mjs）与直连节点的
// hopkv 行（slurm.mjs）是同一种格式（remote/collect.sh 的 ct_gpu / ct_hop_script）：
//   gpu=<index>, <uuid>, <名称>, <显存已用 MiB>, <显存总量 MiB>, <利用率 %>, <温度 °C>, <功耗 W>
//   gpuproc=<uuid>|<pid>|<显存 MiB>|<属主>|<已运行秒数>|<Slurm 作业号>|<命令行>
//   gpuapp=<uuid>|<进程属主>|<显存 MiB>|<进程名>|<Slurm 作业号>     （v2.76 之前的行，照旧能读）
// 这里只收「=」右边的部分。温度 / 功耗在不支持的卡或老驱动上是空串或 [N/A]，按缺失（null）处理。
// 占用者按属主合并显存；nvidia-cuda-mps 守护进程每张卡都挂着一个，不算占用者。
// 作业号（v2.62 起追加，取自进程的 cgroup，不在作业里时为空）：采集账号自己的进程另按作业合并
// 显存，挂在它那一项的 jobs 上——同一张卡上用 MPS 叠了几个训练时，分得出各占多少。别人的进程仍只到属主。
// v2.76（L2）：gpuproc 行额外保留每个进程（pid / 已运行秒数 / 命令行），挂在属主那一项的 procs 上——
// 「不经 Slurm 直接跑 python 占卡」这件事要看得出是谁、跑了多久、怎么起的。命令行是行尾自由文本
// （远端已把 | 换成空格），解析按固定 6 段切、其余整段都算命令行。
// 进程名（comm）不再单独采集，由命令行第一个词的 basename 推出——它只用于上面那条 MPS 判定。

const NAME_MAX = 64;
const UUID_MAX = 96;
export const GPU_MAX_USERS_PER_CARD = 16;
// 一段采集最多 64 行进程（collect.sh 的 head -n 64），一张卡上的作业数不会超过它；这个上限只是兜底。
export const GPU_MAX_JOBS_PER_CARD = 64;
// 同理：一张卡上的进程条目上限（正常远小于它）。
export const GPU_MAX_PROCS_PER_CARD = 64;
// 命令行给人的可读上限（远端已截过一次，这里兜底防超长输入）。
const CMDLINE_MAX = 400;

const clip = (text, max) => String(text ?? "").trim().slice(0, max);
const toNumber = (text) => {
  const value = Number.parseFloat(String(text ?? "").trim());
  return Number.isFinite(value) ? value : null;
};
const toIndex = (text) => (/^\d+$/.test(String(text ?? "").trim()) ? Number(String(text).trim()) : null);

// 名称可能含逗号：前 2 段（index / uuid）与后 5 段（显存已用 / 总量 / 利用率 / 温度 / 功耗）固定，
// 中间拼回。6～7 段的是 v2.33 的旧格式（没有温度与功耗，后 3 段固定），照旧能读。
export function parseGpuCardLine(value) {
  const parts = String(value ?? "").split(",").map((part) => part.trim());
  if (parts.length < 6) return null;
  const index = toIndex(parts[0]);
  if (index == null) return null;
  const tail = parts.length >= 8 ? 5 : 3;
  const name = clip(parts.slice(2, parts.length - tail).join(", "), NAME_MAX);
  if (!name) return null;
  const [memUsed, memTotal, util, temp, power] = parts.slice(-tail).map(toNumber);
  return {
    index,
    uuid: clip(parts[1], UUID_MAX),
    name,
    util,
    memUsedMb: memUsed,
    memTotalMb: memTotal,
    tempC: temp == null ? null : Math.round(temp),
    powerW: power == null ? null : Math.round(power * 10) / 10,
    users: [],
  };
}

// 作业号是行尾追加的字段：5 段及以上时取最后一段（进程名里出现 | 也不会错位），只认纯数字。
// 3～4 段的是 v2.61 及更早的格式（没有作业号），照旧能读。
const OWNER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseGpuAppLine(value) {
  const parts = String(value ?? "").split("|");
  const [uuid, user, mem, comm] = parts;
  if (!uuid?.trim()) return null;
  const owner = String(user || "").trim();
  const job = parts.length >= 5 ? parts[parts.length - 1].trim() : "";
  return {
    uuid: clip(uuid, UUID_MAX),
    user: OWNER_RE.test(owner) ? owner : "未知",
    memMb: toNumber(mem),
    comm: clip(comm, 32),
    jobId: /^\d{1,12}$/.test(job) ? job : null,
  };
}

// 进程名（comm）：只用来认 MPS 守护进程。远端不再单独 ps 一次取 comm，从命令行的第一个词取 basename：
// 「python train.py --x」→ python，「/usr/bin/python3.11 -u x.py」→ python3.11。
// 可执行名里带空格的极少（ps 的 args 列本身也这么切），取不到就返回空串（调用方按普通占用者处理）。
export function gpuCommFromCmdline(cmdline) {
  const first = String(cmdline ?? "").trim().split(/\s+/)[0] || "";
  return clip(first.slice(first.lastIndexOf("/") + 1), 32);
}

// gpuproc 行（v2.76）：前 6 段固定且不含 |，第 7 段起是命令行自由文本（远端已把 | 换成空格）。
// pid 必须是纯数字（nvidia-smi 给的就是 pid；读不到 pid 的行没有保留价值）；uuid 为空、段数不足 → 丢弃。
export function parseGpuProcLine(value) {
  const parts = String(value ?? "").split("|");
  if (parts.length < 6) return null;
  const uuid = clip(parts[0], UUID_MAX);
  const pid = String(parts[1] ?? "").trim();
  if (!uuid || !/^\d{1,12}$/.test(pid)) return null;
  const owner = String(parts[3] || "").trim();
  const job = String(parts[5] || "").trim();
  const cmdline = clip(parts.slice(6).join("|"), CMDLINE_MAX);
  // ps 的 etimes 是整数秒。只认纯数字：老 ps 给别的写法（或没有这一列）时按「未知」处理，
  // 不用 parseFloat——那会把 "3d" 读成 3 秒，把没取到的字段说成一个像样的数。
  const etimes = /^\d{1,10}$/.test(String(parts[4] ?? "").trim()) ? Number(String(parts[4]).trim()) : null;
  return {
    uuid,
    pid,
    memMb: toNumber(parts[2]),
    user: OWNER_RE.test(owner) ? owner : "未知",
    etimes,
    jobId: /^\d{1,12}$/.test(job) ? job : null,
    comm: gpuCommFromCmdline(cmdline),
    cmdline,
  };
}

// MPS 守护进程每张卡都挂一个，不算占用者。进程名来自命令行 basename，个别环境会带方括号。
const isMpsDaemon = (app) => /^\[?nvidia-cuda-mps/.test(app.comm || "");
const byMemDesc = (a, b) => (b.memMb ?? 0) - (a.memMb ?? 0);

// 把占用进程并到各自的卡上（按 uuid 对应），同一属主的显存相加，按显存从大到小排。原地修改 cards。
// selfUser（采集账号）给了的话，它名下带作业号的进程再按作业合并：那一项多一个
// jobs: [{ id, memMb }]（按显存从大到小）；它不在作业里的进程只计入 memMb，不进 jobs。
// 不是合法账号名的 selfUser 当没给（属主认不出时记的「未知」不会被当成自己）。
// v2.76：行里带 pid 的（gpuproc）另在属主那一项挂 procs: [{ pid, memMb, etimes, jobId, comm, cmdline }]，
// 按显存从大到小；每张卡最多 GPU_MAX_PROCS_PER_CARD 条。gpuapp 旧行没有 pid，不产生 procs
// （形状与 v2.75 逐字一致，老的消费方与测试不受影响）。
export function attachGpuUsers(cards, apps, { selfUser: rawSelf = null } = {}) {
  const selfUser = typeof rawSelf === "string" && OWNER_RE.test(rawSelf) ? rawSelf : null;
  const byUuid = new Map(cards.filter((card) => card.uuid).map((card) => [card.uuid, card]));
  const procCount = new Map(); // uuid -> 已收的进程条数（跨属主合计的每卡上限）
  for (const app of apps) {
    if (!app || isMpsDaemon(app)) continue;
    const card = byUuid.get(app.uuid);
    if (!card) continue;
    let entry = card.users.find((item) => item.user === app.user);
    if (entry) entry.memMb = (entry.memMb ?? 0) + (app.memMb ?? 0);
    else if (card.users.length < GPU_MAX_USERS_PER_CARD) {
      entry = { user: app.user, memMb: app.memMb };
      card.users.push(entry);
    }
    if (!entry) continue;
    if (app.pid != null) {
      const used = procCount.get(app.uuid) ?? 0;
      if (used < GPU_MAX_PROCS_PER_CARD) {
        procCount.set(app.uuid, used + 1);
        entry.procs ||= [];
        entry.procs.push({
          pid: app.pid,
          memMb: app.memMb,
          etimes: app.etimes ?? null,
          jobId: app.jobId,
          comm: app.comm || "",
          cmdline: app.cmdline || "",
        });
      }
    }
    if (!selfUser || (selfUser !== "root" && app.user !== selfUser) || !app.jobId) continue;
    entry.jobs ||= [];
    const job = entry.jobs.find((item) => item.id === app.jobId);
    if (job) job.memMb = (job.memMb ?? 0) + (app.memMb ?? 0);
    else if (entry.jobs.length < GPU_MAX_JOBS_PER_CARD) entry.jobs.push({ id: app.jobId, memMb: app.memMb });
  }
  for (const card of cards) {
    card.users.sort(byMemDesc);
    for (const entry of card.users) {
      entry.jobs?.sort(byMemDesc);
      entry.procs?.sort(byMemDesc);
    }
  }
  return cards;
}
