// gpu-card-controller.test.mjs —— 点 GPU 行 → 浮层（v2.76）。
// 关注三件事：点到哪张卡就显示哪张卡（本机 / 直连两条取值路径）、
// 之后每轮状态刷新在浮层开着时就地重渲（关着不白干）、卡换代了不编数据。
import assert from "node:assert/strict";
import test from "node:test";
import { createGpuCardController } from "./gpu-card-controller.js";
import { activeGpuLayer, resolveGpuCard } from "../render/gpu-card-view.js";
import { fakeElement, fakeDialog, fakeDocument, spy } from "./test-support.mjs";

const LOCAL_CARD = {
  index: 0,
  name: "NVIDIA GeForce RTX 4090",
  util: 100,
  memUsedMb: 9806,
  memTotalMb: 24564,
  tempC: 57,
  powerW: 210.71,
  users: [{ user: "kai", memMb: 4412, procs: [{ pid: "1", memMb: 4412, etimes: 60, jobId: null, comm: "python", cmdline: "python train.py" }] }],
};
const NODE04_CARD = { index: 1, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, users: [] };

function statusWith(layer) {
  return { activeServerId: "s1", layers: { resources: { s1: layer } } };
}
const LAYER = { checkedAt: 1700000000000, gpu: [LOCAL_CARD], slurm: { nodes: [{ name: "node04", gpus: { cards: [NODE04_CARD] } }] } };

// morphInnerHtml 经 ownerDocument 的 <template> 解析（与 usage-controller.test.mjs 同一套假 DOM）：
// 写入的 HTML 记在 el.html 上，断言看它。
function morphEl(props = {}) {
  const el = fakeElement({ childNodes: [], ...props });
  el.ownerDocument = {
    createElement: () => {
      const tpl = { content: { childNodes: [] } };
      Object.defineProperty(tpl, "innerHTML", { set: (value) => { el.html = value; } });
      return tpl;
    },
  };
  return el;
}

// 浮层本体 + 挂在 #resGpuList 下的一行（dataset 与真实渲染出来的属性一致）。
function mount({ status = statusWith(LAYER) } = {}) {
  const body = morphEl({ id: "dlgGpuCardBody" });
  const title = morphEl({ tag: "h2", id: "dlgGpuCardTitle" });
  const dlg = fakeDialog({ id: "dlgGpuCard" });
  const list = fakeElement({ id: "resGpuList" });
  const doc = fakeDocument({ dlgGpuCard: dlg, dlgGpuCardBody: body, dlgGpuCardTitle: title, resGpuList: list });
  const openDialog = spy();
  const current = { value: status };
  const ctl = createGpuCardController({ doc, getStatus: () => current.value, openDialog });
  ctl.bind();
  return { ctl, doc, list, body, title, dlg, openDialog, current };
}

function row({ key, index, label }) {
  const el = fakeElement({ tag: "tr", dataset: { gpuKey: key, gpuIndex: String(index), gpuLabel: label } });
  el.setAttribute("data-gpu-key", key);
  el.setAttribute("data-gpu-index", String(index));
  return el;
}

test("resolveGpuCard: 本机走 layer.gpu，直连节点走 layer.slurm.nodes[].gpus.cards；找不到给 null", () => {
  const status = statusWith(LAYER);
  assert.equal(resolveGpuCard(status, "", 0), LOCAL_CARD);
  assert.equal(resolveGpuCard(status, "node04", 1), NODE04_CARD);
  assert.equal(resolveGpuCard(status, "node04", 0), null, "node04 没有 0 号卡");
  assert.equal(resolveGpuCard(status, "node99", 1), null, "没有这台节点");
  assert.equal(resolveGpuCard({}, "", 0), null);
  assert.equal(resolveGpuCard(status, "", 0).users, LOCAL_CARD.users, "拿到的是原始卡：逐进程明细就在里面");
  assert.equal(activeGpuLayer(status), LAYER);
  assert.equal(activeGpuLayer({ activeServerId: "s1" }), null);
});

test("controller: 点本机行 → 打开浮层，标题与正文按这张卡渲染", () => {
  const m = mount();
  const tr = row({ key: "", index: 0, label: "master" });
  m.list.dispatch("click", { target: tr });
  assert.deepEqual(m.openDialog.calls, [["dlgGpuCard"]]);
  assert.equal(m.title.textContent, "GPU #0 · NVIDIA GeForce RTX 4090");
  assert.match(m.body.html, /master/);
  assert.match(m.body.html, /python train\.py/);
  assert.match(m.body.html, /不在 Slurm 作业里/);
});

test("controller: 点直连节点的行 → 取的是那台节点的卡（标题跟着换）", () => {
  const m = mount();
  m.list.dispatch("click", { target: row({ key: "node04", index: 1, label: "node04" }) });
  assert.equal(m.title.textContent, "GPU #1 · NVIDIA A100-PCIE-40GB");
  assert.match(m.body.html, /node04/);
  assert.match(m.body.html, /这块卡上没有计算进程/, "没有进程明细就是空的，不编");
});

test("controller: 点在没有 data-gpu-key 的行上（骨架 / 空态）不开浮层", () => {
  const m = mount();
  const tr = fakeElement({ tag: "tr", dataset: {} });
  m.list.dispatch("click", { target: tr });
  assert.deepEqual(m.openDialog.calls, []);
});

test("controller: 浮层开着时随状态刷新就地重渲；关掉后不再重渲（不白干活）", () => {
  const m = mount();
  m.list.dispatch("click", { target: row({ key: "", index: 0, label: "master" }) });
  m.dlg.open = true;
  const next = statusWith({ ...LAYER, gpu: [{ ...LOCAL_CARD, users: [] }] });
  m.current.value = next;
  m.ctl.onStatus();
  assert.match(m.body.html, /这块卡上没有计算进程/, "同一张卡的新快照顶上来");

  m.dlg.open = false;
  m.body.html = "哨兵";
  m.ctl.onStatus();
  assert.equal(m.body.html, "哨兵", "浮层关着不动 DOM");
});

test("controller: 刷新后这张卡没了（节点掉线 / 轮次换代）→ 说清是换代，不编数据", () => {
  const m = mount();
  m.list.dispatch("click", { target: row({ key: "node04", index: 1, label: "node04" }) });
  m.dlg.open = true;
  m.current.value = statusWith({ checkedAt: 1, gpu: [LOCAL_CARD], slurm: { nodes: [] } });
  m.ctl.onStatus();
  assert.equal(m.title.textContent, "node04 GPU #1");
  assert.match(m.body.html, /采集每 60 秒一轮/);
});
