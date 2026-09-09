@echo off
setlocal
chcp 65001 >nul

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [restore] Refused: this internal alpha does not support safe restore.
  exit /b 51
)

node.exe "%~dp0scripts\unsupported-operation.mjs" restore
exit /b %errorlevel%
