param(
  # 点击处理器的绝对路径（默认优先用同目录的 click-launcher.vbs，其次 focus.ps1）
  [string]$Handler = '',
  # 注册的协议名：通知点击时 Windows 用 <scheme>://focus/<会话标识> 唤起处理器
  [string]$Scheme = 'dsh-task-toast',
  # 卸载：删除 HKCU 下的协议注册
  [switch]$Unregister
)

# dsh-task-toast 通知点击处理器注册：
#   HKCU\Software\Classes\<scheme>            URL Protocol
#   HKCU\Software\Classes\<scheme>\shell\open\command
#     - click-launcher.vbs：交给系统签名程序 wscript.exe 运行（GUI 子系统，无控制台），
#       VBS 再用隐藏窗口启动 focus.ps1，Windows Terminal 不会出现。
#       为什么不用自编译 exe：Windows 11 Smart App Control 会阻止本机编译的未签名 exe
#       （实测报 An Application Control policy has blocked this file），而脚本宿主允许。
#     - focus.ps1：用 powershell.exe 直接运行（兼容回退；Win11 默认终端下可能闪一下终端窗口）
#     - click-helper.exe：0.3.0 之前的旧处理器，仅为兼容保留分支，新安装不再使用
# 只用 HKCU，不需要管理员权限；重复执行是幂等的。
$ErrorActionPreference = 'Stop'

$root = "HKCU:\Software\Classes\$Scheme"

if ($Unregister) {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  Write-Output "unregistered $Scheme"
  exit 0
}

if (-not $Handler) {
  $launcher = Join-Path $PSScriptRoot 'click-launcher.vbs'
  $legacyHelper = Join-Path $PSScriptRoot 'click-helper.exe'
  if (Test-Path -LiteralPath $launcher) {
    $Handler = $launcher
  } elseif (Test-Path -LiteralPath $legacyHelper) {
    $Handler = $legacyHelper
  } else {
    $Handler = Join-Path $PSScriptRoot 'focus.ps1'
  }
}
if (-not (Test-Path -LiteralPath $Handler)) {
  Write-Error "handler not found: $Handler"
  exit 1
}
$resolvedHandler = (Resolve-Path -LiteralPath $Handler).Path

# 注意 %1 原样保留：Windows 激活协议时把它替换成完整 URI（含引号转义）
if ($resolvedHandler -match '(?i)\.vbs$') {
  # 系统签名宿主 wscript.exe（GUI 子系统，无控制台）+ 启动脚本；//B 静默、//Nologo 无横幅
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscript)) { $wscript = 'wscript.exe' }
  $command = '"' + $wscript + '" //B //Nologo "' + $resolvedHandler + '" "%1"'
} elseif ($resolvedHandler -match '(?i)\.exe$') {
  # 旧版自编译 helper：GUI 子系统程序，没有控制台；仅兼容旧处理器路径
  $command = '"' + $resolvedHandler + '" "%1"'
} else {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powershell)) { $powershell = 'powershell.exe' }
  $command = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $resolvedHandler + '" "%1"'
}

New-Item -Path $root -Force | Out-Null
New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path $root -Value 'URL:DSH Task Toast'
$commandKey = Join-Path $root 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $commandKey -Value $command

Write-Output "registered $Scheme -> $resolvedHandler"
