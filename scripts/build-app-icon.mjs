// build-app-icon.mjs —— 由 scripts/assets/app-icon.svg 生成 macOS 图标 scripts/assets/app-icon.icns
// 与 Windows 图标 scripts/assets/app-icon.ico。
// 用法（需在 macOS 上，借 Electron 的 Chromium 渲染 SVG、系统 iconutil 打包 .icns；.ico 由本脚本自己拼）：
//   npx electron scripts/build-app-icon.mjs [--preview <png 路径>] [--ico-only]
// 产物提交进仓库；build-macos-app.sh 构建时用 .icns 替换 Electron 默认图标（Contents/Resources/electron.icns），
// build-windows-app.mjs 把 .ico 放进安装目录（窗口 / 任务栏 / 快捷方式图标）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(here, "assets", "app-icon.svg");
const icnsPath = path.join(here, "assets", "app-icon.icns");
const icoPath = path.join(here, "assets", "app-icon.ico");
const icoOnly = process.argv.includes("--ico-only");
const previewIdx = process.argv.indexOf("--preview");
const previewPath = previewIdx > 0 ? process.argv[previewIdx + 1] : "";

// iconutil 要求的文件名 → 像素尺寸
const ICONSET = [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];

// .ico 里放的尺寸（Windows 资源管理器 / 任务栏 / 开始菜单 / 高 DPI 各取所需）。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ICO 容器：6 字节头 + 每张 16 字节目录项 + 各张 PNG 原样拼接（Vista 起支持 PNG 内嵌）。
// 目录项里宽高 256 写 0。
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function main() {
  const svg = readFileSync(svgPath, "utf8");
  const win = new BrowserWindow({ show: false, width: 400, height: 400 });
  await win.loadURL("about:blank");
  const render = (size) => win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)};
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = ${size};
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL("image/png");
  })()`);

  const pngOf = async (size) => Buffer.from((await render(size)).split(",")[1], "base64");
  const icoImages = [];
  for (const size of ICO_SIZES) icoImages.push({ size, png: await pngOf(size) });
  writeFileSync(icoPath, buildIco(icoImages));
  console.log(`wrote ${path.relative(process.cwd(), icoPath)}`);
  if (icoOnly) return;

  const dir = mkdtempSync(path.join(tmpdir(), "app-icon-"));
  const iconset = path.join(dir, "app-icon.iconset");
  execFileSync("mkdir", ["-p", iconset]);
  for (const [name, size] of ICONSET) {
    const dataUrl = await render(size);
    writeFileSync(path.join(iconset, name), Buffer.from(dataUrl.split(",")[1], "base64"));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath]);
  if (previewPath) writeFileSync(previewPath, Buffer.from((await render(512)).split(",")[1], "base64"));
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), icnsPath)}`);
}

app.whenReady().then(main).then(() => app.quit(), (err) => {
  console.error(err);
  app.exit(1);
});
