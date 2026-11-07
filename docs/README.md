# 开发者说明（工程化配置）

## 测试发现（npm test）

`npm test` 通过 glob 自动发现测试文件：

```
node --test --test-concurrency=4 "scripts/*.test.mjs" "work/**/*.test.mjs"
```

- 两个目录模式覆盖全仓所有 `*.test.mjs`，新增测试文件无需登记（此前手工枚举曾漏掉
  `work/monitor/lib/operation-context.test.mjs`）。
- 刻意不用裸 `**/*.test.mjs`：避免误匹配 `dist/`、`*.app/`、`node_modules/` 里的打包拷贝。
- `--test-concurrency=4`：并发 8 收益已饱和，取 4 是为了给内存留余量（每个用例都会起临时
  目录与假进程）。若新增用例使用固定端口或共享全局文件，请显式串行并在此登记原因。
- 真实 Electron 冒烟不在默认套件内，单独运行：

  ```
  npm run test:browser    # 拉起真实 Electron + fixture 模式 monitor-server（随机端口、临时数据目录）
  ```

  它必须在装有 Electron 二进制的环境里显式运行：宿主若带 `ELECTRON_RUN_AS_NODE`（从打包好的
  app 终端启动开发即如此），Electron 会退化成纯 Node 并以 `does not provide an export named
  'BrowserWindow'` 失败。CI 的 `browser-smoke` job 直接运行 `npm run test:browser`。
  无需 Electron 的静态接线检查留在 `scripts/browser-smoke-wiring.test.mjs`（默认套件内）。
  冒烟窗口一律经 `scripts/lib/smoke-window.mjs` 创建：macOS 创建窗口时会把尺寸钳到屏幕工作区，
  CI 的 macos runner 屏幕只有 1024 宽，不在创建后明确设回去的话，布局断言在 CI 上会以与本机不同的
  宽度运行。

## 时区（npm run test:tz）

历史日文件、用量、简报、隧道稳定性与 Slurm 的时刻一律按北京时间（UTC+8），与机器时区无关：
后端从 `work/monitor/lib/beijing-time.mjs` 取日界换算，前端从 `render/usage-model.js` 取
`clockOf` / `dayKeyOf`，不要用 `getHours` / `setHours` / `new Date(y, m, d)` 这类按本机时区取值的
写法（只显示「刚才几点」的本机时刻除外，如日志面板、「最后更新」徽标）。开发机都在 UTC+8，
这类错误在本机 `npm test` 里看不出来，所以有三道防线：

- 测试里的时间用显式的 UTC+8 构造（`Date.UTC(...)` 减 8 小时，或带 `+08:00` 的字符串），期望值写死。
- 口径敏感的用例包一层 `inEveryTimeZone`（`work/monitor/lib/test-timezones.mjs`）：进程内依次切到
  UTC / 洛杉矶 / 加尔各答 / 东京 / 奥克兰各跑一遍，默认时区下的 `npm test` 就能拦住。
- 整套测试换时区跑：

  ```
  npm run test:tz                          # 依次在上面 5 个时区下跑完整的 npm test（每个约 1 分钟）
  npm run test:tz -- UTC Asia/Tokyo        # 只跑指定的时区
  npm run test:tz -- UTC --test-name-pattern=趋势
  ```

  TZ 经子进程环境变量传入，不过 shell，Windows 上同样可用。CI 的 `test` 矩阵每个 job 各带一个时区
  （洛杉矶 / 加尔各答 / 奥克兰 / UTC），`scripts/test-tz.test.mjs` 守着这张表。

## Lint（Biome）

`npm run lint` 执行 `biome check .`（配置见根目录 `biome.json`）：

- 只启用 linter（recommended 预设），formatter/assist 关闭——本轮不做格式化，
  避免大面积 diff 与并行分支冲突。
- 忽略生成物与第三方目录：`dist/`、`*.app/`、`node-offline/`、`codex-offline-*/`、
  `docs/`、`node_modules/`，并复用 `.gitignore`（vcs.useIgnoreFile）。

### 存量诊断清单（后续收紧）

`biome.json` 现在只有 `preset: recommended`，没有任何逐规则降级——原先那份 a11y /
suspicious 豁免经核对是"空操作"（recommended 预设本身就是同样的级别），已在清理存量后
整体删除。当前全仓 26 条 warn（0 error，`biome check` 退出码 0）：

| 规则 | 存量数量 | 说明 |
| --- | --- | --- |
| `lint/style/noDescendingSpecificity` | 9 | 低权重选择器写在更高权重之后（多为跨文件分层设计的副产物） |
| `lint/correctness/noUnusedFunctionParameters` | 8 | 接口签名要求保留但函数体未用的形参，重命名为 `_x` 即可 |
| `lint/complexity/noImportantStyles` | 6 | `!important`，全部是 `prefers-reduced-motion` 与省电闸（`data-console-hidden`）里必须压过一切的声明 |
| `lint/correctness/noUnusedVariables` | 3 | 待确认是死代码还是预留位 |

这些都不阻断 lint（Biome 默认仅 error 退出非零），可随日常改动顺手消化。新代码请按
error 标准对待。

已清零的类别（供参考，别退回去）：`useOptionalChain` 146 处、`useButtonType` 29 处、
`useTemplate` 16 处、`noUnusedFunctionParameters`（可自动修的）28 处、
`noPrototypeBuiltins` 5 处、`noUnusedImports` 3 处、全部 a11y 与 `noUnusedVariables`
中属死代码的那些。合计从 263 条诊断（240 warn + 23 info）降到 26 条 warn。

**不要再用 `biome check --write --unsafe` 全量刷**：`useOptionalChain` 之外的规则里，
`noUnusedVariables` 会删代码、`noAssignInExpressions` / `noCommaOperator` 会改变表达式
求值位置。需要批量修时用 `--only=<rule>` 逐规则来（本项目就是这么做的），改完必须跑
`npm test`。
