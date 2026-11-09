// Windows 命名管道由内核原子独占（libuv FIRST_PIPE_INSTANCE），进程崩溃自动释放。
// 生命周期覆盖整个 supervisor：不能在“登记完成”后释放，也不依赖可被 GC 的 pid.json。
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";

export function supervisorPipeName(runtimeDir) {
  const key = path.win32.resolve(runtimeDir).toLowerCase();
  return `\\\\.\\pipe\\codex-supervisor-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export async function acquireSupervisorLease(runtimeDir, { platform = process.platform, serverFactory = createServer } = {}) {
  if (platform !== "win32") return { release() {} };
  const server = serverFactory((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      server.close();
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error); // 无法加锁不能继续启动数据面。
    });
    server.listen({ path: supervisorPipeName(runtimeDir), exclusive: true }, () => {
      server.unref();
      resolve({ release: () => server.close() });
    });
  });
}
