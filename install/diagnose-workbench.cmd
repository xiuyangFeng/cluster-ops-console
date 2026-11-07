@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul 2>nul
title Cluster Workbench self-check

rem ===========================================================================
rem Cluster Workbench - Windows self-check.
rem
rem Double-click it, or run:  diagnose-workbench.cmd [--no-pause]
rem It writes a REDACTED report to the Desktop:  workbench-selfcheck.txt
rem
rem This file is deliberately 100%% ASCII and free of labels and goto, for the
rem same reason start-console.cmd is: on Chinese Windows the console code page is
rem CP936/GBK, and cmd.exe mis-computes byte offsets when it re-reads a file that
rem contains UTF-8 multibyte text, or when it seeks a label inside an LF-only copy
rem of the file. An all-ASCII file with no labels is immune to both. The visible
rem consequence is that this tool speaks English only.
rem
rem It also uses NO parenthesised command blocks anywhere, and every write to the
rem report is a single line with its own redirection. Reason: inside a block,
rem percent-variables are expanded while the block is being parsed, so a path
rem containing a bracket - "cluster-workbench-main (1)", or an OneDrive-moved
rem desktop - would close the block early and silently truncate the report.
rem On a plain top-level line brackets in a value are harmless. Keep it that way.
rem
rem Secrets are NEVER read: config.local.json, private keys, proxy passwords and
rem tokens are reported as present/absent at most. Keep it that way when editing.
rem ===========================================================================

set "SC_PAUSE=1"
if /i "%~1"=="--no-pause" set "SC_PAUSE="

rem Real Desktop folder - the registry value also reveals OneDrive redirection.
set "SC_DESKTOP=%USERPROFILE%\Desktop"
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v Desktop 2^>nul') do set "SC_DESKTOP=%%b"
if not exist "%SC_DESKTOP%\" set "SC_DESKTOP=%TEMP%"
set "SC_REPORT=%SC_DESKTOP%\workbench-selfcheck.txt"
del /f /q "%SC_REPORT%" >nul 2>nul
echo. >"%SC_REPORT%"

rem This file lives in <root>\install\, so the parent directory is the install root.
set "SC_THIS_ROOT="
for %%a in ("%~dp0..") do set "SC_THIS_ROOT=%%~fa"
set "SC_DEFAULT_ROOT=%USERPROFILE%\cluster-workbench"

rem Newest log of each install root, resolved up front so the values are ready
rem before the report lines below are parsed.
set "SC_LOG_DEFAULT="
for /f "delims=" %%f in ('dir /b /o-d "%SC_DEFAULT_ROOT%\work\runtime\logs" 2^>nul') do if not defined SC_LOG_DEFAULT set "SC_LOG_DEFAULT=%%f"
set "SC_LOG_THIS="
for /f "delims=" %%f in ('dir /b /o-d "%SC_THIS_ROOT%\work\runtime\logs" 2^>nul') do if not defined SC_LOG_THIS set "SC_LOG_THIS=%%f"
set "SC_HAS_CURL="
where curl >nul 2>&1
if not errorlevel 1 set "SC_HAS_CURL=1"

echo.
echo Cluster Workbench self-check - collecting diagnostics, please wait...
echo Report will be written to:
echo   %SC_REPORT%
echo.

echo ============================================================ >>"%SC_REPORT%" 2>&1
echo  Cluster Workbench self-check report >>"%SC_REPORT%" 2>&1
echo  Generated: %DATE% %TIME% >>"%SC_REPORT%" 2>&1
echo  Report file: %SC_REPORT% >>"%SC_REPORT%" 2>&1
echo  Script: %~f0 >>"%SC_REPORT%" 2>&1
echo ============================================================ >>"%SC_REPORT%" 2>&1
echo. >>"%SC_REPORT%" 2>&1

echo [1] Windows >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
ver >>"%SC_REPORT%" 2>&1
echo. >>"%SC_REPORT%" 2>&1
echo [1.1] Registry - Windows NT CurrentVersion >>"%SC_REPORT%" 2>&1
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ProductName >>"%SC_REPORT%" 2>&1
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v DisplayVersion >>"%SC_REPORT%" 2>&1
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v CurrentBuildNumber >>"%SC_REPORT%" 2>&1
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v UBR >>"%SC_REPORT%" 2>&1
echo. >>"%SC_REPORT%" 2>&1
echo [1.2] Architecture and identity >>"%SC_REPORT%" 2>&1
echo PROCESSOR_ARCHITECTURE=%PROCESSOR_ARCHITECTURE% >>"%SC_REPORT%" 2>&1
echo PROCESSOR_ARCHITEW6432=%PROCESSOR_ARCHITEW6432% >>"%SC_REPORT%" 2>&1
echo USERDOMAIN=%USERDOMAIN% >>"%SC_REPORT%" 2>&1
echo USERNAME=%USERNAME% >>"%SC_REPORT%" 2>&1
echo COMPUTERNAME=%COMPUTERNAME% >>"%SC_REPORT%" 2>&1
echo USERPROFILE=%USERPROFILE% >>"%SC_REPORT%" 2>&1
echo LOCALAPPDATA=%LOCALAPPDATA% >>"%SC_REPORT%" 2>&1
echo TEMP=%TEMP% >>"%SC_REPORT%" 2>&1
net session >nul 2>&1
if not errorlevel 1 echo IsAdmin=yes >>"%SC_REPORT%" 2>&1
if errorlevel 1 echo IsAdmin=no >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [2] Node.js >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
echo [2.1] where node >>"%SC_REPORT%" 2>&1
where node >>"%SC_REPORT%" 2>&1
echo [2.2] node -v >>"%SC_REPORT%" 2>&1
node -v >>"%SC_REPORT%" 2>&1
echo [2.3] private runtime - %LOCALAPPDATA%\cluster-workbench\node\node.exe >>"%SC_REPORT%" 2>&1
if exist "%LOCALAPPDATA%\cluster-workbench\node\node.exe" echo privateNode=FOUND >>"%SC_REPORT%" 2>&1
if not exist "%LOCALAPPDATA%\cluster-workbench\node\node.exe" echo privateNode=NOT-FOUND >>"%SC_REPORT%" 2>&1
if exist "%LOCALAPPDATA%\cluster-workbench\node\node.exe" "%LOCALAPPDATA%\cluster-workbench\node\node.exe" -v >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [3] OpenSSH client >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
where ssh >>"%SC_REPORT%" 2>&1
ssh -V >>"%SC_REPORT%" 2>&1
where ssh-keygen >>"%SC_REPORT%" 2>&1
where ssh-keyscan >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [4] git >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
where git >>"%SC_REPORT%" 2>&1
git --version >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [5] Install layout >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
echo [5.1] default location - %SC_DEFAULT_ROOT% >>"%SC_REPORT%" 2>&1
if exist "%SC_DEFAULT_ROOT%\package.json" echo package.json=YES >>"%SC_REPORT%" 2>&1
if not exist "%SC_DEFAULT_ROOT%\package.json" echo package.json=NO >>"%SC_REPORT%" 2>&1
if exist "%SC_DEFAULT_ROOT%\package.json" findstr /I version "%SC_DEFAULT_ROOT%\package.json" >>"%SC_REPORT%" 2>&1
if exist "%SC_DEFAULT_ROOT%\.git" echo dotgit=YES - auto update available >>"%SC_REPORT%" 2>&1
if not exist "%SC_DEFAULT_ROOT%\.git" echo dotgit=NO - no auto update >>"%SC_REPORT%" 2>&1
if exist "%SC_DEFAULT_ROOT%\config.local.json" echo config.local.json=YES - content never read >>"%SC_REPORT%" 2>&1
if not exist "%SC_DEFAULT_ROOT%\config.local.json" echo config.local.json=NO >>"%SC_REPORT%" 2>&1
if exist "%SC_DEFAULT_ROOT%\work\runtime" echo work-runtime=YES >>"%SC_REPORT%" 2>&1
if not exist "%SC_DEFAULT_ROOT%\work\runtime" echo work-runtime=NO >>"%SC_REPORT%" 2>&1
echo newest-log=%SC_LOG_DEFAULT% >>"%SC_REPORT%" 2>&1
echo. >>"%SC_REPORT%" 2>&1
echo [5.2] this script's install root - %SC_THIS_ROOT% >>"%SC_REPORT%" 2>&1
if exist "%SC_THIS_ROOT%\package.json" echo package.json=YES >>"%SC_REPORT%" 2>&1
if not exist "%SC_THIS_ROOT%\package.json" echo package.json=NO >>"%SC_REPORT%" 2>&1
if exist "%SC_THIS_ROOT%\package.json" findstr /I version "%SC_THIS_ROOT%\package.json" >>"%SC_REPORT%" 2>&1
if exist "%SC_THIS_ROOT%\.git" echo dotgit=YES - auto update available >>"%SC_REPORT%" 2>&1
if not exist "%SC_THIS_ROOT%\.git" echo dotgit=NO - no auto update >>"%SC_REPORT%" 2>&1
if exist "%SC_THIS_ROOT%\config.local.json" echo config.local.json=YES - content never read >>"%SC_REPORT%" 2>&1
if not exist "%SC_THIS_ROOT%\config.local.json" echo config.local.json=NO >>"%SC_REPORT%" 2>&1
if exist "%SC_THIS_ROOT%\work\runtime" echo work-runtime=YES >>"%SC_REPORT%" 2>&1
if not exist "%SC_THIS_ROOT%\work\runtime" echo work-runtime=NO >>"%SC_REPORT%" 2>&1
echo newest-log=%SC_LOG_THIS% >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [6] Local SSH material - file names only, contents are never read >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
dir /b "%USERPROFILE%\.ssh\id_*" >>"%SC_REPORT%" 2>&1
if exist "%USERPROFILE%\.ssh\known_hosts" echo known_hosts=YES >>"%SC_REPORT%" 2>&1
if not exist "%USERPROFILE%\.ssh\known_hosts" echo known_hosts=NO >>"%SC_REPORT%" 2>&1
if exist "%USERPROFILE%\.ssh\config" echo ssh_config=YES >>"%SC_REPORT%" 2>&1
if not exist "%USERPROFILE%\.ssh\config" echo ssh_config=NO >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [7] Proxy - values that may hold credentials are deliberately NOT printed >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable >>"%SC_REPORT%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer >nul 2>&1
if not errorlevel 1 echo ProxyServerKey=present - value not printed >>"%SC_REPORT%" 2>&1
if errorlevel 1 echo ProxyServerKey=absent >>"%SC_REPORT%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL >nul 2>&1
if not errorlevel 1 echo AutoConfigURL=present - PAC is in use >>"%SC_REPORT%" 2>&1
if errorlevel 1 echo AutoConfigURL=absent >>"%SC_REPORT%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride >nul 2>&1
if not errorlevel 1 echo ProxyOverride=present - value not printed >>"%SC_REPORT%" 2>&1
if errorlevel 1 echo ProxyOverride=absent >>"%SC_REPORT%" 2>&1
if defined http_proxy echo http_proxy=set >>"%SC_REPORT%" 2>&1
if not defined http_proxy echo http_proxy=not-set >>"%SC_REPORT%" 2>&1
if defined https_proxy echo https_proxy=set >>"%SC_REPORT%" 2>&1
if not defined https_proxy echo https_proxy=not-set >>"%SC_REPORT%" 2>&1
if defined all_proxy echo all_proxy=set >>"%SC_REPORT%" 2>&1
if not defined all_proxy echo all_proxy=not-set >>"%SC_REPORT%" 2>&1
if defined no_proxy echo no_proxy=set >>"%SC_REPORT%" 2>&1
if not defined no_proxy echo no_proxy=not-set >>"%SC_REPORT%" 2>&1
echo note: cmd matches environment names case-insensitively, so an uppercase >>"%SC_REPORT%" 2>&1
echo HTTP_PROXY / HTTPS_PROXY / ALL_PROXY would show up as the lowercase name above >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [8] Console port 8877 >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
echo [8.1] listeners on 8877 >>"%SC_REPORT%" 2>&1
netstat -ano | findstr ":8877" >>"%SC_REPORT%" 2>&1
echo [8.2] HTTP probe of http://127.0.0.1:8877/ >>"%SC_REPORT%" 2>&1
if defined SC_HAS_CURL curl -s -I --max-time 5 http://127.0.0.1:8877/ 2>&1 | findstr /B HTTP >>"%SC_REPORT%" 2>&1
if not defined SC_HAS_CURL echo curl=absent - probe skipped >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo [9] Desktop >>"%SC_REPORT%" 2>&1
echo ------------------------------------------------------------ >>"%SC_REPORT%" 2>&1
echo DesktopFolder=%SC_DESKTOP% >>"%SC_REPORT%" 2>&1
echo shortcut files: >>"%SC_REPORT%" 2>&1
dir /b "%SC_DESKTOP%\*.lnk" >>"%SC_REPORT%" 2>&1

echo. >>"%SC_REPORT%" 2>&1
echo ============================================================ >>"%SC_REPORT%" 2>&1
echo  END OF REPORT >>"%SC_REPORT%" 2>&1
echo  Please send the file  %SC_REPORT% >>"%SC_REPORT%" 2>&1
echo  to the maintainer, together with a screenshot of any error window. >>"%SC_REPORT%" 2>&1
echo ============================================================ >>"%SC_REPORT%" 2>&1

echo.
echo ============================================================
echo  Report written to:
echo    %SC_REPORT%
echo.
echo  Please send that file to the maintainer in WeChat.
echo ============================================================
echo.
type "%SC_REPORT%" 2>nul
echo.
start "" explorer.exe /select,"%SC_REPORT%"
if defined SC_PAUSE pause
exit /b 0
