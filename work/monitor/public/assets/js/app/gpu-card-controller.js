// app/gpu-card-controller.js —— 点 GPU 行 → 「这块卡上谁在跑」浮层（v2.76）。
//
// 数据不额外采集：就地读当前服务器资源层里那张卡的原始对象
// （layers.resources[serverId].gpu 是登录节点；layers.slurm.nodes[].gpus.cards 是 node04 这类直连节点），
// 逐进程明细（users[].procs）是 slow 采集（60 秒一轮，见 remote/collect.sh 的 gpu 段）带回来的。
// 所以这里**不发任何请求、不改任何状态**：打开时定住「看的是哪张卡」（key + 卡号），
// 之后每次状态刷新（app.js 的 onStatus）在浮层还开着时就地重渲一次。
//
// 对「有人在节点上直接跑 python 占卡、squeue 里看不到」这件事：判据是进程的 Slurm 作业号
// （取自进程 cgroup，空 = 不在任何作业里），结论写在浮层顶部那一句里（render/gpu-card-view.js）。
import { morphInnerHtml, setText } from "../dom-utils.js";
import { activeGpuLayer, buildGpuCardBodyHtml, gpuCardHeading, resolveGpuCard } from "../render/gpu-card-view.js";

// 卡在两次刷新之间换代（采集轮次换了、节点掉线）时的兜底文案：不编数据，说清下一轮就好。
const STALE_TIP = "这张卡的数据刚换代了：采集每 60 秒一轮，下一轮刷新后再点一次。";

export function createGpuCardController({ doc, getStatus, openDialog }) {
  const getEl = (id) => doc.getElementById(id);
  // 浮层当前显示的那张卡：{ key, index, label }。key = "" 是登录节点，否则是直连节点名。
  let opened = null;

  function paint() {
    if (!opened) return;
    const body = getEl("dlgGpuCardBody");
    if (!body) return;
    const status = getStatus?.() || null;
    const card = resolveGpuCard(status, opened.key, opened.index, opened.serverId);
    const title = getEl("dlgGpuCardTitle");
    if (!card) {
      setText(title, opened.label ? `${opened.label} GPU #${opened.index}` : `GPU #${opened.index}`);
      morphInnerHtml(body, `<p class="gpu-detail-note">${STALE_TIP}</p>`);
      return;
    }
    setText(title, gpuCardHeading(card));
    morphInnerHtml(body, buildGpuCardBodyHtml(card, {
      label: opened.label,
      sampledAt: activeGpuLayer(status, opened.serverId)?.checkedAt ?? null,
    }));
  }

  function openFromRow(row) {
    const index = Number(row?.dataset?.gpuIndex);
    if (!Number.isFinite(index)) return;
    opened = {
      serverId: row.closest?.("[data-gpu-server-id]")?.dataset?.gpuServerId || getStatus?.()?.activeServerId,
      key: typeof row.dataset.gpuKey === "string" ? row.dataset.gpuKey : "",
      index,
      label: typeof row.dataset.gpuLabel === "string" ? row.dataset.gpuLabel : "",
    };
    paint();
    openDialog("dlgGpuCard");
  }

  // 整行可点（鼠标）；卡号那格是按钮，Enter / 空格触发的 click 也会冒泡到这里，键盘同一条路径。
  function bind() {
    const list = getEl("resGpuList");
    if (!list) return;
    list.addEventListener("click", (e) => {
      // 单属性选择器（与 dialogs.js / dir-usage-controller.js 同一写法）：这个属性只有 GPU 行有。
      // 点按钮、或点行里任何一格都冒泡到这里；键盘在按钮上按 Enter / 空格同样走这条路径。
      const row = e.target.closest("[data-gpu-key]");
      if (!row) return;
      openFromRow(row);
    });
  }

  // 每轮状态刷新调用一次：浮层开着就按同一张卡重渲（表里的「已运行」也跟着走字）。
  function onStatus() {
    if (!opened) return;
    const dlg = getEl("dlgGpuCard");
    if (dlg?.open) paint();
  }

  return { bind, onStatus };
}
