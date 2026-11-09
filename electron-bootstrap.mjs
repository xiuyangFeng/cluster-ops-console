// 固定入口：恢复中断更新后才加载可更新的主进程。协议升级走完整安装包。
import { app, dialog } from "electron";
import { beginPackageBoot, PACKAGE_APP_NAME, PACKAGE_RELAUNCH_ENV, readPackageJournal, recoverPackageUpdate } from "./work/monitor/lib/self-update/package-recovery.mjs";

const rootDir = import.meta.dirname;
let pending = false;
let watchdog = null;
function failed(error) {
  if (watchdog) clearTimeout(watchdog);
  try {
    if (pending && recoverPackageUpdate(rootDir, { includePending: true })) {
      app.relaunch();
      app.exit(0);
      return;
    }
  } catch (recoveryError) {
    error = recoveryError;
  }
  dialog.showErrorBox("工作台启动失败", String(error?.message || error));
  app.exit(1);
}
try {
  // 先取得与主进程相同的锁。普通重复启动不能提前确认或恢复另一实例的更新。
  app.setName(PACKAGE_APP_NAME);
  let locked = app.requestSingleInstanceLock();
  const marker = Number(process.env[PACKAGE_RELAUNCH_ENV]);
  const deadline = marker + 10_000;
  while (!locked && marker > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    locked = app.requestSingleInstanceLock();
  }
  if (!locked) app.exit(0);
  else {
    pending = beginPackageBoot(rootDir);
    if (pending) {
      watchdog = setTimeout(() => {
        if (readPackageJournal(rootDir)) failed(new Error("新版本启动超时，已恢复旧版"));
      }, 90_000);
      watchdog.unref();
    }
    // 等主进程完成生命周期注册，再让 Electron 发 ready；不 await app.whenReady()。
    await import("./electron-main.mjs");
  }
} catch (error) {
  failed(error);
}
