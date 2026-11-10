# 集群运维工作台（Codex Operations Console）

在自己的电脑和一台 Linux 服务器（计算集群的登录节点、云主机都行）之间建一条 SSH 反向隧道，让服务器上的 Codex、Claude Code 这类 AI 命令行工具经由你电脑的网络访问它们的 API；同时把隧道、服务器负载、GPU、Slurm 作业、AI 用量放在一个桌面窗口里看，断了会自己修。

A desktop console that keeps an SSH reverse tunnel between your computer and a Linux server, so AI CLIs on the server (Codex, Claude Code, …) reach their APIs through your local network — plus monitoring for the tunnel, server load, GPUs, Slurm jobs and AI usage. The UI is in Simplified Chinese.

## 适合谁

- 服务器上不能直接访问外网 API，或直连不稳定，而你自己的电脑可以访问；
- 想在本机一眼看到：隧道通不通、服务器 CPU / 内存 / 磁盘 / GPU、自己的 Slurm 作业、Codex / Claude Code 今天用了多少；
- 一个课题组 / 团队共用一台服务器：每人各用一条隧道、一个端口，互不干扰（见「团队部署」）。

## 下载安装

到 [Releases](../../releases) 下载最新版本：

| 系统 | 文件 | 安装 |
| --- | --- | --- |
| macOS（Apple 芯片） | `CodexOperationsConsole-<版本>-macos.dmg` | 打开后把 App 拖进「应用程序」 |
| Windows 10 1809+（x64） | `CodexOperationsConsole-<版本>-windows-x64-setup.exe` | 双击安装，装到当前用户目录，不需要管理员 |
| Windows 免安装 | `CodexOperationsConsole-<版本>-windows-x64.zip` | 解压到固定目录，双击 `Codex Operations Console.exe` |
| Linux | — | 用源码运行（见下文「从源码运行」），网页模式 |

安装包目前**没有代码签名**，第一次打开时系统会拦一下：

- **macOS**：双击后提示「无法验证开发者」时，打开「系统设置 → 隐私与安全性」，在页面下方点「仍要打开」。也可以在终端执行一次 `xattr -dr com.apple.quarantine "/Applications/Codex Operations Console.app"`。
- **Windows**：SmartScreen 提示「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。

每个安装包旁边都有 `.sha256` 校验文件，并附 GitHub 构建来源证明（artifact attestation），可以核对下载的文件就是本仓库流水线构建的：`shasum -a 256 -c <文件>.sha256`（macOS）/ `certutil -hashfile <文件> SHA256`（Windows）。

**Windows 需要系统自带的 OpenSSH 客户端**（隧道和采集都靠它）。安装器会检查，缺了会提供一键安装（需要管理员确认一次）；也可以手动在「设置 → 系统 → 可选功能 → 添加功能」里装「OpenSSH 客户端」。WinSCP、PuTTY 自带的 SSH 不能代替它。

## 第一次使用

打开 App 后会进入「接入集群」引导，按页面填：

1. **服务器地址、SSH 端口、你的账号**；
2. **核对服务器指纹**（第一次连这台服务器时）；
3. **输入一次登录密码**：只用来把本机生成的专用公钥装到服务器上，用完即丢，不保存、不写日志。

选择「快速接入」时，验证 SSH 后即可进入工作台查看集群资源，工具通道、代理与 API Key 可以以后再配置。选择「完整接入」时，后续自动领取反向隧道端口、建立隧道、测试本机出网，并写好服务器上的代理环境变量，再继续安装和登录工具。

页面会动态说明当前正在做什么、为什么需要这一步、下一步点哪里。失败时按具体原因处理后点「重试」；中途关闭，下次可以从断点继续。密钥已存在、公钥已授权时会复用并验证，不需要反复安装。

**换一台电脑**：安装工作台，连上能够 SSH 访问集群的校园网、单位内网或 VPN，在「配置 → 换电脑 / 重新检测接入」中填写集群地址和自己的账号，用一次登录密码完成本机公钥授权，或使用已有的授权密钥。私钥留在各自电脑上，无需从旧电脑拷贝；服务器会保留旧电脑已有的公钥授权。也可先通过「备份与迁移」导入配置，再点击结果页的重检入口；配置文件不包含私钥和密码。同一网络本身不替代账号授权。

接入过程会改动这些地方（都可以在「配置 → 接入引导 → 撤销接入」里一键撤销）：

| 位置 | 改动 |
| --- | --- |
| 本机 `~/.ssh/id_ed25519_codextunnel` | 新生成一把专用密钥 |
| 本机 `~/.ssh/config` | 加一段带标记的 `Host myserver` |
| 服务器 `~/.ssh/authorized_keys` | 追加上面那把专用公钥 |
| 服务器 `~/.config/cluster-workbench/env.sh` | 完整接入模式下准备代理环境变量，并在 shell 启动文件里加一行带标记的引入 |
| 本机个人配置 | macOS `~/Library/Application Support/codex-tunnel-monitor/`，Windows `%APPDATA%\codex-tunnel-monitor\`；覆盖安装、卸载都不会动 |

**对服务器的要求**：Linux，开着 sshd，允许你的账号登录。快速接入无需端口转发；完整接入还需允许 SSH 端口转发（`AllowTcpForwarding no` 时工具通道建不起来）。不需要 root，不需要在服务器上装常驻服务。Slurm、NVIDIA GPU 有就显示，没有就不显示。

**root 管理入口**：用 `root` 账号接入后，侧栏自动显示「团队管理」（成员、用量与配置管理）和「存储管理」，无需另配 `adminUsers`。普通账号只有列入 `adminUsers` 才显示这两页。存储管理首次使用时在页面保存服务器与允许查看的目录，再按「接入步骤」配置专用受限密钥和只读扫描脚本；配置和脚本不会在登录时静默安装。

**多个服务器连接**：页面顶部点「添加连接」，分别保存 master、node04 等服务器的 IP、SSH 端口、账号和可选私钥路径。以后从「服务器连接」下拉框选择；各连接独立保存，切换不影响其它隧道。首次接入完成后也可点「再添加一个连接」。新增连接默认只监控，需要隧道时单独开启；每台服务器都要完成自己的 SSH 授权与主机指纹核对。

## 更新

Windows 安装版从 v2.95.0 起支持点击热更新：发现新版本后点「更新并重启界面」，自动下载小更新包、校验并隔离自检，备份后应用，只重启界面、保留后台隧道。个人配置、团队配置与数据保留；更新中断或新版本启动失败会恢复旧版。左上角版本号 →「检查更新」也可手动检查。

v2.94.1 等旧版需要先手动下载一次含此功能的完整安装包。Electron 底层运行时或固定更新引导变化时，以及 macOS 安装版，仍通过「下载安装包」覆盖安装。更新源是本公开仓库的正式 GitHub Release，需要本机能访问 GitHub；只推源码或 tag 不会触发安装版更新。

## 从源码运行

需要 Node.js 22.12 ～ 26.x（推荐 24）和 git：

```bash
git clone <本仓库地址>
cd codex-tunnel-monitor
npm start            # Windows 也可以双击 start-console.cmd
```

网页模式不需要 `npm install`，启动后浏览器打开 `http://127.0.0.1:8877`。macOS 上想要桌面窗口，再执行一次 `npm install`（装 Electron 运行时）。源码安装可以在页面里一键更新（`git pull`）。

开发相关：`npm test`（单元测试）、`npm run lint`、`npm run release-scan`（发布前的敏感信息扫描）。打包：`npm run package:mac`、`npm run package:windows`；推一个 `v*` tag 会由 GitHub Actions 构建两个平台的安装包并发布 Release（见 [docs/release.md](docs/release.md)）。架构说明见 [docs/architecture.md](docs/architecture.md)。

## 团队部署

多人共用一台服务器时，维护者可以在仓库根目录的 `config.json`（团队层）里预先写好服务器，再自己打包或让同事用源码安装：

```jsonc
{
  "servers": [{
    "id": "server-01", "name": "实验室集群", "host": "myserver",
    "sshHostName": "cluster.example.org",   // 预填地址：同事只需要填账号和密码
    "sshPort": 22, "localPort": 8888
  }],
  "portRegistry": { "dir": "/shared/agent-hub/ports", "required": true }, // 服务器上的共享端口登记目录，防止多人端口相撞
  "adminUsers": ["your-account"]                                       // 这些账号能看到「团队管理」页
}
```

每个人自己的账号、端口、额外的服务器写在个人层 `config.local.json`（字段说明见 [config.local.example.json](config.local.example.json)），不改团队层。

## 安全说明

- 密码只在把公钥装到服务器时用一次，不落盘；之后都走专用密钥。
- 反向隧道在服务器上只绑定 `127.0.0.1`，同一台服务器上的其他人连不到；本机代理默认只放行 443 端口，其它端口要你明确加进白名单。
- 本机保存的口令用系统提供的加密存储（Electron safeStorage：macOS 钥匙串、Windows DPAPI）；写到服务器上的 API Key 放在你自己的 `~/.config/cluster-workbench/keys/`（目录 700、文件 600）。
- 发现安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可

[MIT](LICENSE)
