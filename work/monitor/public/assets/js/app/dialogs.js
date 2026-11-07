// app/dialogs.js —— 诊断/配置浮层的统一开关。
//
// openDialog 只负责"打开"；打开时要拉什么数据由各控制器经 onDialogOpen(id, fn) 自行登记
// （按登记顺序执行），这里不再知道每个浮层的业务。侧栏与内容区里的入口、浮层内入口（[data-dialog]）、
// 浮层的关闭（[data-close] / 点遮罩）在 initDialogChrome 里统一委托。
export function createDialogs({ doc, logsPanel }) {
  const getEl = (id) => doc.getElementById(id);
  const openHooks = new Map();

  function onDialogOpen(dialogId, fn) {
    if (!openHooks.has(dialogId)) openHooks.set(dialogId, []);
    openHooks.get(dialogId).push(fn);
  }

  function openDialog(dialogId) {
    const dlg = getEl(dialogId);
    if (!dlg) return;
    dlg.showModal();
    for (const fn of openHooks.get(dialogId) || []) fn();
  }

  // 某个面板所在的浮层是否打开（渲染层据此决定是否做重输出渲染）。
  const isPanelOpen = (id) => Boolean(getEl(id)?.closest("dialog")?.open);

  // "查看本次操作日志"（runbook 失败态 / 事件的处置记录）：按 operationId 过滤 + 打开 dlgLogs。
  // 直接 showModal、不走 openDialog：其无过滤的 logsPanel.refresh 会与这里的过滤刷新竞态互相覆盖。
  function openLogsForOperation(operationId) {
    logsPanel.openOperation(operationId);
    const dlg = getEl("dlgLogs");
    if (dlg && !dlg.open) dlg.showModal();
  }

  function initDialogChrome() {
    // 侧栏的浮层入口 + 内容区里渲染出来的入口（如空状态里的「添加服务器」）：同一个委托。
    for (const root of [doc.querySelector(".sidebar-nav"), doc.querySelector("main.console")]) {
      root?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-dialog]");
        if (btn) openDialog(btn.dataset.dialog);
      });
    }
    for (const dlg of doc.querySelectorAll("dialog.hud-dialog")) {
      dlg.addEventListener("click", (e) => {
        // 浮层里的入口（如「配置」里的离线安装 Agent）：先关掉所在浮层再打开目标，两个模态不叠在一起。
        const opener = e.target.closest("[data-dialog]");
        if (opener) {
          dlg.close();
          openDialog(opener.dataset.dialog);
          return;
        }
        if (!e.target.closest("[data-close]") && e.target !== dlg) return;
        dlg.close();
      });
    }
  }

  return { openDialog, onDialogOpen, isPanelOpen, openLogsForOperation, initDialogChrome };
}
