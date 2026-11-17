// smoke-test-plugin.mjs — load the task-toast plugin exactly as DSH would and simulate events
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginDir = fileURLToPath(new URL('.', import.meta.url));
const entry = pathToFileURL(pluginDir + 'lib/index.js').href;

const mod = await import(entry);
console.log('exports:', Object.keys(mod));
console.log('name   :', mod.name);
console.log('apply  :', typeof mod.apply);

const listeners = {};
const effects = [];
const ctx = {
  on(ev, fn) { listeners[ev] = fn; return () => { delete listeners[ev]; }; },
  effect(fn) { effects.push(fn); return () => {}; },
  logger: {
    info: (m) => console.log('[host]', m),
    warn: (m) => console.log('[host:warn]', m),
    error: (m) => console.log('[host:err]', m),
  },
};

// registerProtocol:false keeps this manual smoke test from writing HKCU; it only pops toasts.
mod.apply(ctx, { registerProtocol: false });
console.log('listeners:', Object.keys(listeners));

const session = { id: 'sess-smoke', title: '冒烟测试会话' };
const fire = (type, data) => {
  console.log('\n>> event:', type, JSON.stringify(data));
  listeners['session/event'](session, { type, data });
};

// 1. normal completed turn
fire('turn/start', { turn: 1 });
await new Promise((r) => setTimeout(r, 300));
fire('turn/end', { turn: 1, reason: { kind: 'completed' } });

// 2. errored turn
await new Promise((r) => setTimeout(r, 5000));
fire('turn/start', { turn: 2 });
await new Promise((r) => setTimeout(r, 200));
fire('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'LLM_TIMEOUT', message: '请求模型超时' } } });

// 3. approval asked
await new Promise((r) => setTimeout(r, 5000));
fire('approval/asked', { id: 'a1', toolName: 'pwsh', reason: '执行命令前需确认' });

console.log('\nsmoke test done, waiting for child processes...');
await new Promise((r) => setTimeout(r, 4000));
