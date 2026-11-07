import { createReportService } from "../../reports/service.mjs";
import { parseNdjsonTail, queryLogs, readLogHistoryFiles } from "../../logger.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createReportRoutes({ getConfig, jobsService, incidentStore, tunnelStability, logsDir, version, now }) {
  const service = createReportService({ getConfig, jobsService, incidentStore, tunnelStability, version, now,
    readOperationLogs: async (operationId, serverId) => {
      const scoped = (entries) => entries.filter((entry) => !entry.serverId || entry.serverId === serverId).slice(-20);
      const entries = scoped(queryLogs({ operationId, limit: 200 }).entries);
      if (entries.length || !logsDir) return entries;
      const raw = await readLogHistoryFiles(logsDir, "ops");
      return scoped(parseNdjsonTail(raw || "", { operationId, limit: 200, tailLines: 2000 }).entries);
    },
  });
  return routeTable({
    "GET /api/reports": async ({ res, url }) => {
      const params = url.searchParams;
      const kind = params.get("kind");
      const serverId = params.get("serverId");
      const jobId = params.get("jobId");
      const incidentId = params.get("incidentId");
      if (!["job", "incident"].includes(kind) || !isBoundedServerId(serverId) ||
        (kind === "job" && !/^\d{1,12}(?:_\d{1,9})?$/.test(jobId || "")) ||
        (kind === "incident" && !/^[\w-]{1,80}$/.test(incidentId || ""))) {
        return sendJson(res, { error: "报告目标无效" }, 400);
      }
      await respondOrError(res, async () => sendJson(res, await service.build({ kind, serverId, jobId, incidentId, includeScript: params.get("includeScript") === "1" })));
    },
  });
}
