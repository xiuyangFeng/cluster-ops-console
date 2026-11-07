// window-bounds.mjs —— 主窗口的大小与位置：默认值、记住上次的摆放、换了显示器布局后的修正。
//
// 存在数据目录的 runtime/window-state.json（与其它运行期文件同处；文件丢了或损坏只是回到默认）。
// 「重启界面」（热更新）会新建窗口：有了这份记录，新窗口出现在原来的位置和大小。
// 本模块不 import "electron"：显示器信息（screen.getAllDisplays 的结果）由调用方传入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WINDOW_STATE_FILE = "window-state.json";
// 默认大小：概览的「链路 + 简报」两栏与服务器页的三列在这个宽度下并排（窄于 1100 会上下堆叠）。
export const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1280, height: 860 });
// 小于它的记录视为无效（多半是异常退出时写下的残值），回到默认大小。
export const MIN_SAVED_SIZE = Object.freeze({ width: 480, height: 360 });

const int = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function fitSize(size, area) {
  if (!area) return { ...size };
  return { width: Math.min(size.width, area.width), height: Math.min(size.height, area.height) };
}

// 纯函数：把保存的矩形摆进当前的显示器布局，返回给 BrowserWindow 的 { width, height[, x, y] }。
//   没有记录 / 记录不合法       → 默认大小（不超过主显示器工作区），不给 x/y——由系统居中
//   记录的位置已不在任何显示器上 → 保留大小，同样交给系统居中（拔掉外接屏后窗口不会留在看不见的地方）
//   其余                         → 原样恢复；超出所在显示器工作区的部分收回来
// displays / primary 是 Electron Display 对象（只读 workArea）。
export function resolveWindowBounds(saved, { displays = [], primary = null } = {}) {
  const areas = displays.map((display) => display?.workArea).filter(Boolean);
  const primaryArea = primary?.workArea || areas[0] || null;
  const width = int(saved?.width);
  const height = int(saved?.height);
  const hasSize = width != null && height != null && width >= MIN_SAVED_SIZE.width && height >= MIN_SAVED_SIZE.height;
  const size = hasSize ? { width, height } : { ...DEFAULT_WINDOW_SIZE };
  const x = int(saved?.x);
  const y = int(saved?.y);
  if (!hasSize || x == null || y == null) return fitSize(size, primaryArea);
  // 窗口中心落在哪个显示器的工作区里，就算它在那块屏上
  const centerX = x + size.width / 2;
  const centerY = y + size.height / 2;
  const area = areas.find((a) => centerX >= a.x && centerX < a.x + a.width && centerY >= a.y && centerY < a.y + a.height);
  if (!area) return fitSize(size, primaryArea);
  const fitted = fitSize(size, area);
  return {
    x: clamp(x, area.x, area.x + area.width - fitted.width),
    y: clamp(y, area.y, area.y + area.height - fitted.height),
    ...fitted,
  };
}

// 读写都不抛：窗口状态是锦上添花，读不到用默认，写不进（只读盘 / 权限）就算了。
export function createWindowBoundsStore({ runtimeDir, fs = { mkdirSync, readFileSync, writeFileSync } } = {}) {
  const filePath = path.join(runtimeDir, WINDOW_STATE_FILE);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function save(bounds) {
    const record = { x: int(bounds?.x), y: int(bounds?.y), width: int(bounds?.width), height: int(bounds?.height) };
    if (Object.values(record).some((value) => value == null)) return false;
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  return { filePath, load, save };
}
