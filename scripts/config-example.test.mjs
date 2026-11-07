// config.local.example.json 是同事会照着看的字段说明：它必须能被当前的加载逻辑原样吃下（不告警），
// 字段清单与端口规则不能落后于代码（曾停在 v2.18：缺 egress，本地端口也不符合"远端 + 1000"）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeConfig, PERSONAL_FIELDS, resolveEgressSetting, validateAllowlistForWrite } from "../work/monitor/lib/config-loader.mjs";
import { validateNoProxyExtraForWrite } from "../work/monitor/lib/personal-config-write.mjs";
import { LOCAL_PORT_OFFSET } from "../work/monitor/lib/reverse-port.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(readFileSync(path.join(rootDir, name), "utf8"));
const example = readJson("config.local.example.json");

test("示例与团队配置合并时不产生任何告警", () => {
  const warnings = [];
  mergeConfig(readJson("config.json"), example, { warn: (...args) => warnings.push(args.join(" ")) });
  assert.deepEqual(warnings, []);
});

test("示例里每台服务器的本地端口 = 远端端口 + 1000", () => {
  for (const server of example.servers.filter((s) => s.remotePort != null)) {
    assert.equal(server.localPort, server.remotePort + LOCAL_PORT_OFFSET, server.id);
  }
});

test("字段说明覆盖全部个人层字段，出网 / 白名单 / 内网直连的示例值通过写入校验", () => {
  for (const field of [...PERSONAL_FIELDS, "proxyAllowedTargets", "noProxyExtra"]) {
    assert.ok(example._comment_fields.includes(field), `_comment_fields 缺 ${field}`);
  }
  assert.equal(resolveEgressSetting(example.egress).issue, null);
  assert.equal(validateAllowlistForWrite(example.proxyAllowedTargets).ok, true);
  assert.equal(validateNoProxyExtraForWrite(example.noProxyExtra).ok, true);
});
