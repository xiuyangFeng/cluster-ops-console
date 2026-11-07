import assert from "node:assert/strict";
import test from "node:test";
// 模块可在 Node 导入本身即是回归验证（曾因顶层 document 引用直接 ReferenceError）。
import { updateProgressBar, renderRemoteLoad, createSampleTrack } from "./render/load-panel.js";
import { buildServerCardModel, gpuColor } from "./render/server-card-model.js";
import { parseRemoteLoad, trendDirection } from "./render/resources-model.js";

// 远端采样文本样例：hostname + uptime + free -h(Mem 行) + df -h(挂载行)
const SAMPLE = [
  "myserver",
  " 14:20:01 up 12 days,  3:42,  2 users,  load average: 0.52, 0.48, 0.45",
  "Mem:            31G        12G        18G       1.0G       1.2G        18G",
  "/dev/sda1       458G  120G  315G  28% /",
].join("\n");

test("parseRemoteLoad: 完整样例的 hostname/uptime/load/RAM/DISK 解析", () => {
  const p = parseRemoteLoad(SAMPLE, "-");
  assert.equal(p.hostname, "myserver");
  assert.equal(p.uptime, "up 12 days,  3:42,  2 users");
  assert.equal(p.cpuText, "Load: 0.52");
  assert.equal(p.cpuPercent, 52);
  assert.equal(p.ramPercent, 39); // 12/31 ≈ 38.7 → round 39
  assert.match(p.ramText, /^12G \/ 31G \(39%\)$/);
  assert.equal(p.diskPercent, 28);
  assert.equal(p.diskText, "28% (120G / 458G)");
});

test("parseRemoteLoad: load1 超过 1.0 时 CPU 百分比封顶 100", () => {
  const p = parseRemoteLoad("h\n up 1 day, load average: 3.20, 2.0, 1.0", "-");
  assert.equal(p.cpuPercent, 100);
  assert.equal(p.cpuText, "Load: 3.20");
});

test("parseRemoteLoad: g↔m 单位换算 —— total G / used M 时 used 除以 1024", () => {
  const p = parseRemoteLoad("h\nMem:  31G  512M  30G", "-");
  assert.equal(p.ramPercent, 2); // 0.5/31 ≈ 1.6 → round 2
  assert.match(p.ramText, /512M \/ 31G/);
});

test("parseRemoteLoad: g↔m 单位换算 —— total M / used G 时 total 除以 1024(封顶 100)", () => {
  const p = parseRemoteLoad("h\nMem:  512M  1.0G  0", "-");
  assert.equal(p.ramPercent, 100); // 1.0 / 0.5 = 200% → cap 100
});

test("parseRemoteLoad: df 列不足(百分比列偏移 < 2)时只展示百分比", () => {
  const p = parseRemoteLoad("h\n28% /", "-");
  assert.equal(p.diskPercent, 28);
  assert.equal(p.diskText, "28%");
});

test("parseRemoteLoad: df 标准六列时按列偏移取 used/total", () => {
  const p = parseRemoteLoad("h\n/dev/vda2  100G  75G  25G  75% /data", "-");
  assert.equal(p.diskPercent, 75);
  assert.equal(p.diskText, "75% (75G / 100G)");
});

test("parseRemoteLoad: 畸形/缺行输入不抛异常并回落默认值", () => {
  for (const bad of [null, undefined, "", "garbage text only", "Mem:", "up", "%%%", "Mem:  0  0  0"]) {
    assert.doesNotThrow(() => parseRemoteLoad(bad, "fb-host"));
  }
  const p = parseRemoteLoad("just-a-hostname", "fb-host");
  assert.equal(p.hostname, "just-a-hostname");
  assert.equal(p.uptime, "未知");
  assert.equal(p.cpuText, "未知");
  assert.equal(p.cpuPercent, 0);
  assert.equal(p.ramText, "未获取");
  assert.equal(p.ramPercent, 0);
  assert.equal(p.diskText, "未获取");
  assert.equal(p.diskPercent, 0);
});

test("parseRemoteLoad: Mem 行 total 为 0 时不做除法(百分比保持 0)", () => {
  const p = parseRemoteLoad("h\nMem:  0  0  0", "-");
  assert.equal(p.ramPercent, 0);
  assert.match(p.ramText, /^0 \/ 0$/);
});

// ---- v2.15：nproc 核数解析 + 负载归一化 ----

test("parseRemoteLoad: 有 nproc 行时解析 cores 并归一化负载百分比", () => {
  const p = parseRemoteLoad(`${SAMPLE}\nnproc: 4`, "-");
  assert.equal(p.cores, 4);
  assert.equal(p.load1, 0.52);
  assert.equal(p.cpuPercent, 13); // 0.52 / 4 = 13%
  assert.equal(p.cpuText, "Load 0.52 / 4核 (13%)");
  // 其余字段不受 nproc 行影响
  assert.equal(p.diskPercent, 28);
  assert.equal(p.ramPercent, 39);
});

test("parseRemoteLoad: 无 nproc 行（老格式）cores=null 且既有字段全部保持旧语义", () => {
  const p = parseRemoteLoad(SAMPLE, "-");
  assert.equal(p.cores, null);
  assert.equal(p.load1, 0.52);
  assert.equal(p.cpuText, "Load: 0.52"); // 老展示格式回退
  assert.equal(p.cpuPercent, 52); // 老语义：load1×100 封顶 100
});

test("parseRemoteLoad: 归一化百分比不封顶（过载 >100% 是真实信号）", () => {
  const p = parseRemoteLoad("h\n up 1 day, load average: 40.00, 39.0, 38.0\nnproc: 32", "-");
  assert.equal(p.cores, 32);
  assert.equal(p.cpuPercent, 125); // 40 / 32 = 125%
  assert.equal(p.cpuText, "Load 40.00 / 32核 (125%)");
});

test("parseRemoteLoad: 畸形 nproc 行（非纯数字/零核）按无核数回退", () => {
  for (const badLine of ["nproc: abc", "nproc: 0", "nproc:", "nproc: 4 cores"]) {
    const p = parseRemoteLoad(`${SAMPLE}\n${badLine}`, "-");
    assert.equal(p.cores, null, `"${badLine}" 不应产出 cores`);
    assert.equal(p.cpuPercent, 52, "应保持老语义百分比");
  }
});

// v2.29：结构化字段（面板模型据此格式化字节量；旧文本字段保持原语义不变）。
test("parseRemoteLoad: 结构化字段——free 的字节量/可用列与 df 的设备/总量/已用/剩余/挂载点", () => {
  const p = parseRemoteLoad([
    "node05",
    " 14:20:01 up 12 days,  3:42,  2 users,  load average: 16.00, 15.20, 14.80",
    "               total        used        free      shared  buff/cache   available",
    "Mem:           251Gi        98Gi        40Gi       1.0Gi       113Gi       150Gi",
    "/dev/mapper/home  1.8T  1.1T  620G  65% /home",
    "nproc: 64",
  ].join("\n"), "-");
  const GiB = 1024 ** 3;
  assert.equal(p.memTotalBytes, 251 * GiB);
  assert.equal(p.memUsedBytes, 98 * GiB);
  assert.equal(p.memAvailBytes, 150 * GiB);
  assert.deepEqual(p.disk, {
    device: "/dev/mapper/home",
    totalBytes: Math.round(1.8 * 1024 * GiB),
    usedBytes: Math.round(1.1 * 1024 * GiB),
    availBytes: 620 * GiB,
    usedPct: 65,
    mount: "/home",
  });
  // 老 free（无 available 列）与缺列 df：拿不到的字段一律 null，不猜
  const old = parseRemoteLoad("h\nMem:  31G  12G  18G\n28% /", "-");
  assert.equal(old.memAvailBytes, null);
  assert.equal(old.disk.totalBytes, null);
  assert.equal(old.disk.mount, "/");
  assert.equal(parseRemoteLoad("h", "-").disk, null);
});

test("trendDirection: 环比方向计算（±epsilon 内持平，无历史返回 null）", () => {
  assert.equal(trendDirection(null, 40), null); // 首个采样无历史
  assert.equal(trendDirection(40, null), null);
  assert.equal(trendDirection(30, 40), "up");
  assert.equal(trendDirection(40, 30), "down");
  assert.equal(trendDirection(40, 40.5), "flat"); // 恰好 epsilon 边界 → 持平
  assert.equal(trendDirection(40, 40.6), "up");
  assert.equal(trendDirection(40, 39.4), "down");
});

test("updateProgressBar: 以 scaleX 设置进度与配色 class；空元素安全忽略", () => {
  const bar = { style: {}, className: "" };
  updateProgressBar(bar, 42, "yellow");
  assert.equal(bar.style.width, "100%");
  assert.equal(bar.style.transform, "scaleX(0.42)");
  assert.equal(bar.className, "bar-progress yellow-bar color-yellow");
  assert.doesNotThrow(() => updateProgressBar(null, 10, "green"));
});

test("Node 环境: renderRemoteLoad 空 DOM 下安全空转(memo 签名含 sampleKey / 层 / GPU / 时间桶)", () => {
  const NOW = 1_800_000_000_000;
  // getEl 全部返回 null；pushSample 走 charts.js 纯数据路径,不触 DOM。
  assert.doesNotThrow(() => renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 1000, null, null, NOW));
  // 相同签名第二次调用被 memo 跳过（返回 false），sampleKey 变化则重渲（返回 true）
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 1000, null, null, NOW), false);
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, null, NOW), true);
  // 时间桶（30s）翻页：数据没变也要重渲，「采样于 N 秒前」才会走字
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, null, NOW + 1000), false);
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, null, NOW + 30_000), true);
  // 第 5 参整层：GPU 数值或层级别变化都要重渲
  const layer = { level: "ok", checkedAt: 2000, gpu: [{ index: 0, util: 10, memUsedMb: 100, memTotalMb: 1000 }] };
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, layer, NOW + 30_000), true);
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, structuredClone(layer), NOW + 30_000), false);
  const busier = structuredClone(layer);
  busier.gpu[0].util = 90;
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, busier, NOW + 30_000), true);
  assert.equal(renderRemoteLoad({ ok: true, output: SAMPLE }, { host: "myserver" }, 2000, null, { ...busier, level: "error" }, NOW + 30_000), true);
  // 无数据分支同样安全
  assert.doesNotThrow(() => renderRemoteLoad(null, { host: "myserver" }, null));
});

test("renderRemoteLoad: 趋势版本号进签名——趋势数据变了，同一入参也要重渲；切范围时由监听器自动补渲", async () => {
  const { resetCharts, setTrendRange } = await import("./charts.js");
  const NOW = 1_800_000_100_000;
  const args = [{ ok: true, output: SAMPLE }, { host: "myserver" }, 5000, null, null];
  renderRemoteLoad(...args, NOW);
  assert.equal(renderRemoteLoad(...args, NOW), false);
  // 换服务器清空图表：不通知监听器，但版本号变了，下一帧渲染不会被跳过
  resetCharts();
  assert.equal(renderRemoteLoad(...args, NOW), true);
  assert.equal(renderRemoteLoad(...args, NOW), false);
  // 切范围：监听器当场用上一轮的入参补渲（明细行里的范围高低值要换），所以紧接着同样的调用被跳过
  assert.equal(setTrendRange("m30"), true);
  assert.equal(renderRemoteLoad(...args), false, "监听器已经补渲过");
  assert.equal(setTrendRange("h24"), true);
  assert.equal(renderRemoteLoad(...args), false);
});

test("createSampleTrack: 同一采样重复渲染不推进；新采样推进；换服务器清零", () => {
  const track = createSampleTrack();
  const a = { cpu: 10 };
  const b = { cpu: 20 };
  assert.equal(track.advance("s1", 1000, a), null); // 首个采样无上一采样
  assert.equal(track.advance("s1", 1000, a), null); // 时间桶重渲：不推进
  assert.equal(track.advance("s1", 2000, b), a);
  assert.equal(track.advance("s1", 2000, b), a); // 仍是同一采样 → 上一采样不被覆盖
  assert.equal(track.advance("s2", 3000, a), null); // 跨机对比无意义
});

// ---- v2.18 服务器卡模型（团队/个人徽标 + 隧道胶囊 + GPU 行；实现在 server-card-model.js）----

const tunnelLayer = (over = {}) => ({
  level: "ok",
  reason: "隧道在线",
  tunnelUp: true,
  remotePortOpen: true,
  checkedAt: 1000,
  source: "team",
  tunnel: true,
  ...over,
});

test("buildServerCardModel: 徽标取服务器条目 source，缺省视为团队", () => {
  assert.equal(buildServerCardModel({ id: "s1" }, {}).badge, "团队");
  assert.equal(buildServerCardModel({ id: "s1", source: "team" }, {}).badge, "团队");
  assert.equal(buildServerCardModel({ id: "s1", source: "personal" }, {}).badge, "个人");
});

test("buildServerCardModel: 服务器条目无 source 时回落隧道层的 source", () => {
  const layers = { tunnels: { s1: tunnelLayer({ source: "personal" }) } };
  assert.equal(buildServerCardModel({ id: "s1" }, layers).badge, "个人");
  // 条目上的 source 优先级更高
  assert.equal(buildServerCardModel({ id: "s1", source: "team" }, layers).badge, "团队");
});

test("buildServerCardModel: 隧道胶囊四态（在线/断开/仅监控/等待）", () => {
  const online = buildServerCardModel({ id: "s1" }, { tunnels: { s1: tunnelLayer() } });
  assert.equal(online.tunnelPill, "在线");
  assert.equal(online.tunnelClass, "tunnel-pill-ok");

  const down = buildServerCardModel(
    { id: "s1" },
    { tunnels: { s1: tunnelLayer({ level: "error", tunnelUp: false, remotePortOpen: false }) } },
  );
  assert.equal(down.tunnelPill, "断开");
  assert.equal(down.tunnelClass, "tunnel-pill-error");

  // tunnel:false（仅监控，不建隧道）—— 条目字段与隧道层 level:"skipped" 两条路都认
  assert.equal(buildServerCardModel({ id: "s1", tunnel: false }, {}).tunnelPill, "仅监控");
  const skipped = buildServerCardModel({ id: "s1" }, { tunnels: { s1: tunnelLayer({ level: "skipped" }) } });
  assert.equal(skipped.tunnelPill, "仅监控");
  assert.equal(skipped.tunnelClass, "tunnel-pill-muted");

  // 尚无隧道层条目（首轮采集未回）
  const waiting = buildServerCardModel({ id: "s1" }, {});
  assert.equal(waiting.tunnelPill, "等待");
  assert.equal(waiting.tunnelClass, "tunnel-pill-waiting");
  assert.equal(
    buildServerCardModel(
      { id: "s1" },
      { tunnels: { s1: tunnelLayer({ level: "waiting", tunnelUp: null, remotePortOpen: null }) } },
    ).tunnelPill,
    "等待",
  );
});

test("buildServerCardModel: GPU 行条长=利用率、颜色=显存压力、标签带显存数字", () => {
  const layers = {
    resources: {
      s1: {
        gpu: [
          { index: 0, name: "NVIDIA GeForce RTX 4090", memUsedMb: 2400, memTotalMb: 24000, util: 12 },
          { index: 1, name: "NVIDIA GeForce RTX 4090", memUsedMb: 20000, memTotalMb: 24000, util: 88 },
          { index: 2, name: "NVIDIA GeForce RTX 4090", memUsedMb: 23000, memTotalMb: 24000, util: 100 },
        ],
      },
    },
  };
  const { gpu } = buildServerCardModel({ id: "s1" }, layers);
  assert.equal(gpu.length, 3);
  // v2.18.1：标签带显存数字，型号进 title；条长 barPercent = 利用率，颜色仍按显存压力分档。
  assert.equal(gpu[0].label, "#0 2.3/23.4G");
  assert.match(gpu[0].title, /#0 NVIDIA GeForce RTX 4090 · 显存 2\.3\/23\.4 GB · 利用率 12%/);
  assert.equal(gpu[0].memPercent, 10);
  assert.equal(gpu[0].util, 12);
  assert.equal(gpu[0].barPercent, 12);
  assert.equal(gpu[0].colorClass, "green");
  assert.equal(gpu[1].memPercent, 83);
  assert.equal(gpu[1].barPercent, 88);
  assert.equal(gpu[1].colorClass, "yellow");
  assert.equal(gpu[2].memPercent, 96);
  assert.equal(gpu[2].barPercent, 100);
  assert.equal(gpu[2].colorClass, "red");
  // 利用率缺失：条长 0、右侧显示 "-"，不能借显存百分比冒充。
  const { gpu: noUtil } = buildServerCardModel({ id: "s1" }, { resources: { s1: { gpu: [{ index: 3, memUsedMb: 12000, memTotalMb: 24000 }] } } });
  assert.equal(noUtil[0].util, null);
  assert.equal(noUtil[0].barPercent, 0);
});

test("gpuColor: 与资源面板同一张显存阈值表（80/95）", () => {
  assert.equal(gpuColor(0), "green");
  assert.equal(gpuColor(79), "green");
  assert.equal(gpuColor(80), "yellow");
  assert.equal(gpuColor(94), "yellow");
  assert.equal(gpuColor(95), "red");
  assert.equal(gpuColor(null), "green");
});

test("buildServerCardModel: 无 GPU / 字段畸形时降级为空数组，不抛错", () => {
  assert.deepEqual(buildServerCardModel({ id: "s1" }, { resources: { s1: {} } }).gpu, []);
  assert.deepEqual(buildServerCardModel({ id: "s1" }, { resources: { s1: { gpu: "x" } } }).gpu, []);
  const { gpu } = buildServerCardModel(
    { id: "s1" },
    { resources: { s1: { gpu: [{ memUsedMb: 100 }, null, { index: 3, memUsedMb: 0, memTotalMb: 0, util: "x" }] } } },
  );
  assert.equal(gpu.length, 2); // null 条目丢弃
  assert.equal(gpu[0].label, "GPU 0"); // 无 index/name 时按位次兜底
  assert.equal(gpu[0].memPercent, 0); // 无 memTotalMb → 0，不出 NaN
  assert.equal(gpu[0].util, null);
  assert.equal(gpu[1].label, "GPU 3");
  assert.equal(gpu[1].util, null);
});

test("buildServerCardModel: 全参数缺失时给出可渲染的降级模型", () => {
  const m = buildServerCardModel();
  assert.equal(m.badge, "团队");
  assert.equal(m.tunnelPill, "等待");
  assert.equal(m.tunnelClass, "tunnel-pill-waiting");
  assert.deepEqual(m.gpu, []);
});

test("renderRemoteLoad: 从没采到过数据时在指标块上方显示等待说明（#resNotice），第一笔数据到达后收起", () => {
  const NOW = 1_800_000_200_000;
  const written = [];
  // 只认 #resNotice 的假文档；morphInnerHtml 经 ownerDocument 的 <template> 解析，这里记下写入的 HTML。
  const notice = {
    hidden: true, childNodes: [], isConnected: true,
    ownerDocument: { createElement: () => { const tpl = { content: { childNodes: [] } }; Object.defineProperty(tpl, "innerHTML", { set: (v) => written.push(v) }); return tpl; } },
  };
  const saved = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "resNotice" ? notice : null) };
  try {
    renderRemoteLoad(null, { id: "fresh-1", host: "fresh" }, null, null, { level: "ok", checkedAt: null }, NOW);
    assert.equal(notice.hidden, false);
    assert.match(written.at(-1), /正在等这台服务器的第一次采样/);
    renderRemoteLoad(null, { id: "fresh-1", host: "fresh" }, null, null, { level: "error", reason: "ssh 超时", checkedAt: NOW }, NOW);
    assert.match(written.at(-1), /暂时取不到这台服务器的资源数据/);
    const count = written.length;
    renderRemoteLoad({ ok: true, output: SAMPLE }, { id: "fresh-1", host: "fresh" }, 3000, null, null, NOW);
    assert.equal(notice.hidden, true, "有数据后收起");
    assert.equal(written.length, count, "收起时不再写内容");
  } finally {
    globalThis.document = saved;
  }
});

test("buildServerCardModel: 探测已放慢的服务器在隧道胶囊后带「·慢」，悬停写下次探测时刻；没有退避条目时胶囊照旧", async () => {
  const { buildServerCardExtrasHtml } = await import("./render/server-card-model.js");
  const nextProbeAt = new Date(2026, 9, 12, 14, 3, 20).getTime();
  const layers = { tunnels: { s1: tunnelLayer({ level: "error", tunnelUp: false, remotePortOpen: false }) } };
  const slowed = buildServerCardModel({ id: "s1" }, layers, { since: nextProbeAt - 600_000, nextProbeAt, failures: 9, probing: false });
  assert.deepEqual(slowed.slowed, { mark: "·慢", title: "SSH 连不上，探测已放慢 · 下次 14:03:20 · 连上后自动恢复" });
  assert.equal(slowed.tunnelPill, "断开", "隧道胶囊照旧");
  const html = buildServerCardExtrasHtml(slowed).head;
  assert.match(html, /<span class="tunnel-pill tunnel-pill-error" title="SSH 连不上，探测已放慢 · 下次 14:03:20 · 连上后自动恢复">断开·慢<\/span>$/);
  assert.equal((html.match(/tunnel-pill /g) || []).length, 1, "不多出第二枚胶囊");
  for (const backoff of [undefined, null, {}, { nextProbeAt: null }, { nextProbeAt: "soon" }]) {
    const plain = buildServerCardModel({ id: "s1" }, layers, backoff);
    assert.equal(plain.slowed, null);
    assert.match(buildServerCardExtrasHtml(plain).head, /<span class="tunnel-pill tunnel-pill-error">断开<\/span>$/);
  }
});
