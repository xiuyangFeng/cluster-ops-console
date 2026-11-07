<# : batch portion
@echo off & setlocal DisableDelayedExpansion & chcp 65001 >nul 2>nul & set "CWB_INSTALLER_SELF=%~f0" & (if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" ("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([System.IO.File]::ReadAllText($env:CWB_INSTALLER_SELF, [System.Text.Encoding]::UTF8)))") else (powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([System.IO.File]::ReadAllText($env:CWB_INSTALLER_SELF, [System.Text.Encoding]::UTF8)))")) && ((if not defined CWB_INSTALL_NO_PAUSE pause) & exit /b 0) || ((if not defined CWB_INSTALL_NO_PAUSE pause) & exit /b 1)
Cluster Workbench one-step installer for Windows. Double-click to run.
cmd.exe parses only the two lines above; everything from the closing comment mark on is PowerShell.
The whole batch part is ONE physical line ending in "exit /b", on purpose: cmd re-opens the file and
seeks to a byte offset before every line it reads, and gets that offset wrong once the code page is
UTF-8 and the file was saved with LF line endings (it then "runs" fragments of the PowerShell text).
With everything chained on that line it never reads the file again. Keep these lines ASCII and free
of labels. The exit code is passed on with "&& (... exit /b 0) || (... exit /b 1)": a number written
out in full, because %ERRORLEVEL% on the same line is expanded before PowerShell has run, and a bare
"exit /b" after "call cmd /c exit N" came back as 0 on the Windows runner. The installer only ever
exits 0 or 1. The line hands the file to Windows PowerShell as UTF-8 text.
#>

# ============================================================================
# Cluster Workbench One-Step Installer for Windows (PowerShell 5.1+)
#
# CRITICAL CHINESE WINDOWS (CP936 / GBK) SAFETY INVARIANTS:
# 1. Keep the first 4096+ bytes of this file 100% pure ASCII (0x00..0x7F).
#    When a user downloads this file via GitHub web "Download raw file" (which
#    serves LF line endings instead of CRLF) and runs it on Chinese Windows 10/11
#    (where the default console code page is CP936/GBK), cmd.exe pre-reads the
#    first 4096-byte buffer while parsing line 1 ("<# : batch portion"). If any
#    UTF-8 multibyte sequence appears inside that initial 4096-byte buffer, the
#    CP936 DBCS lead-byte scanner miscounts byte offsets and swallows LF (0x0A) bytes
#    that immediately follow UTF-8 trailing bytes in 0x81..0xFE (such as U+3002),
#    causing SetFilePointer to jump past line 2 straight into the PowerShell body!
# 2. Every comment line in this file MUST end with an ASCII character (such as "#"
#    or ".") so that no UTF-8 trailing byte (0x81..0xFE) ever sits directly before
#    an LF (0x0A) byte.
# 3. Supports both git-clone installation and in-place ZIP archive installation
#    (when extracted from GitHub "Download ZIP" without a .git directory).
#
# Environment variables:
#   CWB_INSTALL_DIR          Target install directory (default: %USERPROFILE%\cluster-workbench,
#                            or the extracted archive root when run from <dir>\install\install-workbench.cmd)
#   CWB_REPO_URL             Git repository URL (https / ssh / local path)
#   CWB_INSTALL_NO_LAUNCH=1  Do not launch the console after installation
#   CWB_INSTALL_NO_PAUSE=1   Do not pause at exit (for automated tests and scripts)
#   CWB_DESKTOP_DIR          Desktop directory path override
#   CWB_NODE_DIST_BASE / CWB_NODE_DIST_MIRROR / CWB_NODE_SHA256
#                            Node distribution URLs and expected SHA-256 override for testing.
#
# PowerShell 5.1 compatibility rules:
#   - No curly quotes or em-dashes in source text.
#   - Never place Chinese characters immediately after a $variable name; use -f formatting.
#   - Never set $ErrorActionPreference = 'Stop' globally (stderr from native tools would throw).
# ============================================================================

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$DefaultRepoUrl = 'https://github.com/xiuyangFeng/cluster-ops-console.git'
# Stable branch name: must match work/monitor/lib/self-update/channel.mjs and install-workbench.sh.
$StableBranch = 'stable'
# Repository package.json name used to identify a valid Cluster Workbench directory.
$PackageName = 'codex-tunnel-monitor'
# Marker written to the shortcut Description field so we only overwrite our own shortcut.
$ShortcutMarker = 'cluster-workbench-installer'

# Pinned private Node.js version and official SHA-256 checksums from:
# https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
# (https://npmmirror.com/mirrors/node/v24.21.0/SHASUMS256.txt is byte-for-byte identical).
# Update together with install-workbench.sh when bumping NodeVersion.
$NodeVersion = '24.21.0'
$NodeSha256 = @{
  'win-x64'   = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
  'win-arm64' = '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921'
}

# Node version gate: must match package.json engines (>=22.12.0 <27), start.sh, and start-console.cmd.
$NodeMinMajor = 22
$NodeMinMinor = 12
$NodeMaxMajor = 27

$State = @{ Step = 0; StepTotal = 6; InstallKind = ''; NodeKind = ''; NodeStage = ''; TempDir = ''; ShortcutPath = '' }

# Console UTF-8 output setup (works both in interactive console and redirected test streams).
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $Utf8NoBom } catch { }
$OutputEncoding = $Utf8NoBom
$RedirectedOut = $null
try {
  if ([Console]::IsOutputRedirected) {
    $RedirectedOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $Utf8NoBom)
    $RedirectedOut.AutoFlush = $true
  }
} catch { $RedirectedOut = $null }

function Say([string]$Text = '') {
  if ($RedirectedOut) { $RedirectedOut.WriteLine($Text) } else { Write-Host $Text }
}
function SayNote([string]$Text) { Say ('  ' + $Text) }
function SayOk([string]$Text) { Say ('  [OK] ' + $Text) }
function SayWarn([string]$Text) { Say ('  [!] ' + $Text) }
function SayStep([string]$Title) {
  $State.Step = $State.Step + 1
  Say ''
  Say ('[{0}/{1}] {2}' -f $State.Step, $State.StepTotal, $Title)
}

function Remove-DirWithRetry([string]$Dir) {
  if (-not $Dir) { return }
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    Start-Sleep -Milliseconds 300
  }
}

function Remove-WorkDirs {
  Remove-DirWithRetry $State.NodeStage
  Remove-DirWithRetry $State.TempDir
  $State.NodeStage = ''
  $State.TempDir = ''
}

function Stop-Install([string]$What, [string[]]$Next = @()) {
  Say ''
  Say ('[X] ' + $What)
  foreach ($line in $Next) { Say ('    ' + $line) }
  Remove-WorkDirs
  exit 1
}

function Get-EnvOrDefault([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function Hide-UrlCredentials([string]$Url) {
  return [regex]::Replace($Url, '(://)[^/@]*@', '$1')
}

function Test-Interactive {
  try { return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) } catch { return $false }
}

# Detect Windows system proxy (HKCU Internet Settings) when user is on campus network with a proxy/VPN tool
# (e.g. Clash / v2rayN) that sets the Windows system proxy but does not export HTTP_PROXY to cmd/git.
function Get-WindowsSystemProxy {
  foreach ($name in @('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { return '' }
  }
  $raw = ''
  try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($reg -and ($reg.ProxyEnable -eq 1)) { $raw = [string]$reg.ProxyServer }
  } catch { $raw = '' }
  # Second source: the WinHTTP proxy set with "netsh winhttp set proxy" (some campus / VPN tools
  # only set this one and leave Internet Settings empty). Get-WinHttpProxy never throws.
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = Get-WinHttpProxy }
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
  $raw = $raw.Trim()
  if ($raw -match '(?:^|;)\s*https?=([^;\s]+)') { $raw = $Matches[1] }
  elseif ($raw.Contains(';')) { $raw = ($raw -split ';')[0].Trim() }
  if ($raw -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $raw = 'http://' + $raw }
  if ($raw -match '^https?://[^\s/]+:\d+$') { return $raw }
  return ''
}

# Read the proxy from "netsh winhttp show proxy" as a second source. That output is localized, so the
# parse just looks for a host:port token; when nothing matches (direct access, netsh missing, no
# rights) it returns an empty string and the caller silently carries on.
function Get-WinHttpProxy {
  try {
    if (-not $env:SystemRoot) { return '' }
    $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
    if (-not (Test-Path -LiteralPath $netsh)) { return '' }
    foreach ($line in @(& $netsh winhttp show proxy 2>$null)) {
      if ([string]$line -match '((?:https?://)?[A-Za-z0-9][A-Za-z0-9.\-]*:[0-9]{2,5})') { return $Matches[1] }
    }
  } catch { }
  return ''
}

# True when Windows is told to fetch its proxy settings from a PAC script (AutoConfigURL). git does
# not understand PAC, so a "working" system proxy can still leave git without any proxy.
function Test-WindowsPacProxy {
  try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if (-not $reg) { return $false }
    return (-not [string]::IsNullOrWhiteSpace([string]$reg.AutoConfigURL))
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Step 1: Install directory classification (absent | empty | workbench | workbench-archive | other)
# ---------------------------------------------------------------------------
function Get-InstallDirKind([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir)) { return 'absent' }
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return 'other' }
  $entries = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($entries.Count -eq 0) { return 'empty' }
  $packageJson = Join-Path $Dir 'package.json'
  $hasGit = Test-Path -LiteralPath (Join-Path $Dir '.git')
  $hasLauncher = Test-Path -LiteralPath (Join-Path $Dir 'scripts\launch.mjs')
  if ($hasLauncher -and (Test-Path -LiteralPath $packageJson)) {
    try {
      $text = [System.IO.File]::ReadAllText($packageJson)
      $pattern = '"name"\s*:\s*"' + [regex]::Escape($PackageName) + '"'
      if ($text -match $pattern) {
        if ($hasGit) { return 'workbench' }
        return 'workbench-archive'
      }
    } catch { }
  }
  return 'other'
}

function Get-WorkbenchVersion {
  try {
    $text = [System.IO.File]::ReadAllText((Join-Path $InstallDir 'package.json'))
    if ($text -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  } catch { }
  return '?'
}

# When the user downloads the repository ZIP and double-clicks install\install-workbench.cmd inside the
# extracted folder (without setting CWB_INSTALL_DIR), install in-place instead of cloning again.
function Resolve-DefaultInstallDir {
  $explicit = [Environment]::GetEnvironmentVariable('CWB_INSTALL_DIR')
  if (-not [string]::IsNullOrWhiteSpace($explicit)) { return $explicit.Trim() }
  $selfPath = $env:CWB_INSTALLER_SELF
  if (-not [string]::IsNullOrWhiteSpace($selfPath) -and (Test-Path -LiteralPath $selfPath)) {
    try {
      $selfDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($selfPath))
      if ((Split-Path -Leaf $selfDir) -ieq 'install') {
        $parentRoot = Split-Path -Parent $selfDir
        $kind = Get-InstallDirKind $parentRoot
        if ($kind -eq 'workbench-archive' -or $kind -eq 'workbench') {
          return $parentRoot
        }
      }
    } catch { }
  }
  return (Join-Path $env:USERPROFILE 'cluster-workbench')
}

$ShortcutName = '集群运维工作台.lnk'

function Confirm-InstallDir {
  SayStep '检查安装位置'
  SayNote $InstallDir
  $State.InstallKind = Get-InstallDirKind $InstallDir
  if ($State.InstallKind -eq 'absent') { SayOk '目录还不存在，稍后新建。'; return }
  if ($State.InstallKind -eq 'empty') { SayOk '目录是空的，直接装在里面。'; return }
  if ($State.InstallKind -eq 'workbench') {
    SayOk ('这里已经装过工作台（v{0}），这次只更新到最新版本。' -f (Get-WorkbenchVersion))
    return
  }
  if ($State.InstallKind -eq 'workbench-archive') {
    SayOk ('这里是已解压的工作台目录（v{0}），直接在此位置配置运行环境。' -f (Get-WorkbenchVersion))
    return
  }
  Stop-Install ('这个位置已经有别的东西，不是集群运维工作台：{0}' -f $InstallDir) @(
    '安装器不会删除或覆盖它，什么都没有改动。',
    '换一个安装目录：在「命令提示符」里先执行  set CWB_INSTALL_DIR=D:\cluster-workbench  ，再把安装器拖进那个窗口回车。',
    '如果它是上次没装完留下的，自己确认后删掉这个目录，再重新双击安装器。'
  )
}

# ---------------------------------------------------------------------------
# Step 2 & 3: OpenSSH client and git.
# ---------------------------------------------------------------------------
function Confirm-Ssh {
  SayStep '检查 OpenSSH 客户端'
  $missing = @()
  foreach ($tool in @('ssh', 'ssh-keygen', 'ssh-keyscan')) {
    $found = Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { $missing += $tool }
  }
  if ($missing.Count -gt 0) {
    Stop-Install ('缺少 OpenSSH 客户端：{0}（工作台靠它们连接集群）。' -f ($missing -join '、')) @(
      '它是 Windows 自带的可选功能，启用需要管理员权限：',
      '  Windows 11：设置 → 系统 → 可选功能 → 查看功能 → 搜索「OpenSSH 客户端」→ 安装',
      '  Windows 10：设置 → 应用 → 可选功能 → 添加功能 → 勾选「OpenSSH 客户端」→ 安装',
      '  或者右键开始按钮 →「终端（管理员）」，执行：Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
      '装好后关闭本窗口，重新双击安装器。已经装过却仍然报这个错，重启电脑后再试。'
    )
  }
  SayOk 'ssh、ssh-keygen、ssh-keyscan 都在。'
}

function Find-Git {
  $command = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Path }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Git\cmd\git.exe') }
  if ($env:ProgramW6432) { $candidates += (Join-Path $env:ProgramW6432 'Git\cmd\git.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe') }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      # Add newly installed Git to current process PATH without modifying system settings.
      $env:PATH = (Split-Path -Parent $candidate) + ';' + $env:PATH
      return $candidate
    }
  }
  return $null
}

function Confirm-Git {
  SayStep '检查 git'
  $git = Find-Git
  if (-not $git) {
    if ($State.InstallKind -eq 'workbench-archive') {
      SayOk '当前使用已解压的工作台压缩包，无需安装 git 即可直接运行。'
      return
    }
    $winget = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
      Stop-Install '没有找到 git，这台电脑上也没有 winget，无法自动安装。' @(
        '打开 https://git-scm.com/download/win 下载 Git for Windows 安装包，一路点「Next」装完。',
        '（或者在 GitHub 仓库页面点击 Code -> Download ZIP 下载压缩包，解压后直接双击里面的 start-console.cmd。）',
        '装好后关闭本窗口，重新双击安装器。'
      )
    }
    SayNote '没有找到 git，正在用 winget 安装 Git for Windows。'
    SayNote '系统可能弹出「是否允许此应用更改你的设备」，点「是」。'
    & $winget.Path install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements | Out-Host
    $git = Find-Git
    if (-not $git) {
      Stop-Install 'winget 运行完了，但这个窗口里还是找不到 git。' @(
        '如果上面显示安装成功：关闭本窗口，重新双击安装器即可。',
        '如果安装失败：打开 https://git-scm.com/download/win 下载安装包，一路点「Next」装完，再重新双击安装器。'
      )
    }
  }
  $version = [string](& git --version 2>$null | Select-Object -First 1)
  SayOk $version
}

# ---------------------------------------------------------------------------
# Step 3.5: Environment preflight (system version / CPU architecture / free disk / install location).
# These checks only add information: when Windows will not tell us a value, we say so and keep going,
# so a probe that fails can never sink an installation that used to work.
# ---------------------------------------------------------------------------
# Windows version from two sources: [Environment]::OSVersion and the registry. Only the registry
# build number counts as "confirmed", because a process without the right manifest can get an old
# (6.x) version from .NET even on Windows 10.
function Get-SystemBuildInfo {
  $info = @{ Build = 0; Major = 0; Name = ''; Confirmed = $false }
  try {
    $version = [Environment]::OSVersion.Version
    $info.Major = [int]$version.Major
    $info.Build = [int]$version.Build
  } catch { }
  try {
    $reg = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    if ($reg) {
      $majorText = [string]$reg.CurrentMajorVersionNumber
      $buildText = [string]$reg.CurrentBuildNumber
      if ($majorText -match '^\d+$') { $info.Major = [int]$majorText }
      if ($buildText -match '^\d+$') {
        $info.Build = [int]$buildText
        $info.Confirmed = $true
      }
      if ($reg.ProductName) { $info.Name = [string]$reg.ProductName }
    }
  } catch { }
  return $info
}

function Get-SystemArchitecture {
  $raw = $env:PROCESSOR_ARCHITEW6432
  if (-not $raw) { $raw = $env:PROCESSOR_ARCHITECTURE }
  return [string]$raw
}

# Free space (MB) of the drive that holds $Dir. Returns -1 when it cannot be determined (UNC share,
# drive not ready, path unreadable): the caller then skips the check instead of guessing.
function Get-FreeSpaceMb([string]$Dir) {
  try {
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Dir))
    if ([string]::IsNullOrWhiteSpace($root)) { return -1 }
    $drive = New-Object System.IO.DriveInfo -ArgumentList $root
    if (-not $drive.IsReady) { return -1 }
    return [int][math]::Floor($drive.AvailableFreeSpace / 1MB)
  } catch {
    return -1
  }
}

# Gate: Node.js 22 and later have no build for Windows 10 before 1809 (build 17763) and none at all
# for 32-bit Windows. Without this, such a machine only fails much later with the misleading
# "the downloaded Node.js does not run on this computer" message.
function Confirm-SystemSupport {
  $arch = Get-SystemArchitecture
  if ($arch -and ($arch -ne 'AMD64') -and ($arch -ne 'ARM64')) {
    Stop-Install ('这台电脑的 CPU 架构是 {0}：32 位 Windows 没有对应的 Node.js 预编译包。' -f $arch) @(
      'Node.js 23 起不再提供 32 位 Windows 版本（工作台随包安装的就是 64 位版），自己去 https://nodejs.org 下载 32 位版也只能停在 Node.js 22。',
      '请换一台 64 位 Windows 10 1809 及以上、或 Windows 11 的电脑，再重新双击安装器。'
    )
  }
  $info = Get-SystemBuildInfo
  $major = [int]$info.Major
  $build = [int]$info.Build
  if ($build -le 0) {
    SayNote '读不到这台电脑的 Windows 版本号，无法预检系统版本（不影响安装，继续）。'
    return
  }
  if ($build -ge 17763) {
    if ($info.Name) {
      SayOk ('系统版本可用：{0}（版本号 {1}）' -f $info.Name, $build)
    } else {
      SayOk ('系统版本可用（版本号 {0}）' -f $build)
    }
    return
  }
  # build < 17763 covers Windows 7 (7601), 8 / 8.1 (9200 / 9600) and Windows 10 before 1809.
  if (-not $info.Confirmed) {
    SayNote ('读到的版本号是 {0}，但读不到注册表里的确认信息，无法判断系统是否太旧（按继续处理）。' -f $build)
    return
  }
  $next = @()
  if ($info.Name) { $next += ('当前系统：{0}（版本号 {1}）' -f $info.Name, $build) }
  if ($major -ge 10) {
    $headline = '这台电脑的 Windows 10 太旧（版本号 {0}），装不了工作台。' -f $build
  } else {
    $headline = '这台电脑还不是 Windows 10（版本号 {0}），装不了工作台。' -f $build
  }
  $next += 'Node.js 22 起只支持 Windows 10 1809（版本号 17763）及以上：自己去 https://nodejs.org 装 Node.js 也起不来。'
  $next += '请换一台电脑（Windows 10 1809 及以上，或 Windows 11），或者先把系统升级到 1809 及以上。'
  $next += '升级或换机之后，重新双击安装器即可。'
  Stop-Install $headline $next
}

function Confirm-DiskSpace {
  $freeMb = Get-FreeSpaceMb $InstallDir
  if ($freeMb -lt 0) { return }
  if ($freeMb -ge 1024) { return }
  Stop-Install ('安装目录所在的磁盘只剩约 {0} MB 可用空间，不够装下工作台。' -f $freeMb) @(
    '装这一步需要约 1 GB 空闲空间：Node.js 压缩包约 38 MB，解压后约 100 MB，再加上仓库文件和运行日志。',
    '请先清理磁盘，或者把安装目录换到空间充足的分区，例如：',
    '在「命令提示符」里先执行  set CWB_INSTALL_DIR=D:\cluster-workbench  ，再把安装器拖进那个窗口回车。'
  )
}

# Warning only (never stops the install): Downloads is auto-cleaned by Storage Sense / Disk Cleanup,
# and OneDrive may turn node.exe into an online-only placeholder file.
function Confirm-InstallLocation {
  $path = $InstallDir.Replace('/', '\').ToLowerInvariant()
  $downloads = ''
  if ($env:USERPROFILE) { $downloads = (Join-Path $env:USERPROFILE 'Downloads').Replace('/', '\').ToLowerInvariant() }
  $inDownloads = $false
  if ($downloads -and (($path -eq $downloads) -or $path.StartsWith($downloads + '\'))) { $inDownloads = $true }
  $inOneDrive = $path.Contains('onedrive')
  $reasons = @()
  if ($inDownloads) { $reasons += '「下载」文件夹（Downloads）' }
  if ($inOneDrive) { $reasons += 'OneDrive 同步文件夹' }
  if ($reasons.Count -eq 0) { return }
  SayWarn ('安装目录落在{0}，建议换个位置：' -f ($reasons -join '、'))
  if ($inDownloads) {
    SayNote 'Windows 的「存储感知 / 磁盘清理」会自动删掉「下载」文件夹里很久不用的文件，安装目录哪天可能整个消失。'
  }
  if ($inOneDrive) {
    SayNote 'OneDrive 会把文件变成「按需下载」的在线占位文件：node.exe 一旦成了占位文件，工作台就启动不了。'
  }
  SayNote '建议把工作台装在固定的本地目录，例如 C:\cluster-workbench。'
  SayNote '在「命令提示符」里先执行  set CWB_INSTALL_DIR=C:\cluster-workbench  ，再把安装器拖进那个窗口回车。'
}

function Show-FirstRunNotice {
  SayNote '中文 Windows 第一次运行从网上下载的 .cmd 会弹出蓝色窗口「Windows 已保护你的电脑」：点「更多信息」，再点「仍要运行」。'
  SayNote '360 / 火绒等安全软件若提示拦截「下载并执行脚本」，选择「允许」，安装才能继续。'
}

# A PAC script (AutoConfigURL) is invisible to git, so the "system proxy" advice printed for network
# failures does not help: spell out the manual HTTPS_PROXY / git config commands instead.
function Show-PacProxyHint {
  if (Get-WindowsSystemProxy) { return }
  if (-not (Test-WindowsPacProxy)) { return }
  SayNote '这台电脑的系统代理用的是 PAC 自动配置脚本（AutoConfigURL）：git 不认 PAC，下载工作台时不会走代理。'
  SayNote '在「命令提示符」里先执行下面两行（地址换成代理软件里显示的地址和端口），再把安装器拖进那个窗口回车：'
  SayNote '  set HTTPS_PROXY=http://127.0.0.1:7890'
  SayNote '  set HTTP_PROXY=http://127.0.0.1:7890'
  SayNote '也可以让 git 以后都用这个代理：git config --global http.proxy http://127.0.0.1:7890'
}

# ---------------------------------------------------------------------------
# Step 4: Node.js preparation.
# ---------------------------------------------------------------------------
function Get-NodeVersionText([string]$Exe) {
  try { return [string](& $Exe --version 2>$null | Select-Object -First 1) } catch { return '' }
}

# Returns $true when Node version is within the supported engine range.
function Test-NodeSupported([string]$Exe) {
  $text = Get-NodeVersionText $Exe
  if ($text -notmatch '^v(\d+)\.(\d+)\.') { return $false }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -gt $NodeMinMajor -and $major -lt $NodeMaxMajor) { return $true }
  return ($major -eq $NodeMinMajor -and $minor -ge $NodeMinMinor)
}

# Abort slow transfers (< 10 KB/s for 30s) so caller can switch to the mirror.
function Get-RemoteFile([string]$Url, [string]$Destination) {
  $curl = $null
  if ($env:SystemRoot) { $curl = Join-Path $env:SystemRoot 'System32\curl.exe' }
  if ($curl -and (Test-Path -LiteralPath $curl)) {
    $progress = '--progress-bar'
    try { if ([Console]::IsErrorRedirected) { $progress = '-sS' } } catch { $progress = '-sS' }
    & $curl -fL $progress --connect-timeout 15 --retry 1 --speed-limit 10240 --speed-time 30 -o $Destination $Url | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Compute lowercase SHA-256 hex directly via .NET (avoids Get-FileHash PS7/PS5.1 module conflict).
function Get-Sha256Hex([string]$Path) {
  $sha = $null
  $stream = $null
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } catch {
    return ''
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($sha) { $sha.Dispose() }
  }
}

function Install-PrivateNode {
  $rawArch = $env:PROCESSOR_ARCHITEW6432
  if (-not $rawArch) { $rawArch = $env:PROCESSOR_ARCHITECTURE }
  $arch = ''
  if ($rawArch -eq 'AMD64') { $arch = 'x64' } elseif ($rawArch -eq 'ARM64') { $arch = 'arm64' }
  $platform = 'win-' + $arch
  $expected = $NodeSha256[$platform]
  if (-not $arch -or -not $expected) {
    Stop-Install ('这台电脑（{0}）没有对应的 Node.js 预编译包。' -f $rawArch) @(
      '请自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24 LTS）：https://nodejs.org',
      '装好后重新双击安装器。'
    )
  }
  $expected = (Get-EnvOrDefault 'CWB_NODE_SHA256' $expected).ToLowerInvariant()
  $file = 'node-v{0}-{1}.zip' -f $NodeVersion, $platform
  try {
    New-Item -ItemType Directory -Force -Path $PrivateRoot -ErrorAction Stop | Out-Null
    $stage = Join-Path $PrivateRoot ('node-staging.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $stage -ErrorAction Stop | Out-Null
  } catch {
    Stop-Install ('建不了目录：{0}' -f $PrivateRoot) @(('原因：{0}' -f $_.Exception.Message))
  }
  $State.NodeStage = $stage
  $zip = Join-Path $stage $file
  $verified = $false
  # Try official dist first, then domestic mirror; both verify against the pinned SHA-256.
  foreach ($base in @($NodeDistBase, $NodeDistMirror)) {
    $url = '{0}/v{1}/{2}' -f $base.TrimEnd('/'), $NodeVersion, $file
    SayNote ('正在下载（约 38 MB）：{0}' -f $url)
    if (-not (Get-RemoteFile $url $zip)) {
      SayWarn '这个地址没有下载下来。'
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      continue
    }
    $actual = Get-Sha256Hex $zip
    if ($actual -and ($actual -eq $expected)) {
      $verified = $true
      break
    }
    SayWarn ('下载到的文件校验值不对，已丢弃（期望 {0}，实际 {1}）。' -f $expected, $actual)
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  }
  if (-not $verified) {
    Stop-Install 'Node.js 没有下载成功，什么都没有安装。' @(
      '官方站和国内镜像两个地址都试过了：要么连不上，要么文件校验不通过。',
      '检查网络后重新双击安装器。',
      '也可以自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24 LTS，https://nodejs.org）后再运行。'
    )
  }
  SayOk '校验通过（SHA-256 与安装器里记录的一致）。'
  $unpacked = Join-Path $stage 'unpacked'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
  } catch {
    Stop-Install '解压 Node.js 失败。' @(('原因：{0}' -f $_.Exception.Message), '多半是磁盘空间不够：清理后重新双击安装器。')
  }
  # Archive contains a single top-level node-v<version>-<platform> directory with node.exe inside.
  $inner = Join-Path $unpacked ('node-v{0}-{1}' -f $NodeVersion, $platform)
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) {
    $first = Get-ChildItem -LiteralPath $unpacked -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($first) { $inner = $first.FullName }
  }
  if (-not (Test-NodeSupported (Join-Path $inner 'node.exe'))) {
    Stop-Install '下载的 Node.js 在这台电脑上运行不起来。' @(
      '请自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24 LTS）：https://nodejs.org',
      '装好后重新双击安装器。'
    )
  }
  # Move old private Node aside into staging dir and swap new one in (retry if antivirus locks node.exe briefly).
  $moveError = ''
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      if (Test-Path -LiteralPath $PrivateNodeDir) {
        Move-Item -LiteralPath $PrivateNodeDir -Destination (Join-Path $stage ('replaced-' + $attempt)) -ErrorAction Stop
      }
      Move-Item -LiteralPath $inner -Destination $PrivateNodeDir -ErrorAction Stop
      $moveError = ''
      break
    } catch {
      $moveError = [string]$_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  }
  if ($moveError) {
    Stop-Install ('没能把 Node.js 放到 {0}。' -f $PrivateNodeDir) @(
      ('原因：{0}' -f $moveError),
      '如果工作台正开着，先关掉它的窗口，再重新双击安装器。'
    )
  }
  Remove-DirWithRetry $stage
  $State.NodeStage = ''
  $State.NodeKind = 'private'
  SayOk ('私有 Node.js {0} 已就绪：{1}' -f (Get-NodeVersionText $PrivateNodeExe), $PrivateNodeDir)
}

function Confirm-Node {
  SayStep '准备 Node.js'
  $systemVersion = ''
  $system = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($system) {
    if (Test-NodeSupported $system.Path) {
      $State.NodeKind = 'system'
      SayOk ('系统已有 Node.js {0}，直接使用。' -f (Get-NodeVersionText $system.Path))
      return
    }
    $systemVersion = Get-NodeVersionText $system.Path
  }
  if ((Test-Path -LiteralPath $PrivateNodeExe) -and (Test-NodeSupported $PrivateNodeExe)) {
    $State.NodeKind = 'private'
    SayOk ('上次装好的私有 Node.js {0} 还在，直接使用：{1}' -f (Get-NodeVersionText $PrivateNodeExe), $PrivateNodeDir)
    return
  }
  if ($systemVersion) {
    SayNote ('系统的 Node.js {0} 不在支持范围内（需要 22.12 及以上、低于 27）。' -f $systemVersion)
  } else {
    SayNote '系统里没有 Node.js。'
  }
  SayNote ('下载一份只给工作台用的 Node.js v{0}，放在 {1}。' -f $NodeVersion, $PrivateNodeDir)
  SayNote '不需要管理员权限，不改系统的 Node 和 PATH。'
  Install-PrivateNode
}

# ---------------------------------------------------------------------------
# Step 5: Clone (git clone), update (git pull --ff-only), or use extracted archive.
# ---------------------------------------------------------------------------
# Returns @{ Code; Text } with LC_ALL=C so Show-GitFailure can match English git messages.
function Invoke-GitCaptured([string[]]$GitArguments) {
  $savedLcAll = $env:LC_ALL
  $savedLang = $env:LANG
  $env:LC_ALL = 'C'
  $env:LANG = 'C'
  $lines = @()
  $code = 1
  try {
    $lines = @(& git @GitArguments 2>&1 | ForEach-Object { $text = [string]$_; Say ('    ' + $text); $text })
    $code = $LASTEXITCODE
    $joined = ($lines -join "`n")
    $netErr = "Could not resolve host|Failed to connect|Couldn't connect|Connection (refused|reset|timed out)|unable to access|Network is unreachable|Operation timed out|SSL|TLS|early EOF|RPC failed"
    if (($code -ne 0) -and ($joined -match $netErr) -and ($RepoUrl -match '^https?://')) {
      $sysProxy = Get-WindowsSystemProxy
      if ($sysProxy) {
        SayNote ('检测到 Windows 系统代理（{0}），正在通过系统代理自动重试...' -f $sysProxy)
        $proxyArgs = @('-c', ('http.proxy=' + $sysProxy), '-c', ('https.proxy=' + $sysProxy)) + $GitArguments
        $lines = @(& git @proxyArgs 2>&1 | ForEach-Object { $text = [string]$_; Say ('    ' + $text); $text })
        $code = $LASTEXITCODE
      }
    }
  } catch {
    $lines = @([string]$_.Exception.Message)
    $code = 1
  } finally {
    $env:LC_ALL = $savedLcAll
    $env:LANG = $savedLang
  }
  return @{ Code = $code; Text = ($lines -join "`n") }
}

# Diagnose git failure and print actionable next steps.
function Show-GitFailure([string]$Text) {
  $authPattern = 'Authentication failed|could not read Username|terminal prompts disabled|Invalid username or (password|token)|Repository not found|returned error: 40[134]|HTTP 40[134]|Permission denied \(publickey'
  $networkPattern = "Could not resolve host|Failed to connect|Couldn't connect|Connection (refused|reset|timed out)|unable to access|Network is unreachable|Operation timed out|SSL|TLS|early EOF|RPC failed"
  Say ''
  if ($Text -match $authPattern) {
    Say '[X] 没有权限下载工作台仓库（它是私有仓库）。'
    if ($RepoUrl -match '^(ssh://|git@)') {
      SayNote '这个地址走 SSH：确认这台电脑的 SSH 公钥已经加到你在代码托管网站的账号里，并且账号有这个仓库的权限。'
    } elseif ($RepoUrl -match 'github\.com[:/]') {
      SayNote '1) 确认维护者已经把你的 GitHub 账号加为仓库协作者，并且你接受了邀请'
      SayNote '   （邀请邮件里点「Accept invitation」，或打开 https://github.com/notifications）。'
      SayNote '2) 重试时 Git 会弹出登录窗口（Git Credential Manager）：点「Sign in with your browser」，'
      SayNote '   在浏览器里登录被邀请的那个 GitHub 账号。窗口可能藏在别的窗口后面，看一下任务栏。'
      SayNote '3) 以前在这台电脑上登录过别的 GitHub 账号：打开「控制面板 → 凭据管理器 → Windows 凭据」，'
      SayNote '   删掉 git:https://github.com 那一条，再重试。'
      SayNote '4) 若命令行始终不便登录：也可直接在浏览器打开仓库主页点 Code -> Download ZIP 下载压缩包，'
      SayNote '   完整解压后直接双击里面的 start-console.cmd 即可使用。'
    } else {
      SayNote ('请确认你有权限访问：{0}' -f (Hide-UrlCredentials $RepoUrl))
    }
    return
  }
  if ($Text -match $networkPattern) {
    Say '[X] 连不上仓库所在的服务器。'
    SayNote '检查网络；靠代理/梯子上网的话，确认代理软件已开启「系统代理」或「TUN 模式」，然后重试。'
    Show-PacProxyHint
    SayNote '（或者直接在已登录 GitHub 的浏览器里点 Code -> Download ZIP 下载压缩包，解压后双击 start-console.cmd。）'
    return
  }
  Say '[X] 下载工作台没有成功，git 的报错见上面几行。'
  SayNote ('仓库地址：{0}' -f (Hide-UrlCredentials $RepoUrl))
}

# Switch newly cloned repo to origin/stable if available on remote.
function Switch-ToStableBranch {
  $current = [string](& git -C $InstallDir symbolic-ref --short -q HEAD 2>$null | Select-Object -First 1)
  if ($current -eq $StableBranch) { return }
  & git -C $InstallDir rev-parse --verify -q ('refs/remotes/origin/' + $StableBranch) 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return }
  & git -C $InstallDir checkout -q -b $StableBranch --track ('origin/' + $StableBranch) 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    SayNote ('远端有稳定版分支，这一份跟稳定版（{0}）：发布方确认过的版本才会收到。' -f $StableBranch)
  } else {
    SayWarn ('没能切到稳定版分支（{0}），这一份留在默认分支上：发布方每次推送都会收到。' -f $StableBranch)
    SayNote ('之后想换到稳定版，在安装目录里执行：npm run update -- --channel {0}' -f $StableBranch)
  }
}

function Get-Workbench {
  SayStep '下载工作台'
  $parent = Split-Path -Parent $InstallDir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent -ErrorAction SilentlyContinue | Out-Null
  }
  while ($true) {
    SayNote ('正在下载：{0}' -f (Hide-UrlCredentials $RepoUrl))
    SayNote '（第一次可能弹出 GitHub 登录窗口；下载本身通常不到一分钟。）'
    $result = Invoke-GitCaptured @('clone', $RepoUrl, $InstallDir)
    if ($result.Code -eq 0) { break }
    Show-GitFailure $result.Text
    # Retry interactively when running in a console; exit immediately in non-interactive runs.
    if (-not (Test-Interactive)) {
      Remove-WorkDirs
      exit 1
    }
    Say ''
    $answer = Read-Host '  处理好之后按回车重试（前面几步不会重做）；输入 q 再回车则退出'
    if ($answer -match '^\s*[qQ]\s*$') {
      Remove-WorkDirs
      exit 1
    }
  }
  Switch-ToStableBranch
  if ((Get-InstallDirKind $InstallDir) -ne 'workbench') {
    Stop-Install ('下载下来的内容不像集群运维工作台（没有 scripts\launch.mjs，或 package.json 的 name 不是 {0}）。' -f $PackageName) @(
      ('请确认仓库地址是否正确：{0}' -f (Hide-UrlCredentials $RepoUrl)),
      ('刚下载的目录还在，没有删除：{0}' -f $InstallDir)
    )
  }
  SayOk ('已下载到 {0}（v{1}）。' -f $InstallDir, (Get-WorkbenchVersion))
}

function Update-Workbench {
  SayStep '更新工作台'
  $origin = [string](& git -C $InstallDir remote get-url origin 2>$null | Select-Object -First 1)
  $before = [string](& git -C $InstallDir rev-parse HEAD 2>$null | Select-Object -First 1)
  SayNote ('正在更新：{0}' -f (Hide-UrlCredentials $origin))
  $result = Invoke-GitCaptured @('-C', $InstallDir, 'pull', '--ff-only')
  if ($result.Code -ne 0) {
    SayWarn ('没能更新到最新版本，继续使用现有的这一份（v{0}）。' -f (Get-WorkbenchVersion))
    SayNote '常见原因：网络不通、GitHub 登录过期、安装目录里有自己改过的文件。'
    SayNote '之后可以在工作台页面左上角点版本号 →「检查更新」，那里会说明具体原因。'
  } else {
    $after = [string](& git -C $InstallDir rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($before -eq $after) {
      SayOk ('已经是最新版本（v{0}）。' -f (Get-WorkbenchVersion))
    } else {
      SayOk ('已更新到最新版本（v{0}）。' -f (Get-WorkbenchVersion))
      SayNote '如果工作台此刻正开着：关掉它的窗口再重新打开，新版本才会生效。'
    }
  }
  $requested = Get-EnvOrDefault 'CWB_REPO_URL' ''
  if ($requested -and $origin -and ($origin -ne $requested)) {
    SayWarn ('这份安装的更新来源是 {0}，和 CWB_REPO_URL 不一样；没有改动它。' -f (Hide-UrlCredentials $origin))
    SayNote '要换来源请自己在安装目录里执行：git remote set-url origin 新地址'
  }
}

function Use-ArchiveWorkbench {
  SayStep '准备已解压的工作台'
  SayOk ('已就绪：{0}（v{1}，压缩包解压模式，无需联网克隆仓库）。' -f $InstallDir, (Get-WorkbenchVersion))
}

# ---------------------------------------------------------------------------
# Step 6: Desktop shortcut via ASCII staging file to avoid WScript.Shell code page issues.
# ---------------------------------------------------------------------------
function New-DesktopShortcut {
  SayStep '创建桌面快捷方式'
  $target = Join-Path $InstallDir 'start-console.cmd'
  $fallback = '启动方法：双击 {0}' -f $target
  if (-not $DesktopDir -or -not (Test-Path -LiteralPath $DesktopDir -PathType Container)) {
    SayWarn ('没有找到桌面目录，没有放快捷方式。{0}' -f $fallback)
    return
  }
  $shortcutPath = Join-Path $DesktopDir $ShortcutName
  try {
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('cwb-install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tempDir -ErrorAction Stop | Out-Null
    $State.TempDir = $tempDir
    $shell = New-Object -ComObject WScript.Shell -ErrorAction Stop
    if (Test-Path -LiteralPath $shortcutPath) {
      $probe = Join-Path $tempDir 'existing.lnk'
      Copy-Item -LiteralPath $shortcutPath -Destination $probe -Force -ErrorAction Stop
      $existing = $shell.CreateShortcut($probe)
      if ([string]$existing.Description -notlike ('*' + $ShortcutMarker + '*')) {
        SayWarn ('桌面上已有一个「{0}」，不是本安装器放的，没有覆盖它。' -f $ShortcutName)
        SayNote $fallback
        return
      }
    }
    $staging = Join-Path $tempDir 'cluster-workbench.lnk'
    $shortcut = $shell.CreateShortcut($staging)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = 'Cluster Workbench launcher (' + $ShortcutMarker + ')'
    $shortcut.Save()
    Move-Item -LiteralPath $staging -Destination $shortcutPath -Force -ErrorAction Stop
    $State.ShortcutPath = $shortcutPath
    SayOk '桌面上的「集群运维工作台」：以后双击它启动。'
  } catch {
    SayWarn ('没能创建桌面快捷方式（{0}）。' -f $_.Exception.Message)
    SayNote $fallback
  }
}

# ---------------------------------------------------------------------------
# Main entry point.
# ---------------------------------------------------------------------------
try {
  if (-not $env:USERPROFILE -or -not $env:LOCALAPPDATA) {
    Stop-Install '读不到 USERPROFILE / LOCALAPPDATA 环境变量，无法确定安装位置。' @('请在自己账号的桌面环境里双击安装器。')
  }
  $InstallDir = Resolve-DefaultInstallDir
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
  if ($InstallDir.Length -le 2) {
    Stop-Install '安装目录不能是磁盘根目录。' @('换一个目录，例如 D:\cluster-workbench。')
  }
  $RepoUrl = Get-EnvOrDefault 'CWB_REPO_URL' $DefaultRepoUrl
  $PrivateRoot = Join-Path $env:LOCALAPPDATA 'cluster-workbench'
  $PrivateNodeDir = Join-Path $PrivateRoot 'node'
  $PrivateNodeExe = Join-Path $PrivateNodeDir 'node.exe'
  $DesktopDir = Get-EnvOrDefault 'CWB_DESKTOP_DIR' ([Environment]::GetFolderPath('Desktop'))
  $NodeDistBase = Get-EnvOrDefault 'CWB_NODE_DIST_BASE' 'https://nodejs.org/dist'
  $NodeDistMirror = Get-EnvOrDefault 'CWB_NODE_DIST_MIRROR' 'https://npmmirror.com/mirrors/node'

  Say '集群运维工作台 · 安装器'
  Show-FirstRunNotice
  Confirm-SystemSupport
  Confirm-InstallDir
  Confirm-InstallLocation
  Confirm-DiskSpace
  Confirm-Ssh
  Confirm-Git
  Confirm-Node
  if ($State.InstallKind -eq 'workbench') {
    Update-Workbench
  } elseif ($State.InstallKind -eq 'workbench-archive') {
    Use-ArchiveWorkbench
  } else {
    Get-Workbench
  }
  New-DesktopShortcut

  $startScript = Join-Path $InstallDir 'start-console.cmd'
  Say ''
  Say '安装完成。'
  SayNote ('安装目录：{0}' -f $InstallDir)
  if ($State.ShortcutPath) {
    SayNote '以后启动：双击桌面上的「集群运维工作台」。'
  } else {
    SayNote ('以后启动：双击 {0}' -f $startScript)
  }
  SayNote '以后更新：有新版本时工作台页面顶部会提示，点「更新」即可。'
  SayNote ('以后遇到问题：双击 {0}\install\diagnose-workbench.cmd，把桌面上生成的报告发给维护者。' -f $InstallDir)
  Remove-WorkDirs
  if ((Get-EnvOrDefault 'CWB_INSTALL_NO_LAUNCH' '') -eq '1') {
    SayNote '这次没有启动工作台（设置了 CWB_INSTALL_NO_LAUNCH=1）。'
    exit 0
  }
  Say ''
  Say '正在启动工作台：会另开一个窗口，浏览器随后自动打开 http://127.0.0.1:8877 ；打开后按页面引导填写集群用户名和密码即可。'
  Say '（若浏览器未自动弹出，请直接复制 http://127.0.0.1:8877 到浏览器打开；若挂着梯子打不开页面，请将代理切为「规则模式 / Rule」。）'
  Say '（新开的那个窗口就是工作台本身：关掉它，工作台就停了。本窗口可以关闭。）'
  try {
    Start-Process -FilePath $startScript -WorkingDirectory $InstallDir -ErrorAction Stop
  } catch {
    SayWarn ('没能自动启动（{0}）。请手动双击：{1}' -f $_.Exception.Message, $startScript)
  }
  exit 0
} catch {
  Say ''
  Say ('[X] 安装器遇到了没预料到的错误：{0}' -f $_.Exception.Message)
  Say '    请把这个窗口里的内容截图发给维护者。'
  Remove-WorkDirs
  exit 1
}
