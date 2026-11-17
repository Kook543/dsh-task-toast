# dsh-task-toast

Windows 10/11 desktop notifications for DeepSeek Harness (DSH). The plugin shows a notification
when a task needs approval, is interrupted, asks a question, or finishes. Clicking a notification
brings DSH to the foreground and opens the session that produced it.

适用于 Windows 10/11 的 DSH 桌面通知插件。任务需要审批、被中断、提问或完成时弹出通知；点击通知
会把 DSH 窗口切到前台，并打开对应会话。

Windows-only. Requires the DSH Desktop app (toast AppId `com.deepseek.dsh`); tested with DSH
0.2.2-rc.1 on Windows 11. No npm runtime dependencies. All helpers are shipped in this package
(PowerShell scripts plus a small wscript launcher); no unsigned executables are used.

| Notification | Trigger | Content |
|---|---|---|
| ✅ 任务完成 | `turn/end` with `reason.kind === 'completed'` | session title + duration |
| ⚠️ 任务中断 | `turn/end` with `reason.kind` = `error` / `interrupted` / `aborted` / `blocked` / `hook` / `user` / `parent` / `disposed` | session title + reason + duration |
| ⏸ 需要审批 | `approval/asked` (tool authorization) | session title + tool + reason |
| ❓ 需要回答 | `tool/call` with `name === 'ask_user_question'` | session title + question |

Every notification carries the originating session id; clicking it:

1. brings the DSH window to the foreground (restoring it if minimized, starting DSH if it is not running);
2. switches the Web UI to that session (cold sessions are loaded on demand).

## Requirements / 环境要求

- **Windows 10 or 11**, with the **DSH Desktop app installed** (the toast AppId comes from its
  Start-menu registration; the notification plugin runs inside the DSH Host process).
- **Windows Script Host** (`wscript.exe`, present on Windows 10/11) for the windowless click
  launcher. If VBScript has been removed or disabled by policy, register the PowerShell fallback
  instead — see [Why the click handler is a script](#why-the-click-handler-is-a-script--为什么点击处理器是脚本).
- **DSH `>= 0.2.2-rc.1 < 0.3.0-0`** (declared in `dsh.engines.dsh`). DSH updates may change the
  internal APIs this plugin listens to; re-test on major/minor upgrades.
- The plugin is declared with `dsh.bundle.platforms: ["win32"]`, so non-Windows profiles refuse to
  load it instead of silently doing nothing.

## Install / 安装

From the plugin market (recommended — it installs the package and selects the bundle):

> DSH → Plugins → Discover (add an index source if needed) or the community `dshmarket` plugin.
> Find **dsh-task-toast** and install it. Restart DSH Desktop afterwards.

Manual install from npm or a checkout:

```powershell
# npm package (after it is published)
dsh plugin --profile desktop add dsh-task-toast

# or from a local checkout / GitHub
dsh plugin --profile desktop add C:\path\to\dsh-task-toast
```

`dsh plugin add` installs the package and adds it to the profile's `dsh.profile.bundles`
automatically (a package that declares `dsh.bundle` is selected on install). If you edit the
profile by hand instead, make sure `"dsh-task-toast"` is in that list and restart.

**Restart DSH Desktop** after installing/upgrading — the Host plugin and its client half are read
at startup.

## What happens on first run / 首次运行的副作用

- The plugin copies its click handler (`focus.ps1`, `register.ps1`, `click-launcher.vbs`) to
  `%LOCALAPPDATA%\dsh-task-toast\bin\` and registers the `dsh-task-toast://` protocol under
  **HKCU** (`HKCU\Software\Classes\dsh-task-toast`). No administrator rights are needed.
- Registration is repeated on every DSH start (idempotent), so upgrades and moved profiles keep
  working.
- The `bin` copy is deliberate: npm upgrades replace the package directory, and after uninstall a
  click then writes one queue entry that nobody consumes instead of showing a "file not found"
  dialog.

Disable the click feature (notifications only) with a profile patch:

```yaml
- id: dsh-task-toast
  config:
    registerProtocol: false
```

## How it works / 工作原理

```
Windows notification
  └─ click → shell opens the HKCU protocol
        wscript.exe //B //Nologo click-launcher.vbs "dsh-task-toast://focus/<session id>"
          └─ launcher validates the URI and starts focus.ps1 with a HIDDEN window
               ├─ appends the session id to %LOCALAPPDATA%\dsh-task-toast\focus.queue.jsonl
               └─ focuses DSH: dsh://open (single-instance handler) + user32 fallback after 700 ms
Host plugin (lib/index.js + lib/focus.js)
  └─ registers GET /task-toast/focus/next (consume-and-clear the queue)
Client half (client.js, inside the DSH page)
  └─ polls that route and calls uiWorkspace.openSession(session id)
```

- Only the existing `session.id` is reused; notification title/body/timing are unchanged.
- `dsh://` stays owned by DSH; the plugin uses its own `dsh-task-toast://` scheme.
- The jump uses the same client navigation path as the sidebar (`uiWorkspace.openSession`), so an
  already open session is switched to and a cold one is loaded; archived sessions are unarchived
  first.
- The queue entry expires after 5 minutes, so an old click cannot hijack a later launch.

## Security and privacy / 安全与隐私

What this plugin does, all locally:

- Registers one per-user protocol handler under `HKCU` and writes one small JSON queue file under
  `%LOCALAPPDATA%`.
- Runs `toast.ps1` (Windows PowerShell 5.1, hidden) to show toasts, and on click runs
  `wscript.exe` → `click-launcher.vbs`, which validates the URI and starts `focus.ps1` with a
  hidden window. No unsigned executable is used: Windows 11 **Smart App Control** blocks locally
  built unsigned `.exe` files (observed error: *An Application Control policy has blocked this
  file*), while the signed `wscript.exe` host is allowed. The launcher only accepts URIs of the
  form `dsh-task-toast://focus/<url-safe id>` before passing them on.
- Reads session titles from the local session log to label notifications; no data leaves the
  machine. There is no network access, telemetry or background service.
- The HTTP route is bound to the DSH loopback server, returns only consumed session ids, requires
  no credentials, and rejects cross-site `Origin` requests and non-`GET` methods.

If Windows Script Host is unavailable in your environment, register the PowerShell handler
directly (a terminal window may flash on Windows 11, but the jump still works):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\dsh-task-toast\bin\register.ps1" -Handler "$env:LOCALAPPDATA\dsh-task-toast\bin\focus.ps1"
```

## Uninstall / 卸载

```powershell
dsh plugin --profile desktop remove dsh-task-toast
# remove the protocol registration (optional; the bin copy stays harmless otherwise)
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\dsh-task-toast\bin\register.ps1" -Unregister
# remove the queue/bin directory if you want a full cleanup
Remove-Item "$env:LOCALAPPDATA\dsh-task-toast" -Recurse -Force
```

Also remove `"dsh-task-toast"` from the profile's `dsh.profile.bundles` if a manual install added
it and the removal did not. Existing notifications in the Action Center stay there; clicking them
after uninstall only writes a queue entry (no jump).

## Why the click handler is a script / 为什么点击处理器是脚本

Directly registering `powershell.exe` (or a locally compiled unsigned `.exe`) has two problems on
current Windows:

1. **Terminal window flash.** `powershell.exe` is a console-subsystem program; the terminal host
   creates a window before `-WindowStyle Hidden` can hide it. Measured on Windows 11 with Windows
   Terminal as the default terminal: the window is on screen for about 0.4–0.6 s per click.
2. **Smart App Control.** A locally compiled unsigned `.exe` is blocked outright when Smart App
   Control is on: *An Application Control policy has blocked this file* (Code Integrity event
   3077). Shipping such an exe would silently break clicking for users with SAC enabled.

`click-launcher.vbs` is therefore the protocol handler: it runs under the signed `wscript.exe`
(no console, no window), validates the URI, and starts `focus.ps1` with `WScript.Shell.Run(cmd, 0,
False)` so the PowerShell process is created hidden from the start. Measured with a console-window
scanner: the direct `powershell.exe` handler shows a `WindowsTerminal` window for ~0.4 s; the
`wscript` launcher shows **no console window at all**.

VBScript is deprecated by Microsoft (still present on Windows 10/11 today, including as a
feature-on-demand). If it is removed or disabled by policy, use the `-Handler focus.ps1`
registration shown above; the click still works, with the terminal window flash.

## Tests / 测试

```powershell
node _smoke-click.mjs     # host side: launch URI, queue, HTTP route, handler install, plugin wiring
node _smoke-client.mjs    # client side: polling, archived sessions, retries, cleanup
node _smoke.mjs           # manual: pop real notifications (uses fake session ids)
npm test                  # runs the two smoke tests above
```

The first two tests do not need a running DSH and do not modify the registry.

## Compatibility and known limitations / 兼容性与已知限制

- **Windows-only**; the bundle declares `platforms: ["win32"]`.
- Requires a DSH version in `engines.dsh`; the plugin uses internal Host/client services
  (`ctx.webServer`, `ctx.inject`, `uiWorkspace`, `sessions`, `workspaces`, the session log) that
  may change between DSH releases.
- The protocol name is global per Windows user. Two profiles/installs that both enable the plugin
  overwrite each other's handler, and they share one queue; only one DSH instance should use it at
  a time.
- Notifications created before installing this version have no click target.
- If DSH is on the welcome/mandatory-update screen, a click can only focus the window.
- If a session no longer exists, a click is retried for about 28 seconds and then dropped.
- DSH's Web UI must be loaded for the jump; the notification still shows without it.

## Publishing / 发布

See [PUBLISHING.md](PUBLISHING.md) for the GitHub/npm release checklist and the
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog submission
(one `data/plugins/<owner>__<repo>.yml` file, category `notify`).

## License

MIT — see [LICENSE](LICENSE).
