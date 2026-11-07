# 发版与安装指南 (Release Guide)

本项目通过 **tag 触发的 GitHub Actions 流水线**（`.github/workflows/release.yml`）自动构建并发布 macOS 与 Windows 桌面安装包。维护者只需打 tag，Release 页面自动产出；同集群同事从 [Releases 页面](https://github.com/xiuyangFeng/cluster-ops-console/releases) 下载即可，无需本地构建环境。

---

## 一、维护者：发一个新版本

1. **bump 版本号（package.json 与 lockfile 一起）**：改 `package.json` 的 `version`（如 `2.16.0`），并把 `package-lock.json` 的顶层 `version` 与 `packages[""].version` 改成同一值。只改 `package.json` 会让 quality 门禁里的 `release-scan` 报 `package-version-mismatch` 而失败。不要为此跑 `npm install`（本机 `npm install` 会顺带改写 lockfile 里的平台字段）。
2. **写 CHANGELOG（两处，版本与日期必须一致）**：
   - `CHANGELOG.md` 顶部新增小节，标题写 `### vX.Y.Z · YYYY-MM-DD`（旧格式 `### vX.Y.Z (YYYY-MM-DD)` 也认）——流水线按 `### vX.Y.Z` 开头抽取小节内容作为 Release 说明；抽不到会退化为占位文案（不会失败，但 Release 页会缺更新内容）。
   - 前端更新日志 `work/monitor/public/assets/js/changelog-data.js` 头部追加同版本、同日期的条目（桌面端点版本号徽章弹出的时间轴读它）。`scripts/changelog-sync.test.mjs` 会校验：它的每个版本都在 `CHANGELOG.md` 里且日期一致、两边按日期降序、首条版本等于 `package.json` 当前版本——漏了这一步 `npm test` 直接失败。
3. **本地过门禁再提交并合入 main**：
   ```bash
   npm test && npm run lint && npm run release-scan
   git add package.json package-lock.json CHANGELOG.md work/monitor/public/assets/js/changelog-data.js
   git commit -m "chore: bump v2.16.0"
   ```
4. **打 annotated tag 并推送**（tag 名必须与 `package.json` version 一致，否则流水线会主动 fail 提醒你漏 bump）：
   ```bash
   git tag -a v2.16.0 -m "v2.16.0"
   git push origin v2.16.0
   ```
5. **等流水线跑完**（约 10-15 分钟）。顺序：quality（test / lint / release-scan）→ **macOS**：构建 `.app`（ad-hoc 重签后 `codesign --verify` 不过即失败）→ 再验签并用 `scripts/hot-update/smoke.mjs` 以最终产物里的二进制起一次隔离的 monitor-server（fixture 模式、临时端口与数据目录，`/api/session` + `/api/status-lite` 均 200）→ 扫描包内 payload → 打 zip 与 dmg → 建 Release（新建时是**草稿**）→ **Windows**：`node scripts/build-windows-app.mjs --smoke --zip --installer`（下载并按 `electron/checksums.json` 校验 Windows 版 Electron → 组装 → 白名单 / 体积 / 语法 / 包内容扫描 → 用包里的 exe 做同样的隔离冒烟 → 便携 zip → Inno Setup 编译 Setup.exe）→ 上传到同一个 Release 并转为正式发布。任何一步失败都不会出现正式 Release（Windows 失败时 Release 留在草稿，修好后重跑 workflow）。产出的 Release 附带：
   - `CodexOperationsConsole-<version>-macos.dmg` / `.zip` —— ad-hoc 签名的 .app（dmg 打开后拖进「应用程序」）
   - `CodexOperationsConsole-<version>-windows-x64-setup.exe` —— Windows 安装器（按当前用户安装，不需要管理员）
   - `CodexOperationsConsole-<version>-windows-x64.zip` —— Windows 免安装版（解压即用）
   - 以上每个文件的 `.sha256`
   - `checksums-<version>.txt` —— .app 内所有运行文件（.mjs/.js + build-info.json）的 SHA-256 清单

   Release 正文 = CHANGELOG 对应小节 + 各安装包的 SHA-256。

**发给源码安装的同事：推进稳定版（v2.62 起）**：用 `git clone` 装的工作台跟的是一条「更新通道」，也就是安装目录所在的分支——安装器装出来的在稳定版（`stable`），每半小时查一次 `origin/stable`；手动 clone 的、以及 `stable` 分支建立之前装的在开发版（`main`），查的是 `origin/main`。那条分支上 `package.json` 的版本号比本机高就提示更新（点了才装，见 README「更新」）。所以：

- **推 main 不再等于发给同事。** 第 3 步合入并 `git push origin main` 之后，只有开发版的安装（发布方自己的，以及在 `stable` 建立之前装好、还没换通道的同事）最迟半小时看到新版本。同事都在稳定版上之后，可以连着发几个版本，自己先用着。
- **确认一个版本可以给同事了，再推进稳定版**：
  ```bash
  npm run release:promote -- --dry-run   # 只核对、列出同事会收到哪几个版本，不推送
  npm run release:promote                # 推进到 origin/main 现在的位置（问一句，回答 y 才推）
  npm run release:promote -- v2.62.0     # 只推进到某个标签 / 提交
  ```
  它先取远端的 main 与 stable（只读），再逐条核对，哪条不过就不推并说明：目标提交已经在 `origin/main` 上；目标是 `origin/stable` 现在位置的后代（只快进，稳定版不回头、不分叉）；目标的版本号比稳定版高（同事那边只看版本号，不高就不会提示任何人）；目标那个版本认识更新通道（v2.62.0 起）。核对通过后列出同事会收到的版本（取自那个提交的 `CHANGELOG.md` 小节标题），在终端里回答 `y` 才执行 `git push origin <提交>:refs/heads/stable`——普通的 push，没有强制推送和跳过确认的开关，本机没推过的标签不会跟着出去。推进之后，跟稳定版的同事最迟半小时看到提示。不需要打 tag，tag 只管 macOS 安装包。
- **第一次运行会创建 `stable` 分支。** 从那一刻起新装的同事默认进稳定版；在那之前已经装好的同事仍在开发版上，不会自己换过来，想换的人各自在安装目录执行 `npm run update -- --channel stable`（换回用 `--channel main`）。建 `stable` 之前，安装器与自更新的行为与以前相同。`stable` 只能指到 v2.62.0 或更新的提交上：更早的版本不认识更新通道、只认 main 分支，装在 `stable` 上就再也收不到更新——`release:promote` 会拒绝这样的目标，也不要用 `git push` 手动把 `stable` 放过去。
- 推 `stable` 不触发 CI：`test` 与 CodeQL 两条工作流的 push 触发只认 main，发布流水线只认 tag。
- 没改版本号的提交不会提示任何人，推进时也一样——`release:promote` 会拒绝版本号没有比稳定版高的目标。
- 同事一键更新前会在本机自检这个版本（隔离模式把监控服务起一遍），起不来的版本装不上去，但别指望它兜底：推进之前照常过门禁，并在自己的开发版上先用一用。
- 改了依赖（`package-lock.json` 里除根版本号以外的内容）的版本，同事那边不会一键更新，会提示在终端里 `git checkout -- package-lock.json && git pull --ff-only && npm install`——`release:promote` 发现这段区间改了依赖时会提醒一句，推进时提前跟同事说。
- 推进错了：稳定版只往前走，撤不回来——在 main 上发一个版本号更高的修正版，再推进一次。已经更新过去的同事可以 `npm run update -- --rollback` 回到上一版；回退之后他那边不再提示装被退掉的那个提交，等稳定版再往前推进才恢复提示。

发错了怎么办：删掉 Release 与 tag（`gh release delete vX.Y.Z` + `git push origin :refs/tags/vX.Y.Z`），修正后重新打 tag。对同一 tag 重跑 workflow 是幂等的（覆盖资产、更新 notes）。

---

## 二、v2.18 升级注意（从 v2.17 及更早版本上来）

v2.18 把腾讯云 / 阿里云两台**私有服务器从团队层 `config.json` 移到了个人层**（同事克隆仓库后不该看到、更不该去探测别人的机器）。因此升级有先后顺序：

**第 1 步（必须先做）：给个人层补上这两台机器。** 打包运行时读的是 `~/Library/Application Support/codex-tunnel-monitor/config.local.json`，开发模式读仓库根目录的 `config.local.json` —— 两个都用的话两个都要写。把下面的 `servers` 合并进去（现有的 `activeAgentId` / `activeServerId` / `sshUser` 等字段原样保留，不要覆盖整个文件）：

```json
{
  "activeAgentId": "codex",
  "activeServerId": "server-01",
  "servers": [
    { "id": "server-tengxun", "name": "腾讯云服务器 (tengxunserver)", "host": "tengxunserver",
      "remotePort": 7893, "localPort": 8890, "tunnel": true,
      "description": "腾讯云 AI 处理及外部边缘计算节点" },
    { "id": "server-aliyun", "name": "阿里云服务器 (vpn-aliyun)", "host": "vpn-aliyun",
      "remotePort": 7894, "localPort": 8891, "tunnel": true,
      "description": "阿里云 VPN 专线网络及代理转发节点" }
  ]
}
```

不想给这两台常驻隧道就把 `tunnel` 改成 `false`（只监控、不建 `ssh -R`、不占反向端口，卡片照常显示负载与 Agent 状态）。字段一览与逐条注释见仓库根目录的 `config.local.example.json`。

**第 2 步：再升级 .app / 拉新代码。** 顺序反了的话，新版本读到的合并配置里就没有这两台机器，它们会从控制台上消失（数据不会丢，补写个人层后下一拍就回来）。

**升级过程中现网隧道不会断。** v2.18 的进程注册表把隧道记录改名成了 `tunnel.<serverId>`，旧的单条 `tunnel` 记录不再被读取；升级前起的那条 `ssh -R` 仍占着远端端口，supervisor 新建隧道撞上 `remote port forwarding failed` 后按命令行签名把它作为孤儿隧道认领（日志事件 `tunnel-orphan-adopted`；需 L2 自动修复开启且不是 `observeOnly`），**不重建隧道**。验收时用 `ps` 核对 7891 那条 `ssh -R` 的 pid 与升级前一致即可，集群侧的 `reclaude` / `codex` 出网全程不中断。

**另外两处默认值变化**（都可在配置里改回）：本地 `runtime/` 目录现在有 50MB 总量预算，日志分卷从 3 份收紧到 1 份（个人层 `storageBudgetBytes` 可调）；L2 自动修复默认开启（个人层 `autoRepair.enabled: false` 关闭，或 `observeOnly: true` 先只观察不执行）。

---

## 三、同事：安装使用

### macOS（桌面 .app）

1. 到 [Releases 页面](https://github.com/xiuyangFeng/cluster-ops-console/releases) 下载最新的 `CodexOperationsConsole-<version>-macos.zip`。
2. **校验完整性**（和同页的 `.sha256` 文件比对，输出 `OK` 即通过）：
   ```bash
   shasum -a 256 -c CodexOperationsConsole-<version>-macos.zip.sha256
   ```
3. 解压后把 `Codex Operations Console.app` 放到 `/Applications` 或任意目录，双击运行。

**ad-hoc 签名的信任边界**：Release 里的 `.app` 只有本机构建机的 ad-hoc 签名，没有 Apple Developer ID，也没有公证。它只能证明「这份 zip 的 SHA-256 / GitHub artifact attestation 与本次 tag 工作流一致」，不能证明发布者已通过 Apple 身份校验，也不能阻止本机用户对未签名应用的 Gatekeeper 拦截。不要把 ad-hoc 签名理解成企业分发或已公证软件。

**首次打开的 Gatekeeper 提示**：.app 是 ad-hoc 签名（无 Apple 开发者证书、未公证），首次双击 macOS 可能提示"无法验证开发者"。处理办法：

- **右键（或按住 Control 点击）.app → 打开 → 在弹窗中再点"打开"**，之后就能正常双击启动；
- 若仍被拦，到 **系统设置 → 隐私与安全性** 底部点"仍要打开"；
- 从浏览器下载的 zip 会带隔离属性，也可用命令一次清除：`xattr -cr "/Applications/Codex Operations Console.app"`。
- 绝对不要点"移到废纸篓"。

首次启动后按控制台内「接入集群」引导完成个人 SSH 配置（密钥、专属端口、隧道、集群侧代理都在界面里自动完成）。

### Windows（桌面安装包）

1. 到 [Releases 页面](https://github.com/xiuyangFeng/cluster-ops-console/releases) 下载 `CodexOperationsConsole-<version>-windows-x64-setup.exe`。
2. 校验（可选）：PowerShell 里 `Get-FileHash .\CodexOperationsConsole-<version>-windows-x64-setup.exe -Algorithm SHA256`，与同页 `.sha256` 文件里的值比对。
3. 双击安装。默认装到 `%LOCALAPPDATA%\Programs\Codex Operations Console`，**不需要管理员**；开始菜单（可选桌面）出现「Codex Operations Console」。装完直接打开，按界面引导接入集群。

要求 Windows 10 1809 及以上（系统自带 OpenSSH 客户端；「设置 → 应用 → 可选功能」里能看到「OpenSSH 客户端」）。

- **SmartScreen 提示**：安装包没有代码签名证书，首次运行可能出现「Windows 已保护你的电脑」——点「更多信息 → 仍要运行」。它只说明发布者未经微软验证；文件完整性用上面的 SHA-256 核对。
- **个人数据位置**：`%APPDATA%\codex-tunnel-monitor`（个人配置 `config.local.json`、`runtime\` 日志与状态）。覆盖安装与卸载都不动它；彻底清除时卸载后手动删这个目录。
- **升级**：下载新版本的 Setup.exe 直接覆盖安装。工作台开着时安装器会提示关闭它（后台的隧道会跟着断开，装完重新打开即恢复）。安装版不走 git 自更新。
- **免安装版**：`…-windows-x64.zip` 解压到固定目录（避开「下载」和 OneDrive），双击 `Codex Operations Console.exe`。数据位置与安装版相同。
- **已知限制**：exe 文件本身的图标与「文件说明」仍是 Electron 默认值（开始菜单 / 桌面快捷方式、窗口与任务栏图标是工作台自己的）。

### Linux / 想跟着源码自动更新的 Windows 同事（网页模式）

不想用安装包、或想在页面里一键跟着发布方升级的，走 browser-first 网页控制台，功能完全一致：

```bash
git clone https://github.com/xiuyangFeng/cluster-ops-console.git
cd codex-tunnel-monitor
npm ci          # 默认跳过 Electron 二进制，很快
npm run setup   # 一键向导：只需填自己的集群 SSH 用户名
npm run start   # Windows 也可直接双击 start-console.cmd
```

启动后浏览器打开 `http://127.0.0.1:8877` 即是控制台。需要 Node.js 22.12+（推荐 24，`.nvmrc` 已写明）。

网页模式的最小权限：只用当前用户身份运行 Node，不要用管理员/root；监听地址保持 `127.0.0.1:8877`，不要对局域网或公网开放。系统防火墙应拒绝外部入站 8877。个人 SSH 用户名、私钥和密码只放本机个人配置或系统密钥串，不要放仓库 `config.json`。Windows 若开启专用网络配置文件，确认 8877 未添加到入站允许规则。

---

## 四、流水线细节（排障用）

- 触发条件：push 任意 `v*` tag；权限为 `contents: write` + 发布证明所需的 `id-token`/`attestations`；同 tag 并发去重。
- 构建链（macOS，job `release`）：先复用 `test.yml`（跨平台测试 + lint + `scripts/release-scan.mjs`）→ tag/version 一致性门禁 → `node scripts/install-electron-runtime.mjs`（CI 中显式验收 Electron.app 落盘）→ `bash scripts/build-macos-app.sh` → `ditto -c -k --keepParent` 打 zip、`hdiutil create` 打 dmg → SHA-256 + GitHub artifact attestation → 抽 CHANGELOG → `gh release create --draft`（已存在则覆盖资产、更新 notes）。
- 构建链（Windows，job `release-windows`，`needs: release`）：`npm ci --ignore-scripts` → `choco upgrade innosetup`（安装器脚本与随附的简体中文语言文件按 Inno Setup 6.5+ 写）→ `node scripts/build-windows-app.mjs --smoke --zip --installer` → attestation → `gh release upload --clobber`、notes 末尾补 Windows 产物的 SHA-256 → `gh release edit --draft=false`。
- Windows 安装包的组成：`scripts/build-windows-app.mjs`（与 macOS 同一份运行文件白名单）+ `scripts/windows-installer/codex-operations-console.iss`（Inno Setup 脚本）+ `scripts/windows-installer/ChineseSimplified.isl`（Inno Setup 官方仓库的简体中文语言文件）+ `scripts/assets/app-icon.ico`（由 `npx electron scripts/build-app-icon.mjs` 从 app-icon.svg 生成）。安装目录里 `resources\app` 的存在让运行时认出打包模式（`lib/runtime-paths.mjs` 的 `isPackagedApp`）：数据落 `%APPDATA%`、不走 git 自更新、登录项走 Electron（HKCU Run）。
- 本机打包：`npm run package:mac`（`scripts/package-macos.sh`：旁路构建 → 验签 → 冒烟 → 扫描 → `dist/macos/` 下的 dmg + zip）；`npm run package:windows`（`dist/windows/` 下的安装目录与便携 zip，macOS 上也能打；Setup.exe 要在装了 Inno Setup 的 Windows 上加 `--installer`，冒烟加 `--smoke`）。
- Electron 下载有 actions/cache 缓存（macOS `~/Library/Caches/electron`，Windows `~\AppData\Local\electron\Cache`），key 绑定 `package-lock.json`。
- 常见失败：
  - *tag 与 package.json version 不一致* —— 漏 bump，按第一节第 4 步的提示修正；
  - *Electron 运行时安装失败* —— 多为 GitHub 下载源瞬时故障，直接 re-run workflow；
  - *App size 超限* —— `build-macos-app.sh` 有 350 MB 硬上限门禁，`build-windows-app.mjs` 有 450 MB（解压后），Electron 大版本升级后需关注；
  - *ISCC 编译失败* —— 多为 runner 上的 Inno Setup 版本低于 6.5（语言文件里有新版才认的条目），看 `Install Inno Setup` 一步装上的版本；
  - *Release 停在草稿* —— macOS 已上传、Windows 那一步失败；修好后重跑 workflow（上传是 `--clobber`，幂等），最后一步会转为正式发布。
