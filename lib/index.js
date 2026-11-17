/**
 * dsh-task-toast — 宿主插件：把 DSH 的会话状态变成 Windows 系统通知。
 *
 * 四种通知：
 *   1. 任务完成   ← turn/end reason.kind === 'completed'
 *   2. 任务中断   ← turn/end reason.kind 为 error/interrupted/aborted/blocked/hook/...
 *   3. 需要审批   ← approval/asked（工具授权）
 *   4. 需要回答   ← tool/call name === 'ask_user_question'（我显式向你请示）
 *
 * 设计要点：
 * - 只监听（ctx.on），不拦截、不改任何 DSH 行为，失败全静默。
 * - 会话标题优先从 session.log 里的 session/title 事件回读：标题只在会话创建
 *   时写一次，插件晚于它加载时收不到该事件，必须回读历史。
 * - 去抖：同类事件在 DEBOUNCE_MS 内只弹一次，避免连发刷屏。
 * - 子代理会话（delegationDepth > 0）不通知，避免一个任务弹好几条。
 * - 通知发不出去时静默跳过，绝不抛到宿主。
 * - 点击跳转（v0.2.0）：通知带 dsh-task-toast://focus/<session.id>；点击由
 *   click-launcher.vbs（wscript 宿主，隐藏窗口启动 focus.ps1）写本地队列，
 *   本插件再注册 exact 路由给 Web 客户端轮询（见 lib/focus.js）。
 *   通知的弹出时机、文案、样式不变，只是在原 showToast 参数上多带一个会话标识。
 * - 平台：整套实现依赖 Windows（WinRT toast、HKCU 协议、user32）；非 Windows 上插件
 *   加载后直接返回，不注册路由、不发通知。
 * - 可安装性：所有脚本路径从 import.meta.url 推导（包内 scripts/），不写死用户目录。
 */
import { spawn } from 'node:child_process'
import {
  FOCUS_ROUTE,
  IS_WINDOWS,
  SCRIPTS_DIR,
  TOAST_SCRIPT,
  createFocusRoute,
  ensureClickHandler,
  launchUriFor,
} from './focus.js'

export const name = 'task-toast'

// DSH 桌面端的 AppUserModelID —— 通知归属显示为「DeepSeek Harness」
const APP_ID = 'com.deepseek.dsh'

const DEBOUNCE_MS = 4000                 // 同类通知最短间隔
const TURN_START_TTL_MS = 30 * 60 * 1000 // turn/start 记录保留时长

/** 每种通知的去抖时间戳 */
const lastSent = new Map()
/** 每个会话最近一次 turn/start 的时间（用于算耗时） */
const turnStartedAt = new Map()
/** 会话标题缓存 */
const sessionTitles = new Map()
/** 正在发送的通知进程（防止被 GC 提前回收） */
const liveChildren = new Set()
/** 点击协议是否已注册；false 时通知不带 LaunchUri（点击行为退回系统默认） */
let clickReady = false

function shouldSend(kind) {
  const now = Date.now()
  const prev = lastSent.get(kind) || 0
  if (now - prev < DEBOUNCE_MS) return false
  lastSent.set(kind, now)
  return true
}

/** 从会话日志里回读最后一条 session/title。 */
function scanTitleFromLog(session) {
  try {
    const log = session && session.log
    if (!Array.isArray(log)) return null
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i]
      if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title) {
        return e.data.title
      }
    }
  } catch (err) {}
  return null
}

/** 会话标题：缓存 → 日志回读 → 会话自带字段 → 兜底。 */
function titleOf(session) {
  try {
    const id = session && session.id ? session.id : 'default'
    if (sessionTitles.has(id)) return sessionTitles.get(id)
    let t = scanTitleFromLog(session)
    if (!t) {
      const raw = session && (session.title || session.name)
      if (typeof raw === 'string' && raw) t = raw
    }
    if (t) {
      const short = String(t).slice(0, 40)
      sessionTitles.set(id, short)
      return short
    }
    return 'DSH'
  } catch (err) {
    return 'DSH'
  }
}

/** 子代理会话不通知（只看主会话）。 */
function isSubagentSession(session) {
  try {
    const d =
      (session && session.header && session.header.delegationDepth) ??
      (session && session.delegationDepth) ??
      0
    return Number(d) > 0
  } catch (err) {
    return false
  }
}

/** 把 DSH 的 reason 对象翻译成一句人话。 */
function describeReason(reason) {
  if (!reason || typeof reason !== 'object') return { ok: false, text: '原因：未知' }
  const kind = reason.kind
  switch (kind) {
    case 'completed':
      return { ok: true, text: '' }
    case 'error': {
      const err = reason.error || {}
      const code = err.code || 'ERROR'
      const msg = err.message ? String(err.message) : ''
      return { ok: false, text: `原因：${code}${msg ? ' — ' + msg.slice(0, 100) : ''}` }
    }
    case 'interrupted':
      return { ok: false, text: '原因：运行被中断' }
    case 'aborted': {
      const inner = reason.reason && reason.reason.kind
      const map = {
        user: '你手动取消了这一轮',
        parent: '上级会话被取消',
        disposed: '会话被关闭',
        hook: '被钩子中断',
      }
      return { ok: false, text: `原因：${map[inner] || inner || '已中止'}` }
    }
    case 'blocked':
      return { ok: false, text: '原因：被策略拦截，本轮未执行' }
    case 'hook':
      return { ok: false, text: `原因：${reason.reason ? String(reason.reason).slice(0, 100) : '被钩子中断'}` }
    case 'user':
      return { ok: false, text: '原因：你手动取消了这一轮' }
    case 'parent':
      return { ok: false, text: '原因：上级会话被取消' }
    case 'disposed':
      return { ok: false, text: '原因：会话被关闭' }
    default:
      return { ok: false, text: `原因：${kind || '未知'}` }
  }
}

function fmtDuration(ms) {
  // < 3s 属于噪声（测试、秒回），不显示而不是显示「0 秒」
  if (!Number.isFinite(ms) || ms < 3000) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs ? `${m} 分 ${rs} 秒` : `${m} 分`
}

/** 从 ask_user_question 的 arguments 里抽出问题文本。 */
function extractQuestion(argumentsText) {
  try {
    if (!argumentsText) return ''
    const args = typeof argumentsText === 'string' ? JSON.parse(argumentsText) : argumentsText
    const qs = args && args.questions
    if (Array.isArray(qs) && qs.length > 0) {
      const first = qs[0]
      const text = first && (first.question || first.header)
      if (text) return String(text).slice(0, 120)
      return ''
    }
    const single = args && (args.question || args.prompt)
    if (single) return String(single).slice(0, 120)
  } catch (err) {}
  return ''
}

/**
 * 构造 toast.ps1 的命令行参数（纯函数，便于冒烟测试）。
 * 带 sid 且点击协议已就绪时追加 -LaunchUri：点击通知即可回到该会话。
 */
export function toastArgs({ title, body, kind, sid, clickable = clickReady }) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', TOAST_SCRIPT,
    '-Title', String(title == null ? '' : title),
    '-Body', String(body == null ? '' : body),
    '-Kind', kind || 'info',
    '-AppId', APP_ID,
  ]
  const launchUri = clickable ? launchUriFor(sid) : ''
  if (launchUri) {
    args.push('-LaunchUri', launchUri)
  }
  return args
}

/** 弹一条 Windows 通知（失败静默）。 */
function showToast(options) {
  try {
    const args = toastArgs(options)
    // 不要 detached：detached 会让 PowerShell 退出 0 但从不弹通知（实测 5 种组合）。
    // stdio 必须留管道，否则同样静默失效。
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    liveChildren.add(child)
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('error', () => {})
    child.on('close', () => liveChildren.delete(child))
  } catch (err) {
    /* 静默：通知失败不影响宿主 */
  }
}

export function apply(ctx, config) {
  const log = (m) => {
    try { ctx?.logger?.info?.(`[task-toast] ${m}`) } catch (err) {}
  }
  log(`loaded (${process.platform}; scripts: ${SCRIPTS_DIR})`)

  if (!IS_WINDOWS) {
    log('Windows only: notifications and click-through are disabled on this platform')
    return
  }

  const disposers = []
  const dispose = () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch (err) {}
    }
    disposers.length = 0
  }
  try { ctx?.effect?.(() => dispose) } catch (err) {}

  function onEvent(session, event) {
    try {
      if (!event || typeof event !== 'object') return
      const type = event.type
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const sid = session && session.id ? session.id : 'default'

      // 标题事件（会话创建时写一次；老会话收不到，靠 scanTitleFromLog 兜底）
      if (type === 'session/title') {
        if (data.title) sessionTitles.set(sid, String(data.title).slice(0, 60))
        return
      }

      // 子代理不通知
      if (isSubagentSession(session)) return

      if (type === 'turn/start') {
        turnStartedAt.set(sid, Date.now())
        const cutoff = Date.now() - TURN_START_TTL_MS
        for (const [k, v] of turnStartedAt) {
          if (v < cutoff) { turnStartedAt.delete(k); sessionTitles.delete(k) }
        }
        return
      }

      // ---------- 4. 显式请示：等你回答 ----------
      if (type === 'tool/call') {
        const toolName = data.name || data.toolName
        if (toolName === 'ask_user_question') {
          if (!shouldSend('ask')) return
          const q = extractQuestion(data.arguments)
          showToast({
            title: '❓ DSH 有个问题问你',
            body: `${titleOf(session)}：${q || '点击回到 DSH 回答'}`,
            kind: 'ask',
            sid,
          })
        }
        return
      }

      // ---------- 3. 工具授权：等你确认 ----------
      if (type === 'approval/asked') {
        if (!shouldSend('approval')) return
        const tool = data.toolName ? String(data.toolName) : '某个操作'
        const reason = data.reason ? String(data.reason).slice(0, 100) : ''
        showToast({
          title: '⏸ DSH 需要你确认',
          body: `${titleOf(session)}：${tool}${reason ? '（' + reason + '）' : ''}`,
          kind: 'ask',
          sid,
        })
        return
      }

      // ---------- 1/2. 完成 或 中断 ----------
      if (type === 'turn/end') {
        const started = turnStartedAt.get(sid)
        const dur = started ? fmtDuration(Date.now() - started) : ''
        turnStartedAt.delete(sid)
        const r = describeReason(data.reason)
        const who = titleOf(session)

        if (r.ok) {
          if (!shouldSend('done')) return
          showToast({
            title: '✅ DSH 任务完成',
            body: dur ? `${who}：耗时 ${dur}` : `${who}：已完成`,
            kind: 'ok',
            sid,
          })
        } else {
          if (!shouldSend('error')) return
          showToast({
            title: '⚠️ DSH 任务中断',
            body: `${who}：${r.text}${dur ? '（已运行 ' + dur + '）' : ''}`,
            kind: 'warn',
            sid,
          })
        }
        return
      }
    } catch (err) {
      /* 任何异常都不影响宿主 */
    }
  }

  try {
    disposers.push(ctx.on('session/event', onEvent))
    disposers.push(ctx.on('session/disposed', (session) => {
      try {
        if (session && session.id) {
          turnStartedAt.delete(session.id)
          sessionTitles.delete(session.id)
        }
      } catch (err) {}
    }))
    log('subscribed to session/event')
  } catch (err) {
    log('subscribe failed: ' + err.message)
  }

  // ---------- 点击通知跳转：注册 dsh-task-toast:// 协议 ----------
  clickReady = false
  try {
    if (config && config.registerProtocol === false) {
      log('toast click disabled by config (registerProtocol=false)')
    } else {
      ensureClickHandler(log, (ok) => {
        clickReady = ok
      })
    }
  } catch (err) {
    log('click setup failed: ' + err.message)
  }

  // ---------- 点击通知跳转：给 Web 客户端提供轮询路由 ----------
  const registerFocusRoute = (scopedCtx) => {
    try {
      const web = scopedCtx && scopedCtx.webServer ? scopedCtx.webServer : null
      if (!web || typeof web.register !== 'function') {
        log('webServer unavailable; toast click jump disabled')
        return
      }
      let origin = ''
      try {
        if (typeof web.getOrigin === 'function') origin = web.getOrigin()
      } catch (err) {}
      disposers.push(web.register({
        kind: 'exact',
        path: FOCUS_ROUTE,
        handler: createFocusRoute({ origin }),
      }))
      log(`focus route registered: ${FOCUS_ROUTE}`)
    } catch (err) {
      log('focus route registration failed: ' + err.message)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerFocusRoute)
    else registerFocusRoute(ctx)
  } catch (err) {
    log('focus route setup failed: ' + err.message)
  }
}
