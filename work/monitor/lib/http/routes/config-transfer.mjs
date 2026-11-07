// 配置的备份与迁移（v2.64，lib/config-transfer/）：
//   GET  /api/config/transfer         导出包含 / 不包含什么、个人配置写前备份在哪（配置页「备份与迁移」打开时读）
//   GET  /api/config/export           导出文件 { filename, document }（不含任何令牌 / 口令 / 私钥）
//   POST /api/config/import/preview   { document } → 将改动的条目（端口相关的单独标出、默认不勾）
//   POST /api/config/import           { document, selected, revision } → 按勾选写入（写前备份）
// 鉴权、Host / Origin 校验走 http-router 的统一闸：读接口同样要令牌（导出里有个人配置）。
// 导入的请求体有上限：正文声明超限直接 413，流式读取时超限按坏请求处理。
import { IMPORT_MAX_BYTES } from "../../config-transfer/document.mjs";
import { isJsonObject, readJsonBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 导入文件本身 ≤ IMPORT_MAX_BYTES，另给勾选列表与外层包装留一点余量。
export const IMPORT_BODY_MAX_BYTES = IMPORT_MAX_BYTES + 64 * 1024;

const unavailable = (res) => sendJson(res, { error: "备份与迁移不可用（监控服务没有装配这一项）" }, 503);

function sendTransferError(res, err) {
  sendJson(res, { error: err.message || "failed", code: err.code || undefined, errors: err.errors || undefined }, err.status || 400);
}

async function readImportBody(req, res) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > IMPORT_BODY_MAX_BYTES) {
    sendJson(res, { error: `导入文件太大（上限 ${Math.round(IMPORT_MAX_BYTES / 1024)} KB）`, code: "too-large" }, 413);
    return null;
  }
  const body = await readJsonBody(req, IMPORT_BODY_MAX_BYTES);
  if (!isJsonObject(body) || !isJsonObject(body.document)) {
    sendJson(res, { error: `读不出导入文件：应当是工作台导出的 JSON，且不超过 ${Math.round(IMPORT_MAX_BYTES / 1024)} KB`, code: "invalid-body" }, 400);
    return null;
  }
  return body;
}

export function createConfigTransferRoutes({ configTransfer = null }) {
  return routeTable({
    "GET /api/config/transfer": async ({ res }) => {
      if (!configTransfer) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, configTransfer.describe()), sendTransferError);
    },
    "GET /api/config/export": async ({ res }) => {
      if (!configTransfer) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await configTransfer.exportDocument()), sendTransferError);
    },
    "POST /api/config/import/preview": async ({ req, res }) => {
      if (!configTransfer) return unavailable(res);
      const body = await readImportBody(req, res);
      if (!body) return;
      await respondOrError(res, async () => sendJson(res, await configTransfer.previewImport(body.document)), sendTransferError);
    },
    "POST /api/config/import": async ({ req, res }) => {
      if (!configTransfer) return unavailable(res);
      const body = await readImportBody(req, res);
      if (!body) return;
      await respondOrError(res, async () => sendJson(res, await configTransfer.applyImport(body.document, {
        selected: body.selected ?? [],
        revision: body.revision ?? null,
      })), sendTransferError);
    },
  });
}
