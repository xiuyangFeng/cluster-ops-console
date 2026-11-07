# Agent Rules - Codex Tunnel Operations Console 运维规范

本文件记录本项目的自动化编码和设计规范，后续的 AI 助手（Agent）在进行编码迭代时必须严格遵守以下规则。

---

## 💾 日志处理与系统轻量化规范
1. **日志文件限额机制**：系统所有的持久化日志一律走结构化日志 `runtime/logs/<source>.ndjson`（`lib/logger.mjs` 的 `createLogger`），单文件大小上限严格限制在 **2MB** 以内。不要再新增明文 `.log` 文件或把子进程输出重定向到文件（旧的 `channel-supervisor.log` 等明文日志已废弃，不再有写入方）。
2. **自动滚动与清除 (Log Rotation)**：系统必须实现定时（或基于事件的）日志容量检查。一旦超过 2MB 额度限制，应立刻执行截断清除操作，并保留简洁的自旋重置时间标记（例如 `--- LOG AUTO-ROTATED AT [ISO TIME] ---`），只保留一份 `.1` 历史分卷，严禁无限制增长或保留过多历史冗余分卷，避免宿主机磁盘空间被高频轮询的 SSH 日志爆盘。

---

## 📢 更新日志与版本记录规范
1. **三处同步**：每次功能更新、重构或修复发版时，同步更新：
   - `package.json` 的 `version`（版本号的单一事实源：界面版本徽章、构建信息与热更新判定都读它）；
   - 根目录 `CHANGELOG.md` 顶部新增该版本小节；
   - `work/monitor/public/assets/js/changelog-data.js` 的 `changelogData` 首条（版本号必须等于 `package.json`，`scripts/changelog-sync.test.mjs` 守护）。
2. **前端可见性保障**：用户点击版本号 Badge 弹出的「更新日志」时间轴必须能看到每次新版本的改动，不得遗漏。时间轴只保留 v2.20.0 及以后的版本，更早的完整历史只在 `CHANGELOG.md`。

---

## 🧩 模块化与并行修改规范
改代码前先读 [docs/architecture.md](docs/architecture.md) 的「项目结构」与「目录归属与多 Agent 并行开发约定」：
1. **入口只做装配**：`electron-main.mjs`、`monitor-server.mjs`、`channel-supervisor.mjs`、`local_http_connect_proxy.mjs`、`app.js`、`setup-wizard.mjs`、`hot-update.mjs` 只放接线，逻辑写进对应目录的小模块。
2. **按目录认领、共享件只加不改签名**：探针 id、校验、错误、原子写、阈值、格式化等共享件已有单一实现，不要再复制一份。
3. **放置规则**：运行时代码放 `work/monitor/` 下（打包白名单），不得 import `scripts/`；数据面只用静态相对 import（热更新指纹按 import 闭包计算）。
4. **测试跟着源码走**：模块测试放同目录；提交前跑 `npm test` 与 `npm run lint`，前端改动再跑 `npm run test:browser`。

---

## 🕒 时间口径与跨环境验证规范
1. **数据侧一律北京时间（固定 UTC+8）**：历史日文件、用量、简报、隧道稳定性、Slurm 时间的日界与时刻都按北京时间。换算只有两份——后端 `work/monitor/lib/beijing-time.mjs`，前端 `work/monitor/public/assets/js/render/usage-model.js`——不要再用本机时区的 `getHours()` / `setHours()` / `new Date(y, m, d)` 处理这些数据，也不要再写一份 `8 * 3600_000`。纯「刚才几点」的本机时刻显示（日志面板、最后更新）除外。
2. **动了时间相关代码跑 `npm run test:tz`**（五个时区各跑一遍全量）。开发机都在 UTC+8，用了本机时区的代码本机全绿、只在别的时区才错。
3. **推送后看 CI**：2026-10 曾因时区问题红了一周没人发现。推 main 之后确认 `test` 工作流的结果；红了先看红在哪，不要带着红继续叠改动。
4. **放开运行时版本范围要先实测**：`package.json` 的 `engines`、`start.sh` 与 `start-console.cmd` 的版本闸门、`install/` 下两个安装器（闸门 + 写死的私有 Node 版本与 SHA-256，校验值抄自该版本的 `SHASUMS256.txt`）、`lib/platform.mjs` 的 `isNodeVersionSupported`、CI 矩阵一起改；新上界对应的 Node 大版本要先跑通全量测试。`scripts/installer.test.mjs` 会检查这几处与 `engines` 一致。
5. **起真实子进程、被测代码自己带时限的用例，要扛得住机器卡顿**：`npm test` 并发起上百个进程，开发机内存吃紧（交换区快用满）时起一个子进程会卡上几秒；另外 macOS 对新写出的可执行文件第一次执行要做一次安全评估（空闲时约 0.3 秒）。被测代码有自己的时限时（如远端脚本给每条 Slurm 命令 6 秒），这类用例单跑全过、全量时偶发超时。写法见 `lib/jobs/watch-scan.test.mjs`：假 `squeue` / `sacct` 写完先各 `spawnSync` 一次；那一趟慢得不正常（正常 0.2 秒、实际超过 4 秒）就重跑，最多三趟，断言不变。断言「子进程退出了」这类不关心快慢的用例，时限给到 60 秒。不要靠放宽产品代码里的时限来让测试变绿。
