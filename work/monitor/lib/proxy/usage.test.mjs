// 隧道使用记录（v2.62）：有界、少写盘；v2.88 起与口令模式无关、一直记。时间与定时器全部注入，不等真实的一分钟。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createUsageRecorder,
  isUsageKey,
  parseUsageDocument,
  PROXY_USAGE_FILE,
  serializeUsage,
  USAGE_COLUMNS,
  USAGE_FLUSH_INTERVAL_MS,
  USAGE_HOUR_MS,
  USAGE_HOURS,
  USAGE_MAX_BYTES,
  USAGE_OTHER_KEY,
  USAGE_TARGET_LIMIT,
  usageHourStart,
  usageTargetKey,
} from "./usage.mjs";

const HOUR = USAGE_HOUR_MS;
const T0 = 500 * HOUR; // 任意一个整点

// 注入版记录器：时间由测试推进，写盘进内存，定时器只登记不触发（由测试手动 tick）。
function harness({ mode = "observe", start = true, existing = null, ...options } = {}) {
  const state = { now: T0 + 1000, writes: [], syncWrites: [], intervals: [], cleared: [], lines: [], failWrites: false };
  const recorder = createUsageRecorder({
    filePath: "/runtime/proxy-usage.json",
    pid: 4242,
    now: () => state.now,
    log: (line) => state.lines.push(line),
    readFile: () => {
      if (existing === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return existing;
    },
    write: async (_file, body) => {
      if (state.failWrites) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      state.writes.push(body);
    },
    writeSync: (_file, body) => {
      state.syncWrites.push(body);
    },
    setIntervalImpl: (fn, ms) => {
      state.intervals.push({ fn, ms });
      return state.intervals.length;
    },
    clearIntervalImpl: (id) => state.cleared.push(id),
    ...options,
  });
  if (mode) recorder.setAuthMode(mode);
  if (start) recorder.start();
  return { recorder, state };
}

// 假 socket：只有记录器读的那几样（字节计数 + close 事件）。
function fakeSocket() {
  const socket = new EventEmitter();
  socket.bytesWritten = 0;
  socket.bytesRead = 0;
  return socket;
}

const rows = (recorder) => Object.fromEntries(recorder.snapshot().hours.flatMap(({ t, targets }) => [...targets].map(([key, row]) => [`${(t - T0) / HOUR}h ${key}`, row])));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("usageTargetKey：主机小写、IPv6 带中括号；字符不在白名单里的目标不进记录", () => {
  assert.equal(usageTargetKey("API.OpenAI.com", "443"), "api.openai.com:443");
  assert.equal(usageTargetKey("93.184.216.34", 8443), "93.184.216.34:8443");
  assert.equal(usageTargetKey("::1", 443), "[::1]:443");
  assert.equal(usageTargetKey("[2001:DB8::1]", "443"), "[2001:db8::1]:443");
  for (const [host, port] of [
    ['evil"host', 443], ["a b", 443], ["<script>", 443], ["a%0d%0ab", 443], ["", 443], ["x".repeat(254), 443],
    ["ok.example.com", 0], ["ok.example.com", 70000], ["ok.example.com", "abc"], ["zz::zz", 443], [null, 443],
  ]) {
    assert.equal(usageTargetKey(host, port), null, `${host}:${port}`);
  }
  assert.equal(isUsageKey("api.openai.com:443"), true);
  assert.equal(isUsageKey("[::1]:443"), true);
  assert.equal(isUsageKey(USAGE_OTHER_KEY), true);
  for (const bad of ['a"b:443', "noport", "a:b:c", "", null, 42]) assert.equal(isUsageKey(bad), false, String(bad));
});

test("口令模式关着也记（v2.88）：去向与流量照记、照写盘；口令计数只有口令模式开着时才有调用方", async () => {
  const { recorder, state } = harness({ mode: null });
  assert.equal(recorder.isActive(), true);
  assert.equal(recorder.hasTimer(), true, "有定时器：每分钟补记还开着的连接");
  const socket = fakeSocket();
  recorder.tunnelOpened("api.openai.com:443", socket);
  recorder.requestDone("api.openai.com:443", { up: 10, down: 20 });
  socket.bytesRead = 300;
  await recorder.tick();
  await settle();
  const row = recorder.snapshot().hours[0].targets.get("api.openai.com:443");
  assert.equal(row[0], 2, "两次连接");
  assert.equal(row[2], 320);
  assert.ok(state.writes.length >= 1, "照写盘");
  assert.equal(parseUsageDocument(state.writes.at(-1)).auth.mode, "off");
});

test("start 之前只记下模式：不读盘、不写盘（交接时旧代理还是这份文件的主人）", async () => {
  let reads = 0;
  const { recorder, state } = harness({ mode: "enforce", start: false, readFile: () => { reads += 1; throw new Error("x"); } });
  recorder.noteAuth("a.example.com:443", "ok");
  await recorder.tick();
  await settle();
  assert.equal(reads, 0);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.intervals, []);
  assert.deepEqual(recorder.snapshot().hours, []);
});

test("计数：带对 / 没带 / 带错 / 被拒，连接数与字节（隧道读 socket 自带的计数，关闭时补齐）", async () => {
  const { recorder, state } = harness();
  const key = "api.openai.com:443";
  recorder.noteAuth(key, "ok");
  recorder.noteAuth(key, "missing");
  recorder.noteAuth(key, "bad");
  recorder.noteDenied(key, "missing");
  recorder.noteDenied(key, "bad");

  const socket = fakeSocket();
  recorder.tunnelOpened(key, socket, { baseUp: 100, baseDown: 40 }); // 建隧道用掉的字节不算
  socket.bytesWritten = 100 + 300;
  socket.bytesRead = 40 + 7000;
  state.now += 30_000;
  await recorder.tick(); // 还开着：补记一次
  assert.deepEqual(rows(recorder)[`0h ${key}`], [1, 300, 7000, state.now, 1, 2, 2, 2]);

  socket.bytesWritten += 50;
  socket.bytesRead += 500;
  state.now += 5_000;
  socket.emit("close");
  assert.deepEqual(rows(recorder)[`0h ${key}`], [1, 350, 7500, state.now, 1, 2, 2, 2], "关闭时补上最后一段，不重复计");
  assert.equal(recorder.liveCount(), 0);

  recorder.requestDone("relay.example.com:9443", { up: 12, down: 3456 });
  assert.deepEqual(rows(recorder)["0h relay.example.com:9443"].slice(0, 3), [1, 12, 3456]);
  assert.deepEqual(USAGE_COLUMNS, ["conn", "up", "down", "lastAt", "authed", "missing", "bad", "denied"]);
});

test("跨小时的长连接：字节记进它实际发生的那个小时", async () => {
  const { recorder, state } = harness();
  const socket = fakeSocket();
  recorder.tunnelOpened("stream.example.com:443", socket);
  socket.bytesRead = 1000;
  await recorder.tick();
  state.now = T0 + HOUR + 5000;
  socket.bytesRead = 1000 + 250;
  await recorder.tick();
  assert.deepEqual(rows(recorder)["0h stream.example.com:443"].slice(0, 3), [1, 0, 1000]);
  assert.deepEqual(rows(recorder)["1h stream.example.com:443"].slice(0, 3), [0, 0, 250], "第二个小时只有字节，不重复计连接");
});

test("目标名上限 200：超出的记进「其它」；被拒的请求只能占前一半名额", () => {
  const { recorder } = harness({ mode: "enforce" });
  // 不带口令的人拿随机主机名刷：最多占 100 个名字，其余全进「其它」。
  for (let i = 0; i < 500; i += 1) recorder.noteDenied(`junk${i}.example.com:443`, "missing");
  let snapshot = rows(recorder);
  assert.equal(Object.keys(snapshot).filter((k) => k.includes("junk")).length, USAGE_TARGET_LIMIT / 2);
  assert.equal(snapshot[`0h ${USAGE_OTHER_KEY}`][7], 400, "其余 400 次被拒记在「其它」");
  // 正常流量的目标仍有名额。
  for (let i = 0; i < 150; i += 1) recorder.noteAuth(`real${i}.example.com:443`, "ok");
  snapshot = rows(recorder);
  assert.equal(Object.keys(snapshot).filter((k) => k.includes("real")).length, USAGE_TARGET_LIMIT / 2);
  assert.equal(snapshot[`0h ${USAGE_OTHER_KEY}`][4], 50, "名额用完之后的 50 个记在「其它」");
  assert.equal(Object.keys(snapshot).length, USAGE_TARGET_LIMIT + 1);
  // 已经有名字的目标照常记在自己名下。
  recorder.noteDenied("junk0.example.com:443", "bad");
  assert.equal(rows(recorder)["0h junk0.example.com:443"][7], 2);
  // 不合规的键、null 一律「其它」。
  recorder.noteAuth(null, "missing");
  recorder.noteAuth('bad"key:443', "missing");
  assert.equal(rows(recorder)[`0h ${USAGE_OTHER_KEY}`][5], 400 + 2);
});

test("只留最近 48 个小时桶；过期的桶丢掉后名额随之腾出", () => {
  const { recorder, state } = harness();
  for (let h = 0; h < 60; h += 1) {
    state.now = T0 + h * HOUR + 1;
    recorder.noteAuth(`hour${h}.example.com:443`, "ok");
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.hours.length, USAGE_HOURS);
  assert.equal(snapshot.hours[0].t, T0 + 12 * HOUR);
  assert.equal(snapshot.hours.at(-1).t, T0 + 59 * HOUR);
  // 名字只剩保留期内的 48 个：再来 152 个新目标都还能有自己的名字。
  for (let i = 0; i < 152; i += 1) recorder.noteAuth(`fresh${i}.example.com:443`, "ok");
  assert.equal([...recorder.snapshot().hours.at(-1).targets.keys()].includes(USAGE_OTHER_KEY), false);
  recorder.noteAuth("one-too-many.example.com:443", "ok");
  assert.equal(recorder.snapshot().hours.at(-1).targets.get(USAGE_OTHER_KEY)[4], 1);
});

test("落盘不超过 128 KB：最坏情况（每小时 200 个最长的目标名）先压每小时的目标数，再丢最旧的小时", () => {
  const longHost = (i) => `${String(i).padStart(4, "0")}.${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}`.slice(0, 253);
  const hours = [];
  for (let h = 0; h < USAGE_HOURS; h += 1) {
    const targets = new Map();
    for (let i = 0; i < USAGE_TARGET_LIMIT; i += 1) targets.set(`${longHost(i)}:65535`, [9e9 + i, 9e15, 9e15, 1.76e12, 9e9, 9e9, 9e9, 9e9]);
    targets.set(USAGE_OTHER_KEY, [1, 2, 3, 4, 5, 6, 7, 8]);
    hours.push({ t: T0 + h * HOUR, targets });
  }
  const body = serializeUsage({ pid: 1, startedAt: 1, writtenAt: 2, auth: { mode: "enforce", since: 1 }, hours });
  assert.ok(Buffer.byteLength(body) <= USAGE_MAX_BYTES, `实际 ${Buffer.byteLength(body)} 字节`);
  const parsed = parseUsageDocument(body);
  assert.ok(parsed.hours.length >= 1);
  assert.equal(parsed.hours.at(-1).t, T0 + (USAGE_HOURS - 1) * HOUR, "留下的是最新的小时");
  // 压掉的目标并进了「其它」，合计不丢：每小时的连接数总和不变。
  const total = (targets) => [...targets.values()].reduce((sum, row) => sum + row[0], 0);
  assert.equal(total(parsed.hours.at(-1).targets), total(hours.at(-1).targets));
  // 连接最多的目标留在名下（i 越大连接数越多）。
  assert.ok([...parsed.hours.at(-1).targets.keys()].some((key) => key.startsWith("0199.")));

  // 更小的上限也守得住；一条都放不下时宁可给出没有小时的空壳，也不超限。
  const tiny = serializeUsage({ pid: 1, startedAt: 1, writtenAt: 2, auth: { mode: "enforce", since: 1 }, hours }, { maxBytes: 600 });
  assert.ok(Buffer.byteLength(tiny) <= 600);
  assert.deepEqual(parseUsageDocument(tiny).hours, []);
});

test("正常规模原样往返：不压缩、不丢行", () => {
  const targets = new Map([["api.openai.com:443", [3, 100, 200, T0 + 5, 2, 1, 0, 0]], ["chatgpt.com:443", [1, 1, 1, T0 + 9, 0, 1, 0, 0]]]);
  const body = serializeUsage({ pid: 77, startedAt: 10, writtenAt: 20, auth: { mode: "observe", since: 15 }, hours: [{ t: T0, targets }] });
  const parsed = parseUsageDocument(body);
  assert.deepEqual({ pid: parsed.pid, startedAt: parsed.startedAt, writtenAt: parsed.writtenAt, auth: parsed.auth }, { pid: 77, startedAt: 10, writtenAt: 20, auth: { mode: "observe", since: 15 } });
  assert.deepEqual([...parsed.hours[0].targets], [...targets]);
});

test("parseUsageDocument：不是我们写的东西不照单全收", () => {
  assert.equal(parseUsageDocument("{ nope"), null);
  assert.equal(parseUsageDocument(JSON.stringify({ v: 2, hours: [] })), null);
  assert.equal(parseUsageDocument(JSON.stringify({ v: 1 })), null);
  const parsed = parseUsageDocument(JSON.stringify({
    v: 1,
    pid: "12; rm -rf /",
    auth: { mode: "surprise", since: -5 },
    hours: [
      { t: T0 + 123, targets: { "a.example.com:443": [1, 1, 1, 1, 1, 1, 1, 1] } }, // 不是整点
      { t: T0, targets: { '<img src=x onerror=1>:443': [1, 1, 1, 1, 1, 1, 1, 1], "ok.example.com:443": [1.9, -5, "7", null, Number.MAX_VALUE, 2, 3, 4], "short.example.com:443": [1, 2] } },
      { t: T0 + HOUR, targets: [] },
      "garbage",
    ],
  }));
  assert.equal(parsed.pid, null);
  assert.deepEqual(parsed.auth, { mode: null, since: 0 });
  assert.equal(parsed.hours.length, 1);
  assert.deepEqual([...parsed.hours[0].targets], [["ok.example.com:443", [1, 0, 0, 0, Number.MAX_SAFE_INTEGER, 2, 3, 4]]], "非法键与形状不对的行跳过，数值钳成不超过安全整数的非负整数");
});

test("写盘：有变化才写，每个定时器周期最多一次；内容没变不写", async () => {
  const { recorder, state } = harness();
  await settle();
  // start 时回报一次「这个进程已经按 observe 在跑」。
  assert.equal(state.writes.length, 1);
  assert.deepEqual(parseUsageDocument(state.writes[0]).auth, { mode: "observe", since: T0 + 1000 });
  assert.equal(parseUsageDocument(state.writes[0]).pid, 4242);
  assert.deepEqual(state.intervals.map((i) => i.ms), [USAGE_FLUSH_INTERVAL_MS], "一个定时器，一分钟一拍");

  // 记了一堆东西：不立刻写，等定时器。
  for (let i = 0; i < 50; i += 1) recorder.noteAuth("api.openai.com:443", "missing");
  await settle();
  assert.equal(state.writes.length, 1);
  await state.intervals[0].fn();
  await settle();
  assert.equal(state.writes.length, 2);
  assert.equal(parseUsageDocument(state.writes[1]).hours[0].targets.get("api.openai.com:443")[5], 50);

  // 之后什么都没发生：定时器走多少拍都不写。
  for (let i = 0; i < 5; i += 1) await recorder.tick();
  assert.equal(state.writes.length, 2, "内容没变不写盘");
});

test("写盘失败：保留待写状态下一轮再试，告警限频、不带内容", async () => {
  const { recorder, state } = harness();
  await settle();
  state.failWrites = true;
  recorder.noteAuth("api.openai.com:443", "ok");
  await recorder.tick();
  await recorder.tick();
  assert.deepEqual(state.lines, ["[proxy-usage] 使用记录写盘失败（ENOSPC），下一轮再试"]);
  state.failWrites = false;
  await recorder.tick();
  assert.equal(parseUsageDocument(state.writes.at(-1)).hours[0].targets.get("api.openai.com:443")[4], 1, "恢复后把攒下的写出去");
});

test("模式变化立刻写一次（控制面靠它确认代理已按新设置在跑）；切到关：照写一次、继续记（v2.88）", async () => {
  const { recorder, state } = harness();
  await settle();
  const socket = fakeSocket();
  recorder.tunnelOpened("api.openai.com:443", socket);
  socket.bytesRead = 900;
  await recorder.tick();
  const before = state.writes.length;

  state.now += 2000;
  recorder.setAuthMode("enforce");
  await settle();
  assert.equal(state.writes.length, before + 1, "不等一分钟");
  assert.deepEqual(parseUsageDocument(state.writes.at(-1)).auth, { mode: "enforce", since: state.now });

  socket.bytesRead = 900 + 100;
  state.now += 2000;
  recorder.setAuthMode("off");
  await settle();
  const last = parseUsageDocument(state.writes.at(-1));
  assert.deepEqual(last.auth, { mode: "off", since: state.now });
  assert.equal(last.hours[0].targets.get("api.openai.com:443")[2], 1000, "切换时把还开着的连接补记完");
  assert.equal(recorder.hasTimer(), true, "关了口令也继续记");
  assert.equal(recorder.isActive(), true);

  socket.bytesRead += 5000;
  socket.emit("close");
  await recorder.tick();
  await settle();
  assert.equal(recorder.snapshot().hours[0].targets.get("api.openai.com:443")[2], 6000);
});

test("模式切换撞上正在写盘：写完再补一次，最后落盘的是最新模式", async () => {
  let releaseWrite;
  const bodies = [];
  const { recorder } = harness({
    start: false,
    write: (_file, body) => new Promise((resolve) => {
      bodies.push(body);
      releaseWrite = resolve;
    }),
  });
  recorder.start(); // 第一次写挂着不返回
  recorder.setAuthMode("off"); // 此时切到关：没有下一轮定时器可等
  assert.equal(bodies.length, 1);
  releaseWrite();
  await settle();
  await settle();
  assert.equal(bodies.length, 2);
  assert.equal(parseUsageDocument(bodies[1]).auth.mode, "off");
  releaseWrite();
});

test("接着记：启动时读回已有记录；过期的小时不要；坏文件从空白开始", () => {
  const existing = serializeUsage({
    pid: 1,
    startedAt: 1,
    writtenAt: 2,
    auth: { mode: "observe", since: 1 },
    hours: [
      { t: T0 - 60 * HOUR, targets: new Map([["old.example.com:443", [5, 0, 0, 0, 0, 0, 0, 0]]]) },
      { t: T0 - HOUR, targets: new Map([["api.openai.com:443", [7, 70, 700, T0 - 10, 7, 0, 0, 0]]]) },
    ],
  });
  const { recorder } = harness({ existing });
  recorder.noteAuth("api.openai.com:443", "ok");
  const snapshot = rows(recorder);
  assert.deepEqual(snapshot["-1h api.openai.com:443"], [7, 70, 700, T0 - 10, 7, 0, 0, 0]);
  assert.equal(snapshot["0h api.openai.com:443"][4], 1);
  assert.equal(Object.keys(snapshot).some((k) => k.includes("old.example.com")), false, "48 小时之前的不读回");

  const broken = harness({ existing: "{ half" });
  broken.recorder.noteAuth("api.openai.com:443", "ok");
  assert.equal(Object.keys(rows(broken.recorder)).length, 1);
  assert.deepEqual(broken.state.lines, [], "读不出已有记录不算错误");
});

test("release（平滑交接时旧代理放掉监听之前）：同步写最后一次，此后不记、不写、定时器停掉", async () => {
  const { recorder, state } = harness();
  await settle();
  const socket = fakeSocket();
  recorder.tunnelOpened("api.openai.com:443", socket);
  socket.bytesWritten = 64;
  recorder.release();
  assert.equal(state.syncWrites.length, 1, "同步写，返回时已经在盘上");
  assert.deepEqual(parseUsageDocument(state.syncWrites[0]).hours[0].targets.get("api.openai.com:443").slice(0, 3), [1, 64, 0]);
  assert.equal(recorder.hasTimer(), false);

  const asyncWrites = state.writes.length;
  recorder.noteAuth("api.openai.com:443", "ok");
  recorder.setAuthMode("enforce");
  socket.bytesWritten = 9999;
  socket.emit("close");
  await recorder.tick();
  recorder.release();
  await settle();
  assert.equal(state.writes.length, asyncWrites);
  assert.equal(state.syncWrites.length, 1, "放手之后这份文件归新代理写");
});

test("真实文件：0600、目录不存在会自己建、内容里只有目标与计数", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "runtime", PROXY_USAGE_FILE);
  const recorder = createUsageRecorder({ filePath, setIntervalImpl: () => 1, clearIntervalImpl: () => {}, log: () => {} });
  recorder.setAuthMode("observe");
  recorder.start(); // 启动时的那次回报是异步写：等它落盘（目录就是这时建出来的）
  for (let i = 0; i < 200 && !existsSync(filePath); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(filePath), true);
  recorder.noteAuth("api.openai.com:443", "missing");
  for (let i = 0; i < 200 && !(await recorder.flush()); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const text = readFileSync(filePath, "utf8");
  const parsed = parseUsageDocument(text);
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.hours[0].targets.get("api.openai.com:443")[5], 1);
  // 跨整点时这一条可能落在后一个小时桶里：两个都算对。
  assert.ok([usageHourStart(Date.now()), usageHourStart(Date.now()) - USAGE_HOUR_MS].includes(parsed.hours[0].t));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["auth", "hours", "pid", "startedAt", "v", "writtenAt"], "文件里只有这几样");
  assert.equal(await recorder.flush(), false, "没有新变化不写");

  // 另一个进程（重启后的代理）接着这份文件记。
  const next = createUsageRecorder({ filePath, setIntervalImpl: () => 1, clearIntervalImpl: () => {}, log: () => {} });
  next.setAuthMode("observe");
  next.start();
  next.noteAuth("api.openai.com:443", "ok");
  next.release();
  const row = parseUsageDocument(readFileSync(filePath, "utf8")).hours[0].targets.get("api.openai.com:443");
  assert.deepEqual([row[4], row[5]], [1, 1]);
});
