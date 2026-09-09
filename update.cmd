@echo off
setlocal
chcp 65001 >nul

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [update] Refused: this internal alpha does not support safe updates.
  exit /b 50
)

node.exe "%~dp0scripts\unsupported-operation.mjs" update
exit /b %errorlevel%
