param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [ValidateSet('ok', 'warn', 'ask', 'info')][string]$Kind = 'info',
  [string]$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
  [string]$Tag = '',
  [string]$LaunchUri = ''
)
$ErrorActionPreference = 'Stop'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$escTitle = [System.Security.SecurityElement]::Escape($Title)
$escBody  = [System.Security.SecurityElement]::Escape($Body)

$attrs = ''
if ($Tag) {
  $attrs += ' tag="' + [System.Security.SecurityElement]::Escape($Tag) + '"'
}
if ($LaunchUri) {
  $attrs += ' activationType="protocol" launch="' + [System.Security.SecurityElement]::Escape($LaunchUri) + '"'
}

$xml = '<toast ' + $attrs + '>' +
  '<visual><binding template="ToastGeneric">' +
  '<text>' + $escTitle + '</text>' +
  '<text>' + $escBody + '</text>' +
  '</binding></visual>' +
  '<audio src="ms-winsoundevent:Notification.Default" />' +
  '</toast>'

try {
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  Write-Output 'shown'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
