/**
 * dsh-task-toast 客户端：把「通知被点击」变成「切到对应会话」。
 *
 * 宿主侧（lib/index.js + lib/focus.js）只负责两件事：
 *   1. 通知带 launch URI，点击时 Windows 唤起 focus.ps1，把会话标识写进本地队列；
 *   2. 提供 exact 路由 GET /task-toast/focus/next，返回 { sessions: [会话标识...] }。
 * 本模块在页面里轮询该同源路由，取到标识后调用 client 服务
 * `uiWorkspace.openSession(会话标识)`——和侧边栏点会话走同一条导航路径，
 * 已打开/未打开的会话都由它切换；一次点击只跳一个会话。
 *
 * 实现约束（来自当前 DSH 客户端行为）：
 * - 路由必须用文档相对地址：桌面端页面是 dsh-app://app/，绝对路径会绕过协议转发；
 * - 宿主路由不经过登录校验，页面用普通 fetch 即可（dsh-app 转发会带上宿主 cookie）；
 * - 不声明 inject：apply 必须立即运行，不能因为等 service 让整页 boot 审计卡住；
 *   service 用 ctx.get() 惰性取，没就绪就先攒着重试；
 * - 队列在宿主侧取走即清空，因此客户端把未完成的会话标识留在 pending 里重试，
 *   直到打开成功、明确失败或用尽重试次数，避免「点了但没跳」。
 *
 * 所有失败静默：拿不到路由或服务时，通知点击只是普通点击。
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-toast',
  factory() {
    const ROUTE = 'task-toast/focus/next'
    const POLL_MS = 700
    const MAX_TRIES = 40 // ~28 秒；覆盖页面/会话列表刚启动的场景
    // 只有 Windows 端会发通知、注册协议；其他平台不产生队列，轮询没有意义。
    const WINDOWS = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '')

    return {
      name: 'dsh-task-toast',
      apply(ctx) {
        if (!WINDOWS) return
        /** sessionId -> 剩余重试次数；跨轮询保留，宿主已经清空队列也不会丢 */
        const pending = new Map()
        /** sessionId -> 已尝试取消归档的次数（归档列表同步有延迟，最多试两次） */
        const unarchiveTries = new Map()
        let polling = false
        let disposed = false

        const get = (name) => {
          try {
            return ctx.get(name)
          } catch (err) {
            return undefined
          }
        }

        /** 尝试跳到一次会话：'done' 成功，'drop' 放弃，'retry' 下一轮再试。 */
        const focusOnce = async (sessionId) => {
          const ui = get('uiWorkspace')
          const sessions = get('sessions')
          if (!ui || !sessions || !sessions.list) return 'retry'
          let state
          try {
            state = sessions.list.getSnapshot()
          } catch (err) {
            return 'retry'
          }
          if (!state || state.phase !== 'ready') return 'retry' // 会话列表还没加载完

          // 已归档的会话不能直接打开（选择会被 clearArchivedCurrent 清掉）：
          // 先取消归档，等列表同步后下一轮再打开。
          let archived = []
          try {
            const workspaces = get('workspaces')
            if (workspaces && workspaces.list) archived = workspaces.list.getSnapshot().archivedSessionIds || []
          } catch (err) {}
          if (Array.isArray(archived) && archived.includes(sessionId)) {
            const tries = unarchiveTries.get(sessionId) || 0
            if (tries >= 2) return 'drop' // 取消归档没成功，别反复请求
            unarchiveTries.set(sessionId, tries + 1)
            try {
              await ui.unarchiveSession(sessionId)
            } catch (err) {}
            return 'retry' // 等归档列表同步到下一轮再打开
          }

          try {
            ui.openSession(sessionId)
            return 'done'
          } catch (err) {
            const message = String((err && err.message) || err)
            // 会话还没进客户端目录：等列表就绪后重试；其他错误放弃这一条
            return message.includes('unknown session') ? 'retry' : 'drop'
          }
        }

        const drain = async () => {
          for (const [sessionId, left] of [...pending]) {
            if (disposed) return
            let verdict = 'retry'
            try {
              verdict = await focusOnce(sessionId)
            } catch (err) {
              verdict = 'retry'
            }
            if (verdict === 'done' || verdict === 'drop' || left <= 1) pending.delete(sessionId)
            else pending.set(sessionId, left - 1)
            if (verdict === 'done' || verdict === 'drop') unarchiveTries.delete(sessionId)
          }
        }

        const tick = async () => {
          if (disposed || polling) return
          polling = true
          try {
            let url = ROUTE
            try {
              url = new URL(ROUTE, document.baseURI).href
            } catch (err) {}
            const response = await fetch(url, { cache: 'no-store' })
            if (response.ok) {
              const payload = await response.json()
              const sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : []
              for (const sessionId of sessions) {
                if (typeof sessionId === 'string' && sessionId && !pending.has(sessionId)) {
                  pending.set(sessionId, MAX_TRIES)
                }
              }
            }
          } catch (err) {
            /* 宿主路由还没就绪或连接正在切换：下一轮再试 */
          } finally {
            polling = false
          }
          await drain()
        }

        try {
          ctx.effect(() => {
            const timer = setInterval(tick, POLL_MS)
            const wake = () => { tick() }
            window.addEventListener('focus', wake)
            document.addEventListener('visibilitychange', wake)
            tick()
            return () => {
              disposed = true
              clearInterval(timer)
              window.removeEventListener('focus', wake)
              document.removeEventListener('visibilitychange', wake)
            }
          })
        } catch (err) {
          console.warn('[dsh-task-toast] toast click jump disabled:', err)
        }
      },
    }
  },
})
