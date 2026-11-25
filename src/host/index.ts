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
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { PLUGIN, VERSION, HEALTH_ROUTE } from '../shared/types.ts'
import type { GalleyPacket, GalleySheet } from '../shared/types.ts'
import { renderTypstSource, type GalleyBlock } from '../typst/index.ts'
import { GalleyStore } from './store.ts'
import { createPrimaryArm, type Arm } from './arms/index.ts'
import {
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
export { HEALTH_ROUTE, PLUGIN, VERSION }
// Arms are re-exported so the in-process gate test (test/05) and the health
// probe can drive the real render pipeline; `@myriaddreamin/*` stays external
// (the native .node binary is loaded lazily by NativeArm.init).
export { createArm, createPrimaryArm, NativeArm, WasmArm, CliArm } from './arms/index.ts'
export type { Arm, ArmName } from './arms/index.ts'

/** The sample packet the health probe renders (proves the native arm in-process). */
const SAMPLE_BLOCKS: GalleyBlock[] = [
  { id: 'b1', kind: 'header', text: 'Arbeitsblatt · Druck und Satz' },
  { id: 'b2', kind: 'heading', level: 1, text: 'Galley Proof' },
  {
    id: 'b3',
    kind: 'prose',
    text: 'Hello from the native Typst arm. This paragraph contains markup metacharacters that must stay inert: # $ [ ] { } _ ^ | and a quote "here" plus a backslash here.',
  },
  { id: 'b4', kind: 'task', text: 'Aufgabe: prove the dual face loads.' },
  { id: 'b5', kind: 'answer', text: 'Lösung: the host compiled and the pane rendered the SVG.' },
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
    const { NodeCompiler } = mod as { NodeCompiler: { create(): TypstCompiler } }
    const c = NodeCompiler.create()
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

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

// ── M1 wiring: one store + one primary arm per plugin load ──────────────────

function getStore(): GalleyStore {
  return new GalleyStore(process.env.GALLEY_ROOT ?? join(process.cwd(), '.dsh', 'galley'))
}

let armPromise: Promise<Arm> | null = null
function getArm(): Promise<Arm> {
  if (!armPromise) armPromise = createPrimaryArm().then((r) => r.arm)
  return armPromise
}
async function getDeps(): Promise<GalleyToolsDeps> {
  const arm = await getArm()
  return {
    store: getStore(),
    render: (sheet: GalleySheet, packet: GalleyPacket, assetBytes?: Record<string, Buffer>) =>
      arm.render(sheet, packet, assetBytes),
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
        id: { type: 'string', description: 'Switch active packet to an existing packetId (exclusive with create fields).' },
        template: { type: 'string', enum: ['arbeitsblatt', 'rfc', 'generic'] },
        title: { type: 'string' },
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
    async execute(args: Record<string, unknown>) {
      try {
        const a = args.id !== undefined ? args : { ...args, origin: 'agent' }
        return await galleyOpen(await getDeps(), (a as unknown as Parameters<typeof galleyOpen>[1]))
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_status',
    description:
      'Report a packet’s current revision, block outlines (never full bodies), pending proposals / ' +
      'unresolved annotations, and a fresh proof receipt per sheet. Omit packetId to use the active packet.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        sheetId: { type: 'string' },
      },
    },
    output: out({
      ok: { type: 'boolean' }, packetId: { type: 'string' }, rev: { type: 'integer' },
      blocks: { type: 'object' }, proofs: { type: 'object' },
    }),
    async execute(args: Record<string, unknown>) {
      try {
        return await galleyStatus(await getDeps(), (args as unknown as Parameters<typeof galleyStatus>[1]))      } catch (error) {
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
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        blockId: { type: 'string' },
        blockIds: { type: 'array', items: { type: 'string' }, description: 'Batch: several block ids at once.' },
      },
    },
    output: out({ ok: { type: 'boolean' }, packetId: { type: 'string' }, blocks: { type: 'array' } }),
    async execute(args: Record<string, unknown>) {
      try {
        return await galleyReadBlock(await getDeps(), (args as unknown as Parameters<typeof galleyReadBlock>[1]))      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_edit_block',
    description:
      'The single writer: insert / patch / move / remove one block (spec 02 §4.4). ' +
      'patch + remove + move require blockId + baseHash (optimistic lock). A human patch records a pending proposal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        sheetId: { type: 'string' },
        op: { type: 'string', enum: ['insert', 'patch', 'move', 'remove'] },
        beforeId: { type: 'string' },
        block: { type: 'object', additionalProperties: true },
        blockId: { type: 'string' },
        baseHash: { type: 'string', description: 'Optional optimistic-lock hash; checked when supplied.' },
        patch: { type: 'object', additionalProperties: true },
        toSheetId: { type: 'string', description: 'Optional target sheet for cross-sheet move.' },
        toBeforeId: { type: 'string' },
        toAfterId: { type: 'string' },
      },
      required: ['sheetId', 'op'],
    },
    output: out({
      ok: { type: 'boolean' }, packetId: { type: 'string' }, rev: { type: 'integer' },
      block: { type: ['object', 'null'] },
      proposal: { type: ['object', 'null'] },
      proof: { type: ['object', 'null'] },
      staleDependents: { type: 'array' },
    }),
    async execute(args: Record<string, unknown>) {
      try {
        // M1.5 H5: the LLM always edits as 'agent'; human-origin blocks are
        // written only by the pane (tools face), which passes origin itself.
        const a = { ...(args as Record<string, unknown>), origin: 'agent' }
        return await galleyEditBlock(await getDeps(), (a as unknown as Parameters<typeof galleyEditBlock>[1]))      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_annotate',
    description: 'Add / list / resolve / unresolve a margin note (Randnotiz) anchored to a block.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        blockId: { type: 'string' },
        action: { type: 'string', enum: ['add', 'list', 'resolve', 'unresolve'] },
        body: {},
        annotationId: { type: 'string' },
      },
      required: ['blockId', 'action'],
    },
    output: out({ ok: { type: 'boolean' }, annotations: { type: 'array' } }),
    async execute(args: Record<string, unknown>) {
      try {
        const a = { ...args, author: 'agent' }
        return await galleyAnnotate(await getDeps(), (a as unknown as Parameters<typeof galleyAnnotate>[1]))
      } catch (error) {
        return toolErrorResult(error)
      }
    },
  })

  register({
    name: 'galley_export',
    description:
      'Export a sheet to typ / md / tex (pure) or pdf (via the render arm). ' +
      'Omit packetId to use the active packet. docx is not available until M4 (fails with GALLEY_EXPORT_FAILED).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packetId: { type: 'string', description: 'Omit to use the active packet.' },
        format: { type: 'string', enum: ['typ', 'md', 'tex', 'pdf', 'docx'] },
        sheetId: { type: 'string' },
      },
      required: ['format'],
    },
    output: out({ ok: { type: 'boolean' }, format: { type: 'string' } }),
    async execute(args: Record<string, unknown>) {
      try {
        return await galleyExport(await getDeps(), (args as unknown as Parameters<typeof galleyExport>[1]))      } catch (error) {
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
  try {
    const disposeTools = registerGalleyTools(ctx)
    // Cordis: the effect body's RETURN VALUE is the disposer. Returning
    // disposeTools (not calling it) registers it as the disposer.
    ctx.effect(() => disposeTools, 'galley: tools')
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.('tool registration failed (continuing without it): %s', errorMessage(error))
  }
  // Routes only exist where a web server is present (dsh web); headless
  // profiles simply skip them.
  ctx.inject(['webServer'], (webCtx: Context) => {
    try {
      registerHealthRoute(webCtx)
    } catch (error) {
      webCtx.logger?.(PLUGIN)?.error?.('route registration failed: %s', errorMessage(error))
    }
  })
}
