// _smoke-client.mjs — 在 Node 里模拟浏览器模块环境，验证 client.js 的轮询与跳转逻辑。
//   node _smoke-client.mjs
// 不连真实 DSH：注入假的 window.__ModuleLoader__ / fetch / uiWorkspace / sessions / workspaces。
// client.js 只会在 Windows UA 下轮询（宿主是 Windows），这里模拟桌面端 UA。
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/40.0.0 Chrome/140.0.0.0 Safari/537.36' },
  configurable: true,
})
const loaded = []
globalThis.window = {
  __ModuleLoader__: { load(definition) { loaded.push(definition) } },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  hidden: false,
  baseURI: 'dsh-app://app/',
  addEventListener() {},
  removeEventListener() {},
}

// 每次轮询返回一批会话标识：正常两个 → 一个已归档的 → 之后为空
const batches = [
  { sessions: ['session-1', 'session-2'] },
  { sessions: ['session-archived'] },
  { sessions: [] },
]
const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  return {
    ok: true,
    json: async () => batches[Math.min(fetchCalls.length - 1, batches.length - 1)],
  }
}

await import(new URL('./client.js', import.meta.url))

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

check('模块通过 window.__ModuleLoader__.load 注册', loaded.length === 1 && loaded[0].id === 'dsh-task-toast')
const plugin = loaded[0].factory(() => { throw new Error('unexpected require') })
check('插件名正确且不硬依赖 service（不会卡住整页 boot）', plugin.name === 'dsh-task-toast' && plugin.inject === undefined)

const opened = []
const unarchived = []
const events = []
const archivedSessionIds = ['session-archived']
const sessionState = {
  phase: 'ready',
  byId: { 'session-1': { id: 'session-1' }, 'session-2': { id: 'session-2' } },
}
const services = {
  uiWorkspace: {
    openSession(sessionId) {
      if (sessionId === 'session-archived' && archivedSessionIds.includes(sessionId)) {
        throw new Error(`sessions.retain: unknown session ${sessionId}`)
      }
      opened.push(sessionId)
      events.push('open:' + sessionId)
    },
    async unarchiveSession(sessionId) {
      unarchived.push(sessionId)
      events.push('unarchive:' + sessionId)
      const index = archivedSessionIds.indexOf(sessionId)
      if (index >= 0) archivedSessionIds.splice(index, 1)
    },
  },
  sessions: { list: { getSnapshot: () => sessionState } },
  workspaces: { list: { getSnapshot: () => ({ archivedSessionIds }) } },
}

let dispose = null
plugin.apply({
  get(name) { return services[name] },
  effect(register) { dispose = register() },
})

await new Promise((resolve) => setTimeout(resolve, 120))
check('首次轮询按顺序跳到通知对应的会话', JSON.stringify(opened) === JSON.stringify(['session-1', 'session-2']), JSON.stringify(opened))
check('轮询用文档相对地址（桌面端 dsh-app://app 才能转发）', fetchCalls[0] === 'dsh-app://app/task-toast/focus/next', fetchCalls[0])

await new Promise((resolve) => setTimeout(resolve, 1600))
check(
  '已归档会话先取消归档、列表同步后再打开',
  JSON.stringify(events) === JSON.stringify([
    'open:session-1', 'open:session-2', 'unarchive:session-archived', 'open:session-archived',
  ]),
  JSON.stringify(events),
)

check('effect 返回清理函数', typeof dispose === 'function')
if (typeof dispose === 'function') dispose()
const callsAtDispose = fetchCalls.length
await new Promise((resolve) => setTimeout(resolve, 900))
check('清理后停止轮询', fetchCalls.length === callsAtDispose, `fetch calls ${callsAtDispose} -> ${fetchCalls.length}`)

// 会话列表还没就绪时保留 pending，不丢点击
const lateLoaded = []
const lateServices = {
  uiWorkspace: { openSession(id) { lateLoaded.push(id) }, async unarchiveSession() {} },
  sessions: { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }) } },
  workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessions: ['session-late'] }) })
const latePlugin = loaded[0].factory(() => {})
let lateDispose = null
let listPhase = 'pending'
latePlugin.apply({
  get(name) { return name === 'sessions' ? { list: { getSnapshot: () => ({ phase: listPhase, byId: {} }) } } : lateServices[name] },
  effect(register) { lateDispose = register() },
})
await new Promise((resolve) => setTimeout(resolve, 120))
check('会话列表未就绪时不误跳', lateLoaded.length === 0, JSON.stringify(lateLoaded))
listPhase = 'ready'
await new Promise((resolve) => setTimeout(resolve, 900))
check('列表就绪后补跳到原会话', JSON.stringify(lateLoaded) === JSON.stringify(['session-late']), JSON.stringify(lateLoaded))
if (typeof lateDispose === 'function') lateDispose()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
