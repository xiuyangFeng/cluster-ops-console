// scripts/lib/smoke-window.mjs —— 冒烟用的窗口：拿到的一定是请求的尺寸（仅 browser-smoke 使用）。
//
// macOS 在创建窗口时把尺寸钳到屏幕工作区。GitHub 的 macos runner 屏幕只有 1024 宽：请求 1100 的窗口
// 实际是 1024，概览内容区从 938px 缩到 862px，三张服务器卡（3 × 280 + 2 × 12 = 864）放不进一行，冒烟在
// 「3 cards must fill available width」上失败。开发机屏幕够大，永远复现不了——把创建宽度改成 1024，
// 失败时的各项坐标与 CI 日志逐数相同。
// 创建之后的 setSize / setContentSize 不受这个钳制（实测可以超出屏幕），所以创建后再明确设一次；
// enableLargerThanScreen 是 macOS 上「允许比屏幕大」的正式开关，一并打开。
//
// 返回一个可以 `new` 的构造函数（子冒烟都是 `new BrowserWindow({...})`，把它当 BrowserWindow 传进去即可）。
export function sizedWindowClass(BrowserWindow) {
  return function SmokeWindow(options = {}) {
    const win = new BrowserWindow({ enableLargerThanScreen: true, ...options });
    const { width, height } = options;
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (options.useContentSize) win.setContentSize(width, height);
      else win.setSize(width, height);
    }
    return win;
  };
}

// 布局断言都以视口宽度为前提：没拿到请求的宽度就在这里把原因说清楚，
// 而不是在后面某条布局断言上以一组看不出原因的坐标失败。
export async function assertViewportWidth(win, expected, label = "smoke window") {
  const actual = await win.webContents.executeJavaScript("window.innerWidth");
  if (Math.abs(actual - expected) > 2) {
    throw new Error(`${label} viewport is ${actual}px wide, expected ${expected}px — the display is probably smaller than the requested window and the explicit resize did not take effect`);
  }
}
