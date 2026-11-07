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

之后的步骤自动完成：领取一个反向隧道端口、建立隧道、测试本机出网、在服务器上写好代理环境变量。某一步失败会停在那一步并说明原因，处理后点「重试」；中途关掉，下次打开从断点继续。走完后可以接着在页面里安装并登录 Codex / Claude Code（装在服务器上，本机不用装）。

接入过程会改动这些地方（都可以在「配置 → 接入引导 → 撤销接入」里一键撤销）：

| 位置 | 改动 |
| --- | --- |
| 本机 `~/.ssh/id_ed25519_codextunnel` | 新生成一把专用密钥 |
| 本机 `~/.ssh/config` | 加一段带标记的 `Host myserver` |
| 服务器 `~/.ssh/authorized_keys` | 追加上面那把专用公钥 |
| 服务器 `~/.config/cluster-workbench/env.sh` | 代理环境变量（`HTTPS_PROXY` 等指向你的隧道端口），并在 shell 启动文件里加一行带标记的引入 |
| 本机个人配置 | macOS `~/Library/Application Support/codex-tunnel-monitor/`，Windows `%APPDATA%\codex-tunnel-monitor\`；覆盖安装、卸载都不会动 |

**对服务器的要求**：Linux，开着 sshd，允许你的账号做 SSH 端口转发（大多数服务器默认允许；`AllowTcpForwarding no` 时隧道建不起来）。不需要 root，不需要在服务器上装任何常驻服务。Slurm、NVIDIA GPU 有就显示，没有就不显示。

## 更新

打包安装的版本不会自己替换文件：有新版本时界面里会提示，点进去到 Releases 下载新的安装包，覆盖安装即可，配置和数据保留。

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
