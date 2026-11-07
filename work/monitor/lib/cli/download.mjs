// 回退安装的本机下载（第 2 期 P-D）：把官方产物（./sources.mjs 解析出的地址与 sha256）下到本机缓存目录，
// 可续传、可换源、按官方校验和核对。
//
//   - 续传：未完成的内容在 `<文件>.part`；再次下载带 `Range: bytes=<已有>-`，服务器回 206 就接着写，
//     回 200（不支持 Range / 换了源）就从头写。中断（断网、本机重启）不浪费已下的部分——设计稿 §8「下载慢」。
//   - 换源：urls 按顺序尝试；每个地址允许几次「网络错误后续传」重试；校验和不符直接删掉重来一次。
//   - 校验：下完对整个文件重算 sha256（续传时前半段不在内存里，统一读文件算，250MB 约 1 秒）。
//   - 缓存：校验通过的文件留在缓存目录，同一产物再次安装（上传失败重试、换服务器）直接复用；
//     安装成功后由调用方删除（cleanup）。
//   - Claude 的 claude.zst：本机 node:zlib 有 zstd 时先下压缩包、校验、解压、再校验原文件（同官方安装器）。
//
//   - 取消：signal（AbortSignal）响了立刻停（EABORT），不换源不重试；.part 留在原地，由调用方决定去留
//     （安装任务被取消时连同成品一起删，见 install.mjs；失败则留着续传）。
//
// 进度回调 onProgress({ bytes, total })，节流由调用方做。网络入口（open）可注入，单测零真实网络。
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";

import { IDLE_TIMEOUT_MS, openHttps } from "./net.mjs";
import { isSha256 } from "./sources.mjs";

export const MAX_ATTEMPTS_PER_URL = 4;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;

export const hasZstd = () => typeof zlib.createZstdDecompress === "function";

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

export const sha256OfText = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return -1;
  }
}

function downloadError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// 一个地址下一轮：带 Range 续传，写 .part；body 长时间无数据按超时失败（保留 .part）。
async function fetchToPart({ url, partPath, total, onProgress, open, signal, idleTimeoutMs }) {
  const have = Math.max(0, await fileSize(partPath));
  if (total && have === total) return;
  const headers = have > 0 ? { range: `bytes=${have}-` } : {};
  const { res } = await open(url, { headers, signal });
  let offset = have;
  let flags = "a";
  if (have > 0 && res.statusCode !== 206) {
    offset = 0;
    flags = "w"; // 服务器不认 Range：从头写
  }
  const length = Number(res.headers?.["content-length"]);
  const expected = total || (Number.isFinite(length) ? offset + length : null);
  let bytes = offset;
  onProgress?.({ bytes, total: expected });
  let idle;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      onProgress?.({ bytes, total: expected });
      clearTimeout(idle);
      idle = setTimeout(() => counter.destroy(downloadError("ETIMEDOUT_IDLE", `下载 ${idleTimeoutMs / 1000} 秒没有新数据`)), idleTimeoutMs);
      cb(null, chunk);
    },
  });
  idle = setTimeout(() => counter.destroy(downloadError("ETIMEDOUT_IDLE", `下载 ${idleTimeoutMs / 1000} 秒没有新数据`)), idleTimeoutMs);
  try {
    // signal 也交给 pipeline：取消时不管网络入口有没有把信号接到响应体上，三段流都立刻销毁、文件句柄关掉。
    await pipeline(res, counter, fs.createWriteStream(partPath, { flags, mode: 0o600 }), signal ? { signal } : {});
  } finally {
    clearTimeout(idle);
  }
  if (total && bytes !== total) throw downloadError("ESHORT", `下载长度不对（${bytes} / ${total} 字节）`);
}

// 下载并校验一个文件到 dir/fileName。已有校验通过的成品直接复用。
// → { filePath, size, sha256, reused }
export async function downloadFile({
  urls,
  dir,
  fileName,
  sha256,
  size = null,
  onProgress,
  open = openHttps,
  signal,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  maxAttemptsPerUrl = MAX_ATTEMPTS_PER_URL,
}) {
  if (!SAFE_FILE.test(String(fileName || ""))) throw downloadError("EARG", `文件名非法: ${fileName}`);
  if (!isSha256(sha256)) throw downloadError("EARG", "缺少 sha256");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, fileName);
  const partPath = `${filePath}.part`;
  if ((await fileSize(filePath)) >= 0) {
    if (await sha256File(filePath) === sha256) {
      const s = await fileSize(filePath);
      onProgress?.({ bytes: s, total: s });
      return { filePath, size: s, sha256, reused: true };
    }
    await fsp.rm(filePath, { force: true });
  }
  const errors = [];
  let checksumRetried = false;
  for (let u = 0; u < urls.length; u += 1) {
    const url = urls[u];
    for (let attempt = 1; attempt <= maxAttemptsPerUrl; attempt += 1) {
      if (signal?.aborted) throw downloadError("EABORT", "下载已取消");
      try {
        await fetchToPart({ url, partPath, total: size, onProgress, open, signal, idleTimeoutMs });
      } catch (err) {
        // 取消：不换源、不重试，立刻结束（.part 留着；要不要删由调用方定——安装任务取消时会删）。
        if (signal?.aborted) throw downloadError("EABORT", "下载已取消");
        errors.push(`${new URL(url).host}: ${err?.message || err}`);
        // HTTP 4xx（404 / 403）换源，不在同一地址上反复撞。
        if (err?.statusCode && err.statusCode < 500) break;
        continue;
      }
      const actual = await sha256File(partPath);
      if (actual === sha256) {
        await fsp.rename(partPath, filePath);
        return { filePath, size: await fileSize(filePath), sha256, reused: false };
      }
      // 校验和不符：已下的全扔掉（续传接错了源 / 中途被篡改），整轮最多重来一次。
      await fsp.rm(partPath, { force: true });
      errors.push(`${new URL(url).host}: 校验和不符`);
      if (checksumRetried) throw downloadError("ECHECKSUM", `${fileName} 校验和与官方清单不符`, { errors });
      checksumRetried = true;
    }
  }
  throw downloadError("EDOWNLOAD", `下载 ${fileName} 失败（${errors.slice(-3).join("；")}）`, { errors });
}

// zstd 解压 src → dest，同时算原文件的 sha256 并按 expect 核对（不符删掉 dest）。
export async function decompressZstd({ src, dest, sha256, size }) {
  if (!hasZstd()) throw downloadError("ENOZSTD", "本机 Node 不支持 zstd");
  const tmp = `${dest}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(src), zlib.createZstdDecompress(), tap, fs.createWriteStream(tmp, { mode: 0o600 }));
  const actual = hash.digest("hex");
  if (actual !== sha256 || (size && bytes !== size)) {
    await fsp.rm(tmp, { force: true });
    throw downloadError("ECHECKSUM", "解压后的文件与官方清单不符");
  }
  await fsp.rename(tmp, dest);
  return { filePath: dest, size: bytes, sha256 };
}

// 按 sources 解析出的 artifact 下载成「可直接上传的文件」：Claude 有 compressed 时走压缩包 + 本机解压。
// 进度只报网络下载那一段（解压很快）。→ { filePath, size, sha256, reused }
export async function downloadArtifact(artifact, { dir, onProgress, open = openHttps, signal, idleTimeoutMs } = {}) {
  const finalPath = path.join(dir, artifact.fileName);
  if (artifact.compressed && hasZstd()) {
    if ((await fileSize(finalPath)) === artifact.size && await sha256File(finalPath) === artifact.sha256) {
      onProgress?.({ bytes: artifact.compressed.size, total: artifact.compressed.size });
      return { filePath: finalPath, size: artifact.size, sha256: artifact.sha256, reused: true };
    }
    try {
      const zst = await downloadFile({ ...artifact.compressed, dir, onProgress, open, signal, idleTimeoutMs });
      const raw = await decompressZstd({ src: zst.filePath, dest: finalPath, sha256: artifact.sha256, size: artifact.size });
      await fsp.rm(zst.filePath, { force: true });
      return { ...raw, reused: false };
    } catch (err) {
      if (err?.code === "EABORT") throw err;
      // 压缩版不行就退到原文件（与官方安装器同样的回落）。
    }
  }
  return downloadFile({ urls: artifact.urls, dir, fileName: artifact.fileName, sha256: artifact.sha256, size: artifact.size, onProgress, open, signal, idleTimeoutMs });
}

// 安装成功后删掉缓存里的成品与残留 .part。
export async function cleanupArtifact(artifact, { dir }) {
  const names = [artifact.fileName, `${artifact.fileName}.part`];
  if (artifact.compressed) names.push(artifact.compressed.fileName, `${artifact.compressed.fileName}.part`);
  await Promise.all(names.map((n) => fsp.rm(path.join(dir, n), { force: true }).catch(() => {})));
}
