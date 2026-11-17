/**
 * dsh-task-toast 的「点击通知 → 跳到对应会话」宿主侧支撑。
 *
 * 包内脚本：`scripts/`（toast.ps1 / focus.ps1 / register.ps1 / click-launcher.vbs）。
 * 出包可安装的关键：所有路径都从 `import.meta.url` 推导，不写死用户目录。
 *
 * 点击链路：
 *   通知里带 launch URI：dsh-task-toast://focus/<会话标识>
 *     └─ 用户点击通知，Windows 按 HKCU 注册的协议唤起 click-launcher.vbs（wscript，无窗口）
 *          ├─ 把会话标识追加进本地点击队列 %LOCALAPPDATA%\dsh-task-toast\focus.queue.jsonl
 *          └─ 把 DeepSeek Harness 窗口切到前台（没开着就启动它）
 *   本文件：安装点击处理器、注册协议、提供 GET /task-toast/focus/next
 *     └─ Web 客户端轮询该路由取走队列，调用 uiWorkspace.openSession(会话标识)
 *
 * 为什么把处理器复制到 %LOCALAPPDATA%\dsh-task-toast\bin 再注册：
 * - npm 升级会替换包目录，已注册的包内路径会短暂失效；稳定副本不受影响。
 * - 卸载插件后注册项仍指向本地副本，点击只会写一条没人消费的队列，不会弹出
 *   “找不到应用/文件”的系统对话框。
 *
 * 设计约束：
 * - 只复用现有 session.id，不增加通知字段；URI 在 toast 点击时才被解析。
 * - 队列跨进程传递，用原子改名避免读走一半。
 * - 所有失败静默：点击跳转失效，不影响通知本身。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 通知点击协议：dsh-task-toast://focus/<会话标识> */
export const SCHEME = 'dsh-task-toast'
/** 客户端轮询取点击事件的 exact 路由 */
export const FOCUS_ROUTE = '/task-toast/focus/next'
/** 通知/点击链路的全部实现都依赖 Windows（WinRT toast、HKCU 协议、user32）。 */
export const IS_WINDOWS = process.platform === 'win32'

/** 包内脚本目录（npm 安装后是 node_modules/dsh-task-toast/scripts）。 */
export const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url))
export const TOAST_SCRIPT = path.join(SCRIPTS_DIR, 'toast.ps1')
export const FOCUS_SCRIPT = path.join(SCRIPTS_DIR, 'focus.ps1')
export const REGISTER_SCRIPT = path.join(SCRIPTS_DIR, 'register.ps1')
/**
 * 点击入口：交给系统签名程序 wscript.exe 运行的无窗口启动器（GUI 子系统）。
 * 为什么不是自编译 exe：Windows 11 Smart App Control 会阻止未签名 exe
 * （实测 “An Application Control policy has blocked this file”），而脚本宿主允许。
 */
export const CLICK_LAUNCHER = path.join(SCRIPTS_DIR, 'click-launcher.vbs')

/** 点击事件有效期：过期点击不再跳转（例如应用关了之后很久才重新打开） */
export const QUEUE_TTL_MS = 5 * 60 * 1000

const LOCAL_DIR = path.join(process.env.LOCALAPPDATA || process.env.TEMP || os.tmpdir(), 'dsh-task-toast')
const QUEUE_FILE = path.join(LOCAL_DIR, 'focus.queue.jsonl')
const INSTALL_DIR = path.join(LOCAL_DIR, 'bin')

/** 正在运行的注册脚本进程（防止被 GC 提前回收） */
const liveChildren = new Set()

/** 点击队列文件（click-launcher.vbs / focus.ps1 用同样的路径规则写入）。 */
export function focusQueueFile() {
  return QUEUE_FILE
}

/** 稳定副本目录：注册表指向这里的处理器，不指向 node_modules。 */
export function clickInstallDir() {
  return INSTALL_DIR
}

/**
 * 选择包内点击处理器：优先 wscript 启动器（无窗口），缺失时退回 focus.ps1。
 * 直连 powershell.exe 时，console 子系统会先让 Windows Terminal 创建窗口，
 * `-WindowStyle Hidden` 只能事后隐藏；启动器用隐藏窗口方式创建 PowerShell，避免闪现。
 */
export function clickHandlerPath() {
  try {
    if (fs.existsSync(CLICK_LAUNCHER)) return CLICK_LAUNCHER
  } catch (err) {}
  return FOCUS_SCRIPT
}

function sameContent(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right))
  } catch (err) {
    return false
  }
}

/**
 * 把点击处理器复制到稳定目录（%LOCALAPPDATA%\dsh-task-toast\bin）。
 * 幂等：内容相同不重写；返回安装后的绝对路径；失败返回 null。
 * @param {string} [directory] 目标目录（测试可注入）
 * @returns {{ directory: string, focus: string, register: string, helper: string | null } | null}
 */
export function installClickHandler(directory = INSTALL_DIR) {
  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch (err) {
    return null
  }

  const files = [
    { source: FOCUS_SCRIPT, name: 'focus.ps1', required: true },
    { source: REGISTER_SCRIPT, name: 'register.ps1', required: true },
    { source: CLICK_LAUNCHER, name: 'click-launcher.vbs', required: false },
  ]
  for (const file of files) {
    const target = path.join(directory, file.name)
    try {
      if (!fs.existsSync(file.source)) {
        if (file.required) return null
        continue
      }
      if (fs.existsSync(target) && sameContent(file.source, target)) continue
      fs.copyFileSync(file.source, target)
    } catch (err) {
      if (file.required) return null
    }
  }

  const focus = path.join(directory, 'focus.ps1')
  const register = path.join(directory, 'register.ps1')
  if (!fs.existsSync(focus) || !fs.existsSync(register)) return null
  const launcher = path.join(directory, 'click-launcher.vbs')
  return {
    directory,
    focus,
    register,
    launcher: fs.existsSync(launcher) ? launcher : null,
  }
}

/** 生成通知的 launch URI；会话标识为空时返回空串（此时通知不带 LaunchUri）。 */
export function launchUriFor(sessionId) {
  try {
    const id = sessionId == null ? '' : String(sessionId).trim()
    if (!id) return ''
    return `${SCHEME}://focus/${encodeURIComponent(id)}`
  } catch (err) {
    return ''
  }
}

/**
 * 取走点击队列里全部有效的会话标识（按点击顺序，连续重复只留一个）。
 * 先把队列原子改名到临时文件再解析，保证同一次点击只会被一个读取者消费。
 * @param {number} [now] 当前时间（测试可注入）
 * @param {string} [file] 队列路径（测试可注入）
 * @returns {string[]} 待跳转的会话标识
 */
export function consumeFocusQueue(now = Date.now(), file = QUEUE_FILE) {
  const aside = `${file}.${process.pid}-${now}.tmp`
  try {
    fs.renameSync(file, aside)
  } catch (err) {
    return [] // 没有队列（或正被追加占住），下次再取
  }
  let text = ''
  try {
    text = fs.readFileSync(aside, 'utf8')
  } catch (err) {}
  try {
    fs.unlinkSync(aside)
  } catch (err) {}
  const sessions = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let record = null
    try {
      record = JSON.parse(line)
    } catch (err) {
      continue
    }
    const id = record && typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    const at = Number(record && record.at)
    if (!id || !Number.isFinite(at)) continue
    if (now - at > QUEUE_TTL_MS) continue // 过期点击不打扰
    if (at - now > 60 * 1000) continue // 时钟跳变保护
    if (sessions[sessions.length - 1] !== id) sessions.push(id)
  }
  return sessions
}

/**
 * 客户端轮询使用的 HTTP 处理器：返回自上次轮询以来被点击的通知对应的会话标识。
 * @param {{ origin?: string }} [options] Host 自己的 origin；用于拒绝第三方网页的同源外请求
 */
export function createFocusRoute(options = {}) {
  const allowedOrigins = new Set(['dsh-app://app'])
  if (options.origin) allowedOrigins.add(String(options.origin).toLowerCase())
  return (req, res) => {
    try {
      const method = req && req.method ? req.method : 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      // 桌面端经 dsh-app://app 转发时会剥掉 Origin；浏览器同源 GET 通常也不带 Origin。
      // 只有真正的跨站请求才带 Origin，这里直接拒绝，避免别的网页把队列消费掉。
      const origin = req && req.headers ? req.headers.origin : undefined
      if (typeof origin === 'string' && origin && !allowedOrigins.has(origin.toLowerCase())) {
        res.writeHead(403, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const body = JSON.stringify({ sessions: consumeFocusQueue() })
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(method === 'HEAD' ? undefined : body)
    } catch (err) {
      try {
        res.writeHead(500, { 'cache-control': 'no-store' })
        res.end()
      } catch (ignored) {}
    }
  }
}

/**
 * 安装稳定副本并注册 HKCU 协议（幂等，不需要管理员权限）。
 * @param {(message: string) => void} [log]
 * @param {(ok: boolean) => void} [done] 注册结束回调；ok 为 true 时通知才带 launch URI
 * @param {{ installDir?: string }} [options]
 */
export function ensureClickHandler(log, done, options = {}) {
  const finish = (ok, message) => {
    try {
      if (log) log(message)
    } catch (err) {}
    try {
      if (done) done(ok)
    } catch (err) {}
  }

  if (!IS_WINDOWS) {
    finish(false, 'toast click disabled: Windows only')
    return
  }

  const installed = installClickHandler(options.installDir || INSTALL_DIR)
  if (!installed) {
    finish(false, `click handler install failed: ${SCRIPTS_DIR}`)
    return
  }
  const handler = installed.launcher || installed.focus

  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', installed.register,
      '-Scheme', SCHEME,
      '-Handler', handler,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    liveChildren.add(child)
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      liveChildren.delete(child)
      finish(false, 'click handler registration error')
    })
    child.on('close', (code) => {
      liveChildren.delete(child)
      if (code === 0) {
        finish(true, `toast click ready (${SCHEME}:// -> ${path.basename(handler)})`)
      } else {
        finish(false, `click handler registration failed (code ${code})`)
      }
    })
  } catch (err) {
    finish(false, 'click handler registration failed: ' + (err && err.message ? err.message : String(err)))
  }
}
