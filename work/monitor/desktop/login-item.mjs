// login-item.mjs —— 打包的 .app 的「登录电脑后自动启动」：Electron 的登录项接口
// （app.getLoginItemSettings / app.setLoginItemSettings，由入口注入 app）。
//
// 只对打包的 App 生效（macOS .app 与 Windows 安装版；Windows 上 Electron 写的是 HKCU 的 Run 项）。源码安装的桌面壳（electron .）跑的是 node_modules 里那个通用的 Electron：
// 把它登记成登录项，登录时打开的是一个空的 Electron 而不是工作台——那种安装形态的开机自启走监控服务的
// /api/autostart（用户级 LaunchAgent，见 lib/autostart/），这里如实回「不支持」。
//
// 设置之后一律回读：系统不接受时（本机临时签名的 App 可能被拒、或等用户在系统设置里批准）
// setLoginItemSettings 并不抛错，只有回读才知道开没开成。页面拿到的就是回读的结果。

import { isPackagedApp } from "../lib/runtime-paths.mjs";

export function createLoginItemController({ ctx, app, platform = process.platform, logger = console }) {
  const packaged = isPackagedApp(ctx.rootDir, platform);

  // { supported, enabled, status, error }：status 是 macOS 13+ 给的登记状态
  // （enabled / not-registered / requires-approval / not-found），取不到为 null。
  function getAutostart() {
    if (!packaged) return { supported: false, enabled: false, status: null, error: null };
    try {
      const settings = app.getLoginItemSettings() || {};
      return {
        supported: true,
        enabled: settings.openAtLogin === true,
        status: typeof settings.status === "string" ? settings.status : null,
        error: null,
      };
    } catch (err) {
      logger.warn("[login-item] read failed:", err?.message || err);
      return { supported: true, enabled: false, status: null, error: String(err?.message || err) };
    }
  }

  function setAutostart(enabled) {
    if (!packaged) return getAutostart();
    try {
      app.setLoginItemSettings({ openAtLogin: enabled === true });
    } catch (err) {
      logger.warn("[login-item] write failed:", err?.message || err);
      return { ...getAutostart(), error: String(err?.message || err) };
    }
    return getAutostart();
  }

  return { getAutostart, setAutostart };
}
