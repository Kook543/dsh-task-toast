param(
  # 任务通知点击后的入口：dsh-task-toast://focus/<会话标识>
  [Parameter(Mandatory = $true, Position = 0)][string]$Uri,
  # 只写队列、不切换窗口（冒烟测试用）
  [switch]$NoActivate
)

# 通知点击处理器：
#   1. 从 URI 里取出目标会话标识
#   2. 追加到本地点击队列（宿主插件 dsh-task-toast 的 HTTP 路由会取走）
#   3. 把 DeepSeek Harness 窗口切到前台；没在运行就启动它
# 全程静默：任何异常都不弹窗，最多让这次点击无效果。
$ErrorActionPreference = 'SilentlyContinue'
$scheme = 'dsh-task-toast'

# ---------- 1. 解析会话标识 ----------
# Windows 协议激活会把完整 URI 作为第一个参数传进来（百分号编码原样保留）。
$sessionId = ''
try {
  $parsed = [System.Uri]$Uri
  if ($parsed.Scheme -eq $scheme -and $parsed.Host -eq 'focus') {
    $sessionId = [System.Uri]::UnescapeDataString($parsed.AbsolutePath.Trim('/'))
  }
} catch {}
$sessionId = ($sessionId -replace '[\r\n\t]', ' ').Trim()
if ($sessionId.Length -gt 200) { $sessionId = $sessionId.Substring(0, 200) }
if (-not $sessionId) { exit 0 }

# ---------- 2. 写入点击队列 ----------
$baseDir = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $baseDir) { $baseDir = $env:TEMP }
$queueDir = Join-Path $baseDir 'dsh-task-toast'
if (-not (Test-Path -LiteralPath $queueDir)) {
  New-Item -ItemType Directory -Path $queueDir -Force | Out-Null
}
$queueFile = Join-Path $queueDir 'focus.queue.jsonl'
$entry = @{ sessionId = $sessionId; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
  # 队列文件异常膨胀时直接重置，避免长期点不到宿主时无限增长
  if ((Test-Path -LiteralPath $queueFile) -and ((Get-Item -LiteralPath $queueFile).Length -gt 512KB)) {
    [System.IO.File]::WriteAllText($queueFile, '', $utf8NoBom)
  }
  [System.IO.File]::AppendAllText($queueFile, $entry + "`n", $utf8NoBom)
} catch {}

if ($NoActivate) { exit 0 }

# ---------- 3. 聚焦：优先走 DSH 自己的 dsh://open ----------
# dsh://open 由 DSH 注册，第二次启动会走单实例 handler -> focusPrimaryWindow：
# 最小化会还原、隐藏会显示、已在前台则保持不动；应用没开着时会顺便启动它。
# 注意：不能用 dsh:// 携带会话标识（argv 会被 DSH 丢弃），所以会话走上面的本地队列。
Start-Process 'dsh://open'
Start-Sleep -Milliseconds 700

# ---------- 4. user32 兜底 ----------
# 某些机器上前台锁会拒绝 dsh://open 的聚焦，这里再显式还原/置顶一次（失败也不影响队列）。
try {
  Add-Type -Namespace DshTaskToast -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
'@
} catch {}

$windowProcess = $null
try {
  # 主窗口标题形如「<会话标题> — DeepSeek Harness」，不能按固定标题匹配，只能按进程找有窗口的那个
  $windowProcess = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
} catch {}

if ($windowProcess) {
  $handle = $windowProcess.MainWindowHandle
  if ([DshTaskToast.Win32]::GetForegroundWindow() -ne $handle) {
    if ([DshTaskToast.Win32]::IsIconic($handle)) {
      [DshTaskToast.Win32]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
    } else {
      [DshTaskToast.Win32]::ShowWindow($handle, 5) | Out-Null   # SW_SHOW
    }
    [DshTaskToast.Win32]::BringWindowToTop($handle) | Out-Null
    $raised = [DshTaskToast.Win32]::SetForegroundWindow($handle)
    if (-not $raised) {
      # 前台锁：把当前前台线程和窗口线程临时挂到本线程再试
      try {
        $foreground = [DshTaskToast.Win32]::GetForegroundWindow()
        $foregroundPid = 0
        $targetPid = 0
        $foregroundThread = [DshTaskToast.Win32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
        $targetThread = [DshTaskToast.Win32]::GetWindowThreadProcessId($handle, [ref]$targetPid)
        $self = [DshTaskToast.Win32]::GetCurrentThreadId()
        $attachForeground = ($foregroundThread -ne 0) -and ($foregroundThread -ne $self) -and [DshTaskToast.Win32]::AttachThreadInput($self, $foregroundThread, $true)
        $attachTarget = ($targetThread -ne 0) -and ($targetThread -ne $self) -and [DshTaskToast.Win32]::AttachThreadInput($self, $targetThread, $true)
        [DshTaskToast.Win32]::SetForegroundWindow($handle) | Out-Null
        [DshTaskToast.Win32]::BringWindowToTop($handle) | Out-Null
        if ($attachForeground) { [DshTaskToast.Win32]::AttachThreadInput($self, $foregroundThread, $false) | Out-Null }
        if ($attachTarget) { [DshTaskToast.Win32]::AttachThreadInput($self, $targetThread, $false) | Out-Null }
      } catch {}
    }
  }
}
exit 0
