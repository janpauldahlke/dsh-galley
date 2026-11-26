/**
 * dsh-galley — tools face (HERMETIC; node: only + injected renderer).
 *
 * Implements the six tools of spec 02 §4 with their full contracts + the
 * typed error codes of spec 02 §3. Every mutation funnels through
 * `GalleyStore.commit` (the single commit path, spec 01 §4). The render arm is
 * injected (dependency), so this module has ZERO `@deepseek-ai/*` and ZERO
 * `@myriaddreamin/*` imports — the native/WASM/CLI arms live in
 * `src/host/arms/*` and the host face wires them in (guardrail 6).
 *
 * `render` is optional: without it, tools that return proofs omit them
 * (headless store-logic tests). With it, receipts are derived per sheet.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  GalleyPacket,
  GalleySheet,
  Block,
  Inline,
  BlockId,
  SheetId,
  LayoutSlot,
  SheetRender,
  SheetProofReceipt,
  GalleyProposal,
  GalleyAnnotation,
  BlockOutline,
  ExportFileReceipt,
  GalleyPreflightWarning,
  ReviewMode,
} from '../shared/types.ts'
import {
  GalleyStore,
  StoreError,
  findBlock,
  allocateBlockId,
  hashBlock,
} from './store.ts'
import { compileSheet, splitSvgPages } from '../typst/index.ts'
import { serializeInlines, parseInlines } from '../shared/inlineMarkup.ts'
import { createGalleyHttpDispatcher, httpStatusForCode } from './httpDispatch.ts'
import {
  GalleyServiceRegistry,
  defaultGalleyRegistry,
  BUILTIN_TEMPLATES,
  type GalleyService,
} from './service.ts'
import {
  getStoreForCwd,
  noteGalleyCwd,
  resolveGalleyCwd,
  resolveGalleyRoot,
  _resetGalleyWorkspaceForTests,
} from './workspace.ts'

export {
  splitSvgPages,
  serializeInlines,
  parseInlines,
  createGalleyHttpDispatcher,
  httpStatusForCode,
  GalleyServiceRegistry,
  defaultGalleyRegistry,
  BUILTIN_TEMPLATES,
  getStoreForCwd,
  noteGalleyCwd,
  resolveGalleyCwd,
  resolveGalleyRoot,
  _resetGalleyWorkspaceForTests,
}
export type { GalleyService }

// Re-export the store's public API so a single built artifact (`galley-core.mjs`)
// serves both the six tools and the hermetic store tests.
export {
  GalleyStore,
  StoreError,
  canonicalJson,
  hashContent,
  blockContentProjection,
  hashBlock,
  computeStale,
  recomputeStale,
  createsCycle,
  allocateBlockId,
  findBlock,
  makeDepEdge,
  UNDO_DEPTH,
  JOURNAL_KEEP,
  MAX_ASSETS_PER_PACKET,
} from './store.ts'

// ── Error codes (spec 02 §3 — the complete v1 set, verbatim GALLEY_* names) ──
export const Err = {
  NO_ACTIVE_PACKET: 'GALLEY_NO_ACTIVE_PACKET',
  PACKET_NOT_FOUND: 'GALLEY_PACKET_NOT_FOUND',
  SHEET_NOT_FOUND: 'GALLEY_SHEET_NOT_FOUND',
  BLOCK_NOT_FOUND: 'GALLEY_BLOCK_NOT_FOUND',
  BLOCK_TYPE_MISMATCH: 'GALLEY_BLOCK_TYPE_MISMATCH',
  DEPENDENCY_CYCLE: 'GALLEY_DEPENDENCY_CYCLE',
  ASSET_NOT_FOUND: 'GALLEY_ASSET_NOT_FOUND',
  ASSET_LIMIT_EXCEEDED: 'GALLEY_ASSET_LIMIT_EXCEEDED',
  PROPOSAL_NOT_FOUND: 'GALLEY_PROPOSAL_NOT_FOUND',
  PROPOSAL_CONFLICT: 'GALLEY_PROPOSAL_CONFLICT',
  ANNOTATION_NOT_FOUND: 'GALLEY_ANNOTATION_NOT_FOUND',
  TYPST_COMPILE_ERROR: 'GALLEY_TYPST_COMPILE_ERROR',
  EXPORT_FAILED: 'GALLEY_EXPORT_FAILED',
  INVALID_PARAMS: 'GALLEY_INVALID_PARAMS',
} as const

/**
 * A typed tool failure. `baseHash`/`currentHash` are attached to
 * GALLEY_PROPOSAL_CONFLICT (spec 02 §3); `diagnostics` to GALLEY_TYPST_COMPILE_ERROR.
 */
export type ToolFailure = {
  ok: false
  code: string
  message: string
  baseHash?: string
  currentHash?: string
  diagnostics?: string
}
export type Ok<T> = { ok: true } & T

function fail(code: string, message: string): ToolFailure {
  return { ok: false, code, message }
}
/**
 * Map a low-level store code to a spec GALLEY_* code. Store codes are entity-
 * agnostic; the tool layer pre-resolves packet/sheet lookups, so a store
 * `not_found` here is always a block vanishing inside the commit path.
 */
function toStoreCode(code: string): string {
  switch (code) {
    case 'conflict': return Err.PROPOSAL_CONFLICT
    case 'cycle': return Err.DEPENDENCY_CYCLE
    case 'no_undo':
    case 'no_redo': return Err.INVALID_PARAMS
    case 'asset_limit': return Err.ASSET_LIMIT_EXCEEDED
    case 'asset_not_found': return Err.ASSET_NOT_FOUND
    case 'proposal_not_found': return Err.PROPOSAL_NOT_FOUND
    case 'not_found': return Err.BLOCK_NOT_FOUND
    case 'invalid_op':
    case 'inline_limit':
    case 'invalid_slot': return Err.INVALID_PARAMS
    case 'invalid_block': return Err.BLOCK_TYPE_MISMATCH
    default: return code
  }
}

export function mapError(error: unknown): ToolFailure {
  if (error instanceof StoreError) {
    const t = fail(toStoreCode(error.code), error.message)
    if (t.code === Err.PROPOSAL_CONFLICT && /base hash mismatch/.test(error.message)) {
      // spec 02 §3: PROPOSAL_CONFLICT carries baseHash + currentHash.
      t.diagnostics = error.message
    }
    return t
  }
  if (error instanceof Error) {
    if (error.message.startsWith('COMPILE')) return fail(Err.TYPST_COMPILE_ERROR, error.message)
    return fail(Err.EXPORT_FAILED, error.message)
  }
  return fail(Err.EXPORT_FAILED, String(error))
}

// ── Compact receipts (M1.5 H4): never leak the full Inline[] body ──────────

/** Flatten an inline run to plain text (strong/emph recurse; others join). */
export function inlineText(inlines: Inline[] | undefined): string {
  if (!inlines) return ''
  return inlines
    .map((i) => {
      switch (i.t) {
        case 'text': return i.v
        case 'strong': return inlineText(i.c)
        case 'emph': return inlineText(i.c)
        case 'code': return i.v
        case 'cloze': return i.hint ?? ''
        case 'math': return i.v
        case 'newline': return '\n'
        default: return ''
      }
    })
    .join('')
}

/** Render a block's meaningful content to text (for outline preview/words). */
export function blockText(block: Block): string {
  const b = block as unknown as Record<string, unknown>
  switch (block.type) {
    case 'header': {
      const f = (block as { fields?: Record<string, string> }).fields ?? {}
      return [f.titel, f.fach, f.klasse, f.datum, f.name].filter(Boolean).join(' · ')
    }
    case 'table': {
      const cell = (c: Inline[]) => inlineText(c)
      const t = block as { headers?: Inline[][]; rows?: Inline[][][] }
      const head = (t.headers ?? []).map(cell).join(' | ')
      const body = (t.rows ?? []).map((r) => r.map(cell).join(' | ')).join('\n')
      return [head, body].filter(Boolean).join('\n')
    }
    default:
      return inlineText((b.body as Inline[] | undefined) ?? undefined)
  }
}

/** A compact per-block outline (identity + origin + ≤60-char preview). */
export function blockOutline(block: Block): BlockOutline {
  const text = blockText(block).replace(/\s+/g, ' ').trim()
  const words = text ? text.split(' ').length : 0
  return {
    id: block.id,
    type: block.type,
    hash: block.hash,
    origin: block.origin,
    words,
    preview: text.slice(0, 60),
    stale: block.stale != null,
  }
}

/** Block ids that are currently stale (StaleInfo != null) in a packet. */
export function staleBlockIds(packet: GalleyPacket): BlockId[] {
  const out: BlockId[] = []
  for (const sid of packet.sheetOrder) {
    for (const b of packet.sheets[sid].blocks) {
      if (b.stale != null) out.push(b.id)
    }
  }
  return out
}

/**
 * Resolve a packet id, falling back to the store's active packet (M1.5 H4).
 * Returns the packet id, or a ToolFailure (NO_ACTIVE_PACKET / PACKET_NOT_FOUND).
 */
export function resolvePacketId(deps: GalleyToolsDeps, packetId: string | undefined): string | ToolFailure {
  const pid = packetId ?? deps.store.getActivePacket()
  if (!pid) return fail(Err.NO_ACTIVE_PACKET, 'no active packet (packetId required)')
  if (!deps.store.load(pid)) return fail(Err.PACKET_NOT_FOUND, `packet ${pid} not found`)
  return pid
}

/** Map asset id → raw bytes for every asset the packet declares (M1.5 H2.2). */
export function assetBytesForPacket(deps: GalleyToolsDeps, packet: GalleyPacket): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  for (const id of Object.keys(packet.assets ?? {})) {
    const bytes = deps.store.readAsset(packet.id, id)
    if (bytes && bytes.length > 0) out[id] = bytes
  }
  return out
}

/** Exported mapping from a low-level store code to a spec GALLEY_* code (tests). */
export function mapStoreCode(code: string): string {
  return toStoreCode(code)
}

// ── Validation (spec 01 §3.5 slot rules, §2 inline limits) ──────────────────

export const MAX_INLINE_NODES = 5000
export const MAX_INLINE_DEPTH = 3

export function validateSlot(slot: LayoutSlot): string | null {
  if (!slot || typeof slot !== 'object') return 'invalid_slot'
  if (slot.mode === 'full' && slot.asset) return 'invalid_slot'
  if ((slot.mode === 'media-right' || slot.mode === 'media-left') && !slot.asset) return 'invalid_slot'
  if (slot.mode === 'card-grid' && slot.columns !== undefined && ![2, 3, 4].includes(slot.columns)) {
    return 'invalid_slot'
  }
  return null
}

export function validateInline(inlines: Inline[]): string | null {
  let count = 0
  const walk = (node: Inline, depth: number): string | null => {
    count++
    if (count > MAX_INLINE_NODES) return 'inline_limit'
    if (depth > MAX_INLINE_DEPTH) return 'inline_limit'
    if (node.t === 'strong' || node.t === 'emph') {
      for (const c of node.c) {
        const e = walk(c, depth + 1)
        if (e) return e
      }
    }
    return null
  }
  for (const i of inlines) {
    const e = walk(i, 1)
    if (e) return e
  }
  return null
}

/** Normalize a raw block body (string or Inline[]) into Inline[]. */
function toInline(body: unknown): Inline[] {
  if (typeof body === 'string') return [{ t: 'text', v: body }]
  if (Array.isArray(body)) return body as Inline[]
  return [{ t: 'text', v: body === undefined || body === null ? '' : String(body) }]
}

/** Build a fully-formed Block from raw input (assigns id, defaults, hash). */
export function buildBlock(
  packet: GalleyPacket,
  raw: Record<string, unknown>,
  origin: 'human' | 'agent',
): { block: Block; error: string | null } {
  const type = raw.type
  if (!['header', 'heading', 'prose', 'source_text', 'task', 'table', 'callout', 'answer'].includes(String(type))) {
    return { block: null as unknown as Block, error: 'invalid_block' }
  }
  const slot = (raw.slot as LayoutSlot) ?? { mode: 'full' }
  const slotErr = validateSlot(slot)
  if (slotErr) return { block: null as unknown as Block, error: slotErr }
  // Spec 01 §3: header and heading blocks are always { mode: 'full' }.
  if ((type === 'header' || type === 'heading') && slot.mode !== 'full') {
    return { block: null as unknown as Block, error: 'invalid_block' }
  }
  // A media slot references an asset that must already exist in the packet
  // (spec 02 §3 GALLEY_ASSET_NOT_FOUND). Assets are staged by the pane; the
  // tools only validate the reference.
  if (slot.asset && !(packet.assets && slot.asset.id in packet.assets)) {
    return { block: null as unknown as Block, error: 'asset_not_found' }
  }

  const bodyInlines = toInline(raw.body)
  if (bodyInlines.length > 0) {
    const e = validateInline(bodyInlines)
    if (e) return { block: null as unknown as Block, error: e }
  }

  const id = (raw.id as BlockId) || allocateBlockId(packet)
  const base: Record<string, unknown> = {
    id,
    type,
    hash: '',
    dependsOn: (raw.dependsOn as unknown[]) ?? [],
    slot,
    origin,
    updatedAt: new Date().toISOString(),
    stale: null,
  }
  switch (type) {
    case 'header':
      base.fields = raw.fields ?? {}
      break
    case 'heading':
      base.level = (raw.level as 1 | 2 | 3) ?? 1
      base.numbered = raw.numbered ?? false
      base.body = bodyInlines
      break
    case 'prose':
    case 'task':
    case 'answer':
      base.body = bodyInlines
      break
    case 'source_text':
      base.title = raw.title
      base.body = bodyInlines
      base.lineNumbers = raw.lineNumbers
      break
    case 'table':
      base.headers = (raw.headers as Inline[][]) ?? []
      base.rows = (raw.rows as Inline[][][]) ?? []
      break
    case 'callout':
      base.tone = (raw.tone as 'info' | 'hint' | 'warning') ?? 'info'
      base.body = bodyInlines
      break
  }
  const block = base as unknown as Block
  block.hash = hashBlock(block)
  return { block, error: null }
}

// ── Proofs ──────────────────────────────────────────────────────────────────

function toReceipt(sr: SheetRender, packet: GalleyPacket): SheetProofReceipt {
  return {
    pages: sr.pages,
    perPage: sr.perPage,
    lastPageLineCount: sr.lastPageLineCount,
    overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
    compiledAtRev: packet.rev,
  }
}

/** Render all (or one) sheets into receipts. */
async function computeProofs(
  deps: GalleyToolsDeps,
  packet: GalleyPacket,
  sheetId?: SheetId,
): Promise<Record<SheetId, SheetProofReceipt | null>> {
  const { render } = deps
  const out: Record<SheetId, SheetProofReceipt | null> = {}
  const ids = sheetId ? [sheetId] : packet.sheetOrder
  const assetBytes = assetBytesForPacket(deps, packet)
  for (const sid of ids) {
    const sheet = packet.sheets[sid]
    if (!sheet) continue
    if (!render) {
      out[sid] = null
      continue
    }
    try {
      const sr = await render(sheet, packet, assetBytes)
      out[sid] = toReceipt(sr, packet)
    } catch {
      out[sid] = { pages: 0, perPage: [], lastPageLineCount: 0, overflowLinesOnLastPage: 0, compiledAtRev: packet.rev }
    }
  }
  return out
}

// ── Renderer port (spec 03 §2) ──────────────────────────────────────────────

export interface GalleyToolsDeps {
  store: GalleyStore
  /** Arm renderer (spec 03 §2). May be sync or async; the tools await it. */
  render?: (sheet: GalleySheet, packet: GalleyPacket, assetBytes?: Record<string, Buffer>) => SheetRender | Promise<SheetRender>
  registry?: GalleyServiceRegistry
  cwd?: string
  now?: () => string
}

// ── Tool 1: galley_open ─────────────────────────────────────────────────────

export interface OpenArgs {
  /** Switch active packet to an existing packet id (exclusive with create fields, spec 02 §4.1). */
  id?: string
  template?: string
  title?: string
  orientation?: 'portrait' | 'landscape'
  blocks?: Record<string, unknown>[]
  targetPages?: number
  /** Provenance for initial `blocks` (default 'human' for pane/hermetic seed; 'agent' from LLM tool). */
  origin?: 'human' | 'agent'
  assets?: { id: string; path: string; mimeType: string; size?: number }[]
}

export async function galleyOpen(deps: GalleyToolsDeps, args: OpenArgs): Promise<Ok<{
  packetId: string
  rev: number
  title: string
  template: string
  reviewMode: ReviewMode
  sheetOrder: SheetId[]
  blocks: Record<SheetId, BlockOutline[]>
  active: true
  proofs: Record<SheetId, SheetProofReceipt | null>
}> | ToolFailure> {
  const { store } = deps
  if (args.id !== undefined) {
    if (args.template || args.title || args.orientation || args.blocks || args.targetPages !== undefined || args.assets) {
      return fail(Err.INVALID_PARAMS, 'id is exclusive with packet creation fields')
    }
    const existing = store.load(args.id)
    if (!existing) return fail(Err.PACKET_NOT_FOUND, `packet ${args.id} not found`)
    store.setActivePacket(existing.id)
    const blocks: Record<SheetId, BlockOutline[]> = {}
    for (const sid of existing.sheetOrder) blocks[sid] = existing.sheets[sid].blocks.map(blockOutline)
    return {
      ok: true,
      packetId: existing.id,
      rev: existing.rev,
      title: existing.title,
      template: existing.template,
      reviewMode: existing.reviewMode ?? 'auto',
      sheetOrder: existing.sheetOrder,
      blocks,
      active: true,
      proofs: await computeProofs(deps, existing),
    }
  }
  const template = args.template ?? 'generic'
  const seedOrigin = args.origin ?? 'human'
  const registry = deps.registry ?? defaultGalleyRegistry
  const isBuiltin = template === 'arbeitsblatt' || template === 'rfc' || template === 'generic'
  const customBlueprint = !isBuiltin ? registry.getTemplate(template, store) : null
  if (!isBuiltin && !customBlueprint) {
    return fail(Err.INVALID_PARAMS, `unknown template '${template}'`)
  }

  try {
    const id = 'p-' + base32(randomBytes(8), 8)
    const packetTitle =
      args.title ??
      (customBlueprint
        ? customBlueprint.title
        : template === 'arbeitsblatt'
          ? 'Arbeitsblatt'
          : 'Document')

    const packet: GalleyPacket = {
      id,
      template,
      title: packetTitle,
      reviewMode: 'auto',
      rev: 0,
      createdAt: '',
      updatedAt: '',
      sheetOrder: [],
      sheets: {},
      nextBlockSeq: 1,
      nextProposalSeq: 1,
      nextAnnotationSeq: 1,
      nextAssetSeq: 1,
      assets: {},
    }

    if (customBlueprint) {
      const bpSheets = customBlueprint.sheets.length > 0
        ? customBlueprint.sheets
        : [{ id: 's1', title: packetTitle, geometry: { paper: 'a4' as const, margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } }, starterBlocks: [] }]
      for (let idx = 0; idx < bpSheets.length; idx++) {
        const bs = bpSheets[idx]
        const sid: SheetId = bs.id || `s${idx + 1}`
        packet.sheetOrder.push(sid)
        packet.sheets[sid] = {
          id: sid,
          title: bs.title || `Sheet ${idx + 1}`,
          geometry: {
            ...JSON.parse(JSON.stringify(bs.geometry)),
            ...(idx === 0 && args.orientation ? { orientation: args.orientation } : {}),
            ...(idx === 0 && args.targetPages !== undefined ? { targetPages: args.targetPages } : {}),
          },
          blocks: [],
        }
        for (const raw of bs.starterBlocks ?? []) {
          const clonedRaw = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
          if (clonedRaw.type === 'header' && args.title && clonedRaw.fields && typeof clonedRaw.fields === 'object') {
            ;(clonedRaw.fields as Record<string, unknown>).titel = args.title
          }
          const { block, error } = buildBlock(packet, clonedRaw, seedOrigin)
          if (error) return fail(toStoreCode(error), `template starter block: ${error}`)
          packet.sheets[sid].blocks.push(block)
          packet.nextBlockSeq += 1
        }
      }
    } else {
      const sheetId: SheetId = 's1'
      const sheet: GalleySheet = {
        id: sheetId,
        title: packetTitle,
        geometry: {
          paper: 'a4',
          ...(args.orientation ? { orientation: args.orientation } : {}),
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          targetPages: args.targetPages ?? (template === 'arbeitsblatt' ? 1 : undefined),
        },
        blocks: [],
      }
      packet.sheetOrder = [sheetId]
      packet.sheets[sheetId] = sheet

      if (template === 'arbeitsblatt') {
        const s2Id: SheetId = 's2'
        packet.sheets[s2Id] = {
          id: s2Id,
          title: 'Erwartungshorizont',
          geometry: { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } },
          blocks: [],
        }
        packet.sheetOrder.push(s2Id)
        const scaffold = (sid: SheetId, raw: Record<string, unknown>): ToolFailure | undefined => {
          const { block, error } = buildBlock(packet, raw, 'agent')
          if (error) return fail(toStoreCode(error), `arbeitsblatt scaffold block: ${error}`)
          packet.sheets[sid].blocks.push(block)
          packet.nextBlockSeq += 1
          return undefined
        }
        const r1 = scaffold(sheetId, { type: 'header', fields: { titel: packet.title, fach: '', klasse: '', datum: '', name: '' } })
        if (r1) return r1
        const r2 = scaffold(sheetId, { type: 'task', body: 'Erste Aufgabe' })
        if (r2) return r2
        const r3 = scaffold(s2Id, { type: 'heading', level: 1, body: 'Erwartungshorizont' })
        if (r3) return r3
        const r4 = scaffold(s2Id, { type: 'answer', body: 'Lösung', dependsOn: [{ id: 'b2', sinceHash: packet.sheets[sheetId].blocks[1].hash, at: new Date().toISOString() }] })
        if (r4) return r4
      }
    }

    const firstSheet = packet.sheets[packet.sheetOrder[0]]
    for (const raw of args.blocks ?? []) {
      const { block, error } = buildBlock(packet, raw, seedOrigin)
      if (error) return fail(toStoreCode(error), `block ${raw.id ?? '?'}: ${error}`)
      firstSheet.blocks.push(block)
      packet.nextBlockSeq += 1
    }
    store.create(packet)
    for (const a of args.assets ?? []) {
      const bytes = Buffer.alloc(a.size ?? 0)
      store.addAsset(
        id,
        { id: a.id, path: a.path, bytesSha256: createHash('sha256').update(bytes).digest('hex'), mimeType: a.mimeType },
        bytes,
        { bumpRev: false },
      )
    }
    const loaded = store.load(id)!
    store.setActivePacket(id)
    const blocks: Record<SheetId, BlockOutline[]> = {}
    for (const sid of loaded.sheetOrder) blocks[sid] = loaded.sheets[sid].blocks.map(blockOutline)
    return {
      ok: true,
      packetId: id,
      rev: loaded.rev,
      title: loaded.title,
      template: loaded.template,
      reviewMode: loaded.reviewMode ?? 'auto',
      sheetOrder: loaded.sheetOrder,
      blocks,
      active: true,
      proofs: await computeProofs(deps, loaded),
    }
  } catch (e) {
    return mapError(e)
  }
}

// ── Tool 2: galley_status ───────────────────────────────────────────────────

export interface StatusArgs { packetId?: string; sheetId?: SheetId }

export async function galleyStatus(deps: GalleyToolsDeps, args: StatusArgs): Promise<Ok<{
  packetId: string
  rev: number
  title: string
  template: string
  reviewMode: ReviewMode
  sheetOrder: SheetId[]
  blocks: Record<SheetId, BlockOutline[]>
  proposals: GalleyProposal[]
  annotations: GalleyAnnotation[]
  preflight: GalleyPreflightWarning[]
  proofs: Record<SheetId, SheetProofReceipt | null>
}> | ToolFailure> {
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = deps.store.load(pid)!
  if (args.sheetId && !packet.sheets[args.sheetId]) return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`)
  const blocks: Record<SheetId, BlockOutline[]> = {}
  for (const sid of packet.sheetOrder) blocks[sid] = packet.sheets[sid].blocks.map(blockOutline)
  const proofs = await computeProofs(deps, packet, args.sheetId)
  const preflight = (deps.registry ?? defaultGalleyRegistry).runPreflight(
    packet,
    proofs,
    deps.cwd ?? process.cwd(),
  )
  return {
    ok: true,
    packetId: pid,
    rev: packet.rev,
    title: packet.title,
    template: packet.template,
    reviewMode: packet.reviewMode ?? 'auto',
    sheetOrder: packet.sheetOrder,
    blocks,
    proposals: deps.store.listProposals(pid).filter((p) => p.status === 'pending'),
    annotations: deps.store.listAnnotations(pid).filter((a) => !a.resolved),
    preflight,
    proofs,
  }
}

// ── Tool 3: galley_read_block ───────────────────────────────────────────────

export interface ReadBlockArgs {
  packetId?: string
  sheetId?: SheetId
  blockId?: BlockId
  /** Batch: read several blocks in one call (M1.5 H4). */
  blockIds?: BlockId[]
}
export interface BlockRead {
  block: Block
  context: string
  dependencies: BlockId[]
  dependents: BlockId[]
  annotations: GalleyAnnotation[]
}

export async function galleyReadBlock(deps: GalleyToolsDeps, args: ReadBlockArgs): Promise<Ok<{
  packetId: string
  blocks: BlockRead[]
}> | ToolFailure> {
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = deps.store.load(pid)!
  const ids = args.blockIds ?? (args.blockId ? [args.blockId] : [])
  if (ids.length === 0) return fail(Err.INVALID_PARAMS, 'blockId or blockIds required')
  const blocks: BlockRead[] = []
  for (const id of ids) {
    const found = findBlock(packet, id)
    if (!found) return fail(Err.BLOCK_NOT_FOUND, `block ${id} not found`)
    const { sheet, index, block } = found
    const dependencies = block.dependsOn.map((d) => d.id)
    const dependents: BlockId[] = []
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid].blocks) {
        if (b.dependsOn.some((d) => d.id === block.id)) dependents.push(b.id)
      }
    }
    const annotations = deps.store.listAnnotations(pid, block.id)
    const context = sheet.blocks
      .slice(Math.max(0, index - 2), index + 3)
      .map((b) => (b.id === block.id ? `[${b.id}] ` : '') + summary(b))
      .join('\n')
    blocks.push({ block, context, dependencies, dependents, annotations })
  }
  return { ok: true, packetId: pid, blocks }
}

function summary(b: Block): string {
  if (b.type === 'header') return `header: ${b.fields.titel ?? ''}`
  const body = (b as { body?: Inline[] }).body
  const text = body ? body.map((i) => (i.t === 'text' ? i.v : '')).join('') : ''
  return `${b.type}: ${text.slice(0, 60)}`
}

// ── Tool 4: galley_edit_block ───────────────────────────────────────────────

export interface EditBlockArgs {
  packetId?: string
  /** Optional (spec 02 §4.4): resolved from `blockId`'s sheet or packet's first sheet when omitted. */
  sheetId?: SheetId
  op: 'insert' | 'patch' | 'move' | 'remove'
  origin: 'human' | 'agent'
  // insert:
  beforeId?: BlockId
  block?: Record<string, unknown>
  // patch / move / remove:
  blockId?: BlockId
  baseHash?: string
  // patch:
  patch?: Record<string, unknown>
  // move:
  toSheetId?: SheetId
  toBeforeId?: BlockId
  toAfterId?: BlockId
}

export async function galleyEditBlock(deps: GalleyToolsDeps, args: EditBlockArgs): Promise<Ok<{
  applied: boolean
  packetId: string
  rev: number
  /** The block that was written (compact outline), or null (proposal path). */
  block: BlockOutline | null
  /** The proposal recorded (when reviewMode==='review' or agent patch on human block), if any. */
  proposal: { id: string; op: string; targetBlockId: BlockId; status: 'pending' } | null
  proof: SheetProofReceipt | null
  /** Block ids now stale (StaleInfo != null) after this change. */
  staleDependents: BlockId[]
}> | ToolFailure> {
  const { store } = deps
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = store.load(pid)!

  if (args.sheetId !== undefined && !packet.sheets[args.sheetId]) {
    return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`)
  }
  const locatedPre = args.blockId ? findBlock(packet, args.blockId) : null
  const resolvedSheetId: SheetId =
    args.sheetId ?? (args.op !== 'insert' && locatedPre ? locatedPre.sheet.id : packet.sheetOrder[0])
  const sheet = packet.sheets[resolvedSheetId]
  if (!sheet) return fail(Err.SHEET_NOT_FOUND, `sheet ${resolvedSheetId} not found`)

  try {
    const inReviewMode = (packet.reviewMode ?? 'auto') === 'review'
    const prePatchOrigin = args.op === 'patch' ? locatedPre?.block?.origin : undefined
    const shouldPropose =
      args.origin === 'agent' && (inReviewMode || (args.op === 'patch' && prePatchOrigin === 'human'))

    if (shouldPropose) {
      const seq = store.listProposals(pid).length + 1
      let prop: GalleyProposal

      if (args.op === 'insert') {
        if (!args.block) return fail(Err.INVALID_PARAMS, 'insert requires a block')
        const { block: built, error } = buildBlock(packet, args.block, 'human')
        if (error) return fail(toStoreCode(error), `invalid block: ${error}`)
        prop = {
          id: `prop-${seq}`,
          op: 'insert',
          sheetId: resolvedSheetId,
          targetBlockId: built.id,
          baseHash: '',
          proposedPatch: { block: built, beforeId: args.beforeId },
          status: 'pending',
          createdAtRev: packet.rev,
        }
      } else {
        if (!args.blockId) return fail(Err.INVALID_PARAMS, `${args.op} requires blockId`)
        const target = locatedPre ?? findBlock(packet, args.blockId)
        if (!target) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`)
        if (args.baseHash && args.baseHash !== target.block.hash) {
          const t = fail(Err.PROPOSAL_CONFLICT, `block ${args.blockId} changed (base hash mismatch)`)
          t.baseHash = args.baseHash
          t.currentHash = target.block.hash
          return t
        }

        if (args.op === 'patch') {
          const proposedPatch = args.patch ?? {}
          const beforePatch: Record<string, unknown> = {}
          const rawBlock = target.block as unknown as Record<string, unknown>
          for (const k of Object.keys(proposedPatch)) {
            if (k in rawBlock) beforePatch[k] = JSON.parse(JSON.stringify(rawBlock[k]))
          }
          prop = {
            id: `prop-${seq}`,
            op: 'patch',
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch,
            proposedPatch,
            status: 'pending',
            createdAtRev: packet.rev,
          }
        } else if (args.op === 'move') {
          const targetSheetId = args.toSheetId ?? resolvedSheetId
          if (!packet.sheets[targetSheetId]) return fail(Err.INVALID_PARAMS, 'target sheet not found')
          prop = {
            id: `prop-${seq}`,
            op: 'move',
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch: { sheetId: target.sheet.id },
            proposedPatch: {
              toSheetId: targetSheetId,
              toBeforeId: args.toBeforeId,
              toAfterId: args.toAfterId,
            },
            status: 'pending',
            createdAtRev: packet.rev,
          }
        } else {
          // remove
          prop = {
            id: `prop-${seq}`,
            op: 'remove',
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch: { type: target.block.type, preview: blockText(target.block).slice(0, 80) },
            proposedPatch: { remove: true },
            status: 'pending',
            createdAtRev: packet.rev,
          }
        }
      }

      store.addProposal(pid, prop)
      const loadedProp = store.load(pid)!
      const renderProp = deps.render
      const proofProp = renderProp
        ? await (async () => {
            try {
              return toReceipt(
                await renderProp(loadedProp.sheets[resolvedSheetId], loadedProp, assetBytesForPacket(deps, loadedProp)),
                loadedProp,
              )
            } catch {
              return null
            }
          })()
        : null
      return {
        ok: true,
        applied: false,
        packetId: pid,
        rev: loadedProp.rev,
        block: null,
        proposal: { id: prop.id, op: prop.op ?? 'patch', targetBlockId: prop.targetBlockId, status: 'pending' },
        proof: proofProp,
        staleDependents: staleBlockIds(loadedProp),
      }
    }

    const needsExpect = (args.op === 'patch' || args.op === 'remove' || args.op === 'move') && args.baseHash !== undefined
    let changedId: BlockId | null = null
    let touchedSheetId: SheetId = resolvedSheetId
    store.commit(
      pid,
      needsExpect ? { blockId: args.blockId ?? '', baseHash: args.baseHash! } : null,
      (p) => {
        const sh = p.sheets[resolvedSheetId]
        switch (args.op) {
          case 'insert': {
            if (!args.block) throw new StoreError('invalid_op', 'insert requires a block')
            const { block, error } = buildBlock(p, args.block, args.origin)
            if (error) throw new StoreError(error, 'invalid block')
            const idx = args.beforeId ? sh.blocks.findIndex((b) => b.id === args.beforeId) : sh.blocks.length
            sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, block)
            p.nextBlockSeq += 1
            changedId = block.id
            return block.id
          }
          case 'patch': {
            if (!args.blockId) throw new StoreError('invalid_op', 'patch requires blockId')
            const found = findBlock(p, args.blockId)
            if (!found) throw new StoreError('not_found', `block ${args.blockId} not found`)
            touchedSheetId = found.sheet.id
            const b = found.block as unknown as Record<string, unknown>
            const now = deps.now ? deps.now() : new Date().toISOString()
            for (const [k, v] of Object.entries(args.patch ?? {})) {
              if (k === 'body') {
                const inlines = toInline(v)
                if (inlines.length > 0) {
                  const e = validateInline(inlines)
                  if (e) throw new StoreError(e, 'inline limit')
                }
                b.body = inlines
              } else if (k === 'slot') {
                const slotVal = v as LayoutSlot
                const e = validateSlot(slotVal)
                if (e) throw new StoreError(e, 'slot')
                if ((found.block.type === 'header' || found.block.type === 'heading') && slotVal.mode !== 'full') {
                  throw new StoreError('invalid_block', 'header/heading must use full slot')
                }
                if (slotVal.asset && !(p.assets && slotVal.asset.id in p.assets)) {
                  throw new StoreError('asset_not_found', `asset ${slotVal.asset.id} not found`)
                }
                b.slot = slotVal
              } else if (k === 'dependsOn') {
                if (!Array.isArray(v)) throw new StoreError('invalid_op', 'dependsOn must be an array')
                b.dependsOn = v.map((item) => {
                  if (typeof item === 'string') {
                    const target = findBlock(p, item)
                    return { id: item, sinceHash: target ? target.block.hash : '', at: now }
                  }
                  return item
                })
              } else if (['fields', 'level', 'tone', 'headers', 'rows', 'numbered', 'title', 'lineNumbers'].includes(k)) {
                b[k] = v
              }
            }
            if (args.origin === 'human') b.origin = 'human'
            if (b.body) {
              const e = validateInline(b.body as Inline[])
              if (e) throw new StoreError(e, 'inline limit')
            }
            changedId = found.block.id
            return found.block.id
          }
          case 'move': {
            const id = args.blockId
            if (!id) throw new StoreError('invalid_op', 'move requires blockId')
            const from = findBlock(p, id)
            if (!from) throw new StoreError('not_found', `block ${id} not found`)
            const targetSheet = p.sheets[args.toSheetId ?? resolvedSheetId]
            if (!targetSheet) throw new StoreError('invalid_op', `target sheet not found`)
            from.sheet.blocks.splice(from.index, 1)
            let to = targetSheet.blocks.length
            if (args.toBeforeId) to = targetSheet.blocks.findIndex((b) => b.id === args.toBeforeId)
            if (args.toAfterId) {
              const i = targetSheet.blocks.findIndex((b) => b.id === args.toAfterId)
              to = i >= 0 ? i + 1 : targetSheet.blocks.length
            }
            targetSheet.blocks.splice(to < 0 ? targetSheet.blocks.length : to, 0, from.block)
            touchedSheetId = targetSheet.id
            changedId = id
            return id
          }
          case 'remove': {
            if (!args.blockId) throw new StoreError('invalid_op', 'remove requires blockId')
            const found = findBlock(p, args.blockId)
            if (!found) throw new StoreError('not_found', `block ${args.blockId} not found`)
            found.sheet.blocks.splice(found.index, 1)
            touchedSheetId = found.sheet.id
            changedId = found.block.id
            return found.block.id
          }
        }
        return null
      },
    )

    const loaded = store.load(pid)!
    const render = deps.render
    const proof = render
      ? await (async () => {
          try {
            return toReceipt(await render(loaded.sheets[touchedSheetId], loaded, assetBytesForPacket(deps, loaded)), loaded)
          } catch {
            return null
          }
        })()
      : null

    // Direct path (insert / move / remove / patch on an agent-origin block):
    // always applied, never a proposal.
    let block: BlockOutline | null = null
    if (changedId) {
      const found = findBlock(loaded, changedId)
      if (found) block = blockOutline(found.block)
    }
    return {
      ok: true,
      applied: true,
      packetId: pid,
      rev: loaded.rev,
      block,
      proposal: null,
      proof,
      staleDependents: staleBlockIds(loaded),
    }
  } catch (e) {
    return mapError(e)
  }
}

// ── Tool 5: galley_annotate ─────────────────────────────────────────────────

export interface AnnotateArgs {
  packetId?: string
  blockId: BlockId
  action: 'add' | 'list' | 'resolve' | 'unresolve'
  author?: 'human' | 'agent'
  body?: Inline[] | string
  annotationId?: string
}

export async function galleyAnnotate(deps: GalleyToolsDeps, args: AnnotateArgs): Promise<Ok<{ annotations: GalleyAnnotation[]; created: GalleyAnnotation | null }> | ToolFailure> {
  const { store } = deps
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = store.load(pid)!
  if (!findBlock(packet, args.blockId)) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`)
  switch (args.action) {
    case 'add': {
      const body = toInline(args.body ?? '')
      const annotation: GalleyAnnotation = {
        id: `ann-${store.listAnnotations(pid).length + 1}`,
        blockId: args.blockId,
        author: args.author ?? 'human',
        body,
        resolved: false,
        createdAtRev: packet.rev,
      }
      store.addAnnotation(pid, annotation)
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: annotation }
    }
    case 'list':
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: null }
    case 'resolve':
    case 'unresolve': {
      if (!args.annotationId) return fail(Err.INVALID_PARAMS, `${args.action} requires annotationId`)
      const updated = store.setAnnotationResolved(pid, args.annotationId, args.action === 'resolve')
      if (!updated) return fail(Err.ANNOTATION_NOT_FOUND, `annotation ${args.annotationId} not found`)
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: null }
    }
    default:
      return fail(Err.INVALID_PARAMS, `unknown action`)
  }
}

// ── Tool 6: galley_export ───────────────────────────────────────────────────

export interface ExportArgs {
  packetId?: string
  sheetId?: SheetId
  sheetIds?: SheetId[]
  format: 'pdf' | 'docx' | 'typ' | 'tex' | 'md'
  /** When supplied, materializes `<outDir>/galley-exports/<slug>.<ext>` and populates `files[]`. */
  outDir?: string
}

function exportSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
  return s || 'galley'
}

export async function galleyExport(
  deps: GalleyToolsDeps,
  args: ExportArgs,
): Promise<Ok<{ format: string; text?: string; bytes?: Buffer; files?: ExportFileReceipt[] }> | ToolFailure> {
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = deps.store.load(pid)!
  if (!['typ', 'md', 'tex', 'pdf', 'docx'].includes(args.format)) {
    return fail(Err.INVALID_PARAMS, `unknown export format '${args.format}'`)
  }
  if (args.format === 'docx') {
    return fail(Err.EXPORT_FAILED, 'docx exporter lands in M4; use pdf or typ')
  }

  const targetIds: SheetId[] =
    args.sheetIds && args.sheetIds.length > 0
      ? args.sheetIds
      : args.sheetId
        ? [args.sheetId]
        : args.outDir
          ? packet.sheetOrder
          : [packet.sheetOrder[0]]

  for (const sid of targetIds) {
    if (!packet.sheets[sid]) return fail(Err.SHEET_NOT_FOUND, `sheet ${sid} not found`)
  }

  try {
    let firstText: string | undefined
    let firstBytes: Buffer | undefined
    const files: ExportFileReceipt[] = []
    const slug = exportSlug(packet.title)
    if (args.outDir) {
      mkdirSync(join(args.outDir, 'galley-exports'), { recursive: true })
    }

    for (let i = 0; i < targetIds.length; i++) {
      const sid = targetIds[i]
      const sheet = packet.sheets[sid]
      let text: string | undefined
      let bytes: Buffer
      let pages: number | null = null

      switch (args.format) {
        case 'typ':
          text = compileSheet(sheet, packet.assets).typ
          bytes = Buffer.from(text, 'utf8')
          break
        case 'md':
          text = toMarkdown(sheet)
          bytes = Buffer.from(text, 'utf8')
          break
        case 'tex':
          text = toTex(sheet)
          bytes = Buffer.from(text, 'utf8')
          break
        case 'pdf': {
          if (!deps.render) return fail(Err.TYPST_COMPILE_ERROR, 'no render arm available for pdf')
          const sr = await deps.render(sheet, packet, assetBytesForPacket(deps, packet))
          if (!sr.pdf || sr.pdf.length === 0) return fail(Err.EXPORT_FAILED, 'render arm produced no pdf bytes')
          bytes = sr.pdf
          pages = sr.pages
          break
        }
        default:
          return fail(Err.INVALID_PARAMS, 'unknown format')
      }

      if (i === 0) {
        firstText = text
        firstBytes = args.format === 'pdf' ? bytes : undefined
      }

      if (args.outDir) {
        const filename = targetIds.length === 1 && sid === 's1' ? `${slug}.${args.format}` : `${slug}-${sid}.${args.format}`
        const relPath = `galley-exports/${filename}`
        writeFileSync(join(args.outDir, relPath), bytes)
        files.push({
          sheetId: sid,
          path: relPath,
          format: args.format,
          pages,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }

    return {
      ok: true,
      format: args.format,
      ...(firstText !== undefined ? { text: firstText } : {}),
      ...(firstBytes !== undefined ? { bytes: firstBytes } : {}),
      ...(args.outDir ? { files } : {}),
    }
  } catch (e) {
    return mapError(e)
  }
}

// ── Exporters (spec 03 §8; M1: typ + md + tex are pure, pdf via arm) ────────

function inlineToMarkdown(inlines: Inline[]): string {
  return inlines
    .map((i) => {
      switch (i.t) {
        case 'text': return i.v
        case 'strong': return `**${inlineToMarkdown(i.c)}**`
        case 'emph': return `*${inlineToMarkdown(i.c)}*`
        case 'code': return `\`${i.v}\``
        case 'cloze': return `_${(i.hint ?? '').padStart(Math.max(1, (i.hint ?? '').length + 1), '_')}_`
        case 'math': return `$${i.v}$`
        case 'newline': return '\n'
        default: return ''
      }
    })
    .join('')
}

function toMarkdown(sheet: GalleySheet): string {
  const L: string[] = [`# ${sheet.title}`, '']
  for (const b of sheet.blocks) {
    if (b.type === 'header') {
      L.push(`**${b.fields.titel ?? ''}**${b.fields.fach ? ` · ${b.fields.fach}` : ''}${b.fields.name ? ` · ${b.fields.name}` : ''}`)
    } else if (b.type === 'heading') {
      L.push(`${'#'.repeat(b.level)} ${inlineToMarkdown(b.body)}`)
    } else if (b.type === 'table') {
      const cell = (c: Inline[]) => inlineToMarkdown(c)
      L.push(b.headers.map((c) => `| **${cell(c)}**`).join(' '))
      L.push(`|${b.headers.map(() => ' --- ').join('')}`)
      for (const row of b.rows) L.push(`|${row.map((c) => cell(c)).join(' ')}`)
    } else if (b.type === 'callout') {
      L.push(`> [${b.tone}] ${inlineToMarkdown(b.body)}`)
    } else {
      const body = (b as { body?: Inline[] }).body
      L.push(body ? inlineToMarkdown(body) : '')
    }
    L.push('')
  }
  return L.join('\n')
}

function toTex(sheet: GalleySheet): string {
  const esc = (s: string) => s.replace(/([&%$#_{}])/g, '\\$1')
  const inlineTex = (inlines: Inline[]): string =>
    inlines
      .map((i) => {
        switch (i.t) {
          case 'text': return esc(i.v)
          case 'strong': return `\\textbf{${inlineTex(i.c)}}`
          case 'emph': return `\\emph{${inlineTex(i.c)}}`
          case 'code': return `\\texttt{${esc(i.v)}}`
          case 'math': return `$${i.v}$`
          case 'newline': return '\\\\'
          default: return ''
        }
      })
      .join('')
  const L: string[] = [
    '\\documentclass[a4paper]{article}',
    `\\title{${esc(sheet.title)}}`,
    '\\begin{document}',
    '\\maketitle',
  ]
  for (const b of sheet.blocks) {
    if (b.type === 'heading') L.push(`\\section{${inlineTex(b.body)}}`)
    else if (b.type === 'table') {
      const cell = (c: Inline[]) => inlineTex(c)
      L.push(`\\begin{tabular}{${'l'.repeat(Math.max(1, b.headers.length))}}`)
      L.push(b.headers.map((c) => `\\textbf{${cell(c)}}`).join(' & ') + ' \\\\\\')
      for (const row of b.rows) L.push(row.map((c) => cell(c)).join(' & ') + ' \\\\')
      L.push('\\end{tabular}')
    } else {
      const body = (b as { body?: Inline[] }).body
      if (body) L.push(inlineTex(body))
    }
  }
  L.push('\\end{document}')
  return L.join('\n')
}

// ── helpers ─────────────────────────────────────────────────────────────────

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(buf: Buffer, len: number): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out.slice(0, len)
}
