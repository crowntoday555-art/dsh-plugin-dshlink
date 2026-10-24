/** Node-side (host) half: all shortcut logic lives in lib/client.js (web client bundle). */
export const name = 'dsh-plugin-dshlink'

/** Host-side dependencies: none — the host half is a passive marker. */
export const inject = []

/**
 * Host-side no-op apply: the bundle must resolve to a valid cordis plugin
 * (function or object with an "apply" method) or the 0.2.x loader rejects it
 * with "invalid plugin ... received object". Real behaviour is client-side.
 */
export function apply(ctx, config) {
}
