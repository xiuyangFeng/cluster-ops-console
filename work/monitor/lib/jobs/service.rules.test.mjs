// v2.62 提醒规则的端到端验收：jobs 服务整轮（sacct 采集 → 失败取证 → 关注采集）跑真实的远端脚本
// （本机 /bin/sh 与 python3），Slurm 是临时目录里的假 sacct / squeue / scontrol，存储落在临时目录。
// 「假 ssh」只取调用里的远端命令在本机执行：不连任何主机。时钟手动推进，假 sacct 的时间按它生成。
// 桌面原生通知那一侧接的是真的轮询器（desktop/job-notices.mjs），系统通知是假的。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJobNoticesController } from "../../desktop/job-notices.mjs";
import { createDiagnosesStore, DIAGNOSES_FILE } from "./diagnoses-store.mjs";
import { FORENSICS_REMOTE_COMMAND } from "./forensics.mjs";
import { createJobRegistry, REGISTRY_FILE } from "./registry.mjs";
import { JOBS_REMOTE_COMMAND } from "./scan.mjs";
import { createJobsService } from "./service.mjs";
import { WATCH_REMOTE_COMMAND } from "./watch-scan.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "./watch-store.mjs";

const MIN = 60000;
const SERVER = "server-01";
const CONFIG = { servers: [{ id: SERVER, host: "cluster", name: "主集群服务器 (cluster)" }] };

const FAKE_SACCT = `#!/bin/sh
case " $* " in
  *SubmitLine*) cat "$FAKE_DIR/sacct-submit.txt" ;;
  *--units=K*) cat "$FAKE_DIR/sacct-resources.txt" ;;
  *) cat "$FAKE_DIR/sacct-jobs.txt" ;;
esac
`;
const FAKE_SQUEUE = '#!/bin/sh\ncat "$FAKE_DIR/squeue.txt"\n';
const FAKE_SCONTROL = "#!/bin/sh\nexit 1\n";

// 毫秒 → sacct 的远端本地时间写法（假集群在东八区）。
const stamp = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
const elapsed = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

function cluster() {
  const root = mkdtempSync(path.join(os.tmpdir(), "job-rules-e2e-"));
  const bin = path.join(root, "bin");
  const work = path.join(root, "w");
  const runtime = path.join(root, "runtime");
  for (const dir of [bin, work, runtime]) mkdirSync(dir, { recursive: true });
  for (const [name, body] of [["sacct", FAKE_SACCT], ["squeue", FAKE_SQUEUE], ["scontrol", FAKE_SCONTROL]]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  for (const name of ["sacct-jobs.txt", "sacct-submit.txt", "sacct-resources.txt", "squeue.txt"]) writeFileSync(path.join(bin, name), "");
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, TZ: "Asia/Shanghai", HOME: root, LC_ALL: "C" };
  // macOS 对新写出的可执行文件第一次执行要做一次安全评估（空闲时约 0.3 秒，机器忙时可达数秒），
  // 会吃掉远端脚本给每条 Slurm 命令的 6 秒时限。先各跑一次，把评估放在计时之外。
  for (const name of ["sacct", "squeue", "scontrol"]) spawnSync(path.join(bin, name), [], { env, timeout: 60000 });
  const user = os.userInfo().username;
  const commands = [];
  // 假 ssh：远端命令（sh -s / python3 -c …）原样交给本机 sh 执行，脚本与参数照旧走标准输入。
  // 机器内存吃紧时起子进程会卡上几秒；这一趟慢得不正常就重跑（远端脚本只读、同样的输入结果相同），最多三趟。
  const execCollector = async (invocation) => {
    const command = invocation.args.at(-1);
    commands.push(command);
    const once = () => {
      const startedAt = Date.now();
      const res = spawnSync("/bin/sh", ["-c", command], { input: invocation.input, encoding: "utf8", env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      return { res, ms: Date.now() - startedAt };
    };
    let attempt = once();
    for (let i = 0; i < 2 && attempt.ms > 4000; i += 1) attempt = once();
    return { code: attempt.res.status, stdout: attempt.res.stdout || "", stderr: attempt.res.stderr || "" };
  };
  let clock = Date.now();
  const start = clock;
  // 一台「电脑」上的整套服务：存储都读写 runtime 目录里的文件，重启 = 再建一套。
  const boot = () => createJobsService({
    getConfig: async () => CONFIG, execCollector, probeSshFailureReason: (code, stderr) => `exit ${code} ${stderr}`, now: () => clock,
    registry: createJobRegistry({ filePath: path.join(runtime, REGISTRY_FILE), now: () => clock }),
    diagnoses: createDiagnosesStore({ filePath: path.join(runtime, DIAGNOSES_FILE), now: () => clock }),
    watchStore: createJobWatchStore({ filePath: path.join(runtime, JOB_WATCH_FILE), now: () => clock }),
  });
  // rows：[id, name, state, { end?: 结束时刻, ran?: 已运行秒数, exit? }]
  const setJobs = (rows) => {
    const lines = rows.map(([id, name, state, { end = null, ran = 600, exit = state === "FAILED" ? "1:0" : "0:0" } = {}]) => {
      const pending = state === "PENDING";
      return [id, name, state, exit, stamp(start - 3600000), pending ? "Unknown" : stamp(start - 1800000), end ? stamp(end) : "Unknown", elapsed(pending ? 0 : ran), pending ? "None assigned" : "node01", "CPU"].join("|");
    });
    writeFileSync(path.join(bin, "sacct-jobs.txt"), lines.length ? `${lines.join("\n")}\n` : "");
    writeFileSync(path.join(bin, "sacct-submit.txt"), `${rows.map(([id, name]) => `${id}|${id}|${name}|${user}|${work}|sbatch run.sh`).join("\n")}\n`);
    writeFileSync(path.join(bin, "squeue.txt"), `${rows.filter(([, , state]) => state === "RUNNING" || state === "PENDING").map(([id, , state]) => `${id}|${user}|${state}`).join("\n")}\n`);
  };
  // 作业还在队列里时由 slow 采集登记的日志路径（这里直接喂 slurm 段原文）。
  const register = (service, entries) => service.observeSlurmSection(SERVER, [
    "state=ok", `user=${user}`, `jobreg_total=${entries.length}`,
    ...entries.map(([id, name, log]) => `jobreg=${id}|${id}|N/A|${name}|${work}|${path.join(work, log)}|(null)|${path.join(work, "run.sh")}`),
  ].join("\n"));
  return {
    root, work, runtime, user, commands, boot, setJobs, register,
    now: () => clock,
    at: (minutes) => { clock = start + minutes * MIN; return clock; },
    t: (minutes) => start + minutes * MIN,
    log: (name, body) => writeFileSync(path.join(work, name), body),
    saved: () => JSON.parse(readFileSync(path.join(runtime, JOB_WATCH_FILE), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const TRACEBACK = 'Traceback (most recent call last):\n  File "train.py", line 12, in <module>\n    cfg = arms[name]\nKeyError: \'arm\'\n';
const sshCount = (c, command) => c.commands.filter((item) => item === command).length;
const usable = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;

test("假 Slurm 端到端：新失败的作业合成一条提醒（带诊断出的原因），重启后不重发；规则命中的作业自动进组、结束后按上限滚动；手动关注不被挤占；免打扰期间不发；非法规则被拒", { skip: !usable, timeout: 300000 }, async () => {
  const c = cluster();
  try {
    let service = c.boot();
    const base = [
      ["2990", "old_fail", "FAILED", { end: c.t(-180) }],
      ["3001", "xp_wallgate", "RUNNING"],
      ["3002", "xp_queue", "PENDING"],
      ["3003", "lora_a", "RUNNING"],
      ["3004", "lora_b", "RUNNING"],
      ["3005", "eval_long", "RUNNING"],
    ];
    c.setJobs(base);
    c.log("train_3001.log", "epoch 3 step 40\n");
    await c.register(service, [["3001", "xp_wallgate", "train_%j.log"], ["3003", "lora_a", "lora_%j.log"], ["3004", "lora_b", "lora_%j.log"], ["3005", "eval_long", "eval_%j.log"]]);

    // 规则非法输入被拒，什么都不存。
    for (const body of [{ action: "rules", patterns: [""] }, { action: "rules", patterns: ["x".repeat(65)] }, { action: "rules", longRunMinutes: 3 }, { action: "rules", failNotify: "yes" }, { action: "rules" }]) {
      await assert.rejects(service.changeWatch(SERVER, body), (error) => error.status === 400, JSON.stringify(body));
    }
    const rules = await service.changeWatch(SERVER, { action: "rules", patterns: ["xp_*"] });
    assert.deepEqual(rules.rules, { failNotify: true, longRunMinutes: null, patterns: ["xp_*"] });

    // ---- 第 1 轮：建基线（两天内已有的失败不提醒）；规则命中的作业进组，同一轮就读到日志 ----
    const first = await service.runScan(SERVER);
    assert.equal(first.level, "ok", first.reason);
    let view = await service.getWatchView(SERVER);
    assert.deepEqual(view.notifications, [], "头一轮只建基线");
    assert.deepEqual(view.watches.map((w) => [w.label, w.auto.rule, w.jobIds]), [["xp_*", "name:xp_*", ["3001"]]], "排队中的 3002 不占名额，开始跑了才进组");
    const tracked = view.watches[0].jobs;
    assert.deepEqual([tracked[0].state, tracked[0].progress.status, tracked[0].progress.step, tracked[0].progress.epoch], ["RUNNING", "ok", 40, 3], "自动关注的作业与手动关注同一套采集");
    assert.deepEqual(view.suggestions.map((s) => s.prefix).sort(), ["eval_long", "lora_a", "lora_b", "old_fail"], "已有规则管着的 xp_ 不再建议");
    assert.deepEqual([sshCount(c, JOBS_REMOTE_COMMAND), sshCount(c, FORENSICS_REMOTE_COMMAND), sshCount(c, WATCH_REMOTE_COMMAND)], [1, 1, 1], "一轮还是原来那三次调用（采集 / 取证 / 关注），没有多出来的");

    // ---- 第 2 轮：三个作业失败——两个同因、一个超时 → 合成一条 ----
    c.log("lora_3003.log", `loading\n${TRACEBACK}`);
    c.log("lora_3004.log", `loading\n${TRACEBACK}`);
    c.log("eval_3005.log", "step 1\nslurmstepd: error: *** JOB 3005 ON node01 CANCELLED AT 2026-10-12T10:00:00 DUE TO TIME LIMIT ***\n");
    const failed = [
      ...base.slice(0, 2), ["3002", "xp_queue", "RUNNING"],
      ["3003", "lora_a", "FAILED", { end: c.t(2) }], ["3004", "lora_b", "FAILED", { end: c.t(3) }], ["3005", "eval_long", "TIMEOUT", { end: c.t(4), ran: 7200 }],
    ];
    c.setJobs(failed);
    c.at(5);
    await service.runScan(SERVER);
    view = await service.getWatchView();
    assert.equal(view.notifications.length, 1);
    const notice = view.notifications[0];
    assert.deepEqual([notice.kind, notice.watchId, notice.serverId, notice.title], ["failed", null, SERVER, "3 个作业失败"]);
    assert.equal(notice.body, "2 个 KeyError: 'arm'，1 个超出时限。作业号 3005、3004、3003。详情见「我的历史」。");
    assert.deepEqual(notice.jobIds, ["3005", "3004", "3003"]);
    assert.equal(notice.intro, undefined, "这位用户已经自己设过规则，不需要「默认开启」的说明");
    assert.deepEqual((await service.getWatchView(SERVER)).watches[0].jobs.map((j) => [j.id, j.state]), [["3001", "RUNNING"], ["3002", "RUNNING"]], "3002 开始跑了，这一轮进组");

    // ---- 重启：存储从文件读回，下一轮不重发 ----
    await service.flush();
    service = c.boot();
    c.at(10);
    await service.runScan(SERVER);
    view = await service.getWatchView();
    assert.deepEqual(view.notifications.map((n) => n.id), [notice.id], "重启后不重发");
    assert.deepEqual((await service.listDiagnoses(SERVER)).groups.map((g) => [g.category, g.count]), [["python", 2], ["timeout", 1], ["no-log", 1]]);

    // 桌面原生通知按这份收件箱轮询（desktop/job-notices.mjs）：接上真的轮询器，系统通知用假的记下标题。
    const shown = [];
    class FakeNotification {
      static isSupported() { return true; }
      constructor(options) { this.options = options; }
      on() {}
      show() { shown.push(this.options.title); }
    }
    const notifier = createJobNoticesController({ fetchNotifications: () => service.getWatchView(), Notification: FakeNotification, now: () => c.now(), timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} } });
    await notifier.start();
    assert.deepEqual(shown, ["3 个作业失败"], "不属于任何关注组的失败提醒照常弹出");

    // ---- 免打扰：新的失败照记进收件箱，但不弹系统通知；免打扰结束后也不补发 ----
    await service.changeWatch(null, { action: "settings", quietUntil: c.t(90) });
    c.setJobs([...failed, ["3006", "lora_c", "OUT_OF_MEMORY", { end: c.t(18) }]]);
    c.at(20);
    await service.runScan(SERVER);
    view = await service.getWatchView();
    assert.deepEqual(view.notifications.map((n) => [n.title, n.jobIds, n.readAt]), [["作业失败：lora_c", ["3006"], null], ["3 个作业失败", ["3005", "3004", "3003"], null]]);
    assert.equal(view.settings.quietUntil, c.t(90));
    assert.match(view.notifications[0].body, /^内存不足被系统终止。作业号 3006。/);
    await notifier.poll();
    assert.deepEqual(shown, ["3 个作业失败"], "免打扰期间不发");
    await service.changeWatch(null, { action: "settings", quietUntil: 0 });
    await notifier.poll();
    assert.deepEqual(shown, ["3 个作业失败"], "免打扰结束后不补发那一条");

    // ---- 名额：再来 70 个命中规则的作业，自动关注合计只到 60；结束的腾出位置后才收后面的 ----
    const pipeline = (states) => Array.from({ length: 70 }, (_, i) => [String(4001 + i), `cfdauto_mesh_${String(i).padStart(3, "0")}`, ...states(i)]);
    const withPipeline = (states) => [...failed, ["3006", "lora_c", "OUT_OF_MEMORY", { end: c.t(18) }], ...pipeline(states)];
    await service.changeWatch(SERVER, { action: "rules", patterns: ["xp_*", "cfdauto_*"] });
    c.setJobs(withPipeline(() => ["RUNNING"]));
    c.at(25);
    await service.runScan(SERVER);
    const autoJobs = async () => (await service.getWatchView(SERVER)).watches.filter((w) => w.auto).flatMap((w) => w.jobIds);
    let auto = await autoJobs();
    assert.equal(auto.length, 60, "两条规则合计 60 个");
    assert.deepEqual(auto.filter((id) => id.startsWith("3")).sort(), ["3001", "3002"]);
    assert.deepEqual(auto.filter((id) => id.startsWith("4")).sort().at(-1), "4058", "先提交的先进，后 12 个等名额");
    c.setJobs(withPipeline((i) => (i < 10 ? ["COMPLETED", { end: c.t(27) + i * 1000 }] : ["RUNNING"])));
    c.at(30);
    await service.runScan(SERVER);
    auto = await autoJobs();
    assert.equal(auto.length, 60);
    assert.deepEqual(auto.filter((id) => Number(id) >= 4001 && Number(id) <= 4010), [], "结束的 10 个被等着的在跑作业挤掉");
    assert.deepEqual(auto.filter((id) => id.startsWith("4")).sort().at(-1), "4068");
    assert.equal((await service.getWatchView()).notifications.length, 2, "进组、滚动、单个结束都不提醒");

    // ---- 手动关注不被挤占：手动关注 150 个，自动的让到只剩 50 个 ----
    const manual = Array.from({ length: 150 }, (_, i) => [String(5001 + i), `manual_${i}`, "RUNNING"]);
    c.setJobs([...withPipeline((i) => (i < 10 ? ["COMPLETED", { end: c.t(27) + i * 1000 }] : ["RUNNING"])), ...manual]);
    c.at(35);
    await service.runScan(SERVER);
    await service.changeWatch(SERVER, { action: "watch", jobIds: manual.slice(0, 100).map(([id]) => id), label: "手动一" });
    await service.changeWatch(SERVER, { action: "watch", jobIds: manual.slice(100).map(([id]) => id), label: "手动二" });
    view = await service.getWatchView(SERVER);
    assert.deepEqual(view.watches.filter((w) => !w.auto).map((w) => [w.label, w.jobIds.length]), [["手动一", 100], ["手动二", 50]]);
    assert.equal((await autoJobs()).length, 50);
    c.at(40);
    await service.runScan(SERVER);
    view = await service.getWatchView(SERVER);
    assert.deepEqual(view.watches.filter((w) => !w.auto).map((w) => w.jobIds.length), [100, 50], "下一轮自动关注也不会把手动的挤回去");
    assert.equal((await autoJobs()).length, 50);

    // ---- 免打扰结束之后的新失败：照常提醒、照常弹 ----
    c.setJobs([...withPipeline((i) => (i < 10 ? ["COMPLETED", { end: c.t(27) + i * 1000 }] : ["RUNNING"])), ...manual, ["3007", "lora_d", "FAILED", { end: c.t(43) }]]);
    c.at(45);
    await service.runScan(SERVER);
    await notifier.poll();
    assert.deepEqual(shown, ["3 个作业失败", "作业失败：lora_d"]);
    notifier.stop();

    await service.flush();
    const saved = c.saved();
    assert.equal(saved.watches.reduce((sum, w) => sum + w.jobs.length, 0), 200);
    assert.deepEqual(saved.settings[SERVER].rules, { failNotify: true, longRunMinutes: null, patterns: ["xp_*", "cfdauto_*"] });
    assert.deepEqual(Object.keys(saved.failures[SERVER].seen).sort(), ["2990", "3003", "3004", "3005", "3006", "3007"]);
    assert.deepEqual(saved.notifications.map((n) => [n.kind, n.watchId]), [["failed", null], ["failed", null], ["failed", null]]);
    // 整个过程只有那三种既有的远端命令，每轮各至多一次。
    assert.deepEqual([...new Set(c.commands)].sort(), [FORENSICS_REMOTE_COMMAND, JOBS_REMOTE_COMMAND, WATCH_REMOTE_COMMAND].sort());
    assert.equal(sshCount(c, JOBS_REMOTE_COMMAND), 9);
    assert.ok(sshCount(c, WATCH_REMOTE_COMMAND) <= 9 && sshCount(c, FORENSICS_REMOTE_COMMAND) <= 9);
  } finally { c.cleanup(); }
});

// 2026-10-12 独立审查第 1 条，接真的远端脚本（job-watch.py + job-subruns.py）走一遍：
// 单测里的 SSH 桩是照远端行为写的模型，这里确认真脚本对「条目上的游标」与「只有游标的收尾读取」确实这样回。
test("假 Slurm 端到端（审查 1）：自动关注的普通作业只在关注条目上记 stdout 游标、不建子任务状态；出现 LAUNCH / END 才建；最后一次采样之后才写出的子任务失败由结束后的收尾读取补上", { skip: !usable, timeout: 300000 }, async () => {
  const c = cluster();
  try {
    const service = c.boot();
    const iso = (ms) => `${stamp(ms)}+0800`;
    const running = [["4001", "xp_plain", "RUNNING"], ["4002", "xp_orch", "RUNNING"], ["4003", "xp_late", "RUNNING"]];
    c.setJobs(running);
    const out = { 4001: "starting\n", 4002: "starting\n", 4003: "starting\n" };
    const write = () => { for (const [id, body] of Object.entries(out)) c.log(`out_${id}.log`, body); };
    write();
    await c.register(service, running.map(([id, name]) => [id, name, "out_%j.log"]));
    await service.changeWatch(SERVER, { action: "rules", patterns: ["xp_*"], failNotify: false });

    // ---- 第 1 轮：三个都进组、都被采样；stdout 里还没有子任务事件 ----
    assert.equal((await service.runScan(SERVER)).level, "ok");
    const items = () => Object.fromEntries(c.saved().watches[0].jobs.map((j) => [j.id, j.orch ?? null]));
    const subruns = async () => Object.fromEntries((await service.getWatchView(SERVER)).watches[0].jobs.map((j) => [j.id, j.subruns && [j.subruns.launched, j.subruns.ended, j.subruns.failed, j.subruns.finalized]]));
    const stored = () => JSON.parse(readFileSync(path.join(c.runtime, "job-subruns.json"), "utf8")).jobs.map((state) => [state.jobId, state.auto === true, state.finalized]);
    let cursors = items();
    assert.deepEqual(Object.values(cursors).map((cur) => [cur.path, cur.off]), ["4001", "4002", "4003"].map((id) => [path.join(c.work, `out_${id}.log`), 9]), "读到哪了记在关注条目上");
    assert.ok(Object.values(cursors).every((cur) => /^\d+:\d+$/.test(cur.cid)));
    assert.deepEqual(await subruns(), { 4001: null, 4002: null, 4003: null });
    assert.deepEqual(stored(), [], "普通作业不建子任务状态");

    // ---- 第 2 轮：4001 继续写普通输出；4002 启动并结束了一个子任务 ----
    out[4001] += "epoch 1 step 10\n";
    out[4002] += `${iso(c.t(1))} LAUNCH A_s1 train 0\n${iso(c.t(3))} END A_s1 train 0\n`;
    write();
    c.at(5);
    await service.runScan(SERVER);
    cursors = items();
    assert.deepEqual([cursors[4001].off, cursors[4002], cursors[4003].off], [out[4001].length, null, 9], "4001 的游标前进；4002 有了状态，条目上的游标拿掉");
    assert.deepEqual(await subruns(), { 4001: null, 4002: [1, 1, 0, false], 4003: null });
    assert.deepEqual(stored(), [["4002", true, false]], "只有真是编排型的留状态，记在自动关注的名额里");

    // ---- 第 3 轮：4003 在上一次采样之后才启动子任务、子任务以退出码 1 结束，然后整个作业结束 ----
    out[4003] += `${iso(c.t(6))} LAUNCH B_s1 train 0\n${iso(c.t(7))} END B_s1 train 1\n`;
    write();
    c.setJobs([...running.slice(0, 2), ["4003", "xp_late", "COMPLETED", { end: c.t(8) }]]);
    c.at(10);
    await service.runScan(SERVER);
    assert.deepEqual(await subruns(), { 4001: null, 4002: [1, 1, 0, false], 4003: [1, 1, 1, true] }, "收尾读取补上了 4003 的子任务记录");
    assert.deepEqual(stored().sort(), [["4002", true, false], ["4003", true, true]]);
    assert.equal(items()[4003], null, "读回来之后不再留游标");
    const notices = (await service.getWatchView()).notifications;
    assert.deepEqual(notices.map((n) => [n.kind, n.title]), [["subrun-failed", "xp_* 有子任务失败"]]);
    assert.match(notices[0].body, /4003 · B_s1 train（退出码 1）/);
    await service.flush();
  } finally { c.cleanup(); }
});
