# Agent 适配器（AgentAdapter）接口与接入指南

v2.16 起，监控台对每种 agent CLI（codex / reclaude / 未来的 zcode、gemini 等）的
全部差异点收敛为**一个适配器对象**，在 `work/monitor/lib/agents/registry.mjs`
注册一次即可让探针注册、状态合成、三层视图与前端根因展示全链路生效。
接第三个 agent 不再需要改 probes / state-store / monitor-core / 前端的散落分支。

- 注册表与接口权威注释：`work/monitor/lib/agents/registry.mjs`
- 参考实现：`work/monitor/lib/agents/codex.mjs`、`work/monitor/lib/agents/reclaude.mjs`、
  `work/monitor/lib/agents/zcode.mjs`（下文实例）
- 适配器契约测试：`work/monitor/lib/agents/registry.test.mjs`、`work/monitor/lib/agents/zcode.test.mjs`

适配器是一个纯声明 + 少量纯函数的对象；注册表是 `registry.mjs` 里的冻结列表
`ADAPTERS`（固定三家：codex / reclaude / zcode），按 `probeIds` 建索引。

## 接口一览

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `string` | 适配器种类，与配置 `agents[].kind` 一一对应（如 `"codex"`）。 |
| `agentId` | `string` | 默认 agent 配置 id（`agentsStatus` / `agentExpiry` 的键）。配置里存在同 `kind` 条目时以该条目的 id 为准。 |
| `probeIds` | `string[]` | 本适配器声明的探针 id（静态，不依赖 ctx）。state-store 据此做「探针 id → 适配器」分派与层级 `checkedAt` 汇总。 |
| `probeSpecs(ctx)` | `(ctx) => spec[]` | 探针定义数组，每项 `{ id, intervalMs, timeoutMs, run }`。`layer:"agents"`、`usesSsh:true`、熔断门控 `enabled` 由 `registerAgentProbes` 统一补齐。已注册的适配器热载时不重注册（每次调用都会新建闭包，如 doctor 的 ok 连击计数）。`intervalMs` 可以是数字，也可以是 `(刚记录的结果) => 毫秒`；「安装 / 自检 / 登录」这类稳态下没必要高频问的诊断探针用 `steady-interval.mjs` 的 `createSteadyInterval()`（连续 3 轮 ok 后 90 秒 → 5 分钟，非 ok 立即回 90 秒），并把探针 id 登记进同文件的 `STEADY_PROBE_IDS`（通道恢复时插队补跑）——不要各写一套节流。 |
| `createInitialState()` | `() => state` | 适配器私有归并状态（state-store 每 kind 持有一份），初始值须与「检测中...」首屏语义一致。 |
| `onProbeResult({ id, result, state, helpers })` | `=> patch` | 归并一次探针结果（含 `level:"skipped"` 熔断轮）。返回 `{ status?, expiry? }`；键不存在表示「本轮不触碰对应存量值」。 |
| `buildStatus(state)` | `(state) => entry` | 由归并状态合成 `agentsStatus` 条目（纯函数）。输出在既有形状上追加 `degradedReason`（非降级时为 `null`）。 |
| `isSkipped(state)` | `(state) => bool` | 该 agent 当前是否熔断跳过（决定层级 `level:"skipped"`）。 |
| `legacyFields(state)` | `(state) => object` | 合入 `getLegacyStatus` 顶层的旧字段片段（codex: `{ doctor, endpoint }`；reclaude: `{ claudeEndpoint }`）。新适配器返回 `{}`。 |
| `healthInputs(state)` | `(state) => object` | 合入 `classifyHealth` 入参的片段。不参与全局健康聚合返回 `{}`。 |
| `moduleHint` | `{ description, cost, disableWarning? }` | 设置页「监控模块」开关旁的说明、采集代价（如「每 90 秒一次 SSH」）与关闭警示（`lib/modules/catalog.mjs` 读取）。 |

### 启用与关闭（v2.47 起统一规则）

适配器**不再声明** `isEnabled`。是否启用只有一条规则（`registry.mjs` 的
`agentAdapterEnabled(adapter, config)`）：运行配置 `agents[]` 里有条目经
`adapterForAgent` 映射到该适配器即启用。运行配置的 `agents[]` 已按个人层
`config.local.json` 的 `disabledModules`（`"agent:<agentId>"`）过滤
（`lib/modules/catalog.mjs` 的 `applyModulePreferences`），所以：

- codex / reclaude 由 `normalizeAgentConfig` 默认物化 → 默认启用；zcode 需团队配置写入条目；
- 三个都能在**设置页「监控模块」**里关掉（`POST /api/modules { id: "agent:<agentId>", enabled }`），
  不重启、秒级生效：配置内核桥（`config-hot-reload.mjs`）在热载时按新配置
  `registerAgentProbes` 注册新启用的适配器、注销被关掉的适配器的探针；state-store
  清掉其 `agentsStatus` / 旧字段 / 私有归并状态，重新打开时从 `createInitialState()`
  （「检测中...」）起步；事件同步把它的未结事件以「模块已关闭」结案；
- 依赖 agent 的旁路一律经注册表派生，不按 id 写死：事件归属（`adapterForProbeId` +
  `agentIdForAdapter`）、探针指标、通道恢复补跑 doctor（先查 `scheduler.isRegistered`）、
  账号层信号复核与 log-signals 的 reclaude 两段扫描（reclaude 关闭时跳过，fast 采集
  脚本与远端端口证据不变）。

`probeSpecs(ctx)` 的 `ctx` 由 `probes.mjs` 提供：

```
getConfig()                       → Promise<config>
getMainServerConfig(config)       → 活动服务器条目
execFileCmd(cmd, args, opts)      → { stdout, stderr, code }（永不 reject）
sshArgsFor(server, config)        → 探针 SSH 参数数组（ControlMaster/身份统一）
probeSshFailureReason(code, stderr, stdout) → SSH 失败归因文案
```

`onProbeResult` 的 `helpers` 由 state-store 提供：

```
getPreviousStatus()      → 当前 agentsStatus 条目（熔断占位需要 ...previous 时用）
getBridgeStage(stage)    → bridgeStages 快照（codex endpoint 探针回写 agent-endpoint 用）
ingestBridgeStage(snap)  → 写入桥接阶段
now()                    → 毫秒时钟
```

## 接入第三个 agent 的步骤清单

以接入 `zcode` 为例（完整可运行样例见 `registry.test.mjs` 的 `createZcodeAdapter`）：

1. **新建适配器文件** `work/monitor/lib/agents/zcode.mjs`，导出
   `export const zcodeAdapter = { kind: "zcode", agentId: "zcode-01", ... }`。
   - `probeIds` 里的探针 id 全局唯一（按 probeId 建索引，重复会互相覆盖）；
   - `probeSpecs(ctx)` 的 `run` 用 `ctx.execFileCmd("ssh", [...ctx.sshArgsFor(main, config), 远端命令])`
     发起探测，远端命令保持静态字符串拼接（不要引入未收口的配置插值——注入面收口
     见 `normalizeAgentConfig` 与 `resolveClaudeEndpointTarget` 的注释）；
   - `run` 返回 `{ level, reason, data }`；`level` 取 `ok | warn | error`。
2. **注册**：在 `registry.mjs` 的冻结列表 `ADAPTERS` 末尾追加 `zcodeAdapter`
   （列表顺序决定探针注册顺序与 `getLegacyStatus` 旧字段键序）。
3. **配置 agent 条目**：让配置的 `agents[]` 出现
   `{ id: "zcode-01", name: "ZCode", kind: "zcode", command: "zcode" }`。
   默认 agents 物化在 `monitor-core.mjs` 的 `normalizeAgentConfig`；仅个人使用时也
   可只写进本地配置层。有条目即启用，用户可在设置页「监控模块」关掉；适配器补上
   `moduleHint` 让开关旁有说明与采集代价。
4. **前端零改动**：
   - 卡片/概览走通用模板：`agentSummary` 兜底取 `status.output`，`buildAgentHeadline`
     按 `health` 渲染通用文案；
   - 降级根因第一行：前端 `degradedReasonText` 直接展示 `buildStatus` 输出的
     `degradedReason`，缺省时回落到层级 reason，再缺省显示「原因待定位」。
5. **测试**：仿照 `registry.test.mjs` 断言三件事——探针被注册（含熔断门控）、探针
   结果合成出 `agentsStatus` 条目、`buildAgentOverview` + `buildAgentHeadline`
   渲染不报错。测试直接 import 适配器对象，不要改动共享的注册表。

## 实例：zcode 的接入（v2.17，扩展点首次实战）

`work/monitor/lib/agents/zcode.mjs` 是第三个真实适配器，也是本注册表的第一次
实战验证。以下按实际走的步骤记录，含踩到的接口不顺处与相应调整。

### 1. 先侦察，再设计探针（只读 SSH）

探针设计建立在对 myserver 的只读侦察（`cat/ls/ps/--version`）之上，三个关键事实
都与"想当然"的设计相反：

- **没有 PATH 上的 zcode CLI**（`which zcode` 落空，`~/.local/bin` 也没有）。
  安装事实 = `~/.zcode/server/zcode-server.cjs`（bundle）+ 自带 node v22.16.0。
  所以探针用 `test -f` 判安装，而不是 `zcode --version`。
- **应用版本不落盘服务端**：bundle 里的版本取自桌面端拉起时传的 `ZCODE_VERSION`
  环境变量。可采集的版本事实是 `~/.zcode/server/.asset-components/*.json`
  组件清单（如 `glm.json` 的 `0.13.3`），探针以此合成 `version` 字段。
- **zcode-server 不常驻**：由 sshd 随桌面会话按需拉起，健康稳态下 `ps` 里
  没有进程。因此进程存活只作信息展示，**绝不参与判级**——否则默认态即误报
  （v2.12 全红误报的教训）。

最有价值的探测项是**配置漂移**：`~/.zcode/v2/setting.json` 的 `httpProxy` 必须
指向反向隧道 `http://127.0.0.1:<remotePort>`，字段丢失/漂移 → 远程会话
`MODEL_TLS_VALIDATION_FAILED`。期望值复用 `lib/proxy-config.mjs` 的
`zcodeProxySettingsPatch(port)`（引导写入与漂移检测同一事实源），在**本地解析侧**
比对——远端命令是 100% 静态串，`remotePort` 不进入命令（比 codex/reclaude 的
插值模式更收敛）。health 三态：`ready`（安装 + 代理指向隧道）/ `degraded`
（漂移/缺字段/文件缺失/JSON 损坏，degradedReason 各自点名根因并带 TLS 后果）/
`missing`（未安装）。

### 2. 接口不顺处 #1：探针无条件全量注册（本次的主要调整）

原注册表把「注册适配器」与「注册探针」划等号——codex/reclaude 恰好都是
`normalizeAgentConfig` 物化的默认 agents，没暴露问题。zcode 是配置可选的 agent：
默认配置（无 `kind:"zcode"` 条目）下必须零探针、零状态。调整（保持既有测试
一行不改全绿）：

- （v2.17 时）适配器新增可选 `isEnabled(config)`，`registerProbes` 对声明了它的适配器做
  **注册时门控**。为什么不用探针的 `enabled` 回调门控：调度器对 `enabled=false` 的探针每轮
  都发 `level:"skipped"` 的 PROBE_UPDATED，skipped 轮经适配器归并会把禁用 agent 的
  `agentsStatus` 键物化出来、泄漏进 `/api/status`——不注册才是零足迹。
- state-store 在 `computeHealth` / `getLegacyStatus` 的适配器循环跳过禁用适配器，
  `onProbeUpdated` 加纵深防御（禁用适配器的结果即使直发事件也不合成状态）。

> v2.47 更新：`isEnabled` 已删除，并入上文「启用与关闭」的统一规则；「注册时门控、
> 不靠 enabled 回调」的零足迹原则保留。v2.17 时的代价——门控分支经 `getConfig().then`
> 微任务注册、**配置热载增删 zcode 条目需重启生效**——随之消失：启动时
> `registerProbes({ config })` 按启动配置同步注册，之后由配置内核桥随热载增删。

### 3. 接口不顺处 #2：前端两处硬编码残留

- 切换按钮小字曾是 `kind === "reclaude" ? "ReClaude" : "Doctor"`——第三个 agent
  会被错标成 Doctor。改为配置字段 `agents[].switchLabel`
  （`agentSwitchLabel(agent)`：switchLabel → diagnosticLabel → kind 逐级回退），
  `normalizeAgentConfig` 默认物化 codex→"Doctor" / reclaude→"ReClaude"，
  既有显示逐字不变。
- `agentLatencyMs` 的兜底分支读 `bridgeStages["agent-endpoint"]`——该阶段只由
  codex endpoint 探针写入，第三个 agent 走这条会**串显 codex 的延迟**。收窄为
  codex 专属分支，其余 agent 走通用 `agentsStatus[id].endpoint.latencyMs`。
- `agentEndpointOk` 的通用路径（`agentsStatus[id].endpoint.ok`）本来就成立：
  zcode 的 buildStatus 合成 `endpoint` 字段（语义 = 代理配置指向隧道）即可吃到
  通用「端点可达/不可达」chip。`degradedReason` 后端直出 → 前端第一行零改动，
  这条注册表承诺经实战验证成立。

### 4. 已知缺口（本次未动）

`getActiveAgentView`（render/overview.js）的非 claude 分支仍固定读顶层
`status.doctor` / `status.endpoint`（codex 旧字段）：zcode 被切为活跃 agent 时，
下方详情面板会显示 codex 的数据。卡片/概览/根因行不受影响。留待下一轮
把该函数按适配器输出通用化。

### 5. 顺手的接口（记录以免下次改掉）

- `probeSpecs(ctx)` 注入 `execFileCmd`/`sshArgsFor`：探针测试全程无副作用，
  mock 一个 `execFileImpl` 即可端到端跑 run。
- `onProbeResult` 的 patch 缺键语义（不触碰存量值）天然支撑「SSH 未到达远端时
  保留上一轮事实、不伪造未安装」。
- 真实输出做 fixture 的回报很高：`setting.json` 全文、`glm.json` 清单原文入库
  （`zcode.test.mjs`），解析器对"清单没有 version 字段""httpProxy 带尾斜杠"
  这类真实形态的行为都有断言。

## 行为兼容红线（改适配器时必读）

- 既有探针 id（`doctor` / `endpoint` / `reclaude` / `claude-endpoint`）、间隔、超时、
  `agentsStatus` / layers / API 响应形状、熔断占位文案（"通道异常，已熔断跳过检查"
  等）均为 v1.5.2 兼容面，逐字节不可变；前端与既有测试是兼容性验收器。
- 熔断 `skipped` 轮**不覆盖** `expiry`（patch 不带 `expiry` 键即可）；
  reclaude 的 `claude-endpoint` 熔断不计入 agent 级 `skipped`。
- 解析纯函数（`parseDoctorSummary` / `parseReclaudeStatus` / `buildCodexAgentStatus`
  等）仍从 `monitor-core.mjs` 导出（导出面不变），适配器引用而非复制；
  `resolveClaudeEndpointTarget` 实体在 `agents/reclaude.mjs`，`probes.mjs` re-export。
- 账号层日志信号命中后的即时复核（`forceRun("reclaude")`，reclaude 启用时才触发）目前仍在
  `lib/probes/register.mjs` 的 log-signals 接线处；若第三个 agent 也需要「信号 → 立即复核」，
  在该处按信号 category 扩展，勿在适配器内自行调调度器。
- `log-signals` 探针永不随模块关闭：它是远端端口结论的唯一数据源。
