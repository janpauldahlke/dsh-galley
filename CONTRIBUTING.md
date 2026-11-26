# Contributing to `dsh-galley`

`dsh-galley` is an out-of-tree dual-face plugin (`lib/index.js` ESM Host + `lib/client.js` CJS `__ModuleLoader__` Client) for **DeepSeek Harness** (`dsh`).

## Build & Verification

```sh
npm install
npm run build        # bundles via dsh-build-tools + runs tsc --noEmit
npm test             # builds + runs hermetic & compiler-backed node --test suite
npm pack --dry-run   # audits published tarball contents
```

All tests use Node's built-in runner (`node --test`) with zero external test frameworks and exercise the real `GalleyStore`, `NativeArm`, offline `WasmArm`, HTTP dispatcher, and ZIP/OOXML outputs.

## Architectural Guardrails

1. **Bounded Context & English-First Core:**
   - `dsh-galley` owns domain-neutral block co-authoring, provenance (`🔓 Auto` vs `🔒 Review`), `dependsOn` staleness, instant Typst proofing, and deterministic `.pdf` / `.docx` / `.typ` / `.tex` / `.md` export.
   - Core UI strings, preflight messages, tool schemas, and built-in templates (`worksheet`, `rfc`, `generic`) remain domain-neutral English (`src/shared/i18n.ts`, with `de` stubbed for printed document labels when `packet.locale === 'de'`).
   - Domain-specific template packs and custom preflight rules belong in companion Cordis leaf plugins consuming `ctx.galley.registerTemplate(...)` and `ctx.galley.registerPreflight(...)` (e.g. `dsh-galley-templates`).
2. **Offline-First & Electron-Safe Assets:**
   - Never add `postinstall` downloads or runtime CDN font fetches.
   - Keep `src/typst/` and `src/host/docx.ts` free of harness or transitive npm dependencies so `lib/typst-render.mjs` and `lib/galley-core.mjs` remain standalone `node:`-builtin modules.
   - Load bundled assets (`fonts/*`) via `node:fs` buffers relative to module URLs so the package runs identically in `npm` profiles and Electron `.asar` bundles.
3. **Local Acceptance Etiquette:**
   - Never run broad process kills (`pkill dsh`, `pkill node`) or touch primary operator ports (`:3080`, `:8080`, `:11434`). Run isolated web acceptance checks on a dedicated secondary port (e.g. `:3090`).

## Extending `dsh-galley` via `ctx.galley`

Companion Cordis plugins can register templates and preflight checks with automatic disposal:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-galley-pack'
export const inject = ['galley']

export function apply(ctx: Context & { galley: any }): void {
  const dispose = ctx.galley.registerTemplate({
    id: 'lab-report',
    title: 'Lab Report',
    source: 'plugin',
    sheets: [
      {
        id: 's1',
        title: 'Report',
        geometry: { paper: 'a4', margin: { top: 2, right: 2, bottom: 2, left: 2 } },
        starterBlocks: [
          { type: 'header', fields: { titel: 'Lab Report', fach: 'Physics', datum: '' } },
          { type: 'heading', level: 1, body: '1. Apparatus & Observations' },
          { type: 'prose', body: 'Record measurements below.' },
        ],
      },
    ],
  })
  ctx.effect(() => dispose)
}
```
