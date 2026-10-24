# dsh-plugin-dshlink

Extended shortcuts for **DeepSeek Harness** (desktop + web): model switching, reasoning-effort cycling, and session navigation. Companion plugin of [大烧货LINK / DSHLink](https://github.com/crowntoday555-art/dshlink) — a HarmonyOS watch remote for DSH.

## 0.2.2 — 2026-10-24

Fixed a startup crash against DSH 0.2.1-rc.3 ("web boot: entry did not activate /
dsh-plugin-dshlink: failed"):

- Shortcut modifiers now use `"primary"` instead of hardcoded `"control"`.
  On `web:macos` a `control+alt` default is rejected by `isWebBindingAllowed`
  (macOS web requires `meta`/primary), which made `ctx.shortcuts.register()`
  throw during activation and abort the whole web boot.
- Dropped `desktop:linux`/`web:linux` default profiles: the Linux rule set
  reserves Arrow-key defaults ("Reserved shortcut default").
- `regions` now includes `"terminal"` so watch-driven commands also fire while
  a terminal pane has focus.
- The mock test harness now ports the real registry validation
  (normalizeBinding / isWebBindingAllowed / bindingIssue / built-in conflict
  table) so regressions of this class fail in `node tests/plugin.test.mjs`.

## Shortcuts (Windows/Linux; macOS swaps Ctrl for ⌘)

| Action | Default keys |
|---|---|
| Switch to next model | `Ctrl+Alt+M` |
| Switch to previous model | `Ctrl+Alt+Shift+M` |
| Reasoning effort up | `Ctrl+Alt+U` |
| Reasoning effort down | `Ctrl+Alt+J` |
| Next session | `Ctrl+Alt+↓` |
| Previous session | `Ctrl+Alt+↑` |
| Switch to session 1–9 | `Ctrl+Alt+1` … `Ctrl+Alt+9` |

All bindings are rebindable in DSH via `Ctrl+/` (shortcut cheat sheet / settings). Session order: pinned first, then most recent activity; archived sessions are skipped.

## Install

Requires Node.js ≥ 22 and pnpm.

```
npx --yes -p @deepseek-ai/dsh dsh plugin --profile desktop add github:crowntoday555-art/dsh-plugin-dshlink
```

(or `--profile web` for the browser client). Restart DeepSeek Harness after installing.

## Uninstall

```
npx --yes -p @deepseek-ai/dsh dsh plugin --profile desktop remove dsh-plugin-dshlink
```

## How it works

Client-side Cordis bundle. Registers `dshlink.*` shortcut commands through the official `ctx.shortcuts.register` API; model/effort changes go through the official per-session model directory (`sessions.selectModel`), and session switching through the workspace service (`openSession`). No DOM scraping, no network requests of its own.

## License

MIT
