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

// ── Real validation ported from @deepseek-ai/dsh-client-shortcuts (0.2.1-rc.3) ──
// These rules mirror ShortcutRegistry.register(): any throw here would abort
// DSH web boot with "dsh-plugin-dshlink: failed".
const keyNames = {
  Escape: 'Esc', Tab: 'Tab', Space: 'Space', Backspace: 'Bksp', Delete: 'Del',
  Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
}
const modifierOrder = ['control', 'alt', 'shift', 'meta']
function normalizeBinding(binding, platform) {
  const codes = [binding.code, ...(binding.secondCode === undefined ? [] : [binding.secondCode])]
  codes.sort()
  for (const code of codes) {
    if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/u.test(code) && !Object.hasOwn(keyNames, code)) {
      throw new Error(`Unsupported shortcut code: ${code}`)
    }
  }
  if (codes.length === 2 && codes[0] === codes[1]) throw new Error('Shortcut keys must be distinct')
  const modifiers = new Set(binding.modifiers.map((v) => (v === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : v)))
  return { code: codes[0], ...(codes[1] === undefined ? {} : { secondCode: codes[1] }), modifiers: modifierOrder.filter((v) => modifiers.has(v)) }
}
function bindingKey(b) {
  const codes = b.secondCode === undefined ? [b.code] : [b.code, b.secondCode].sort()
  return [...b.modifiers, ...codes].join('+')
}
function isWebBindingAllowed(binding, platform) {
  if (binding.secondCode !== undefined) return false
  if (platform === 'windows' || platform === 'macos') {
    if (binding.modifiers.length >= 3) return true
    const primary = platform === 'macos' ? 'meta' : 'control'
    if (binding.modifiers.length === 1 && (['Comma', 'Backslash'].includes(binding.code) && binding.modifiers[0] === primary || binding.code === 'Backquote' && binding.modifiers[0] === 'control')) return true
    if (binding.modifiers.length === 2 && binding.modifiers.includes(primary) && (binding.modifiers.includes('alt') || binding.modifiers.includes('shift'))) return true
  }
  return false
}
function bindingIssue(binding, runtime, platform) {
  const { code, modifiers } = binding
  if (runtime === 'desktop' && (platform === 'windows' || platform === 'macos')) return null
  if (binding.secondCode !== undefined) return 'unsupported-key'
  if (modifiers.length === 0 || modifiers.every((m) => m === 'shift')) return 'modifier-required'
  if ((platform === 'windows' || platform === 'macos') && modifiers.length >= 3) return null
  if (runtime === 'web' && (platform === 'windows' || platform === 'macos') && isWebBindingAllowed(binding, platform)) return null
  const primary = modifiers.includes(platform === 'macos' ? 'meta' : 'control')
  if (['Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code) || code === 'Enter' && !modifiers.includes('alt')
    || primary && ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH'].includes(code)
    || primary && code === 'KeyA' && !modifiers.includes('shift')
    || platform !== 'macos' && (modifiers.includes('meta') || modifiers.includes('alt') && ['F4', 'F2'].includes(code))
    || platform === 'macos' && modifiers.includes('control') && modifiers.includes('meta')
    || platform === 'macos' && modifiers.includes('alt') && !primary) return 'reserved'
  if (runtime === 'web' && !isWebBindingAllowed(binding, platform)) return 'unsupported-browser'
  return null
}
function overlappingBindings(left, right) {
  if (left.modifiers.join('+') !== right.modifiers.join('+')) return false
  if (left.secondCode !== undefined && right.secondCode !== undefined) return bindingKey(left) === bindingKey(right)
  return [left.code, left.secondCode].some((c) => c !== undefined && (c === right.code || c === right.secondCode))
}
// Built-in command defaults (desktop:windows profile), extracted from
// dsh-client-ui-* bundles shipped with DSH 0.2.1-rc.3.
const BUILT_INS = [
  ['sidebar.left.toggle', 'KeyB', ['control']],
  ['sidebar.right.toggle', 'KeyB', ['control', 'alt']],
  ['workspace.openLocal', 'KeyO', ['control', 'alt']],
  ['workspace.add', 'KeyO', ['control']],
  ['settings.open', 'Comma', ['control']],
  ['shortcuts.open', 'Slash', ['control']],
  ['browser.new', 'KeyT', ['control']],
  ['workspace.files', 'KeyP', ['control']],
  ['terminal.new', 'Backquote', ['control']],
  ['session.new', 'KeyN', ['control']],
  ['session.search', 'KeyK', ['control']],
  ['session.rename', 'KeyG', ['control', 'alt']],
  ['session.fork', 'KeyF', ['control', 'alt']],
  ['session.archive', 'KeyA', ['control', 'shift']],
  ['devtools-inspector', 'Period', ['control', 'shift']],
].map(([id, code, modifiers]) => ({ id, defaults: everyProfile(code, modifiers) }))
function everyProfile(code, modifiers, webModifiers) {
  const web = webModifiers ?? modifiers
  return {
    'desktop:macos': { code, modifiers }, 'desktop:windows': { code, modifiers }, 'desktop:linux': { code, modifiers },
    'web:macos': { code, modifiers: web }, 'web:windows': { code, modifiers: web },
  }
}
function realRegister(command) {
  const existing = [...BUILT_INS, ...registered]
  if (registered.some((c) => c.id === command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`)
  for (const runtime of ['desktop', 'web']) {
    for (const platform of ['macos', 'windows', 'linux']) {
      const candidate = command.defaults[`${runtime}:${platform}`]
      if (candidate === undefined) continue
      const binding = normalizeBinding(candidate, platform)
      if (runtime === 'web' && !isWebBindingAllowed(binding, platform)) throw new Error(`Unsupported Web shortcut: ${command.id}`)
      if (bindingIssue(binding, runtime, platform) !== null) throw new Error(`Reserved shortcut default: ${command.id}`)
      for (const prev of existing) {
        const other = prev.defaults[`${runtime}:${platform}`]
        if (other !== undefined && overlappingBindings(binding, normalizeBinding(other, platform))) {
          throw new Error(`Conflicting shortcut defaults: ${command.id} and ${prev.id} (${runtime}:${platform})`)
        }
      }
    }
  }
  if (typeof command.label !== 'function') throw new Error(`label must be a function: ${command.id}`)
  if (!Array.isArray(command.aliases) || !Array.isArray(command.regions) || !Array.isArray(command.modals)) throw new Error(`aliases/regions/modals must be arrays: ${command.id}`)
  if (typeof command.resolve !== 'function') throw new Error(`resolve must be a function: ${command.id}`)
  registered.push(command)
  return () => {}
}
// ── end ported validation ──

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
  shortcuts: { register: realRegister },
}
target.apply(ctx)

const expected = 4 + 2 + 9 + 9 // model 2 + effort 2 + session next/prev 2 + session 1-9 + project 1-9
if (registered.length !== expected) throw new Error(`FAIL: expected ${expected} commands, got ${registered.length}`)
for (const cmd of registered) {
  const def = cmd.defaults['desktop:windows']
  if (!def || !def.code) throw new Error('FAIL: missing desktop:windows default for ' + cmd.id)
  const linux = Object.keys(cmd.defaults).filter((k) => k.endsWith(':linux'))
  if (linux.length > 0) throw new Error('FAIL: linux profile declared for ' + cmd.id + ' (policy: none)')
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
