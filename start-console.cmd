@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul 2>nul
title Codex Operations Console (Cluster Workbench)
cd /d "%~dp0"

rem Keep this file 100% ASCII and free of jump-labels:
rem On Chinese Windows (CP936/GBK), cmd.exe miscalculates file byte offsets after
rem "chcp 65001" if the batch file contains UTF-8 multibyte text, causing syntax
rem errors and instant window closure before reaching "pause".
rem Node version gate matches package.json engines (>=22.12.0 <27), start.sh, and installers.
set "NODE_GATE=const [a,b]=process.versions.node.split('.').map(Number); process.exit((a===22 && b>=12) || (a>22 && a<27) ? 0 : 1)"
set "PRIVATE_NODE=%LOCALAPPDATA%\cluster-workbench\node\node.exe"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"
set "NODE_EXE="
set "SYSTEM_NODE="
set "CWB_BOOTSTRAP_FAILED="

where node >nul 2>nul
if not errorlevel 1 set "SYSTEM_NODE=1"
if defined SYSTEM_NODE node -e "%NODE_GATE%" >nul 2>nul
if defined SYSTEM_NODE if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%PRIVATE_NODE%" "%PRIVATE_NODE%" -e "%NODE_GATE%" >nul 2>nul
if not defined NODE_EXE if exist "%PRIVATE_NODE%" if not errorlevel 1 set "NODE_EXE=%PRIVATE_NODE%"

rem If Node.js is still missing (e.g. extracted from GitHub Download ZIP directly),
rem automatically invoke install\install-workbench.cmd in-place via UTF-8 PowerShell
rem to download the private Node.js runtime and create the desktop shortcut.
rem Remember its exit code: a failed bootstrap must NOT be reported as "Node.js not found",
rem otherwise the user reports the wrong symptom (the installer already printed the real reason).
if not defined NODE_EXE if not defined CWB_NO_AUTO_BOOTSTRAP if exist "%~dp0install\install-workbench.cmd" (
  set "CWB_AUTO_INSTALLER=%~dp0install\install-workbench.cmd"
  set "CWB_INSTALL_DIR=%~dp0."
  rem Set these inside the PowerShell child, not with a plain set: a plain set here
  rem would leak into THIS cmd process and disable the pauses below, so the failure
  rem messages would flash past before the user could read them.
  rem CWB_INSTALL_NO_LAUNCH=1 is required on this path - the installer reads it and
  rem must not launch a second console, because this script launches it.
  rem CWB_INSTALL_NO_PAUSE is kept as belt-and-braces only: here the installer runs
  rem as a script block, so its batch header - the only place that reads that
  rem variable - never executes, and there is nothing for it to suppress.
  rem NOTE for future edits: inside a parenthesised block never put a lone round
  rem bracket in a comment or in echo text. On its own it ends the block early and
  rem the rest of the block then runs unconditionally. Reword to avoid it, or
  rem escape it the way the messages below do - that is why those messages carry no
  rem unescaped closing bracket.
  "%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$env:CWB_INSTALL_NO_LAUNCH='1'; $env:CWB_INSTALL_NO_PAUSE='1'; & ([scriptblock]::Create([System.IO.File]::ReadAllText($env:CWB_AUTO_INSTALLER, [System.Text.Encoding]::UTF8)))"
  if errorlevel 1 set "CWB_BOOTSTRAP_FAILED=1"
  if exist "%PRIVATE_NODE%" "%PRIVATE_NODE%" -e "%NODE_GATE%" >nul 2>nul
  if exist "%PRIVATE_NODE%" if not errorlevel 1 set "NODE_EXE=%PRIVATE_NODE%"
)

rem Bootstrap ran but failed: the real reason is the installer output above this line.
if not defined NODE_EXE if defined CWB_BOOTSTRAP_FAILED (
  echo [X] The automatic setup did not finish, so Node.js is still missing.
  echo     The reason is printed above by install\install-workbench.cmd.
  echo     Fix that one thing, then run this file again.
  echo.
  if not defined CWB_INSTALL_NO_PAUSE pause
  exit /b 1
)
rem Bootstrap reported success but the private node.exe still fails the version gate:
rem almost always an old Windows build (below 10 1809) or antivirus blocking node.exe.
if not defined NODE_EXE if exist "%PRIVATE_NODE%" (
  echo [X] The Node.js runtime downloaded by install\install-workbench.cmd cannot run here.
  echo     Usual causes: Windows older than 10 version 1809, or antivirus blocking node.exe.
  echo     Run install\install-workbench.cmd once and read its last lines, or install
  echo     Node.js 24 LTS from https://nodejs.org, then run this file again.
  echo.
  if not defined CWB_INSTALL_NO_PAUSE pause
  exit /b 1
)
if not defined NODE_EXE if not defined SYSTEM_NODE (
  echo [X] Node.js (v22.12 - v26.x^) was not found on this computer.
  echo     Please run install\install-workbench.cmd or install Node.js 24 LTS from https://nodejs.org
  echo.
  if not defined CWB_INSTALL_NO_PAUSE pause
  exit /b 1
)
if not defined NODE_EXE (
  for /f "delims=" %%v in ('node -v') do echo [X] Unsupported Node.js version: %%v (requires ^>=22.12.0 and ^<27^).
  echo     Please run install\install-workbench.cmd or install Node.js 24 LTS from https://nodejs.org
  echo.
  if not defined CWB_INSTALL_NO_PAUSE pause
  exit /b 1
)

"%NODE_EXE%" scripts\launch.mjs %*
set "CWB_EXIT=%ERRORLEVEL%"
if not defined CWB_INSTALL_NO_PAUSE pause
exit /b %CWB_EXIT%
