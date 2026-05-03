@echo off
chcp 65001 > nul
REM =========================================================
REM Phase M データ同期: Box の run_history.jsonl を
REM denko-dashboard repo に取り込み → git push で Cloudflare 自動デプロイ
REM
REM 推奨実行頻度: 1日2回 (朝9時・夕方17時) Windows タスクスケジューラ登録
REM 手動実行: このバッチをダブルクリック
REM =========================================================

setlocal enabledelayedexpansion
set REPO_DIR=%~dp0
set SRC=C:\Users\t-mat\Box\030_DENKO\010_営業本部\010_電力機器事業部\000_Common\999_FLAM_Order_Automation\master_sync\run_history.jsonl
set DST_DIR=%REPO_DIR%public\data
set DST=%DST_DIR%\run_history.jsonl

cd /d "%REPO_DIR%"

echo.
echo ===========================================================
echo   Phase M データ同期 - %date% %time%
echo ===========================================================
echo.

REM ---- 1. Source 存在確認 ----
if not exist "%SRC%" (
    echo ❌ source not found: %SRC%
    echo    → master_sync で orchestrate_order.js を実行する必要があります
    exit /b 1
)

REM ---- 2. Destination dir 作成 ----
if not exist "%DST_DIR%" mkdir "%DST_DIR%"

REM ---- 3. コピー ----
echo [1/4] Copying run_history.jsonl...
copy /Y "%SRC%" "%DST%" > nul
if !ERRORLEVEL! NEQ 0 (
    echo ❌ copy failed
    exit /b 1
)
for %%I in ("%DST%") do echo    %%~zI bytes / 最終更新 %%~tI

REM ---- 4. git diff チェック ----
git diff --quiet "%DST%" 2>nul
if !ERRORLEVEL! EQU 0 (
    echo [2/4] No changes - skipping commit
    exit /b 0
)

REM ---- 5. git add / commit / push ----
echo [2/4] Staging changes...
git add "public/data/run_history.jsonl" 2>nul

echo [3/4] Committing...
for /f "tokens=*" %%t in ('powershell -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set TIMESTAMP=%%t
git commit -m "data(phase-m): run_history.jsonl 更新 (%TIMESTAMP%)" > nul 2>&1
if !ERRORLEVEL! NEQ 0 (
    echo    Nothing to commit (no diff)
    exit /b 0
)

echo [4/4] Pushing to GitHub...
git push 2>nul
if !ERRORLEVEL! NEQ 0 (
    echo ❌ git push failed - 認証/ネット確認
    exit /b 1
)

echo.
echo ✅ Sync complete - Cloudflare Pages が自動再ビルドします (1-2分)
echo.
endlocal
