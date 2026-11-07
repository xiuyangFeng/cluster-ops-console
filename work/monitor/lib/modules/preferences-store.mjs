// 模块开关 / 面板显隐偏好的个人层读写（只在控制面使用）。
//
// 刻意不放进 config-loader.mjs：那个文件在数据面 supervisor 的 import 闭包里，
// 改它会让热更新判定数据面变化、触发 supervisor 交接；偏好只影响控制面，读写也只在这里。
import * as nodeFs from "node:fs";
import { writePrivateFileAtomicSync } from "../atomic-file.mjs";
import { ConfigValidationError } from "../config-loader.mjs";
import { isLegacyModulePreferences, MODULE_PREFS_VERSION, PREFERENCE_FIELDS, validatePreferenceIds } from "./catalog.mjs";

function readPersonalObject(localConfigPath, fs) {
  let raw;
  try {
    raw = fs.readFileSync(localConfigPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || /ENOENT/.test(String(err?.message || err))) return {};
    throw new ConfigValidationError("个人配置无法读取，原文件未改动");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch {
    throw new ConfigValidationError("个人配置无法读取，请修复后重试，原文件未改动", [{ field: "config", message: "配置必须是有效 JSON 对象" }]);
  }
}

// 从个人层原始对象取偏好：只认个人层（团队层写了也忽略，否则团队配置能替所有同事
// 关掉某个监控）。缺省为空数组（按团队默认 / 全部显示）。legacyModuleDefaults 标出旧偏好（规则见 catalog.mjs 文件头）。
export function pickPreferences(personal) {
  const source = personal && typeof personal === "object" && !Array.isArray(personal) ? personal : {};
  return {
    ...Object.fromEntries(PREFERENCE_FIELDS.map((f) => [f, Array.isArray(source[f]) ? source[f] : []])),
    legacyModuleDefaults: isLegacyModulePreferences(source),
  };
}

// 只改 disabledModules / enabledModules / hiddenPanels，其余字段原样保留；任一字段非法即整体拒绝。
// 每次写入都打上 modulePrefsVersion——调用方先用 catalog.explicitModulePreferences 把旧偏好物化进
// enabledModules（config-hot-reload 的两个写入口都这样做），否则打上版本号后旧语义就丢了。
// 空数组照常写入（表示按默认 / 全部显示）。tmp+rename 原子写，与 writeActiveSelection 同口径。
export function writePersonalPreferences({ localConfigPath, patch, fs = nodeFs }) {
  const current = readPersonalObject(localConfigPath, fs);
  const next = { ...current };
  for (const f of PREFERENCE_FIELDS) {
    if (!Object.hasOwn(patch || {}, f)) continue;
    const checked = validatePreferenceIds(patch[f]);
    if (!checked.ok) throw new ConfigValidationError("偏好设置未通过校验", [{ field: f, message: checked.message }]);
    next[f] = checked.value;
  }
  next.modulePrefsVersion = MODULE_PREFS_VERSION;
  next.revision = (Number(current.revision) || 0) + 1;
  writePrivateFileAtomicSync(localConfigPath, `${JSON.stringify(next, null, 2)}\n`, { fs, chmodDir: false });
  return next;
}
