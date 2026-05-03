# Phase M データ同期 自動起動解除

$taskName = 'Phase_M_Data_Sync'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "✅ タスク削除完了: $taskName" -ForegroundColor Green
} else {
    Write-Host "ℹ️ タスクが登録されていません: $taskName" -ForegroundColor Yellow
}
