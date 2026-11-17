// _smoke-click.mjs — 验证「点击通知 → 跳到会话」的宿主侧链路（不需要重启 DSH）
//   node _smoke-click.mjs
// 覆盖：launch URI 生成 → 点击队列消费（顺序/去重/过期/坏行）→ HTTP 路由响应。
// 不弹真实通知、不改注册表。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  CLICK_LAUNCHER,
  FOCUS_SCRIPT,
  IS_WINDOWS,
  QUEUE_TTL_MS,
  SCRIPTS_DIR,
  TOAST_SCRIPT,
  clickHandlerPath,
  consumeFocusQueue,
  createFocusRoute,
  focusQueueFile,
  installClickHandler,
  launchUriFor,
} from './lib/focus.js'
import { apply, toastArgs } from './lib/index.js'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

const queue = focusQueueFile()
fs.mkdirSync(path.dirname(queue), { recursive: true })
const writeQueue = (records) => {
  fs.writeFileSync(queue, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// ---------- 1. launch URI 复用 session.id ----------
const sid = 'session-11111111-2222-3333-4444-555555555555'
check('launchUriFor 复用 session.id', launchUriFor(sid) === 'dsh-task-toast://focus/' + sid, launchUriFor(sid))
check('launchUriFor 空标识不带 URI', launchUriFor('') === '' && launchUriFor(undefined) === '' && launchUriFor('   ') === '')
check('launchUriFor 编码不安全的字符', launchUriFor('session a/b') === 'dsh-task-toast://focus/session%20a%2Fb', launchUriFor('session a/b'))

// ---------- 2. 队列消费（焦点脚本写入的 JSONL） ----------
const now = Date.now()
writeQueue([
  { sessionId: 'session-a', at: now },
  { sessionId: 'session-a', at: now }, // 连续重复只跳一次
  { sessionId: 'session-b', at: now + 10 },
  { sessionId: 'session-expired', at: now - QUEUE_TTL_MS - 1000 },
  { sessionId: '', at: now },
])
const consumed = consumeFocusQueue(now)
check('按点击顺序返回、连续去重、过滤过期/空标识', JSON.stringify(consumed) === JSON.stringify(['session-a', 'session-b']), JSON.stringify(consumed))
check('消费后队列文件被取走', !fs.existsSync(queue))
check('空队列返回 []', JSON.stringify(consumeFocusQueue(now)) === '[]')

fs.writeFileSync(queue, 'not-json\n{"sessionId":"session-c","at":' + now + '}\n', 'utf8')
check('坏行跳过，好行保留', JSON.stringify(consumeFocusQueue(now)) === JSON.stringify(['session-c']))

// ---------- 3. HTTP 路由 ----------
writeQueue([{ sessionId: 'session-route', at: Date.now() }])
function callRoute(method, headers = {}, options = {}) {
  const handler = createFocusRoute(options)
  const result = { status: 0, headers: null, body: undefined }
  handler(
    { method, headers },
    {
      writeHead(status, hdrs) { result.status = status; result.headers = hdrs },
      end(body) { result.body = body },
    },
  )
  return result
}
const ok = callRoute('GET')
const payload = JSON.parse(ok.body)
check('GET 返回 { sessions } 且 status=200', ok.status === 200 && payload.sessions.length === 1 && payload.sessions[0] === 'session-route', ok.body)
check('响应禁止缓存且是 JSON', ok.headers['cache-control'] === 'no-store' && /application\/json/.test(ok.headers['content-type']))
check('第二次 GET 为空（一次点击只消费一次）', JSON.parse(callRoute('GET').body).sessions.length === 0)
check('POST 返回 405', callRoute('POST').status === 405)

// 跨站 Origin 被拒绝；桌面代理(/同源)没有 Origin 或带 dsh-app://app 时放行
writeQueue([{ sessionId: 'session-origin', at: Date.now() }])
const origin = 'http://127.0.0.1:55559'
check('陌生 Origin 返回 403', callRoute('GET', { origin: 'https://evil.example' }, { origin }).status === 403)
check('Host 自己的 Origin 放行', JSON.parse(callRoute('GET', { origin }, { origin }).body).sessions.length === 1)
writeQueue([{ sessionId: 'session-desktop', at: Date.now() }])
check('dsh-app://app 放行（桌面代理会剥掉 Origin，这里覆盖带 Origin 的情况）', JSON.parse(callRoute('GET', { origin: 'dsh-app://app' }, { origin }).body).sessions.length === 1)

// ---------- 4. 真实 HTTP（IncomingMessage/ServerResponse 契约） ----------
const server = http.createServer((req, res) => createFocusRoute({ origin })(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
try {
  writeQueue([{ sessionId: 'session-http', at: Date.now() }])
  const first = await fetch(`http://127.0.0.1:${port}/task-toast/focus/next`)
  const firstBody = await first.json()
  check('真实 HTTP GET 返回会话标识', first.status === 200 && firstBody.sessions[0] === 'session-http', JSON.stringify(firstBody))
  const second = await fetch(`http://127.0.0.1:${port}/task-toast/focus/next`)
  check('真实 HTTP 第二次为空', (await second.json()).sessions.length === 0)
  const crossSite = await fetch(`http://127.0.0.1:${port}/task-toast/focus/next`, { headers: { origin: 'https://evil.example' } })
  check('真实 HTTP 跨站 Origin 被拒', crossSite.status === 403, String(crossSite.status))
} finally {
  await new Promise((resolve) => server.close(resolve))
}

// ---------- 5. 通知参数：只多带点击目标，文案/样式参数完全不变 ----------
const toast = { title: '✅ DSH 任务完成', body: '示例会话：已完成', kind: 'ok', sid: 'session-42' }
const clickableArgs = toastArgs({ ...toast, clickable: true })
const launchIndex = clickableArgs.indexOf('-LaunchUri')
check(
  'clickReady 时通知带 -LaunchUri 且指向该会话',
  launchIndex >= 0 && clickableArgs[launchIndex + 1] === 'dsh-task-toast://focus/session-42',
  String(clickableArgs[launchIndex + 1]),
)
check(
  '标题/正文/样式参数与旧版一致',
  clickableArgs.includes('-Title') && clickableArgs[clickableArgs.indexOf('-Title') + 1] === toast.title &&
    clickableArgs[clickableArgs.indexOf('-Body') + 1] === toast.body &&
    clickableArgs[clickableArgs.indexOf('-Kind') + 1] === 'ok' &&
    clickableArgs[clickableArgs.indexOf('-AppId') + 1] === 'com.deepseek.dsh',
)
check('clickReady=false 时不带 -LaunchUri（退回旧行为）', !toastArgs({ ...toast, clickable: false }).includes('-LaunchUri'))
check('没有会话标识时不带 -LaunchUri', !toastArgs({ ...toast, sid: undefined, clickable: true }).includes('-LaunchUri'))
check('通知脚本参数指向包内脚本', clickableArgs[clickableArgs.indexOf('-File') + 1] === TOAST_SCRIPT, clickableArgs[clickableArgs.indexOf('-File') + 1])

// ---------- 5b. 包内路径 / 点击处理器安装 ----------
check('平台判定与 Node 一致', IS_WINDOWS === (process.platform === 'win32'), process.platform)
check('通知脚本在包内且存在', fs.existsSync(TOAST_SCRIPT) && TOAST_SCRIPT.startsWith(SCRIPTS_DIR), TOAST_SCRIPT)
check('点击启动器在包内且存在', fs.existsSync(CLICK_LAUNCHER) && CLICK_LAUNCHER.startsWith(SCRIPTS_DIR), CLICK_LAUNCHER)
const launcherExists = fs.existsSync(CLICK_LAUNCHER)
const clickHandler = clickHandlerPath()
check(
  launcherExists ? '点击处理器优先 wscript 启动器（无窗口）' : '没有启动器时回退 focus.ps1',
  launcherExists ? clickHandler === CLICK_LAUNCHER : clickHandler === FOCUS_SCRIPT,
  clickHandler,
)
check('选中的点击处理器文件存在', fs.existsSync(clickHandler))

const installDir = path.join(os.tmpdir(), `dsh-task-toast-install-${process.pid}`)
try {
  fs.rmSync(installDir, { recursive: true, force: true })
  const installed = installClickHandler(installDir)
  check('installClickHandler 复制处理器到稳定目录', !!installed && fs.existsSync(installed.focus) && fs.existsSync(installed.register), installDir)
  check('稳定副本与包内脚本内容一致', !!installed && fs.readFileSync(installed.focus).equals(fs.readFileSync(FOCUS_SCRIPT)))
  if (launcherExists) {
    check('启动器一并复制', !!installed && installed.launcher !== null && fs.existsSync(installed.launcher))
  }
  const again = installClickHandler(installDir)
  check('重复安装是幂等的（内容相同不重写）', !!again && again.launcher === (launcherExists ? installed.launcher : null))
} finally {
  try { fs.rmSync(installDir, { recursive: true, force: true }) } catch (err) {}
}

// ---------- 6. Host 插件装配（不弹通知、不写注册表） ----------
const routes = []
const subscriptions = []
const mockCtx = {
  on(event) { subscriptions.push(event); return () => {} },
  effect(fn) { return () => {} },
  inject(deps, callback) {
    callback({
      webServer: {
        getOrigin: () => origin,
        register: (route) => { routes.push(route); return () => {} },
      },
    })
    return { await() {} }
  },
  logger: { info() {} },
}
apply(mockCtx, { registerProtocol: false })
check('apply 订阅 session/event', subscriptions.includes('session/event'))
check(
  'apply 注册 exact 路由 /task-toast/focus/next',
  routes.length === 1 && routes[0].kind === 'exact' && routes[0].path === '/task-toast/focus/next',
  JSON.stringify(routes.map((route) => [route.kind, route.path])),
)

// 清理测试队列，避免影响真实插件
try { fs.unlinkSync(queue) } catch (err) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
