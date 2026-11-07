import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { statusError } from "./status-error.mjs";

const VAULT_IPC_ORIGIN = "http://127.0.0.1:8877";
const MAX_VAULT_PASSWORD_CHARS = 4096;

export function isTrustedVaultIpcOrigin(url) {
  try {
    return new URL(String(url || "")).origin === VAULT_IPC_ORIGIN;
  } catch {
    return false;
  }
}

export function assertVaultPassword(password) {
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_VAULT_PASSWORD_CHARS || /[\r\n\0]/.test(password)) {
    throw statusError("只接受一次性密码，且不会写入配置文件", 400, { code: "no-password" });
  }
  return password;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createVaultHttpServer({
  vault,
  token,
  host = "127.0.0.1",
  createHttpServer = createServer,
} = {}) {
  if (!vault || !token) throw new Error("vault HTTP 需要 vault 与 token");
  if (host !== "127.0.0.1") throw new Error("vault HTTP 只允许 127.0.0.1");

  async function readBody(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) return null;
    }
    try { return JSON.parse(body || "{}"); } catch { return null; }
  }

  function send(res, value, status = 200) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }

  const server = createHttpServer(async (req, res) => {
    const reqHost = String(req.headers.host || "").split(":")[0];
    if (reqHost && reqHost !== "127.0.0.1" && reqHost !== "localhost") {
      return send(res, { error: "vault only accepts localhost" }, 403);
    }
    if (req.method !== "POST") return send(res, { error: "method not allowed" }, 405);
    if (!safeEqual(req.headers["x-vault-token"], token)) return send(res, { error: "Unauthorized" }, 401);
    try {
      const data = await readBody(req);
      if (!data || typeof data !== "object" || Array.isArray(data)) return send(res, { error: "invalid body" }, 400);
      if (req.url === "/put") return send(res, await vault.put(assertVaultPassword(data.password)));
      if (req.url === "/get") return send(res, { password: await vault.get(data.authRef) });
      if (req.url === "/delete") return send(res, await vault.delete(data.authRef));
      return send(res, { error: "not found" }, 404);
    } catch (err) {
      return send(res, { error: err.message, code: err.code }, err.status || 400);
    }
  });

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve({
          url: `http://${host}:${address.port}`,
          port: address.port,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  return { listen, server };
}
