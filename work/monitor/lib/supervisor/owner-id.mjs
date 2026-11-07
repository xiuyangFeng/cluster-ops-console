// 本机识别码：给隧道会话打标记用（见 tunnel-spec 的 buildTunnelMarker），每台 Mac 一个，
// 持久化在 runtimeDir。supervisor 重启 / 热更新交接后沿用同一个码，才能认出上一任留下的残留会话；
// 另一台电脑（或另一个 checkout 的数据目录）有自己的码，彼此的会话互不触碰。
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";

import { writePrivateFileAtomicSync } from "../atomic-file.mjs";

export const TUNNEL_OWNER_ID_FILE = "tunnel-owner-id";
const OWNER_ID_RE = /^[0-9a-f]{16}$/;

export function loadOrCreateTunnelOwnerId(runtimeDir, { fs = nodeFs, random = () => randomBytes(8).toString("hex") } = {}) {
  if (!runtimeDir) return null;
  const file = path.join(runtimeDir, TUNNEL_OWNER_ID_FILE);
  try {
    const existing = String(fs.readFileSync(file, "utf8")).trim();
    if (OWNER_ID_RE.test(existing)) return existing;
  } catch {}
  const id = random();
  if (!OWNER_ID_RE.test(id)) return null;
  try {
    writePrivateFileAtomicSync(file, `${id}\n`, { fs, chmodDir: false });
  } catch {
    // 写不进去也照用：只是 supervisor 重启后换了码，认不出本次运行留下的残留会话。
  }
  return id;
}
