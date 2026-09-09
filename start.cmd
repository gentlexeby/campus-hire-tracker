@echo off
setlocal
chcp 65001 >nul

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [start] Node.js was not found. Install Node.js 24 LTS, then run setup.cmd again.
  exit /b 10
)

node.exe "%~dp0scripts\start.mjs"
exit /b %errorlevel%
