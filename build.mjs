/**
 * dsh-galley build — via shared dsh-build-tools.
 *
 * Three artifacts:
 * - lib/index.js   (ESM, node) — host face; `@deepseek-ai/*` external (default)
 *                                + `@myriaddreamin/*` external (native .node
 *                                binary must never be inlined).
 * - lib/client.js  (CJS, browser) — client face; platform baseline external
 *                                (default), ModuleLoader-wrapped.
 * - lib/typst-render.mjs (ESM, node) — HERMETIC block→.typ core; ZERO harness
 *                                externals so `node --test` runs without dsh.
 */
import { buildDshPlugin } from 'dsh-build-tools'

await buildDshPlugin({
  host: { externals: ['@deepseek-ai/*', '@myriaddreamin/*'] },
  modules: [
    { entry: 'src/typst/index.ts', out: 'typst-render.mjs' },
    // HERMETIC M1 core (store + six tools + ast); node: builtins only — the
    // render arm is injected, so `node --test` runs it without dsh or the arms.
    { entry: 'src/host/tools.ts', out: 'galley-core.mjs' },
    // Pure client pane state/protocol helpers for hermetic `node --test`.
    { entry: 'src/client/paneModel.ts', out: 'galley-pane.mjs' },
  ],
})
