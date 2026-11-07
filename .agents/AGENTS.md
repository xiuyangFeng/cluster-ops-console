# Agent Rules - Codex Tunnel Operations Console 运维规范

本文件记录本项目的自动化编码和设计规范，后续的 AI 助手（Agent）在进行编码迭代时必须严格遵守以下规则。

---

## 💾 日志处理与系统轻量化规范
1. **日志文件限额机制**：系统所有的持久化日志一律走结构化日志 `runtime/logs/<source>.ndjson`（`lib/logger.mjs` 的 `createLogger`），单文件大小上限严格限制在 **2MB** 以内。不要再新增明文 `.log` 文件或把子进程输出重定向到文件（旧的 `channel-supervisor.log` 等明文日志已废弃，不再有写入方）。
2. **自动滚动与清除 (Log Rotation)**：系统必须实现定时（或基于事件的）日志容量检查。一旦超过 2MB 额度限制，应立刻执行截断清除操作，并保留简洁的自旋重置时间标记（例如 `--- LOG AUTO-ROTATED AT [ISO TIME] ---`），只保留一份 `.1` 历史分卷，严禁无限制增长或保留过多历史冗余分卷，避免宿主机磁盘空间被高频轮询的 SSH 日志爆盘。
3. **集群上的文件同样要有上限**：本机 logger 与 runtime sweeper 管不到远端。远端脚本若必须写诊断日志（如远端守护进程的 `console-launch.log`），须自带容量上限并保留末尾诊断；被常驻进程以 `>>` 长期打开的文件只能就地截断、不能靠 rename 轮转（参见 `work/monitor/lib/daemons/commands.mjs` 的 `cap_log`）。

---

## 📢 更新日志与版本记录规范
1. **CHANGELOG 与前端双重同步**：每次发版（功能更新、重构优化或 Bug 修复）必须把变更细节**同步记录**在以下两处，版本号与日期两边完全一致：
   - 根目录 [CHANGELOG.md](../CHANGELOG.md)：权威、完整的更新记录，顶部新增 `### vX.Y.Z · YYYY-MM-DD` 小节（Release 流水线按此抽取说明）。README 的 `## 📋 版本更新记录 (Changelog)` 只保留摘要与链接，不再逐版本追加。
   - 前端更新日志数据 [work/monitor/public/assets/js/changelog-data.js](../work/monitor/public/assets/js/changelog-data.js) 的 `changelogData` 数组头部（`app.js` 里已不再内嵌这份数据）。
   - `scripts/changelog-sync.test.mjs` 校验两边版本/日期一致、按日期降序、首条等于 `package.json` 版本；`package-lock.json` 的版本须同步改（`release-scan` 校验）。完整发版步骤见 [docs/release.md](../docs/release.md)。
2. **前端可见性保障**：必须确保每次更新在前端应用的控制面板界面上，用户可以通过点击版本号 Badge 弹出的毛玻璃「更新日志」时间轴窗口清晰、直观地看到每次版本的详细优化和改动，不得遗漏。
