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
  GalleyJournalEntry,
  BlockOutline,
  ExportFileReceipt,
  GalleyPreflightWarning,
  ReviewMode,
  GalleyLocale,
  SourceProvenance,
} from '../shared/types.ts'
import { getGalleyStrings, GALLEY_I18N, DEFAULT_LOCALE, resolveColophonText } from '../shared/i18n.ts'
import {
  GalleyStore,
  StoreError,
  findBlock,
  allocateBlockId,
  hashBlock,
  validateProvenance,
} from './store.ts'
import { compileSheet, deriveHitBands, deriveReceipt, parseSvgPages, splitSvgPages } from '../typst/index.ts'
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
  setSessionActivePacket,
  getSessionActivePacket,
  clearSessionActivePacket,
  _resetGalleyWorkspaceForTests,
} from './workspace.ts'
import {
  exportSheetDocx,
  unpackDocxEntries,
  probeImageDimensions,
  probeSvgDimensions,
  splitInlinesTwoColumn,
} from './docx.ts'

export {
  exportSheetDocx,
  unpackDocxEntries,
  probeImageDimensions,
  probeSvgDimensions,
  splitInlinesTwoColumn,
  validateProvenance,
  deriveHitBands,
  deriveReceipt,
  parseSvgPages,
  splitSvgPages,
  serializeInlines,
  parseInlines,
  createGalleyHttpDispatcher,
  httpStatusForCode,
  GalleyServiceRegistry,
  defaultGalleyRegistry,
  BUILTIN_TEMPLATES,
  getGalleyStrings,
  resolveColophonText,
  GALLEY_I18N,
  DEFAULT_LOCALE,
  getStoreForCwd,
  noteGalleyCwd,
  resolveGalleyCwd,
  resolveGalleyRoot,
  setSessionActivePacket,
  getSessionActivePacket,
  clearSessionActivePacket,
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
  EXPORT_BLOCKED_BY_PREFLIGHT: 'GALLEY_EXPORT_BLOCKED_BY_PREFLIGHT',
  INVALID_PARAMS: 'GALLEY_INVALID_PARAMS',
} as const

/**
 * A typed tool failure. `baseHash`/`currentHash` are attached to
 * GALLEY_PROPOSAL_CONFLICT (spec 02 §3); `diagnostics` to GALLEY_TYPST_COMPILE_ERROR;
 * `preflightWarnings` to GALLEY_EXPORT_BLOCKED_BY_PREFLIGHT.
 */
export type ToolFailure = {
  ok: false
  code: string
  message: string
  baseHash?: string
  currentHash?: string
  diagnostics?: string
  preflightWarnings?: GalleyPreflightWarning[]
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
  if (!Array.isArray(inlines)) {
    return isInlineObject(inlines) ? inlineText([inlines]) : typeof inlines === 'string' ? inlines : ''
  }
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
      const f = block.fields ?? { titel: '' }
      return [f.titel, f.subtitle, f.fach, f.klasse, f.datum, f.name].filter(Boolean).join(' · ')
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
  if ((slot.mode === 'media-right' || slot.mode === 'media-left' || slot.mode === 'media-below') && !slot.asset) {
    return 'invalid_slot'
  }
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

/** Normalize a raw block body (mini-markup string or Inline[]) into Inline[]. */
function toInline(body: unknown): Inline[] {
  if (typeof body === 'string') return parseInlines(body)
  if (Array.isArray(body)) return body as Inline[]
  if (isInlineObject(body)) return [body]
  return parseInlines(body === undefined || body === null ? '' : String(body))
}

function isInlineObject(x: unknown): x is Inline {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const t = (x as Record<string, unknown>).t
  return (
    t === 'text' ||
    t === 'strong' ||
    t === 'emph' ||
    t === 'code' ||
    t === 'cloze' ||
    t === 'math' ||
    t === 'newline'
  )
}

/**
 * Normalize a single table cell from any natural LLM/caller shape:
 * - `"plain text"` -> `[{ t: 'text', v: "plain text" }]`
 * - `{ t: 'text', v: '...' }` (single Inline node) -> `[node]`
 * - `Inline[]` (or mixed string/Inline array) -> validated `Inline[]`
 */
function normalizeTableCell(rawCell: unknown): { cell: Inline[]; error: string | null } {
  if (rawCell === null || rawCell === undefined) return { cell: [], error: null }
  if (typeof rawCell === 'string') {
    const parsed = parseInlines(rawCell)
    const e = validateInline(parsed)
    return e ? { cell: [], error: e } : { cell: parsed, error: null }
  }
  if (isInlineObject(rawCell)) {
    const e = validateInline([rawCell])
    return e ? { cell: [], error: e } : { cell: [rawCell], error: null }
  }
  if (Array.isArray(rawCell)) {
    const out: Inline[] = []
    for (const item of rawCell) {
      if (typeof item === 'string') out.push({ t: 'text', v: item })
      else if (isInlineObject(item)) out.push(item)
      else return { cell: [], error: 'invalid_block' }
    }
    if (out.length > 0) {
      const e = validateInline(out)
      if (e) return { cell: [], error: e }
    }
    return { cell: out, error: null }
  }
  return { cell: [], error: 'invalid_block' }
}

function normalizeTableHeaders(rawHeaders: unknown): { headers: Inline[][]; error: string | null } {
  if (rawHeaders === undefined || rawHeaders === null) return { headers: [], error: null }
  if (!Array.isArray(rawHeaders)) return { headers: [], error: 'invalid_block' }
  const headers: Inline[][] = []
  for (const c of rawHeaders) {
    const res = normalizeTableCell(c)
    if (res.error) return { headers: [], error: res.error }
    headers.push(res.cell)
  }
  return { headers, error: null }
}

function normalizeTableRows(rawRows: unknown): { rows: Inline[][][]; error: string | null } {
  if (rawRows === undefined || rawRows === null) return { rows: [], error: null }
  if (!Array.isArray(rawRows)) return { rows: [], error: 'invalid_block' }
  const rows: Inline[][][] = []
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) return { rows: [], error: 'invalid_block' }
    const row: Inline[][] = []
    for (const c of rawRow) {
      const res = normalizeTableCell(c)
      if (res.error) return { rows: [], error: res.error }
      row.push(res.cell)
    }
    rows.push(row)
  }
  return { rows, error: null }
}

function normalizeTableColWidths(rawWidths: unknown): { colWidths: (string | number)[] | undefined; error: string | null } {
  if (rawWidths === undefined || rawWidths === null) return { colWidths: undefined, error: null }
  if (!Array.isArray(rawWidths)) return { colWidths: undefined, error: 'invalid_block' }
  const out: (string | number)[] = []
  for (const w of rawWidths) {
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      out.push(w)
    } else if (typeof w === 'string' && /^(\d+(\.\d+)?(%|fr|pt|cm|mm|em)|auto)$/.test(w.trim())) {
      out.push(w.trim())
    } else {
      return { colWidths: undefined, error: 'invalid_block' }
    }
  }
  return { colWidths: out.length > 0 ? out : undefined, error: null }
}

/**
 * Normalize `dependsOn` items (accepts string blockIds `["b2"]` OR `{ id, sinceHash?, at? }`
 * objects) so both `insert` and `patch` anchor `sinceHash` to the target block's current hash.
 */
function normalizeDependsOn(
  packet: GalleyPacket,
  rawDeps: unknown,
  now: string,
): { deps: Block['dependsOn']; error: string | null } {
  if (rawDeps === undefined || rawDeps === null) return { deps: [], error: null }
  if (!Array.isArray(rawDeps)) return { deps: [], error: 'invalid_op' }
  const deps: Block['dependsOn'] = []
  for (const item of rawDeps) {
    if (typeof item === 'string') {
      const target = findBlock(packet, item)
      deps.push({ id: item, sinceHash: target ? target.block.hash : '', at: now })
    } else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
      const d = item as { id: string; sinceHash?: string; at?: string }
      const target = findBlock(packet, d.id)
      const sinceHash =
        typeof d.sinceHash === 'string' && d.sinceHash.length > 0
          ? d.sinceHash
          : target
            ? target.block.hash
            : ''
      deps.push({ id: d.id, sinceHash, at: typeof d.at === 'string' ? d.at : now })
    } else {
      return { deps: [], error: 'invalid_op' }
    }
  }
  return { deps, error: null }
}

export type { SourceProvenance }

const KNOWN_HEADER_KEYS = new Set([
  'titel',
  'title',
  'subtitle',
  'untertitel',
  'fach',
  'subject',
  'klasse',
  'group',
  'meta',
  'datum',
  'date',
  'name',
  '_unknownKeys',
])

/** Normalize neutral English & German header keys (`title`, `subtitle`, `subject`/`fach`, `group`/`meta`/`klasse`, `date`/`datum`, `name`). */
export function normalizeHeaderFields(rawFields: unknown): Record<string, unknown> {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return { titel: '' }
  const f = rawFields as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const out: Record<string, unknown> = {
    titel: str(f.titel) ?? str(f.title) ?? '',
  }
  const subtitle = str(f.subtitle) ?? str(f.untertitel)
  if (subtitle !== undefined && subtitle !== '') out.subtitle = subtitle
  const fach = str(f.fach) ?? str(f.subject)
  if (fach !== undefined) out.fach = fach
  const klasse = str(f.klasse) ?? str(f.group) ?? str(f.meta)
  if (klasse !== undefined) out.klasse = klasse
  const datum = str(f.datum) ?? str(f.date)
  if (datum !== undefined) out.datum = datum
  if ('name' in f && f.name !== undefined && f.name !== null) {
    out.name = String(f.name)
  }
  const unknown = Object.keys(f).filter(
    (k) => !KNOWN_HEADER_KEYS.has(k) && f[k] !== undefined && f[k] !== null && f[k] !== '',
  )
  if (unknown.length > 0) {
    out._unknownKeys = unknown.sort()
  }
  return out
}

/** Extract plain-text fallback title for `header` blocks when `fields.title` was omitted in favor of `title` or `body`. */
function extractHeaderTitleFallback(raw: Record<string, unknown>): string {
  if (typeof raw.titel === 'string' && raw.titel.trim()) return raw.titel.trim()
  if (typeof raw.title === 'string' && raw.title.trim()) return raw.title.trim()
  if (raw.body !== undefined && raw.body !== null) {
    const flat = inlineText(toInline(raw.body)).replace(/\s+/g, ' ').trim()
    if (flat) return flat
  }
  return ''
}

const HEADER_SHORTHAND_PATCH_KEYS = new Set([
  'titel',
  'title',
  'subtitle',
  'untertitel',
  'fach',
  'subject',
  'klasse',
  'group',
  'meta',
  'datum',
  'date',
  'name',
  'body',
])

/**
 * Normalize a `patch` payload targeting a `header` block:
 * - Accepts `patch.fields` OR top-level shorthands (`patch.title`, `patch.body`, `patch.subtitle`, …).
 * - Preserves existing `fields` keys when only shorthands are supplied, and falls back to
 *   `patch.title` / flattened `patch.body` if `fields.titel` would otherwise be blank.
 */
function resolveHeaderPatchFields(
  existingFields: Record<string, unknown> | undefined,
  patchInput: Record<string, unknown>,
): Record<string, unknown> | null {
  const prev = existingFields ?? { titel: '' }
  if ('fields' in patchInput && patchInput.fields && typeof patchInput.fields === 'object' && !Array.isArray(patchInput.fields)) {
    const rf = patchInput.fields as Record<string, unknown>
    const norm = normalizeHeaderFields(rf)
    if (!String(norm.titel ?? '').trim()) {
      const fb = extractHeaderTitleFallback(patchInput)
      const explicitEmptyTitle = 'titel' in rf || 'title' in rf
      if (fb) {
        norm.titel = fb
      } else if (!explicitEmptyTitle && typeof prev.titel === 'string' && prev.titel.trim()) {
        norm.titel = prev.titel
      }
    }
    return norm
  }
  const hasShorthand = Object.keys(patchInput).some((k) => HEADER_SHORTHAND_PATCH_KEYS.has(k))
  if (!hasShorthand) return null
  const mergedRaw: Record<string, unknown> = { ...prev }
  if ('title' in patchInput || 'titel' in patchInput) {
    delete mergedRaw.titel
    delete mergedRaw.title
  }
  if ('subtitle' in patchInput || 'untertitel' in patchInput) {
    delete mergedRaw.subtitle
    delete mergedRaw.untertitel
  }
  if ('subject' in patchInput || 'fach' in patchInput) {
    delete mergedRaw.fach
    delete mergedRaw.subject
  }
  if ('group' in patchInput || 'meta' in patchInput || 'klasse' in patchInput) {
    delete mergedRaw.klasse
    delete mergedRaw.group
    delete mergedRaw.meta
  }
  if ('date' in patchInput || 'datum' in patchInput) {
    delete mergedRaw.datum
    delete mergedRaw.date
  }
  for (const [k, v] of Object.entries(patchInput)) {
    if (k !== 'body' && HEADER_SHORTHAND_PATCH_KEYS.has(k)) {
      mergedRaw[k] = v
    }
  }
  if ('body' in patchInput && !('title' in patchInput) && !('titel' in patchInput)) {
    const bodyTitle = extractHeaderTitleFallback({ body: patchInput.body })
    if (bodyTitle) mergedRaw.titel = bodyTitle
  }
  const norm = normalizeHeaderFields(mergedRaw)
  if (!String(norm.titel ?? '').trim()) {
    const fb = extractHeaderTitleFallback(patchInput)
    if (fb) norm.titel = fb
  }
  return norm
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

  const now = new Date().toISOString()
  const normDeps = normalizeDependsOn(packet, raw.dependsOn, now)
  if (normDeps.error) return { block: null as unknown as Block, error: normDeps.error }

  const normProv = validateProvenance(raw.provenance)
  if (normProv.error) return { block: null as unknown as Block, error: normProv.error }

  const id = (raw.id as BlockId) || allocateBlockId(packet)
  const base: Record<string, unknown> = {
    id,
    type,
    hash: '',
    dependsOn: normDeps.deps,
    slot,
    ...(normProv.provenance ? { provenance: normProv.provenance } : {}),
    origin,
    updatedAt: now,
    stale: null,
  }
  switch (type) {
    case 'header': {
      const normFields = normalizeHeaderFields(raw.fields)
      if (!String(normFields.titel ?? '').trim()) {
        const fb = extractHeaderTitleFallback(raw)
        if (fb) normFields.titel = fb
      }
      base.fields = normFields
      break
    }
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
    case 'table': {
      const hRes = normalizeTableHeaders(raw.headers)
      if (hRes.error) return { block: null as unknown as Block, error: hRes.error }
      const rRes = normalizeTableRows(raw.rows)
      if (rRes.error) return { block: null as unknown as Block, error: rRes.error }
      const wRes = normalizeTableColWidths(raw.colWidths)
      if (wRes.error) return { block: null as unknown as Block, error: wRes.error }
      base.headers = hRes.headers
      base.rows = rRes.rows
      if (wRes.colWidths) base.colWidths = wRes.colWidths
      break
    }
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

function toReceipt(sr: SheetRender, packet: GalleyPacket, sheet?: GalleySheet): SheetProofReceipt {
  const tp = sheet?.geometry?.targetPages
  return {
    ...(sheet?.id ? { sheetId: sheet.id } : {}),
    pages: sr.pages,
    perPage: sr.perPage,
    lastPageLineCount: sr.lastPageLineCount,
    overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
    targetPages: tp ?? null,
    targetPagesMet: tp !== undefined ? sr.pages <= tp : null,
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
      out[sid] = toReceipt(sr, packet, sheet)
    } catch {
      const tp = sheet.geometry.targetPages
      out[sid] = {
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        targetPages: tp ?? null,
        targetPagesMet: tp !== undefined ? false : null,
        compiledAtRev: packet.rev,
      }
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
  locale?: GalleyLocale
  /** Opt-in footer colophon (`true` for neutral localized default, or custom string). */
  colophon?: boolean | string
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
  colophon?: boolean | string
  reviewMode: ReviewMode
  sheetOrder: SheetId[]
  blocks: Record<SheetId, BlockOutline[]>
  active: true
  proofs: Record<SheetId, SheetProofReceipt | null>
}> | ToolFailure> {
  const { store } = deps
  if (args.id !== undefined) {
    if (
      args.template ||
      args.title ||
      args.colophon !== undefined ||
      args.orientation ||
      args.blocks ||
      args.targetPages !== undefined ||
      args.assets
    ) {
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
      ...(existing.colophon !== undefined ? { colophon: existing.colophon } : {}),
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
  const isLegacyFastPath = template === 'rfc' || template === 'generic'
  const customBlueprint = !isLegacyFastPath ? registry.getTemplate(template, store) : null
  if (!isLegacyFastPath && !customBlueprint) {
    return fail(Err.INVALID_PARAMS, `unknown template '${template}'`)
  }
  if (args.colophon !== undefined && typeof args.colophon !== 'boolean' && typeof args.colophon !== 'string') {
    return fail(Err.INVALID_PARAMS, 'colophon must be a boolean or string')
  }

  try {
    const id = 'p-' + base32(randomBytes(8), 8)
    const packetTitle =
      args.title ??
      (customBlueprint ? customBlueprint.title : 'Document')
    const packetLocale: GalleyLocale | undefined =
      (args as { locale?: GalleyLocale }).locale ?? customBlueprint?.locale
    const rawColophon = args.colophon !== undefined ? args.colophon : customBlueprint?.colophon
    const normalizedColophon: boolean | string | undefined =
      rawColophon === true
        ? true
        : typeof rawColophon === 'string' && rawColophon.trim().length > 0
          ? rawColophon.trim()
          : undefined

    const packet: GalleyPacket = {
      id,
      template,
      title: packetTitle,
      ...(packetLocale ? { locale: packetLocale } : {}),
      ...(normalizedColophon !== undefined ? { colophon: normalizedColophon } : {}),
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
          title: (idx === 0 && args.title) ? args.title : (bs.title || `Sheet ${idx + 1}`),
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
          // Starter blocks inside built-in/plugin multi-block templates default to agent-editable scaffold
          const blockOrigin =
            seedOrigin === 'human' && (customBlueprint.source === 'builtin' || customBlueprint.source === 'plugin')
              ? 'agent'
              : seedOrigin
          const { block, error } = buildBlock(packet, clonedRaw, blockOrigin)
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
          ...(args.targetPages !== undefined ? { targetPages: args.targetPages } : {}),
        },
        blocks: [],
      }
      packet.sheetOrder = [sheetId]
      packet.sheets[sheetId] = sheet
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
      ...(loaded.colophon !== undefined ? { colophon: loaded.colophon } : {}),
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
  colophon?: boolean | string
  reviewMode: ReviewMode
  sheetOrder: SheetId[]
  blocks: Record<SheetId, BlockOutline[]>
  proposals: GalleyProposal[]
  annotations: GalleyAnnotation[]
  recentChanges: GalleyJournalEntry[]
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
    ...(packet.colophon !== undefined ? { colophon: packet.colophon } : {}),
    reviewMode: packet.reviewMode ?? 'auto',
    sheetOrder: packet.sheetOrder,
    blocks,
    proposals: deps.store.listProposals(pid).filter((p) => p.status === 'pending'),
    annotations: deps.store.listAnnotations(pid).filter((a) => !a.resolved),
    recentChanges: deps.store.listJournal(pid),
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

export const MAX_BATCH_OPS = 25

export interface BatchBlockOp {
  op: 'insert' | 'patch' | 'move' | 'remove'
  sheetId?: SheetId
  beforeId?: BlockId
  afterId?: BlockId
  afterBlockId?: BlockId
  block?: Record<string, unknown>
  blockId?: BlockId
  baseHash?: string
  patch?: Record<string, unknown>
  toSheetId?: SheetId
  toBeforeId?: BlockId
  toAfterId?: BlockId
}

export interface EditBlockArgs {
  packetId?: string
  /**
   * Target sheet id (`s1`, `s2`, …).
   * - `patch`/`move`/`remove`: auto-resolved from `blockId`'s owning sheet when omitted.
   * - `insert`: auto-resolved from `beforeId`/`afterId` anchor or `s1` on single-sheet packets;
   *   REQUIRED on multi-sheet packets when no `beforeId`/`afterId` anchor is supplied.
   * - `batch`: optional default `sheetId` inherited by sub-ops that omit `sheetId`.
   * - `sheet-update`/`sheet-remove`: target sheet (defaults to `s1` on single-sheet `sheet-update`).
   */
  sheetId?: SheetId
  op: 'insert' | 'patch' | 'move' | 'remove' | 'batch' | 'sheet-add' | 'sheet-update' | 'sheet-remove'
  origin: 'human' | 'agent'
  // batch:
  ops?: BatchBlockOp[]
  // insert:
  beforeId?: BlockId
  afterId?: BlockId
  afterBlockId?: BlockId
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
  // sheet-add / sheet-update:
  title?: string
  targetPages?: number | null
  orientation?: 'portrait' | 'landscape'
  paper?: 'a4' | 'letter'
}

export interface ProposalSummary {
  id: string
  op: string
  targetBlockId: BlockId
  status: 'pending'
}

type PlannedBlockStep =
  | { kind: 'fail'; failure: ToolFailure }
  | {
      kind: 'propose'
      proposal: GalleyProposal
      sheetId: SheetId
    }
  | {
      kind: 'direct'
      sheetId: SheetId
      changedId: BlockId
      note: string
      applyTo: (p: GalleyPacket) => BlockId
    }

function planAndSimulateBlockOp(
  working: GalleyPacket,
  sub: BatchBlockOp,
  ctx: {
    origin: 'human' | 'agent'
    inReviewMode: boolean
    createdAtRev: number
    propSeq: number
    now: string
  },
): PlannedBlockStep {
  if (!['insert', 'patch', 'move', 'remove'].includes(String(sub.op))) {
    return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, `unsupported block op '${String(sub.op)}'`) }
  }
  if (sub.sheetId !== undefined && !working.sheets[sub.sheetId]) {
    return { kind: 'fail', failure: fail(Err.SHEET_NOT_FOUND, `sheet ${sub.sheetId} not found`) }
  }

  const insertAfterId = sub.op === 'insert' ? (sub.afterId ?? sub.afterBlockId) : undefined
  const insertAnchorId = sub.op === 'insert' ? (sub.beforeId ?? insertAfterId) : undefined
  const locatedAnchor = insertAnchorId ? findBlock(working, insertAnchorId) : null
  if (insertAnchorId && !locatedAnchor) {
    return { kind: 'fail', failure: fail(Err.BLOCK_NOT_FOUND, `anchor block ${insertAnchorId} not found`) }
  }
  if (locatedAnchor && sub.sheetId !== undefined && sub.sheetId !== locatedAnchor.sheet.id) {
    return {
      kind: 'fail',
      failure: fail(
        Err.INVALID_PARAMS,
        `anchor block ${insertAnchorId} belongs to sheet ${locatedAnchor.sheet.id}, not ${sub.sheetId}`,
      ),
    }
  }

  let resolvedSheetId: SheetId
  if (sub.op === 'insert') {
    if (sub.sheetId !== undefined) {
      resolvedSheetId = sub.sheetId
    } else if (locatedAnchor) {
      resolvedSheetId = locatedAnchor.sheet.id
    } else if (working.sheetOrder.length === 1) {
      resolvedSheetId = working.sheetOrder[0]
    } else {
      return {
        kind: 'fail',
        failure: fail(
          Err.INVALID_PARAMS,
          `multi-sheet packet (${working.sheetOrder.join(', ')}): pass sheetId (or beforeId/afterId) on insert`,
        ),
      }
    }
  } else {
    const locatedPre = sub.blockId ? findBlock(working, sub.blockId) : null
    resolvedSheetId = sub.sheetId ?? (locatedPre ? locatedPre.sheet.id : working.sheetOrder[0])
  }

  const locatedPre = sub.blockId ? findBlock(working, sub.blockId) : null
  const sheet = working.sheets[resolvedSheetId]
  if (!sheet) {
    return { kind: 'fail', failure: fail(Err.SHEET_NOT_FOUND, `sheet ${resolvedSheetId} not found`) }
  }

  let effectiveBeforeId = sub.beforeId
  if (!effectiveBeforeId && insertAfterId) {
    const idx = sheet.blocks.findIndex((b) => b.id === insertAfterId)
    if (idx >= 0 && idx + 1 < sheet.blocks.length) {
      effectiveBeforeId = sheet.blocks[idx + 1].id
    }
  }

  // Finding 3: in `auto` mode, agent `patch`, `remove`, AND `move` on human-authored blocks stage proposals.
  const targetOrigin =
    sub.op === 'patch' || sub.op === 'remove' || sub.op === 'move' ? locatedPre?.block?.origin : undefined
  const shouldPropose = ctx.origin === 'agent' && (ctx.inReviewMode || targetOrigin === 'human')

  if (shouldPropose) {
    if (sub.op === 'insert') {
      if (!sub.block) return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, 'insert requires a block') }
      const { block: built, error } = buildBlock(working, sub.block, 'human')
      if (error) return { kind: 'fail', failure: fail(toStoreCode(error), `invalid block: ${error}`) }
      if (built.type === 'header' && !(built.fields?.titel ?? '').trim()) {
        return {
          kind: 'fail',
          failure: fail(Err.INVALID_PARAMS, 'header block requires fields.title (or title)'),
        }
      }
      working.nextBlockSeq += 1
      return {
        kind: 'propose',
        sheetId: resolvedSheetId,
        proposal: {
          id: `prop-${ctx.propSeq}`,
          op: 'insert',
          sheetId: resolvedSheetId,
          targetBlockId: built.id,
          baseHash: '',
          proposedPatch: { block: built, beforeId: effectiveBeforeId },
          status: 'pending',
          createdAtRev: ctx.createdAtRev,
        },
      }
    }

    if (!sub.blockId) {
      return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, `${sub.op} requires blockId`) }
    }
    const target = locatedPre ?? findBlock(working, sub.blockId)
    if (!target) {
      return { kind: 'fail', failure: fail(Err.BLOCK_NOT_FOUND, `block ${sub.blockId} not found`) }
    }
    if (sub.baseHash && sub.baseHash !== target.block.hash) {
      const t = fail(Err.PROPOSAL_CONFLICT, `block ${sub.blockId} changed (base hash mismatch)`)
      t.baseHash = sub.baseHash
      t.currentHash = target.block.hash
      return { kind: 'fail', failure: t }
    }

    if (sub.op === 'patch') {
      const rawPatch = { ...(sub.patch ?? {}) }
      const proposedPatch: Record<string, unknown> = {}
      if (target.block.type === 'header') {
        const hdrFields = resolveHeaderPatchFields(
          target.block.fields as unknown as Record<string, unknown>,
          rawPatch,
        )
        if (hdrFields) proposedPatch.fields = hdrFields
        for (const [k, v] of Object.entries(rawPatch)) {
          if (k !== 'fields' && !HEADER_SHORTHAND_PATCH_KEYS.has(k)) {
            proposedPatch[k] = v
          }
        }
      } else {
        Object.assign(proposedPatch, rawPatch)
      }
      if ('provenance' in proposedPatch) {
        const pRes = validateProvenance(proposedPatch.provenance)
        if (pRes.error) return { kind: 'fail', failure: fail(toStoreCode(pRes.error), 'invalid provenance') }
        proposedPatch.provenance = pRes.provenance
      }
      const beforePatch: Record<string, unknown> = {}
      const rawBlock = target.block as unknown as Record<string, unknown>
      for (const k of Object.keys(proposedPatch)) {
        if (k in rawBlock) beforePatch[k] = JSON.parse(JSON.stringify(rawBlock[k]))
      }
      return {
        kind: 'propose',
        sheetId: target.sheet.id,
        proposal: {
          id: `prop-${ctx.propSeq}`,
          op: 'patch',
          sheetId: target.sheet.id,
          targetBlockId: target.block.id,
          baseHash: target.block.hash,
          beforePatch,
          proposedPatch,
          status: 'pending',
          createdAtRev: ctx.createdAtRev,
        },
      }
    }

    if (sub.op === 'move') {
      const targetSheetId = sub.toSheetId ?? resolvedSheetId
      if (!working.sheets[targetSheetId]) {
        return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, 'target sheet not found') }
      }
      return {
        kind: 'propose',
        sheetId: target.sheet.id,
        proposal: {
          id: `prop-${ctx.propSeq}`,
          op: 'move',
          sheetId: target.sheet.id,
          targetBlockId: target.block.id,
          baseHash: target.block.hash,
          beforePatch: { sheetId: target.sheet.id },
          proposedPatch: {
            toSheetId: targetSheetId,
            toBeforeId: sub.toBeforeId,
            toAfterId: sub.toAfterId,
          },
          status: 'pending',
          createdAtRev: ctx.createdAtRev,
        },
      }
    }

    // remove proposal
    return {
      kind: 'propose',
      sheetId: target.sheet.id,
      proposal: {
        id: `prop-${ctx.propSeq}`,
        op: 'remove',
        sheetId: target.sheet.id,
        targetBlockId: target.block.id,
        baseHash: target.block.hash,
        beforePatch: { type: target.block.type, preview: blockText(target.block).slice(0, 80) },
        proposedPatch: { remove: true },
        status: 'pending',
        createdAtRev: ctx.createdAtRev,
      },
    }
  }

  // Direct mutation path: validate, simulate on `working`, and emit deterministic replay closure for `store.commit`.
  if (sub.op === 'insert') {
    if (!sub.block) return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, 'insert requires a block') }
    const { block, error } = buildBlock(working, sub.block, ctx.origin)
    if (error) return { kind: 'fail', failure: fail(toStoreCode(error), `invalid block: ${error}`) }
    if (block.type === 'header' && !(block.fields?.titel ?? '').trim()) {
      return {
        kind: 'fail',
        failure: fail(Err.INVALID_PARAMS, 'header block requires fields.title (or title)'),
      }
    }
    const simIdx = effectiveBeforeId ? sheet.blocks.findIndex((b) => b.id === effectiveBeforeId) : sheet.blocks.length
    sheet.blocks.splice(simIdx < 0 ? sheet.blocks.length : simIdx, 0, JSON.parse(JSON.stringify(block)) as Block)
    working.nextBlockSeq += 1
    const seqAfterInsert = working.nextBlockSeq
    const beforeAnchor = effectiveBeforeId
    const targetSid = resolvedSheetId
    const note = `insert ${block.id} (${block.type}) on ${targetSid} (${ctx.origin})`
    return {
      kind: 'direct',
      sheetId: targetSid,
      changedId: block.id,
      note,
      applyTo: (p: GalleyPacket) => {
        const sh = p.sheets[targetSid]
        const copy = JSON.parse(JSON.stringify(block)) as Block
        if (Array.isArray(copy.dependsOn) && copy.dependsOn.length > 0) {
          copy.dependsOn = copy.dependsOn.map((d) => {
            const orig = findBlock(p, d.id)
            return orig ? { ...d, sinceHash: orig.block.hash } : d
          })
        }
        copy.hash = hashBlock(copy)
        const idx = beforeAnchor ? sh.blocks.findIndex((b) => b.id === beforeAnchor) : sh.blocks.length
        sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, copy)
        p.nextBlockSeq = Math.max(p.nextBlockSeq + 1, seqAfterInsert)
        return copy.id
      },
    }
  }

  if (!sub.blockId) {
    return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, `${sub.op} requires blockId`) }
  }
  const target = findBlock(working, sub.blockId)
  if (!target) {
    return { kind: 'fail', failure: fail(Err.BLOCK_NOT_FOUND, `block ${sub.blockId} not found`) }
  }
  if (sub.baseHash !== undefined && sub.baseHash !== target.block.hash) {
    const t = fail(Err.PROPOSAL_CONFLICT, `block ${sub.blockId} changed (base hash mismatch)`)
    t.baseHash = sub.baseHash
    t.currentHash = target.block.hash
    return { kind: 'fail', failure: t }
  }

  if (sub.op === 'patch') {
    const patchInput = sub.patch ?? {}
    const applyPatchOnPacket = (p: GalleyPacket): BlockId => {
      const found = findBlock(p, sub.blockId!)
      if (!found) throw new StoreError('not_found', `block ${sub.blockId} not found`)
      const b = found.block as unknown as Record<string, unknown>
      let contentTouched = false
      const isHeader = found.block.type === 'header'

      if (found.block.type === 'header') {
        const hdrFields = resolveHeaderPatchFields(
          found.block.fields as unknown as Record<string, unknown>,
          patchInput,
        )
        if (hdrFields) {
          b.fields = hdrFields
          contentTouched = true
        }
      }

      for (const [k, v] of Object.entries(patchInput)) {
        if (isHeader && (k === 'fields' || HEADER_SHORTHAND_PATCH_KEYS.has(k))) {
          continue
        }
        if (k === 'body') {
          const inlines = toInline(v)
          if (inlines.length > 0) {
            const e = validateInline(inlines)
            if (e) throw new StoreError(e, 'inline limit')
          }
          b.body = inlines
          contentTouched = true
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
          const norm = normalizeDependsOn(p, v, ctx.now)
          if (norm.error) throw new StoreError(norm.error, 'dependsOn must be a valid array')
          b.dependsOn = norm.deps
        } else if (k === 'headers') {
          const hRes = normalizeTableHeaders(v)
          if (hRes.error) throw new StoreError(hRes.error, 'invalid table headers')
          b.headers = hRes.headers
          contentTouched = true
        } else if (k === 'rows') {
          const rRes = normalizeTableRows(v)
          if (rRes.error) throw new StoreError(rRes.error, 'invalid table rows')
          b.rows = rRes.rows
          contentTouched = true
        } else if (k === 'colWidths') {
          const wRes = normalizeTableColWidths(v)
          if (wRes.error) throw new StoreError(wRes.error, 'invalid table colWidths')
          if (wRes.colWidths) b.colWidths = wRes.colWidths
          else delete b.colWidths
          contentTouched = true
        } else if (k === 'fields') {
          b.fields = normalizeHeaderFields(v)
          contentTouched = true
        } else if (k === 'provenance') {
          const provRes = validateProvenance(v)
          if (provRes.error) throw new StoreError(provRes.error, 'invalid provenance')
          if (provRes.provenance === null) delete b.provenance
          else if (provRes.provenance !== undefined) b.provenance = provRes.provenance
          contentTouched = true
        } else if (['level', 'tone', 'numbered', 'title', 'lineNumbers'].includes(k)) {
          b[k] = v
          contentTouched = true
        }
      }

      if (contentTouched && !('dependsOn' in patchInput) && Array.isArray(b.dependsOn) && b.dependsOn.length > 0) {
        b.dependsOn = (b.dependsOn as Block['dependsOn']).map((d) => {
          const originBlk = findBlock(p, d.id)
          return originBlk ? { id: d.id, sinceHash: originBlk.block.hash, at: ctx.now } : d
        })
      }
      if (ctx.origin === 'human') b.origin = 'human'
      if (b.body) {
        const e = validateInline(b.body as Inline[])
        if (e) throw new StoreError(e, 'inline limit')
      }
      found.block.hash = hashBlock(found.block)
      return found.block.id
    }

    try {
      applyPatchOnPacket(working)
    } catch (e) {
      return { kind: 'fail', failure: mapError(e) }
    }
    const patchedKeys = Object.keys(patchInput).join(',') || 'noop'
    const touchedSid = target.sheet.id
    return {
      kind: 'direct',
      sheetId: touchedSid,
      changedId: target.block.id,
      note: `patch ${target.block.id} (${target.block.type}:${patchedKeys}) on ${touchedSid} (${ctx.origin})`,
      applyTo: applyPatchOnPacket,
    }
  }

  if (sub.op === 'move') {
    const targetSheetId = sub.toSheetId ?? resolvedSheetId
    if (!working.sheets[targetSheetId]) {
      return { kind: 'fail', failure: fail(Err.INVALID_PARAMS, 'target sheet not found') }
    }
    const fromSid = target.sheet.id
    const applyMoveOnPacket = (p: GalleyPacket): BlockId => {
      const from = findBlock(p, sub.blockId!)
      if (!from) throw new StoreError('not_found', `block ${sub.blockId} not found`)
      const dest = p.sheets[targetSheetId]
      if (!dest) throw new StoreError('invalid_op', 'target sheet not found')
      from.sheet.blocks.splice(from.index, 1)
      let to = dest.blocks.length
      if (sub.toBeforeId) to = dest.blocks.findIndex((b) => b.id === sub.toBeforeId)
      if (sub.toAfterId) {
        const i = dest.blocks.findIndex((b) => b.id === sub.toAfterId)
        to = i >= 0 ? i + 1 : dest.blocks.length
      }
      dest.blocks.splice(to < 0 ? dest.blocks.length : to, 0, from.block)
      return from.block.id
    }
    try {
      applyMoveOnPacket(working)
    } catch (e) {
      return { kind: 'fail', failure: mapError(e) }
    }
    return {
      kind: 'direct',
      sheetId: targetSheetId,
      changedId: sub.blockId,
      note:
        fromSid === targetSheetId
          ? `move ${sub.blockId} within ${targetSheetId} (${ctx.origin})`
          : `move ${sub.blockId} ${fromSid}→${targetSheetId} (${ctx.origin})`,
      applyTo: applyMoveOnPacket,
    }
  }

  // remove
  const applyRemoveOnPacket = (p: GalleyPacket): BlockId => {
    const found = findBlock(p, sub.blockId!)
    if (!found) throw new StoreError('not_found', `block ${sub.blockId} not found`)
    found.sheet.blocks.splice(found.index, 1)
    return found.block.id
  }
  const removedType = target.block.type
  const removedSid = target.sheet.id
  try {
    applyRemoveOnPacket(working)
  } catch (e) {
    return { kind: 'fail', failure: mapError(e) }
  }
  return {
    kind: 'direct',
    sheetId: removedSid,
    changedId: sub.blockId,
    note: `remove ${sub.blockId} (${removedType}) from ${removedSid} (${ctx.origin})`,
    applyTo: applyRemoveOnPacket,
  }
}

export async function galleyEditBlock(deps: GalleyToolsDeps, args: EditBlockArgs): Promise<Ok<{
  applied: boolean
  appliedCount?: number
  proposedCount?: number
  packetId: string
  sheetId: SheetId
  sheetOrder?: SheetId[]
  rev: number
  /** The block that was written (compact outline), or null (proposal / sheet op path). */
  block: BlockOutline | null
  blocks?: BlockOutline[]
  /** The proposal recorded (when reviewMode==='review' or agent mutation on human block), if any. */
  proposal: ProposalSummary | null
  proposals?: ProposalSummary[]
  proof: SheetProofReceipt | null
  proofs?: Record<SheetId, SheetProofReceipt | null>
  /** Block ids now stale (StaleInfo != null) after this change. */
  staleDependents: BlockId[]
}> | ToolFailure> {
  const { store } = deps
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = store.load(pid)!
  const inReviewMode = (packet.reviewMode ?? 'auto') === 'review'

  // Sheet-level ops (`sheet-add` | `sheet-update` | `sheet-remove`) through the single writer
  if (args.op === 'sheet-add' || args.op === 'sheet-update' || args.op === 'sheet-remove') {
    if (inReviewMode && args.origin === 'agent') {
      return fail(Err.INVALID_PARAMS, 'packet is locked in review mode; unlock auto mode before sheet structure edits')
    }
    try {
      let targetSid: SheetId
      if (args.op === 'sheet-add') {
        if (args.targetPages !== undefined && args.targetPages !== null && (!Number.isFinite(args.targetPages) || args.targetPages < 0)) {
          return fail(Err.INVALID_PARAMS, 'targetPages must be >= 1 (or 0/null for unbounded)')
        }
        if (args.orientation !== undefined && args.orientation !== 'portrait' && args.orientation !== 'landscape') {
          return fail(Err.INVALID_PARAMS, `invalid orientation '${String(args.orientation)}'`)
        }
        if (args.paper !== undefined && args.paper !== 'a4' && args.paper !== 'letter') {
          return fail(Err.INVALID_PARAMS, `invalid paper '${String(args.paper)}'`)
        }
        const added = store.addSheet(pid, {
          title: args.title,
          orientation: args.orientation,
          targetPages: args.targetPages && args.targetPages > 0 ? args.targetPages : undefined,
          paper: args.paper,
          actor: args.origin,
        })
        targetSid = added.sheetId
      } else if (args.op === 'sheet-update') {
        const sid = args.sheetId ?? (packet.sheetOrder.length === 1 ? packet.sheetOrder[0] : undefined)
        if (!sid) {
          return fail(Err.INVALID_PARAMS, `multi-sheet packet (${packet.sheetOrder.join(', ')}): pass sheetId on sheet-update`)
        }
        if (!packet.sheets[sid]) return fail(Err.SHEET_NOT_FOUND, `sheet ${sid} not found`)
        if (
          args.title === undefined &&
          args.targetPages === undefined &&
          args.orientation === undefined &&
          args.paper === undefined
        ) {
          return fail(Err.INVALID_PARAMS, 'sheet-update requires at least one of title, targetPages, orientation, or paper')
        }
        store.updateSheet(
          pid,
          sid,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.targetPages !== undefined ? { targetPages: args.targetPages } : {}),
            ...(args.orientation !== undefined ? { orientation: args.orientation } : {}),
            ...(args.paper !== undefined ? { paper: args.paper } : {}),
          },
          args.origin,
        )
        targetSid = sid
      } else {
        // sheet-remove
        if (!args.sheetId) return fail(Err.INVALID_PARAMS, 'sheet-remove requires sheetId')
        if (!packet.sheets[args.sheetId]) return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`)
        const updated = store.removeSheet(pid, args.sheetId, args.origin)
        targetSid = updated.sheetOrder[0]
      }

      const loaded = store.load(pid)!
      const sh = loaded.sheets[targetSid]
      const proof =
        deps.render && sh
          ? await (async () => {
              try {
                return toReceipt(
                  await deps.render!(sh, loaded, assetBytesForPacket(deps, loaded)),
                  loaded,
                  sh,
                )
              } catch {
                return null
              }
            })()
          : null
      return {
        ok: true,
        applied: true,
        packetId: pid,
        sheetId: targetSid,
        sheetOrder: loaded.sheetOrder,
        rev: loaded.rev,
        block: null,
        proposal: null,
        proof,
        staleDependents: staleBlockIds(loaded),
      }
    } catch (e) {
      return mapError(e)
    }
  }

  // Finding 5: `op: 'batch'` — 1..25 block operations in a single atomic commit + single proof pass.
  if (args.op === 'batch') {
    if (!Array.isArray(args.ops) || args.ops.length === 0 || args.ops.length > MAX_BATCH_OPS) {
      return fail(Err.INVALID_PARAMS, `batch requires ops array of 1..${MAX_BATCH_OPS} block operations`)
    }
    if (args.sheetId !== undefined && !packet.sheets[args.sheetId]) {
      return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`)
    }
    try {
      const working = JSON.parse(JSON.stringify(packet)) as GalleyPacket
      const now = deps.now ? deps.now() : new Date().toISOString()
      let propSeq = store.listProposals(pid).length + 1
      const directSteps: Extract<PlannedBlockStep, { kind: 'direct' }>[] = []
      const stagedProposals: GalleyProposal[] = []
      const touchedSheetSet = new Set<SheetId>()
      let lastSheetId: SheetId = args.sheetId ?? packet.sheetOrder[0]

      for (let i = 0; i < args.ops.length; i++) {
        const rawSub = args.ops[i]
        if (!rawSub || typeof rawSub !== 'object' || Array.isArray(rawSub)) {
          return fail(Err.INVALID_PARAMS, `batch ops[${i}] must be an object`)
        }
        const sub: BatchBlockOp = {
          ...rawSub,
          ...(rawSub.sheetId === undefined && args.sheetId !== undefined ? { sheetId: args.sheetId } : {}),
        }
        const planned = planAndSimulateBlockOp(working, sub, {
          origin: args.origin,
          inReviewMode,
          createdAtRev: packet.rev,
          propSeq,
          now,
        })
        if (planned.kind === 'fail') {
          return planned.failure
        }
        touchedSheetSet.add(planned.sheetId)
        lastSheetId = planned.sheetId
        if (planned.kind === 'propose') {
          stagedProposals.push(planned.proposal)
          propSeq += 1
        } else {
          directSteps.push(planned)
        }
      }

      if (directSteps.length > 0) {
        const summaryNote =
          directSteps.length <= 2
            ? directSteps.map((s) => s.note).join('; ')
            : `batch (${directSteps.length} ops on ${[...touchedSheetSet].join(',')}) (${args.origin})`
        store.commit(
          pid,
          null,
          (p) => {
            let lastId: BlockId | null = null
            for (const step of directSteps) {
              lastId = step.applyTo(p)
            }
            return lastId
          },
          { actor: args.origin, note: summaryNote },
        )
        for (const prop of stagedProposals) {
          store.addProposal(pid, prop, { bumpRev: false })
        }
      } else if (stagedProposals.length > 0) {
        for (let i = 0; i < stagedProposals.length; i++) {
          store.addProposal(pid, stagedProposals[i], { bumpRev: i === stagedProposals.length - 1 })
        }
      }

      const loaded = store.load(pid)!
      const proofsBySheet: Record<SheetId, SheetProofReceipt | null> = {}
      if (deps.render) {
        const assetBytes = assetBytesForPacket(deps, loaded)
        for (const sid of loaded.sheetOrder) {
          if (!touchedSheetSet.has(sid)) continue
          const sh = loaded.sheets[sid]
          if (!sh) continue
          try {
            proofsBySheet[sid] = toReceipt(await deps.render(sh, loaded, assetBytes), loaded, sh)
          } catch {
            proofsBySheet[sid] = null
          }
        }
      } else {
        for (const sid of touchedSheetSet) proofsBySheet[sid] = null
      }

      const directOutlines: BlockOutline[] = []
      const seenIds = new Set<BlockId>()
      for (const step of directSteps) {
        if (seenIds.has(step.changedId)) continue
        const found = findBlock(loaded, step.changedId)
        if (found) {
          directOutlines.push(blockOutline(found.block))
          seenIds.add(step.changedId)
        }
      }
      const proposalSummaries: ProposalSummary[] = stagedProposals.map((p) => ({
        id: p.id,
        op: p.op ?? 'patch',
        targetBlockId: p.targetBlockId,
        status: 'pending',
      }))

      return {
        ok: true,
        applied: stagedProposals.length === 0,
        appliedCount: directSteps.length,
        proposedCount: stagedProposals.length,
        packetId: pid,
        sheetId: lastSheetId,
        rev: loaded.rev,
        block: directOutlines.length > 0 ? directOutlines[directOutlines.length - 1] : null,
        blocks: directOutlines,
        proposal: proposalSummaries[0] ?? null,
        proposals: proposalSummaries,
        proof: proofsBySheet[lastSheetId] ?? null,
        proofs: proofsBySheet,
        staleDependents: staleBlockIds(loaded),
      }
    } catch (e) {
      return mapError(e)
    }
  }

  try {
    const working = JSON.parse(JSON.stringify(packet)) as GalleyPacket
    const now = deps.now ? deps.now() : new Date().toISOString()
    const propSeq = store.listProposals(pid).length + 1
    const planned = planAndSimulateBlockOp(
      working,
      {
        op: args.op,
        sheetId: args.sheetId,
        beforeId: args.beforeId,
        afterId: args.afterId,
        afterBlockId: args.afterBlockId,
        block: args.block,
        blockId: args.blockId,
        baseHash: args.baseHash,
        patch: args.patch,
        toSheetId: args.toSheetId,
        toBeforeId: args.toBeforeId,
        toAfterId: args.toAfterId,
      },
      {
        origin: args.origin,
        inReviewMode,
        createdAtRev: packet.rev,
        propSeq,
        now,
      },
    )
    if (planned.kind === 'fail') {
      return planned.failure
    }

    if (planned.kind === 'propose') {
      const prop = planned.proposal
      store.addProposal(pid, prop)
      const loadedProp = store.load(pid)!
      const propSheetId = prop.sheetId ?? planned.sheetId
      const proofProp = deps.render
        ? await (async () => {
            try {
              const propSheet = loadedProp.sheets[propSheetId]
              return toReceipt(
                await deps.render!(propSheet, loadedProp, assetBytesForPacket(deps, loadedProp)),
                loadedProp,
                propSheet,
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
        sheetId: propSheetId,
        rev: loadedProp.rev,
        block: null,
        proposal: { id: prop.id, op: prop.op ?? 'patch', targetBlockId: prop.targetBlockId, status: 'pending' },
        proof: proofProp,
        proofs: { [propSheetId]: proofProp },
        staleDependents: staleBlockIds(loadedProp),
      }
    }

    const needsExpect = (args.op === 'patch' || args.op === 'remove' || args.op === 'move') && args.baseHash !== undefined
    store.commit(
      pid,
      needsExpect ? { blockId: args.blockId ?? '', baseHash: args.baseHash! } : null,
      (p) => planned.applyTo(p),
      { actor: args.origin, note: planned.note },
    )

    const loaded = store.load(pid)!
    const touchedSheetId = planned.sheetId
    const proof = deps.render
      ? await (async () => {
          try {
            const touchedSheet = loaded.sheets[touchedSheetId]
            return toReceipt(
              await deps.render!(touchedSheet, loaded, assetBytesForPacket(deps, loaded)),
              loaded,
              touchedSheet,
            )
          } catch {
            return null
          }
        })()
      : null

    let block: BlockOutline | null = null
    const found = findBlock(loaded, planned.changedId)
    if (found) block = blockOutline(found.block)

    return {
      ok: true,
      applied: true,
      packetId: pid,
      sheetId: touchedSheetId,
      rev: loaded.rev,
      block,
      proposal: null,
      proof,
      proofs: { [touchedSheetId]: proof },
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
  provenance?: SourceProvenance
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
      let prov: SourceProvenance | undefined
      if (args.provenance !== undefined) {
        const provRes = validateProvenance(args.provenance)
        if (provRes.error || provRes.provenance === null) {
          return fail(Err.INVALID_PARAMS, 'invalid provenance (sourceId required)')
        }
        prov = provRes.provenance
      }
      const body = toInline(args.body ?? '')
      const annotation: GalleyAnnotation = {
        id: `ann-${store.listAnnotations(pid).length + 1}`,
        blockId: args.blockId,
        author: args.author ?? 'human',
        body,
        ...(prov ? { provenance: prov } : {}),
        resolved: false,
        createdAtRev: packet.rev,
      }
      const saved = store.addAnnotation(pid, annotation)
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: saved }
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
  /** Attribution of caller (`'agent'` blocks on error-severity preflight; `'human'` may bypass with `force: true`). */
  origin?: 'human' | 'agent'
  /** Human-only override to allow exporting despite `severity: 'error'` preflight diagnostics. */
  force?: boolean
}

export function exportSlug(title: string): string {
  const de = title
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
  const s = de
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
): Promise<
  | Ok<{
      format: string
      text?: string
      bytes?: Buffer
      files?: ExportFileReceipt[]
      preflightWarnings: GalleyPreflightWarning[]
    }>
  | ToolFailure
> {
  const pid = resolvePacketId(deps, args.packetId)
  if (typeof pid !== 'string') return pid
  const packet = deps.store.load(pid)!
  if (!['typ', 'md', 'tex', 'pdf', 'docx'].includes(args.format)) {
    return fail(Err.INVALID_PARAMS, `unknown export format '${args.format}'`)
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
    const slug = exportSlug(packet.title)
    const needAssets = args.format === 'pdf' || args.format === 'docx' || Boolean(deps.render)
    const packetAssetBytes = needAssets ? assetBytesForPacket(deps, packet) : {}

    const renderedBySheet = new Map<SheetId, SheetRender>()
    const proofMap: Record<SheetId, SheetProofReceipt | null> = {}

    if (deps.render) {
      for (const sid of packet.sheetOrder) {
        const sh = packet.sheets[sid]
        if (!sh) continue
        if (args.format === 'pdf' && targetIds.includes(sid)) {
          const sr = await deps.render(sh, packet, packetAssetBytes)
          renderedBySheet.set(sid, sr)
          proofMap[sid] = toReceipt(sr, packet, sh)
        } else {
          try {
            const sr = await deps.render(sh, packet, packetAssetBytes)
            renderedBySheet.set(sid, sr)
            proofMap[sid] = toReceipt(sr, packet, sh)
          } catch {
            proofMap[sid] = null
          }
        }
      }
    }

    const preflightCwd = args.outDir ?? deps.cwd ?? process.cwd()
    const preflightWarnings = (deps.registry ?? defaultGalleyRegistry).runPreflight(
      packet,
      deps.render ? proofMap : undefined,
      preflightCwd,
    )
    const blockingErrors = preflightWarnings.filter((w) => w.severity === 'error')
    if (blockingErrors.length > 0) {
      const humanForceAllowed = args.origin === 'human' && args.force === true
      const headlessForceAllowed = args.origin === undefined && args.force === true
      if (!humanForceAllowed && !headlessForceAllowed) {
        const blocked = fail(
          Err.EXPORT_BLOCKED_BY_PREFLIGHT,
          `export blocked by ${blockingErrors.length} preflight error(s): ${blockingErrors.map((e) => `${e.code}: ${e.message}`).join(' | ')}`,
        )
        blocked.preflightWarnings = preflightWarnings
        return blocked
      }
    }

    const prepared: Array<{ sid: SheetId; text?: string; bytes: Buffer; pages: number | null }> = []
    for (let i = 0; i < targetIds.length; i++) {
      const sid = targetIds[i]
      const sheet = packet.sheets[sid]
      let text: string | undefined
      let bytes: Buffer
      let pages: number | null = null

      switch (args.format) {
        case 'typ':
          text = compileSheet(sheet, packet.assets, packet.locale, { colophon: packet.colophon }).typ
          bytes = Buffer.from(text, 'utf8')
          break
        case 'md':
          text = toMarkdown(sheet, packet.locale)
          bytes = Buffer.from(text, 'utf8')
          break
        case 'tex':
          text = toTex(sheet)
          bytes = Buffer.from(text, 'utf8')
          break
        case 'docx':
          bytes = exportSheetDocx(sheet, packet, packetAssetBytes)
          break
        case 'pdf': {
          if (!deps.render) return fail(Err.TYPST_COMPILE_ERROR, 'no render arm available for pdf')
          const sr = renderedBySheet.get(sid) ?? (await deps.render(sheet, packet, packetAssetBytes))
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
        firstBytes = args.format === 'pdf' || args.format === 'docx' ? bytes : undefined
      }
      prepared.push({ sid, text, bytes, pages })
    }

    const files: ExportFileReceipt[] = []
    if (args.outDir) {
      mkdirSync(join(args.outDir, 'galley-exports'), { recursive: true })
      const omitSheetSuffix = packet.sheetOrder.length === 1
      for (const item of prepared) {
        const filename = omitSheetSuffix ? `${slug}.${args.format}` : `${slug}-${item.sid}.${args.format}`
        const relPath = `galley-exports/${filename}`
        writeFileSync(join(args.outDir, relPath), item.bytes)
        files.push({
          sheetId: item.sid,
          path: relPath,
          format: args.format,
          pages: item.pages,
          sizeBytes: item.bytes.length,
          sha256: createHash('sha256').update(item.bytes).digest('hex'),
        })
      }
    }

    return {
      ok: true,
      format: args.format,
      ...(firstText !== undefined ? { text: firstText } : {}),
      ...(firstBytes !== undefined ? { bytes: firstBytes } : {}),
      ...(args.outDir ? { files } : {}),
      preflightWarnings,
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

function mdCell(inlines: Inline[]): string {
  return inlineToMarkdown(inlines)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim()
}

function toMarkdown(sheet: GalleySheet, locale?: GalleyLocale): string {
  const pStr = getGalleyStrings(locale).print
  const isDe = locale === 'de'
  const L: string[] = [`# ${sheet.title}`, '']
  let taskNum = 0
  for (const b of sheet.blocks) {
    if (b.type === 'header') {
      const f = b.fields ?? { titel: '' }
      const meta: string[] = []
      if (f.subtitle) meta.push(f.subtitle)
      if (f.fach) meta.push(isDe ? `Fach: ${f.fach}` : f.fach)
      if (f.klasse) meta.push(f.klasse.includes(':') ? f.klasse : `${pStr.groupPrefix}${f.klasse}`)
      if (f.datum) meta.push(isDe ? `Datum: ${f.datum}` : f.datum)
      if (f.name !== undefined) {
        meta.push(f.name ? `${pStr.namePrefix}${f.name}` : `${pStr.namePrefix}________________________`)
      }
      L.push(`**${f.titel ?? ''}**${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`)
    } else if (b.type === 'heading') {
      L.push(`${'#'.repeat(b.level)} ${inlineToMarkdown(b.body)}`)
    } else if (b.type === 'source_text') {
      if (b.title) L.push(`### ${b.title}`)
      L.push(inlineToMarkdown(b.body))
      if (b.provenance?.citation) {
        const attr = b.provenance.locator
          ? `${b.provenance.citation}, ${b.provenance.locator}`
          : b.provenance.citation
        L.push(`*— ${attr}*`)
      }
    } else if (b.type === 'task') {
      taskNum += 1
      const bodyMd = inlineToMarkdown(b.body)
      const hasPrefix = /^\*{0,2}\s*(?:Task|Problem|Question|Exercise|Aufgabe)\s+\d+\b/i.test(bodyMd)
      L.push(hasPrefix ? bodyMd : `**${pStr.taskPrefix} ${taskNum}:** ${bodyMd}`)
    } else if (b.type === 'table') {
      const colCount = Math.max(
        b.headers.length,
        ...b.rows.map((r) => r.length),
        1,
      )
      const headerCells = Array.from({ length: colCount }, (_, i) => {
        const text = b.headers[i] ? mdCell(b.headers[i]) : ''
        return text ? `**${text}**` : ''
      })
      L.push(`| ${headerCells.join(' | ')} |`)
      L.push(`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`)
      for (const row of b.rows) {
        const rowCells = Array.from({ length: colCount }, (_, i) => (row[i] ? mdCell(row[i]) : ''))
        L.push(`| ${rowCells.join(' | ')} |`)
      }
    } else if (b.type === 'callout') {
      L.push(`> [${b.tone}] ${inlineToMarkdown(b.body).replace(/\n/g, '\n> ')}`)
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
