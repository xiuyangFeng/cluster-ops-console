; Codex Operations Console 的 Windows 安装器（Inno Setup 6.5+）。
; 不要直接用 ISCC 编译本文件：scripts/build-windows-app.mjs --installer 先组装好安装目录，
; 再以 /D 传入 AppVersion / SourceDir / OutputDir / OutputBaseFilename / IconFile 编译。
;
; 设计要点：
;   * 按当前用户安装（PrivilegesRequired=lowest）：装到 %LOCALAPPDATA%\Programs，不需要管理员权限，
;     与 install-workbench.cmd「不要用管理员身份运行」的约定一致。
;   * 个人配置与运行数据在 %APPDATA%\codex-tunnel-monitor（work/monitor/lib/runtime-paths.mjs），
;     不在安装目录里：覆盖安装、卸载都不动它们。
;   * 覆盖安装时先清掉旧的 resources\app，免得上一版删掉的模块残留在新版目录里。
;   * 后台的守护进程 / 代理 / 隧道与桌面 App 是同一个 exe（ELECTRON_RUN_AS_NODE），文件被占用时由
;     Restart Manager 统一关掉（CloseApplications=force）；卸载时按映像名把整棵进程树结束掉。
;   * AppUserModelID 必须与 work/monitor/desktop/context.mjs 的 APP_USER_MODEL_ID 一致（原生通知靠它）。
;   * 隧道与采集靠 Windows 自带的 OpenSSH 客户端。没装时多一个默认勾选的任务「安装 OpenSSH 客户端」：
;     装完文件后以管理员身份（弹一次 UAC）执行 Add-WindowsCapability；没装上只提示，不影响安装，
;     App 内的接入引导还会再给一键安装（work/monitor/lib/onboarding-guide/service.mjs 的 installOpenSsh）。

#ifndef AppVersion
  #error "AppVersion is not defined: build with node scripts/build-windows-app.mjs --installer"
#endif

#define AppName "Codex Operations Console"
#define AppExeName "Codex Operations Console.exe"
#define AppUserModelID "com.xiuyang.codex-operations-console"

[Setup]
AppId={{63699FAD-A033-4DB3-992E-EA7D54D0A84D}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=xiuyang
AppPublisherURL=https://github.com/xiuyangFeng/cluster-ops-console
AppSupportURL=https://github.com/xiuyangFeng/cluster-ops-console/issues
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1809 起系统自带 OpenSSH 客户端（隧道与采集都靠它）。
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\resources\app-icon.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "installopenssh"; Description: "安装 Windows 自带的 OpenSSH 客户端（工作台靠它连接服务器；需要管理员确认一次）"; GroupDescription: "系统组件："; Check: OpenSshMissing

[InstallDelete]
Type: filesandordirs; Name: "{app}\resources\app"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\resources\app-icon.ico"; AppUserModelID: "{#AppUserModelID}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\resources\app-icon.ico"; AppUserModelID: "{#AppUserModelID}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 桌面 App 与后台进程（守护 / 代理 / ssh 隧道）一起结束，否则文件被占用删不掉。
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM ""{#AppExeName}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopApp"
; 「登录电脑后自动启动」打开过的话，Electron 在 HKCU\...\Run 下以 AppUserModelID 为名登记过；卸载后不留失效的启动项。
Filename: "{sys}\reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v ""{#AppUserModelID}"" /f"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveLoginItem"

[Code]
const
  OpenSshCapability = 'OpenSSH.Client~~~~0.0.1.0';

// 32 位的安装程序访问 System32 可能被重定向到 SysWOW64：Sysnative 与 {sys} 两处都看。
function OpenSshMissing: Boolean;
begin
  Result := not (FileExists(ExpandConstant('{win}\Sysnative\OpenSSH\ssh.exe'))
    or FileExists(ExpandConstant('{sys}\OpenSSH\ssh.exe')));
end;

// 64 位 PowerShell（Add-WindowsCapability 在 32 位 PowerShell 里不可用）。
function NativePowerShell: String;
begin
  Result := ExpandConstant('{win}\Sysnative\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(Result) then
    Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('installopenssh') and OpenSshMissing then
  begin
    WizardForm.StatusLabel.Caption := '正在安装 OpenSSH 客户端（需要一两分钟）…';
    ShellExec('runas', NativePowerShell,
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-WindowsCapability -Online -Name ' + OpenSshCapability + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if OpenSshMissing and not WizardSilent then
      MsgBox('OpenSSH 客户端没有装上（可能是没有确认管理员权限，或这台电脑不允许安装可选功能）。' + #13#10 + #13#10 +
        '打开工作台后，接入引导里还可以一键安装；也可以在「设置 → 系统 → 可选功能 → 添加功能」里手动添加「OpenSSH 客户端」。',
        mbInformation, MB_OK);
  end;
end;
