import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";

import { downloadArtifact, downloadFile, hasZstd } from "./download.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const DATA = Buffer.from("x".repeat(100000));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-dl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 假的 openHttps：按 url 返回内容，支持 Range；可让某次响应半路断开。
function fakeOpen(files, { cutAfter = null, log = [] } = {}) {
  let cut = cutAfter;
  return async (url, { headers = {} } = {}) => {
    log.push([url, headers.range || null]);
    const body = files[url];
    if (!body) throw Object.assign(new Error("HTTP 404"), { statusCode: 404 });
    const m = headers.range?.match(/^bytes=(\d+)-$/);
    const start = m ? Number(m[1]) : 0;
    const slice = body.subarray(start);
    const res = Readable.from((async function* gen() {
      if (cut != null) {
        const n = cut;
        cut = null;
        yield slice.subarray(0, n);
        await new Promise((r) => setTimeout(r, 30)); // 让已收到的部分先落盘，再断开
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      yield slice;
    })());
    res.statusCode = m ? 206 : 200;
    res.headers = { "content-length": String(slice.length) };
    return { res, url };
  };
}

test("下载：中途断开后带 Range 续传，校验通过后改名；进度单调到总量", async (t) => {
  const dir = tmpDir(t);
  const log = [];
  const seen = [];
  const out = await downloadFile({
    urls: ["https://a/x"],
    dir,
    fileName: "x.bin",
    sha256: sha(DATA),
    size: DATA.length,
    open: fakeOpen({ "https://a/x": DATA }, { cutAfter: 40000, log }),
    onProgress: (p) => seen.push(p.bytes),
  });
  assert.equal(out.size, DATA.length);
  assert.deepEqual(log.map((l) => l[1]), [null, "bytes=40000-"]);
  assert.equal(seen.at(-1), DATA.length);
  assert.ok(!fs.existsSync(path.join(dir, "x.bin.part")));
  // 再来一次：直接复用，不发请求
  const again = await downloadFile({ urls: ["https://a/x"], dir, fileName: "x.bin", sha256: sha(DATA), open: async () => assert.fail("不该再下") });
  assert.equal(again.reused, true);
});

test("下载：主源 404 换下一个源；校验和始终不符 → 报错且不留成品", async (t) => {
  const dir = tmpDir(t);
  const out = await downloadFile({ urls: ["https://a/missing", "https://b/x"], dir, fileName: "y.bin", sha256: sha(DATA), open: fakeOpen({ "https://b/x": DATA }) });
  assert.equal(out.reused, false);
  await assert.rejects(
    downloadFile({ urls: ["https://b/x"], dir, fileName: "z.bin", sha256: "0".repeat(64), open: fakeOpen({ "https://b/x": DATA }) }),
    /校验和与官方清单不符/,
  );
  assert.ok(!fs.existsSync(path.join(dir, "z.bin")));
  assert.ok(!fs.existsSync(path.join(dir, "z.bin.part")));
});

// v2.57 后续：安装任务的取消靠它——信号一响立刻停，不换源、不重试。
test("下载：AbortSignal 中途取消 → 立刻以 EABORT 结束，不再去试下一个源；.part 留在原地由调用方处理", async (t) => {
  const dir = tmpDir(t);
  const log = [];
  // 慢源：每 5ms 吐 1KB，不靠信号停不下来。网络入口故意不理会 signal（由下载自己的管道负责停）。
  const slowOpen = async (url) => {
    log.push(url);
    const res = Readable.from((async function* gen() {
      for (;;) {
        yield Buffer.alloc(1024, 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })());
    res.statusCode = 200;
    res.headers = {};
    return { res, url };
  };
  const controller = new AbortController();
  let seen = 0;
  const started = Date.now();
  const pending = downloadFile({
    urls: ["https://a/x", "https://b/x"],
    dir,
    fileName: "slow.bin",
    sha256: sha(DATA),
    size: 50 * 1024 * 1024,
    open: slowOpen,
    signal: controller.signal,
    onProgress: ({ bytes }) => {
      seen = bytes;
      if (bytes >= 4096 && !controller.signal.aborted) controller.abort();
    },
  });
  await assert.rejects(pending, (err) => err.code === "EABORT" && /已取消/.test(err.message));
  assert.ok(Date.now() - started < 5000, "没有等空闲超时");
  assert.ok(seen >= 4096);
  assert.deepEqual(log, ["https://a/x"], "取消后不换源、不重试");
  assert.deepEqual(fs.readdirSync(dir), ["slow.bin.part"]);
  // 已经取消的信号：一个请求都不发。
  await assert.rejects(downloadFile({ urls: ["https://a/x"], dir, fileName: "slow.bin", sha256: sha(DATA), open: slowOpen, signal: controller.signal }), (err) => err.code === "EABORT");
  assert.equal(log.length, 1);
});

test("downloadArtifact：有 .zst 且本机支持 zstd → 下压缩包、解压后按原文件校验", { skip: hasZstd() ? false : "本机 Node 无 zstd" }, async (t) => {
  const dir = tmpDir(t);
  const zst = zlib.zstdCompressSync(DATA);
  const log = [];
  const artifact = {
    fileName: "claude-2.1.292-linux-x64",
    urls: ["https://d/claude"],
    sha256: sha(DATA),
    size: DATA.length,
    compressed: { fileName: "claude-2.1.292-linux-x64.zst", urls: ["https://d/claude.zst"], sha256: sha(zst), size: zst.length },
  };
  const out = await downloadArtifact(artifact, { dir, open: fakeOpen({ "https://d/claude.zst": zst }, { log }) });
  assert.equal(out.sha256, sha(DATA));
  assert.deepEqual(fs.readFileSync(out.filePath), DATA);
  assert.deepEqual(log.map((l) => l[0]), ["https://d/claude.zst"]);
  assert.ok(!fs.existsSync(path.join(dir, "claude-2.1.292-linux-x64.zst")), "压缩包解完即删");
});

test("downloadArtifact：压缩包不可用 → 退回原文件", async (t) => {
  const dir = tmpDir(t);
  const artifact = {
    fileName: "c.bin",
    urls: ["https://d/raw"],
    sha256: sha(DATA),
    size: DATA.length,
    compressed: { fileName: "c.bin.zst", urls: ["https://d/missing.zst"], sha256: "1".repeat(64), size: 10 },
  };
  const out = await downloadArtifact(artifact, { dir, open: fakeOpen({ "https://d/raw": DATA }) });
  assert.deepEqual(fs.readFileSync(out.filePath), DATA);
});
