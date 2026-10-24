// dsh-plugin-dshlink — extended shortcuts for DeepSeek Harness
//
// Registers dshlink.* shortcut commands (desktop + web) for:
//   * model cycling        Ctrl+Alt+M / Ctrl+Alt+Shift+M
//   * reasoning effort     Ctrl+Alt+U (up) / Ctrl+Alt+J (down)
//   * session navigation   Ctrl+Alt+Up/Down (prev/next), Ctrl+Alt+1..9 (direct)
//
// APIs (verified against DSH 0.2.0 bundles):
//   ctx.shortcuts.register({ id, label, aliases, defaults, regions, modals, resolve })
//   ctx.sessions.list.getSnapshot().byId          — { id -> { id, retainedBy, lastActivity?, ... } }
//   ctx.get('uiWorkspace').openSession(sessionId) — reveal a session in the main view
//   ctx.modelDirectories.directoryFor(sessionId)  — { load(), store.getSnapshot(), select(), catalog.reasoningFor() }
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dshlink',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = ['shortcuts', 'sessions', 'uiWorkspace', 'modelDirectories', 'workspaces', 'remote', 'remote.session']

    /** Snapshot of the sessions service list, tolerant of unavailable service. */
    function sessionsOf(ctx) {
      try {
        return ctx.sessions.list.getSnapshot()
      } catch (error) {
        return undefined
      }
    }

    /** The session currently retained by the main view, if any. */
    function currentSession(ctx) {
      const list = sessionsOf(ctx)
      if (list === undefined) return undefined
      return Object.values(list.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)
    }

    /**
     * Ordered non-archived session ids for navigation: pinned rows first
     * (stable by recency), then the rest by last activity, newest first.
     * Tolerates missing fields; de-duplicates.
     */
    function orderedSessionIds(ctx) {
      const list = sessionsOf(ctx)
      if (list === undefined) return []
      const seen = new Set()
      const rows = []
      for (const row of Object.values(list.byId)) {
        if (row === undefined || row.id === undefined || seen.has(row.id)) continue
        if (row.archived === true) continue
        seen.add(row.id)
        rows.push(row)
      }
      const activity = (row) => Number.isFinite(row.lastActivity) ? row.lastActivity : 0
      rows.sort((left, right) => {
        const pin = (right.pinned === true ? 1 : 0) - (left.pinned === true ? 1 : 0)
        return pin !== 0 ? pin : activity(right) - activity(left)
      })
      return rows.map((row) => row.id)
    }

    /** Reveal a session in the main view through the workspace service. */
    function openSession(ctx, sessionId) {
      try {
        ctx.get('uiWorkspace')?.openSession(sessionId)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * Flat model list from the per-session directory catalog.
     * Returns [{ provider, model }] in catalog group order.
     */
    async function modelList(directory) {
      if (directory === undefined) return []
      try {
        await directory.load()
      } catch (error) {
        /* catalog may already be loaded; a failed refresh is not fatal */
      }
      const snapshot = directory.store.getSnapshot()
      const groups = snapshot?.groups ?? []
      const list = []
      for (const group of groups) {
        for (const model of group.models ?? []) {
          list.push({ provider: group.id, model: model.id })
        }
      }
      return list
    }

    /** Current selection of a session directory: projected next, else catalog default. */
    function currentSelection(directory) {
      const snapshot = directory?.store?.getSnapshot?.()
      if (snapshot === undefined) return undefined
      if (snapshot.current !== undefined && snapshot.current !== null) return snapshot.current
      return snapshot.pending ?? undefined
    }

    function apply(ctx) {
      const register = (id, label, aliases, defaults, resolve) => {
        ctx.effect(() => ctx.shortcuts.register({
          id,
          label,
          aliases,
          defaults,
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve
        }), `dshlink-extend: ${id}`)
      }

      // 修饰键用 "primary"：macOS 归一化为 Cmd，Windows/Linux 为 Ctrl。
      // 不声明 linux 档（linux 规则保留 Arrow 键默认值）。
      // web 档要求 ≥primary+alt 或三修饰键，否则 isWebBindingAllowed 拒绝——
      // 0.2.1 硬编码 'control' 使 web:macos 抛 "Unsupported Web shortcut"，
      // web boot 因此判定 dsh-plugin-dshlink 激活失败，DSH 无法启动。
      const crossPlatform = (code, modifiers) => ({
        'desktop:macos': { code, modifiers },
        'desktop:windows': { code, modifiers },
        'web:macos': { code, modifiers },
        'web:windows': { code, modifiers }
      })

      // ── Model cycling ────────────────────────────────────────────────
      const cycleModel = (ctx2, step) => () => {
        const session = currentSession(ctx2)
        if (session === undefined) {
          return { status: 'blocked', reason: '没有打开的会话' }
        }
        return {
          status: 'handled',
          run: async () => {
            try {
              const directory = ctx2.modelDirectories.directoryFor(session.id)
              const list = await modelList(directory)
              if (list.length === 0) return
              const current = currentSelection(directory)
              let index = current === undefined ? -1 : list.findIndex((row) => row.provider === current.provider && row.model === current.model)
              if (index < 0) index = 0
              const next = list[(index + step + list.length) % list.length]
              await directory.select(next)
            } catch (error) {
              /* selection failures surface through the picker store */
            }
          }
        }
      }
      register('dshlink.model.next', () => '切换到下一个模型', ['next model'], crossPlatform('KeyM', ['primary', 'alt']), (context) => cycleModel(ctx, 1)())
      register('dshlink.model.prev', () => '切换到上一个模型', ['previous model'], crossPlatform('KeyM', ['primary', 'alt', 'shift']), (context) => cycleModel(ctx, -1)())

      // ── Reasoning effort ─────────────────────────────────────────────
      // 与官方模型选择器同语义：reasoning 元数据（efforts/defaultEffort）仅在
      // catalog.load() 后才从远端填充，store.current 也在 load 后同步——必须
      // 先 load 再读，否则读到空目录静默退出（0.2.2 及之前 Ctrl+Alt+U/J 无效）。
      const cycleEffort = (ctx2, step) => () => {
        const session = currentSession(ctx2)
        if (session === undefined) {
          return { status: 'blocked', reason: '没有打开的会话' }
        }
        return {
          status: 'handled',
          run: async () => {
            try {
              const directory = ctx2.modelDirectories.directoryFor(session.id)
              await directory.load().catch(() => {})
              const snapshot = directory.store.getSnapshot()
              const current = snapshot.current ?? snapshot.pending
              if (current === undefined || current === null) return
              const reasoning = directory.catalog?.reasoningFor?.(current)
              const levels = (reasoning?.efforts ?? [])
                .map((level) => level?.id)
                .filter((id) => typeof id === 'string' && id.length > 0)
              if (levels.length === 0) return
              // 当前档位：显式值 → 目录默认档 → 第一档
              const effortNow = current.reasoningEffort ?? reasoning?.defaultEffort
              let index = levels.indexOf(effortNow)
              if (index < 0) index = levels.indexOf(reasoning?.defaultEffort)
              if (index < 0) index = 0
              const next = levels[(index + step + levels.length) % levels.length]
              await directory.select({ provider: current.provider, model: current.model, reasoningEffort: next })
            } catch (error) {
              /* selection failures surface through the picker store */
            }
          }
        }
      }
      register('dshlink.effort.up', () => '推理强度：升高一档', ['effort up'], crossPlatform('KeyU', ['primary', 'alt']), (context) => cycleEffort(ctx, 1)())
      register('dshlink.effort.down', () => '推理强度：降低一档', ['effort down'], crossPlatform('KeyJ', ['primary', 'alt']), (context) => cycleEffort(ctx, -1)())

      // ── Session navigation ───────────────────────────────────────────
      const stepSession = (ctx2, delta) => () => {
        const ids = orderedSessionIds(ctx2)
        if (ids.length < 2) {
          return { status: 'blocked', reason: '没有可切换的会话' }
        }
        const current = currentSession(ctx2)
        const index = current === undefined ? -1 : ids.indexOf(current.id)
        const next = ids[(index + delta + ids.length) % ids.length]
        return {
          status: 'handled',
          run: () => { openSession(ctx2, next) }
        }
      }
      register('dshlink.session.next', () => '切换到下一个会话', ['next session'], crossPlatform('ArrowDown', ['primary', 'alt']), (context) => stepSession(ctx, 1)())
      register('dshlink.session.prev', () => '切换到上一个会话', ['previous session'], crossPlatform('ArrowUp', ['primary', 'alt']), (context) => stepSession(ctx, -1)())

      const nthSession = (ctx2, slot) => () => {
        const ids = orderedSessionIds(ctx2)
        if (slot >= ids.length) {
          return { status: 'blocked', reason: '没有更多会话' }
        }
        return {
          status: 'handled',
          run: () => { openSession(ctx2, ids[slot]) }
        }
      }
      const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']
      digits.forEach((code, offset) => {
        register(`dshlink.session.${offset + 1}`, () => `切换到第 ${offset + 1} 个会话`, [`session ${offset + 1}`], crossPlatform(code, ['primary', 'alt']), (context) => nthSession(ctx, offset)())
      })

      // ── Project navigation（大烧货LINK 进度页长按直达）────────────────
      // 与引擎侧项目卡片同序：按「工作区内会话最近活动」降序，跳过空工作区。
      const workspacesOf = (ctx2) => {
        try {
          return ctx2.workspaces?.state?.getSnapshot?.().items ?? []
        } catch (error) {
          return []
        }
      }
      const workspaceActivity = (list, sessionIds) => {
        let max = 0
        for (const sid of sessionIds ?? []) {
          const row = list?.byId?.[sid]
          if (row !== void 0 && Number.isFinite(row.lastActivity) && row.lastActivity > max) max = row.lastActivity
        }
        return max
      }
      const orderedWorkspaceIds = (ctx2) => {
        const items = workspacesOf(ctx2)
        const list = sessionsOf(ctx2)
        return items
          .map((w) => ({ id: w.workspaceId, act: workspaceActivity(list, w.sessionIds) }))
          .filter((w) => w.act > 0)
          .sort((a, b) => b.act - a.act)
          .map((w) => w.id)
      }
      const nthProject = (ctx2, slot) => () => {
        const ids = orderedWorkspaceIds(ctx2)
        if (slot >= ids.length) {
          return { status: 'blocked', reason: '没有更多项目' }
        }
        return {
          status: 'handled',
          run: () => {
            try {
              ctx2.get('uiWorkspace')?.openWorkspace(ids[slot])
            } catch (error) {
              /* open failures surface through the workspace UI */
            }
          }
        }
      }
      digits.forEach((code, offset) => {
        register(`dshlink.project.${offset + 1}`, () => `直达第 ${offset + 1} 个项目`, [`project ${offset + 1}`], crossPlatform(code, ['primary', 'alt', 'shift']), (context) => nthProject(ctx, offset)())
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
