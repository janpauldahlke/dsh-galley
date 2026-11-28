/**
 * dsh-galley — host half (M1: store + six tools, dual face).
 *
 * - `inject: ['tools']` — the tools face must work in headless sessions too.
 * - Routes nest under `ctx.inject(['webServer'], …)` so headless profiles
 *   activate the tools without waiting on a web server.
 * - The render arm is chosen by `createPrimaryArm()` (native → WASM fallback);
 *   the native N-API binary stays EXTERNAL in the bundle (never inlined).
 *
 * apply must never throw: each registration degrades to a logged error.
 *
 * Routes:
 * - GET /api/galley/health — liveness { ok, name, version, arm, typst }.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  PLUGIN,
  VERSION,
  HEALTH_ROUTE,
  STATE_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  DOWNLOAD_ROUTE,
  PROPOSAL_ROUTE_PREFIX,
} from '../shared/types.ts'
import type { GalleyPacket, GalleySheet, SourceProvenance } from '../shared/types.ts'
import { renderTypstSource, type GalleyBlock } from '../typst/index.ts'
import { createPrimaryArm, loadBundledFontBlobs, type Arm } from './arms/index.ts'
import {
  createGalleyUserMessage,
  estimateTokens,
  formatGalleyDelta,
  installGalleyInject,
  MAX_INJECT_CHARS,
  scanResumedGalleyState,
  type FormatGalleyDeltaInput,
  type GalleyDeltaSource,
  type GalleyInjectDeps,
} from './inject.ts'
import { registerGalleyRoutes } from './routes.ts'
import { defaultGalleyRegistry, GalleyServiceRegistry, type GalleyService } from './service.ts'
import {
  getStoreForCwd,
  resolveGalleyCwd,
  setSessionActivePacket,
  getSessionActivePacket,
} from './workspace.ts'
import {
  Err,
  MAX_BATCH_OPS,
  galleyOpen,
  galleyStatus,
  galleyReadBlock,
  galleyEditBlock,
  galleyAnnotate,
  galleyExport,
  type GalleyToolsDeps,
} from './tools.ts'

export const name = PLUGIN
export const inject = ['tools']
export {
  HEALTH_ROUTE,
  STATE_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  DOWNLOAD_ROUTE,
  PROPOSAL_ROUTE_PREFIX,
  PLUGIN,
  VERSION,
  MAX_INJECT_CHARS,
  MAX_BATCH_OPS,
  defaultGalleyRegistry,
  GalleyServiceRegistry,
  installGalleyInject,
  formatGalleyDelta,
  scanResumedGalleyState,
  createGalleyUserMessage,
  estimateTokens,
  setSessionActivePacket,
  getSessionActivePacket,
}
export type {
  GalleyService,
  GalleyDeltaSource,
  GalleyInjectDeps,
  FormatGalleyDeltaInput,
  SourceProvenance,
}
// Arms are re-exported so the in-process gate test (test/05) and the health
// probe can drive the real render pipeline; `@myriaddreamin/*` stays external
// (the native .node binary is loaded lazily by NativeArm.init).
export {
  createArm,
  createPrimaryArm,
  NativeArm,
  WasmArm,
  CliArm,
  BUNDLED_FONT_FILES,
  loadBundledFontBlobs,
  resolveBundledFontsDir,
} from './arms/index.ts'
export type { Arm, ArmName } from './arms/index.ts'

/** The sample packet the health probe renders (proves the native arm in-process). */
const SAMPLE_BLOCKS: GalleyBlock[] = [
  { id: 'b1', kind: 'header', text: 'Galley Workbench · Typesetting Probe' },
  { id: 'b2', kind: 'heading', level: 1, text: 'Galley Proof' },
  {
    id: 'b3',
    kind: 'prose',
    text: 'Hello from the native Typst arm. This paragraph contains markup metacharacters that must stay inert: # $ [ ] { } _ ^ | and a quote "here" plus a backslash here.',
  },
  { id: 'b4', kind: 'task', text: 'Task: prove the dual face loads.' },
  { id: 'b5', kind: 'answer', text: 'Answer: the host compiled and the pane rendered the SVG.' },
]

export interface RenderReceipt {
  ok: true
  arm: 'native' | 'wasm' | 'cli'
  typst: string
  pages: number
  pdfBytes: number
  svgBytes: number
  ms: number
}

/**
 * Native render arm (health probe). Lazy-imports the N-API compiler so the
 * host bundle stays thin and the native binary is resolved at first use.
 */
let nativeCompilerPromise: Promise<unknown> | null = null
export function renderTypstNative(source: string): Promise<RenderReceipt> {
  const t0 = Date.now()
  if (!nativeCompilerPromise) {
    nativeCompilerPromise = import('@myriaddreamin/typst-ts-node-compiler')
  }
  return nativeCompilerPromise.then((mod) => {
    const { NodeCompiler } = mod as {
      NodeCompiler: { create(args?: { fontArgs?: Array<{ fontBlobs: Buffer[] }> }): TypstCompiler }
    }
    const fontBlobs = loadBundledFontBlobs()
    const c = NodeCompiler.create(fontBlobs.length > 0 ? { fontArgs: [{ fontBlobs }] } : undefined)
    const r = c.compile({ mainFileContent: source })
    if (r.hasError()) {
      const d = r.takeDiagnostics()
      const msg = (d?.shortDiagnostics ?? []).map((x) => x.message).join(' | ')
      throw new Error(`GALLEY_TYPST_COMPILE_ERROR: ${msg || 'unknown'}`)
    }
    const pdf = c.pdf(r.result) as Uint8Array
    const svg = c.svg(r.result)
    return {
      ok: true,
      arm: 'native',
      typst: '0.14.2',
      pages: r.result.numOfPages,
      pdfBytes: pdf.length,
      svgBytes: typeof svg === 'string' ? svg.length : (svg as Uint8Array).length,
      ms: Date.now() - t0,
    } satisfies RenderReceipt
  })
}

// Minimal structural view of the compiler (avoids pulling the dep's types).
interface TypstCompiler {
  compile(a: { mainFileContent: string }): {
    hasError(): boolean
    takeDiagnostics(): { shortDiagnostics?: Array<{ message: string }> } | null
    result: { numOfPages: number }
  }
  pdf(r: unknown): Uint8Array
  svg(r: unknown): unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function toolErrorResult(error: unknown) {
  return { ok: false as const, error: errorMessage(error) }
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'bytes' in value) {
    const { bytes: _omit, ...compact } = value as Record<string, unknown>
    return [{ type: 'text', text: JSON.stringify(compact, null, 2) }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

// ── Workspace-scoped store + primary arm ────────────────────────────────────

type ExecLike = {
  agent?: {
    session?: {
      id?: string
      header?: { id?: string; cwd?: string }
    }
  }
}

function sessionIdOf(exec?: ExecLike): string | null {
  const sid = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
  return typeof sid === 'string' && sid.trim() ? sid.trim() : null
}

let armPromise: Promise<Arm> | null = null
function getArm(): Promise<Arm> {
  if (!armPromise) armPromise = createPrimaryArm().then((r) => r.arm)
  return armPromise
}

async function getDepsForCwd(cwdParam?: string | null): Promise<{
  deps: GalleyToolsDeps
  root: string
  cwd: string
}> {
  const arm = await getArm()
  const { store, root, cwd } = getStoreForCwd(cwdParam)
  return {
    root,
    cwd,
    deps: {
      store,
      cwd,
      registry: defaultGalleyRegistry,
      render: (sheet: GalleySheet, packet: GalleyPacket, assetBytes?: Record<string, Buffer>) =>
        arm.render(sheet, packet, assetBytes),
    },
  }
}

async function getToolContext(args: Record<string, unknown>, exec?: ExecLike): Promise<{
  deps: GalleyToolsDeps
  root: string
  sessionId: string | null
  effectivePacketId: string | undefined
  unpinnedSession: boolean
}> {
  const explicitCwd = typeof args.cwd === 'string' ? args.cwd : undefined
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const resolved = resolveGalleyCwd(explicitCwd, sessionCwd)
  const { deps, root } = await getDepsForCwd(resolved)
  const sessionId = sessionIdOf(exec)

  let effectivePacketId = typeof args.packetId === 'string' ? args.packetId : undefined
  let unpinnedSession = false
  if (effectivePacketId === undefined && sessionId) {
    // When `sessionId` is present, never fall back to workspace-global `store.getActivePacket()`:
    // an unbound session must return `GALLEY_NO_ACTIVE_PACKET` until `galley_open` binds it.
    const pinned = getSessionActivePacket(root, sessionId)
    if (pinned && deps.store.load(pinned)) {
      effectivePacketId = pinned
    } else {
      unpinnedSession = true
    }
  }
  return { deps, root, sessionId, effectivePacketId, unpinnedSession }
}

function unpinnedSessionFailure() {
  return {
    ok: false as const,
    code: Err.NO_ACTIVE_PACKET,
    message: 'no active packet bound to this session (call galley_open first)',
  }
}

/** Register the six M1 tools (tools face). */
export function registerGalleyTools(ctx: Context): () => void {
  const tools = (ctx as unknown as { tools: { register(def: Record<string, unknown>): () => void } }).tools
  const disposers: (() => void)[] = []
  const register = (def: Record<string, unknown>): void => {
    try {
      disposers.push(tools.register(def))
    } catch (error) {
      ctx.logger?.(PLUGIN)?.warn?.('tool registration failed: %s', errorMessage(error))
    }
  }
  const out = (props: Record<string, unknown>) => ({
    schema: { type: 'object', additionalProperties: true, properties: props },
    render: renderJson,
  })

  register({
    name: 'galley_open',
    description:
      'Open (create) a new galley packet or switch to an existing packet via `id`. It becomes the active packet and ' +
      'returns a compact receipt (packetId, rev, per-sheet block outlines, per-sheet proofs) — never the full block bodies.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        id: { type: 'string', description: 'Switch active packet to an existing packetId (exclusive with create fields).' },
        template: {
          type: 'string',
          description:
            'Built-in ("worksheet" | "rfc" | "generic") or domain-plugin / workspace template id.',
        },
        title: { type: 'string' },
        locale: {
          type: 'string',
          enum: ['en', 'de'],
          description: 'Optional document print label locale ("en" default; "de" for German print labels).',
        },
        colophon: {
          oneOf: [{ type: 'boolean' }, { type: 'string' }],
          description: 'Optional opt-in bottom-margin colophon (`true` for localized neutral default, or custom string).',
        },
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        targetPages: { type: 'integer' },
        blocks: {
          type: 'array',
          description: 'Initial blocks (type + body + optional slot/level/… per spec 01).',
          items: { type: 'object', additionalProperties: true },
        },
        assets: {
          type: 'array',
          description: 'Assets to stage for this packet (metadata; the pane uploads the bytes). Max 20.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              path: { type: 'string' },
              mimeType: { type: 'string' },
              size: { type: 'integer' },
            },
            required: ['id', 'path', 'mimeType'],
          },
        },
      },
    },
    output: out({
      ok: { type: 'boolean' }, packetId: { type: 'string' }, rev: { type: 'integer' },
      blocks: { type: 'object' }, proofs: { type: 'object' },
    }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, root, sessionId } = await getToolContext(args, exec)
        const a = args.id !== undefined ? args : { ...args, origin: 'agent' }
        const res = await galleyOpen(deps, a as unknown as Parameters<typeof galleyOpen>[1])
        if (res.ok && sessionId) {
          setSessionActivePacket(root, sessionId, res.packetId)
        }
        return res
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_status',
    description:
      'Report a packet’s current revision, block outlines (never full bodies), pending proposals, ' +
      'unresolved annotations, attributed recentChanges journal, preflight warnings, and per-sheet proofs (incl. sheetId & targetPagesMet). ' +
      'Never inspect or edit `.dsh/galley/*` files directly via filesystem tools.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        sheetId: { type: 'string' },
      },
    },
    output: out({
      ok: { type: 'boolean' }, packetId: { type: 'string' }, rev: { type: 'integer' },
      blocks: { type: 'object' }, proofs: { type: 'object' }, recentChanges: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, effectivePacketId, unpinnedSession } = await getToolContext(args, exec)
        if (unpinnedSession) return unpinnedSessionFailure()
        const a = effectivePacketId !== undefined ? { ...args, packetId: effectivePacketId } : args
        return await galleyStatus(deps, a as unknown as Parameters<typeof galleyStatus>[1])
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_read_block',
    description:
      'Read one or more blocks with their neighbors, dependency edges, dependents, and annotations. ' +
      'Pass blockId for a single block or blockIds (array) for a batch. Omit packetId to use the active packet.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        blockId: { type: 'string' },
        blockIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several block ids at once.' },
      },
    },
    output: out({ ok: { type: 'boolean' }, packetId: { type: 'string' }, blocks: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, effectivePacketId, unpinnedSession } = await getToolContext(args, exec)
        if (unpinnedSession) return unpinnedSessionFailure()
        const a = effectivePacketId !== undefined ? { ...args, packetId: effectivePacketId } : args
        return await galleyReadBlock(deps, a as unknown as Parameters<typeof galleyReadBlock>[1])
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_edit_block',
    description:
      'The single writer for blocks AND sheets (never edit `.dsh/galley/*` files directly). ' +
      `Block ops: \`insert\` | \`patch\` | \`move\` | \`remove\` | \`batch\` (prefer \`op: "batch"\` with \`ops\` up to ${MAX_BATCH_OPS} items to apply multi-block edits in one atomic revision). ` +
      'Sheet ops: `sheet-add` | `sheet-update` | `sheet-remove`. ' +
      'Conventions: (1) On multi-sheet packets, `insert` REQUIRES `sheetId` (or `beforeId`/`afterId`); omitting `beforeId`/`afterId` appends to the end of `sheetId`. ' +
      '(2) `task` auto-prepends "Task N" (or "Aufgabe N" when packet locale is "de") unless `body` already starts with a numbered prefix. ' +
      '(3) `dependsOn: ["b2"]` accepts block ID strings on both `insert` and `patch` (auto-snapshots `sinceHash`). ' +
      '(4) `table` accepts 2D strings with mini-markup (`headers: ["Col A","Col B"]`, `rows: [["1", "**Bold**"]]`) + optional `colWidths` (`["20%","80%"]`). ' +
      '(5) `header.fields`: accepts `{ title, subtitle, subject, meta, date, name }` (or `{ titel, untertitel, fach, klasse, datum, name }`); `fields.title` is required on `header` insert (`name: ""` renders a blank fill-in line; omit `name` when not needed).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        packetId: { type: 'string', description: 'Omit to use the session-sticky active packet.' },
        sheetId: {
          type: 'string',
          description:
            'Target sheet (`s1`, `s2`, …). Required on `insert` for multi-sheet packets (unless `beforeId`/`afterId` is given) and on `sheet-remove` / multi-sheet `sheet-update`. Auto-resolved from `blockId` on `patch`/`move`/`remove`.',
        },
        op: {
          type: 'string',
          enum: ['insert', 'patch', 'move', 'remove', 'batch', 'sheet-add', 'sheet-update', 'sheet-remove'],
        },
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_OPS,
          description:
            `batch: 1..${MAX_BATCH_OPS} block operations (\`{ op: "insert" | "patch" | "move" | "remove", sheetId?, block?, blockId?, patch?, beforeId?, afterId?, toSheetId?, toBeforeId?, toAfterId?, baseHash? }\`) applied in one atomic commit.`,
          items: { type: 'object', additionalProperties: true },
        },
        beforeId: { type: 'string', description: 'insert: place before this block ID (omit `beforeId`/`afterId` to append to sheet end).' },
        afterId: { type: 'string', description: 'insert: place immediately after this block ID.' },
        block: {
          type: 'object',
          additionalProperties: true,
          description: 'insert: new block object (e.g. `{ type, body, dependsOn: ["b2"], provenance?: { sourceId, quoteSha256?, citation?, locator? } }`).',
        },
        blockId: { type: 'string', description: 'patch / move / remove: target block ID.' },
        baseHash: { type: 'string', description: 'Optional optimistic-lock hash; checked when supplied.' },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'patch: fields to update (e.g. `{ body, dependsOn: ["b2"], colWidths, provenance }` — pass `provenance: null` to clear).',
        },
        toSheetId: { type: 'string', description: 'move: target sheet ID for cross-sheet move.' },
        toBeforeId: { type: 'string', description: 'move: place before this block ID.' },
        toAfterId: { type: 'string', description: 'move: place after this block ID.' },
        title: { type: 'string', description: 'sheet-add / sheet-update: sheet title.' },
        targetPages: {
          type: 'integer',
          minimum: 0,
          description: 'sheet-add / sheet-update: page budget (>= 1), or pass 0 to clear to unbounded.',
        },
        orientation: {
          type: 'string',
          enum: ['portrait', 'landscape'],
          description: 'sheet-add / sheet-update: page orientation.',
        },
        paper: {
          type: 'string',
          enum: ['a4', 'letter'],
          description: 'sheet-add / sheet-update: paper size.',
        },
      },
      required: ['op'],
    },
    output: out({
      ok: { type: 'boolean' },
      applied: { type: 'boolean' },
      packetId: { type: 'string' },
      sheetId: { type: 'string' },
      rev: { type: 'integer' },
      proof: { type: 'object' },
      proofs: { type: 'object' },
      staleDependents: { type: 'array', items: { type: 'string' } },
    }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, effectivePacketId, unpinnedSession } = await getToolContext(args, exec)
        if (unpinnedSession) return unpinnedSessionFailure()
        const a = {
          ...(args as Record<string, unknown>),
          ...(effectivePacketId !== undefined ? { packetId: effectivePacketId } : {}),
          origin: 'agent',
        }
        return await galleyEditBlock(deps, a as unknown as Parameters<typeof galleyEditBlock>[1])
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_annotate',
    description:
      'Add / list / resolve / unresolve a non-printing margin note anchored to a block (shown in the Galley pane, never printed on the PDF).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        blockId: { type: 'string' },
        action: { type: 'string', enum: ['add', 'list', 'resolve', 'unresolve'] },
        body: {},
        provenance: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional source-grounding metadata on `add` (`{ sourceId, quoteSha256?, citation?, locator? }`).',
          properties: {
            sourceId: { type: 'string' },
            quoteSha256: { type: 'string' },
            citation: { type: 'string' },
            locator: { type: 'string' },
          },
          required: ['sourceId'],
        },
        annotationId: { type: 'string' },
      },
      required: ['blockId', 'action'],
    },
    output: out({ ok: { type: 'boolean' }, annotations: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, effectivePacketId, unpinnedSession } = await getToolContext(args, exec)
        if (unpinnedSession) return unpinnedSessionFailure()
        const a = {
          ...args,
          ...(effectivePacketId !== undefined ? { packetId: effectivePacketId } : {}),
          author: 'agent',
        }
        return await galleyAnnotate(deps, a as unknown as Parameters<typeof galleyAnnotate>[1])
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_export',
    description:
      'Export sheets to pdf (via Typst arm), docx (deterministic OOXML Word document), or typ / md / tex (pure text), ' +
      'writing deliverables into <cwd>/galley-exports/ ready for `present`. ' +
      'The live Galley pane already previews every committed revision automatically; call `galley_export` ONLY when the user asks for final deliverable files (.pdf/.docx), not after every edit. ' +
      'Omit packetId to use the active packet.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional project working directory (defaults to session cwd).' },
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        format: { type: 'string', enum: ['typ', 'md', 'tex', 'pdf', 'docx'] },
        sheetId: { type: 'string' },
        sheetIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['format'],
    },
    output: out({
      ok: { type: 'boolean' },
      format: { type: 'string' },
      files: { type: 'array', items: { type: 'object', additionalProperties: true } },
      preflightWarnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
    async execute(args: Record<string, unknown>, exec?: ExecLike) {
      try {
        const { deps, effectivePacketId, unpinnedSession } = await getToolContext(args, exec)
        if (unpinnedSession) return unpinnedSessionFailure()
        const exportArgs = {
          ...(args as unknown as Parameters<typeof galleyExport>[1]),
          ...(effectivePacketId !== undefined ? { packetId: effectivePacketId } : {}),
          outDir: deps.cwd,
          origin: 'agent' as const,
          force: false,
        }
        const res = await galleyExport(deps, exportArgs)
        if (res.ok && 'bytes' in res) {
          const { bytes: _omit, ...jsonSafe } = res
          return jsonSafe
        }
        return res
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  return () => {
    for (const d of disposers) d()
  }
}

function registerHealthRoute(ctx: Context): void {
  const unregister = ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_ROUTE,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      renderTypstNative(renderTypstSource(SAMPLE_BLOCKS))
        .then((receipt) => {
          send(res, 200, {
            ok: true,
            name: PLUGIN,
            version: VERSION,
            arm: receipt.arm,
            typst: receipt.typst,
            sample: { pages: receipt.pages, pdfBytes: receipt.pdfBytes, svgBytes: receipt.svgBytes, ms: receipt.ms },
            time: new Date().toISOString(),
          })
        })
        .catch((error) => {
          send(res, 500, { ok: false, name: PLUGIN, version: VERSION, error: errorMessage(error) })
        })
    },
  })
  ctx.effect(() => unregister, 'galley: /api/galley/health route')
}

export function apply(ctx: Context): void {
  // Expose `ctx.galley` Cordis service so companion leaf bundles can register
  // reusable templates and deterministic preflight checks cleanly.
  try {
    if (typeof ctx.provide === 'function') {
      const withdraw = ctx.provide('galley', defaultGalleyRegistry.toCordisService())
      if (typeof withdraw === 'function') {
        ctx.effect(() => withdraw, 'galley: cordis service')
      }
    }
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.('galley service registration failed: %s', errorMessage(error))
  }

  try {
    const disposeTools = registerGalleyTools(ctx)
    ctx.effect(() => disposeTools, 'galley: tools')
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.('tool registration failed (continuing without it): %s', errorMessage(error))
  }

  // KV-cache-safe agent/pre-step outline + delta inject (M3, works in web + headless profiles).
  try {
    const disposeInject = installGalleyInject(ctx, { getDepsForCwd, registry: defaultGalleyRegistry })
    ctx.effect(() => disposeInject, 'galley: pre-step inject')
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.('pre-step inject registration failed (continuing without it): %s', errorMessage(error))
  }
  // Routes only exist where a web server is present (dsh web); headless
  // profiles simply skip them.
  ctx.inject(['webServer'], (webCtx: Context) => {
    try {
      registerHealthRoute(webCtx)
      registerGalleyRoutes(webCtx, { getDepsForCwd, registry: defaultGalleyRegistry })
    } catch (error) {
      webCtx.logger?.(PLUGIN)?.error?.('route registration failed: %s', errorMessage(error))
    }
  })
}
