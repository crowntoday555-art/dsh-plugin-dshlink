// 决定性诊断：在 vm 中运行 rc.3 官方 ModelDirectoryResolver（stub cordis/remote），
// 让 dsh-plugin-dshlink 的 model/effort 命令对着真实目录实现执行。
// 用法：node tests/rc3-directory.test.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = 'E:/dshlink/_shots'

// ── 最小 snapshot store（对应 @deepseek-ai/dsh-client-store.createSnapshotStore）──
function createSnapshotStore(initial) {
  let value = structuredClone(initial)
  const listeners = new Set()
  const clone = (v) => (typeof v === 'object' && v !== null ? structuredClone(v) : v)
  return {
    getSnapshot: () => value,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    set: (next) => { value = clone(next); for (const l of listeners) l() },
    update: (fn) => {
      const draft = structuredClone(value)
      fn(draft)
      value = draft
      for (const l of listeners) l()
    },
  }
}

// ── 加载 rc.3 model-selection bundle，捕获其 factory ──
let msFactory = null
const msSandbox = { window: { __ModuleLoader__: { load: (e) => { msFactory = e.factory } } }, console }
vm.createContext(msSandbox)
vm.runInContext(readFileSync(join(shots, 'ms_client.js'), 'utf8'), msSandbox)
if (typeof msFactory !== 'function') throw new Error('ms factory not captured')

// ── require 桩 ──
class FakeService {
  constructor(ctx, name) { this.ctx = ctx; this.name = name; ctx[name] = this }
}
const stubs = {
  '@deepseek-ai/cordis': { Service: FakeService, Context: class {}, Fiber: class {} },
  '@deepseek-ai/dsh-client-store': { createSnapshotStore },
  '@deepseek-ai/dsh-client-ui-primitives': { IconDataOutlineRegular: 'icon' },
  'react': { createElement: () => null, useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: () => ({}), useState: (v) => [v, () => {}], forwardRef: (f) => f },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'f' },
  'react-dom': { createRoot: () => ({ render: () => {} }) },
}
const require2 = (name) => {
  if (name in stubs) return stubs[name]
  throw new Error('client-modules: require("' + name + '") missed the module table')
}

const msExports = msFactory(require2)
console.log('ms exports:', Object.keys(msExports).join(', '))
const Resolver = msExports.ModelDirectoryResolver
if (!Resolver) throw new Error('ModelDirectoryResolver not exported')

// ── 假 root ctx：sessions/remote 按 rc.3 契约 ──
const calls = { modelCatalog: 0, selectModel: [] }
const projectedStores = new Map()
// projected（持久投影）：会话 s1 已有投影 {next: deepseek-v32-exp, medium}
const projected = createSnapshotStore({ next: { provider: 'deepseek', model: 'deepseek-v32-exp', reasoningEffort: 'medium' } })
const catalogValue = () => ({
  default: { provider: 'deepseek', model: 'deepseek-v32-exp' },
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [
      { id: 'deepseek-v32-exp', name: 'DeepSeek V3.2-Exp', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultEffort: 'medium' } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } },
    ] },
    { id: 'custom', name: '自定义', models: [{ id: 'grok-4.5', name: 'Grok 4.5' }] },
  ],
  failures: [],
})
const rootCtx = {
  on: () => () => {},
  get: () => undefined,
  sessions: {
    // rc.3 契约：scope → 会话作用域 ctx（有 effect）；binding → 活跃绑定，
    // binding.session.projections.faceOf("modelSelection") 是持久模型选择投影源
    scope: (id) => ({ sessionId: id, effect: (fn) => { fn(); return () => {} } }),
    binding: (id) => ({ session: {
      projections: { faceOf: (name) => projected },
      getSnapshot: () => ({ blank: false }),
    } }),
    subagentAddress: () => undefined,
    list: { getSnapshot: () => ({ byId: {} }) },
  },
  remote: {
    $on: () => {},
    session: {
      modelCatalog: async () => { calls.modelCatalog++; return { ok: true, value: catalogValue() } },
      selectModel: async (req) => { calls.selectModel.push(req); return { ok: true, value: undefined } },
    },
  },
}

const resolver = new Resolver(rootCtx)
console.log('resolver name:', resolver.name)

const catalog = resolver.catalog
const dir = resolver.directoryFor('s1')
console.log('directoryFor(s1) →', dir && dir.constructor?.name)
const snap = await dir.load()
console.log('after load: status=%s current=%j groups=%d', snap.status, snap.current, snap.groups.length)
const reasoning = catalog.reasoningFor(snap.current)
console.log('reasoningFor(current) →', JSON.stringify(reasoning))

// ── 载入我们的插件并对真实 resolver 执行 effort/model 命令 ──
let pluginFactory = null
const pSandbox = { window: { __ModuleLoader__: { load: (e) => { pluginFactory = e.factory } } }, console }
vm.createContext(pSandbox)
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), pSandbox)
const pExports = pluginFactory(require2)

const sessionsById = {
  s1: { id: 's1', retainedBy: { mainView: 1 }, lastActivity: 100 },
}
const registered = []
const ourCtx = {
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
  sessions: { list: { getSnapshot: () => ({ byId: sessionsById }) } },
  modelDirectories: resolver,
  shortcuts: { register: (cmd) => { registered.push(cmd); return () => {} } },
}
pExports.apply(ourCtx)
const byId = Object.fromEntries(registered.map((c) => [c.id, c]))
console.log('registered:', registered.length)

// effort.up：期望 medium → high（经真实目录 + 真实 selectModel 路径）
let r = byId['dshlink.effort.up'].resolve({})
console.log('effort.up resolve →', r.status)
await r.run()
console.log('selectModel calls:', JSON.stringify(calls.selectModel, null, 0))

r = byId['dshlink.effort.down'].resolve({})
await r.run()
r = byId['dshlink.model.next'].resolve({})
console.log('model.next resolve →', r.status)
await r.run()
console.log('selectModel calls:', JSON.stringify(calls.selectModel))
console.log('DIAG DONE')
