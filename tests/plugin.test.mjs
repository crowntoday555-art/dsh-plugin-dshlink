// Mock harness for lib/client.js — verifies registration + command logic
// outside the browser. Run: node tests/plugin.test.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let pluginFactory = null
const sandbox = { window: { __ModuleLoader__: { load: (entry) => { pluginFactory = entry.factory } } }, console }
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox)

if (typeof pluginFactory !== 'function') throw new Error('FAIL: factory not captured')

const module = { exports: {} }
const exports = module.exports
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
const pluginExports = pluginFactory(() => { throw new Error('unexpected require') })
const target = pluginExports?.apply !== undefined ? pluginExports : exports
if (typeof target.apply !== 'function' || !Array.isArray(target.inject)) {
  throw new Error('FAIL: apply/inject missing: ' + Object.keys(target).join(','))
}
console.log('inject services:', target.inject.join(', '))

const registered = []
const opened = []
const selections = []
const sessionsById = {
  s1: { id: 's1', retainedBy: { mainView: 2 }, pinned: true, lastActivity: 100 },
  s2: { id: 's2', retainedBy: {}, pinned: false, lastActivity: 300 },
  s3: { id: 's3', retainedBy: {}, pinned: false, lastActivity: 200, archived: true },
}
const dir = {
  load: async () => {},
  store: {
    getSnapshot: () => ({
      current: { provider: 'official', model: 'deepseek-chat', reasoningEffort: 'medium' },
      groups: [
        { id: 'official', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
        { id: 'custom', models: [{ id: 'grok-4.5' }] },
      ],
    }),
  },
  catalog: { reasoningFor: () => ({ efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }) },
  select: async (s) => { selections.push(s); return { ok: true } },
}
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get: (n) => (n === 'uiWorkspace' ? { openSession: (id) => {
    opened.push(id)
    // simulate the real main-view switch so next/prev chain correctly
    for (const row of Object.values(sessionsById)) row.retainedBy = {}
    sessionsById[id].retainedBy = { mainView: 1 }
  } } : undefined),
  sessions: { list: { getSnapshot: () => ({ byId: sessionsById }) } },
  modelDirectories: { directoryFor: () => dir },
  shortcuts: { register: (cmd) => { registered.push(cmd); return () => {} } },
}
target.apply(ctx)

const expected = 4 + 2 + 9 // model 2 + effort 2 + session next/prev 2 + session 1-9
if (registered.length !== expected) throw new Error(`FAIL: expected ${expected} commands, got ${registered.length}`)
for (const cmd of registered) {
  const def = cmd.defaults['desktop:windows']
  if (!def || !def.code) throw new Error('FAIL: missing desktop:windows default for ' + cmd.id)
  console.log(' ', cmd.id, '→', def.code, '[' + def.modifiers.join('+') + ']')
}

const byId = Object.fromEntries(registered.map((c) => [c.id, c]))

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }

// model.next: official/deepseek-chat → official/deepseek-reasoner
let r = byId['dshlink.model.next'].resolve({})
assert(r.status === 'handled', 'model.next handled')
await r.run()
assert(selections[0]?.model === 'deepseek-reasoner', 'model.next selected deepseek-reasoner')

// effort.up: medium → high
r = byId['dshlink.effort.up'].resolve({})
assert(r.status === 'handled', 'effort.up handled')
await r.run()
assert(selections[1]?.reasoningEffort === 'high', 'effort.up selected high')

// effort.down from medium → low
r = byId['dshlink.effort.down'].resolve({})
await r.run()
assert(selections[2]?.reasoningEffort === 'low', 'effort.down went medium → low')

// session order: pinned s1 first, then s2 (s3 archived skipped)
r = byId['dshlink.session.next'].resolve({})
assert(r.status === 'handled', 'session.next handled')
r.run()
assert(opened[0] === 's2', 'session.next opened s2 from s1')

r = byId['dshlink.session.prev'].resolve({})
r.run()
assert(opened[1] === 's1', 'session.prev opened s1 from s2')

r = byId['dshlink.session.3'].resolve({})
assert(r.status === 'blocked' && r.reason === '没有更多会话', 'session.3 blocked (only 2 live sessions)')

// no-session guard: empty session map
const emptyCtx = { ...ctx, sessions: { list: { getSnapshot: () => ({ byId: {} }) } } }
// re-apply to a fresh registry to test guard paths is overkill; direct check via resolve on empty current:
sessionsById.s1.retainedBy = {}
r = byId['dshlink.model.next'].resolve({})
assert(r.status === 'blocked', 'model.next blocked without an open session')
sessionsById.s1.retainedBy = { mainView: 2 }

console.log('ALL TESTS PASSED ✓  (commands:', registered.length + ')')
