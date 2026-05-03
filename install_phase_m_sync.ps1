# Phase M データ同期 自動起動セットアップ
# 1日2回 (08:00 / 22:00) sync_phase_m_data.bat を実行するタスクを登録
#
# 使い方: PowerShell を 管理者として実行 → このスクリプトを実行
# 解除: uninstall_phase_m_sync.ps1 を実行

$ErrorActionPreference = 'Stop'

$taskName = 'Phase_M_Data_Sync'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $root 'sync_phase_m_data.bat'

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Phase M データ同期 自動起動セットアップ" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "対象スクリプト: $batPath"
Write-Host "実行スケジュール: 毎日 08:00 と 22:00"
Write-Host ""

if (-not (Test-Path $batPath)) {
    Write-Host "❌ バッチファイルが見つかりません: $batPath" -ForegroundColor Red
    exit 1
}

# 既存タスクがあれば削除
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "既存タスクを削除して再登録します..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# トリガー: 毎日 08:00 と 22:00
$trigger1 = New-ScheduledTaskTrigger -Daily -At '08:00'
$trigger2 = New-ScheduledTaskTrigger -Daily -At '22:00'

# アクション: バッチ実行
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$batPath`"" -WorkingDirectory $root

# 設定: PCがバッテリでも実行 / 起動時刻を逃した場合は次に起動した時に実行
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# プリンシパル: 現在のユーザー / 通常権限
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# 登録
Register-ScheduledTask `
    -TaskName $taskName `
    -Trigger @($trigger1, $trigger2) `
    -Action $action `
    -Settings $settings `
    -Principal $principal `
    -Description 'FLAM Phase M ダッシュボード データ同期 (Box → GitHub)' | Out-Null

Write-Host ""
Write-Host "✅ タスク登録完了: $taskName" -ForegroundColor Green
Write-Host "   毎日 08:00 と 22:00 に自動実行されます" -ForegroundColor Green
Write-Host ""
Write-Host "手動で今すぐ実行: " -NoNewline
Write-Host ".\sync_phase_m_data.bat" -ForegroundColor Yellow
Write-Host "解除:             " -NoNewline
Write-Host ".\uninstall_phase_m_sync.ps1" -ForegroundColor Yellow
Write-Host ""
