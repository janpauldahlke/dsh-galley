/**
 * Pure, DOM-free state & protocol helpers for the Galley rightbar pane (spec 04).
 *
 * Bundled into `lib/client.js` for the browser AND emitted standalone as
 * `lib/galley-pane.mjs` so `node --test` verifies polling delays, width mode
 * thresholds, UTF-8 SVG data-URI decoding, block defaults, and dirty-buffer
 * conflict reconciliation without a DOM.
 */
import { parseInlines, serializeInlines } from '../shared/inlineMarkup.ts'
import { getGalleyStrings, type GalleyLocale } from '../shared/i18n.ts'
import type {
  Block,
  BlockId,
  BlockType,
  HeaderBlock,
  Inline,
  LayoutSlot,
  ProofHitBand,
} from '../shared/types.ts'

export const WIDE_PANE_MIN_PX = 480
export const POLL_IDLE_MS = 2000
export const POLL_POST_MUTATION_MS = 1000
export const POLL_CATCHUP_MS = 150
export const POLL_HIDDEN_MS = 10000
export const POLL_RETRY_MS = 2000

export type PaneLayoutOverride = 'auto' | 'wide' | 'narrow'
export type NarrowTab = 'proof' | 'blocks'

export function computePaneMode(widthPx: number, override: PaneLayoutOverride): 'wide' | 'narrow' {
  if (override === 'wide') return 'wide'
  if (override === 'narrow') return 'narrow'
  return widthPx >= WIDE_PANE_MIN_PX ? 'wide' : 'narrow'
}

export function nextPollDelayMs(opts: {
  hidden: boolean
  hadError: boolean
  postMutation: boolean
  revAdvanced: boolean
}): number {
  if (opts.hidden) return POLL_HIDDEN_MS
  if (opts.hadError) return POLL_RETRY_MS
  if (opts.revAdvanced) return POLL_CATCHUP_MS
  if (opts.postMutation) return POLL_POST_MUTATION_MS
  return POLL_IDLE_MS
}

export function withCwdQuery(
  path: string,
  cwd: string | null | undefined,
  sessionId?: string | null,
): string {
  const params: string[] = []
  const trimmedCwd = cwd?.trim()
  if (trimmedCwd) params.push(`cwd=${encodeURIComponent(trimmedCwd)}`)
  const trimmedSid = sessionId?.trim()
  if (trimmedSid) params.push(`sessionId=${encodeURIComponent(trimmedSid)}`)
  if (params.length === 0) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${params.join('&')}`
}

export function shortCwdLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return cwd.startsWith('/') ? cwd : parts.join('/')
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * Decode a `data:image/svg+xml;base64,…` URI (or raw `<svg…` string) into UTF-8
 * SVG markup ready for inline rendering. Works in both browser and Node.
 */
export function decodeSvgDataUri(uriOrSvg: string): string {
  if (!uriOrSvg) return ''
  const trimmed = uriOrSvg.trim()
  if (trimmed.startsWith('<svg')) return trimmed
  const prefix = 'data:image/svg+xml;base64,'
  if (trimmed.startsWith(prefix)) {
    const b64 = trimmed.slice(prefix.length)
    if (typeof globalThis.atob === 'function') {
      const bin = globalThis.atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    }
    return Buffer.from(b64, 'base64').toString('utf8')
  }
  return ''
}

export function formatOverflowBanner(
  overflowLines: number,
  targetPages?: number,
  locale?: GalleyLocale,
): string | null {
  if (!overflowLines || overflowLines <= 0) return null
  const ui = getGalleyStrings(locale).ui
  if (targetPages && targetPages > 0) {
    return ui.overflowOverTarget(overflowLines, targetPages)
  }
  return ui.overflowGeneric(overflowLines)
}

// ── Block preview & starter templates ───────────────────────────────────────

function plainInlineText(inlines: Inline[] | undefined): string {
  if (!inlines || inlines.length === 0) return ''
  return inlines
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
        case 'math':
          return n.v
        case 'strong':
        case 'emph':
          return plainInlineText(n.c)
        case 'cloze':
          return `[${n.hint ?? '___'}]`
        case 'newline':
          return ' '
        default:
          return ''
      }
    })
    .join('')
}

export function flattenBlockPreview(block: Block, maxChars = 60): string {
  if (block.type === 'header') {
    const f = block.fields ?? ({} as HeaderBlock['fields'])
    const joined = [f.titel, f.subtitle, f.fach, f.klasse, f.datum].filter(Boolean).join(' · ')
    return (joined || 'Header').slice(0, maxChars)
  }
  if (block.type === 'table') {
    const head = (block.headers ?? []).map((c) => plainInlineText(c)).join(' | ')
    return (head || `${block.rows?.length ?? 0} rows`).slice(0, maxChars)
  }
  const body = (block as { body?: Inline[] }).body
  const raw = plainInlineText(body).replace(/\s+/g, ' ').trim()
  return raw.slice(0, maxChars)
}

export function createStarterBlockPayload(type: BlockType): Record<string, unknown> {
  switch (type) {
    case 'header':
      return {
        type: 'header',
        fields: { titel: 'Document', fach: '', klasse: '', datum: '', name: '' },
      }
    case 'heading':
      return {
        type: 'heading',
        level: 2,
        numbered: false,
        body: [{ t: 'text', v: 'Section' }],
      }
    case 'prose':
      return {
        type: 'prose',
        body: [{ t: 'text', v: 'New paragraph.' }],
      }
    case 'source_text':
      return {
        type: 'source_text',
        title: 'Source Excerpt',
        lineNumbers: { every: 5, start: 1 },
        body: [{ t: 'text', v: 'First line of source text.\nSecond line.' }],
      }
    case 'task':
      return {
        type: 'task',
        body: [{ t: 'text', v: 'Complete the following task.' }],
      }
    case 'table':
      return {
        type: 'table',
        headers: [[{ t: 'text', v: 'Column 1' }], [{ t: 'text', v: 'Column 2' }]],
        rows: [[[{ t: 'text', v: 'Item' }], [{ t: 'text', v: 'Description' }]]],
      }
    case 'callout':
      return {
        type: 'callout',
        tone: 'info',
        body: [{ t: 'text', v: 'Important note.' }],
      }
    case 'answer':
      return {
        type: 'answer',
        body: [{ t: 'text', v: 'Expected answer.' }],
      }
  }
}

// ── Dirty editor buffer & conflict state machine (spec 04 §4 & §6) ──────────

export interface BlockDraftBuffer {
  blockId: BlockId
  blockType: BlockType
  baseHash: string
  dirty: boolean
  conflict: boolean
  remoteHash?: string
  // Editable fields across the 8 block types:
  markup: string
  headerFields: { titel: string; subtitle: string; fach: string; klasse: string; datum: string; name: string }
  headerShowNameLine: boolean
  headingLevel: 1 | 2 | 3
  headingNumbered: boolean
  sourceTitle: string
  lineEvery: number // 0 = disabled
  lineStart: number
  calloutTone: 'info' | 'hint' | 'warning'
  tableHeaders: string[]
  tableRows: string[][]
  slot: LayoutSlot
  dependsOnIds: BlockId[]
}

export function blockToDraftBuffer(block: Block): BlockDraftBuffer {
  const base: BlockDraftBuffer = {
    blockId: block.id,
    blockType: block.type,
    baseHash: block.hash,
    dirty: false,
    conflict: false,
    markup: '',
    headerFields: { titel: '', subtitle: '', fach: '', klasse: '', datum: '', name: '' },
    headerShowNameLine: true,
    headingLevel: 1,
    headingNumbered: false,
    sourceTitle: '',
    lineEvery: 0,
    lineStart: 1,
    calloutTone: 'info',
    tableHeaders: ['Column 1', 'Column 2'],
    tableRows: [['', '']],
    slot: block.slot ? JSON.parse(JSON.stringify(block.slot)) : { mode: 'full' },
    dependsOnIds: (block.dependsOn ?? []).map((d) => d.id),
  }

  switch (block.type) {
    case 'header':
      base.headerFields = {
        titel: block.fields?.titel ?? '',
        subtitle: block.fields?.subtitle ?? '',
        fach: block.fields?.fach ?? '',
        klasse: block.fields?.klasse ?? '',
        datum: block.fields?.datum ?? '',
        name: block.fields?.name ?? '',
      }
      base.headerShowNameLine = block.fields?.name !== undefined
      break
    case 'heading':
      base.headingLevel = block.level ?? 1
      base.headingNumbered = Boolean(block.numbered)
      base.markup = serializeInlines(block.body)
      break
    case 'source_text':
      base.sourceTitle = block.title ?? ''
      base.lineEvery = block.lineNumbers?.every ?? 0
      base.lineStart = block.lineNumbers?.start ?? 1
      base.markup = serializeInlines(block.body)
      break
    case 'callout':
      base.calloutTone = block.tone ?? 'info'
      base.markup = serializeInlines(block.body)
      break
    case 'table':
      base.tableHeaders =
        block.headers && block.headers.length > 0
          ? block.headers.map((c) => serializeInlines(c))
          : ['Column 1']
      base.tableRows =
        block.rows && block.rows.length > 0
          ? block.rows.map((r) => r.map((c) => serializeInlines(c)))
          : [base.tableHeaders.map(() => '')]
      break
    case 'prose':
    case 'task':
    case 'answer':
      base.markup = serializeInlines(block.body)
      break
  }

  return base
}

/**
 * Reconcile an open editor buffer with a newly polled server block:
 * - Clean buffer (`!dirty`) -> seamlessly adopts server block.
 * - Dirty buffer with matching `baseHash` -> keeps user's in-flight edits untouched.
 * - Dirty buffer with changed `block.hash !== baseHash` -> flags `conflict: true`
 *   (spec 04 §4.4: never silently clobber uncommitted human keystrokes).
 */
export function reconcileDraftBuffer(
  current: BlockDraftBuffer | null,
  incoming: Block | undefined,
): BlockDraftBuffer | null {
  if (!incoming) return null
  if (!current || current.blockId !== incoming.id) {
    return blockToDraftBuffer(incoming)
  }
  if (!current.dirty) {
    return blockToDraftBuffer(incoming)
  }
  if (incoming.hash === current.baseHash) {
    return current.conflict ? { ...current, conflict: false, remoteHash: undefined } : current
  }
  return {
    ...current,
    conflict: true,
    remoteHash: incoming.hash,
  }
}

export interface CommitOutcome {
  ok: boolean
  status: number
}

/**
 * Apply the HTTP result of a human commit to the local draft buffer (Spec 04 §4.4):
 * - `ok: true` -> clears `dirty` and `conflict`.
 * - `status === 409` -> MUST preserve `dirty: true` and set `conflict: true` so
 *   a subsequent state poll never clobbers uncommitted human keystrokes!
 * - other errors -> keep `dirty: true` so local work is retained.
 */
export function applyCommitOutcome(
  draft: BlockDraftBuffer,
  outcome: CommitOutcome,
): BlockDraftBuffer {
  if (outcome.ok) {
    return { ...draft, dirty: false, conflict: false, remoteHash: undefined }
  }
  if (outcome.status === 409) {
    return { ...draft, dirty: true, conflict: true }
  }
  return { ...draft, dirty: true }
}

/** Convert a BlockDraftBuffer into the `patch` payload for `POST /api/galley/edit`. */
export function draftBufferToPatch(draft: BlockDraftBuffer): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (draft.blockType !== 'header' && draft.blockType !== 'heading') {
    patch.slot = draft.slot
  }
  patch.dependsOn = draft.dependsOnIds

  switch (draft.blockType) {
    case 'header': {
      const f: Record<string, string> = {
        titel: draft.headerFields.titel,
        fach: draft.headerFields.fach,
        klasse: draft.headerFields.klasse,
        datum: draft.headerFields.datum,
      }
      if (draft.headerFields.subtitle.trim().length > 0) {
        f.subtitle = draft.headerFields.subtitle
      }
      if (draft.headerShowNameLine) {
        f.name = draft.headerFields.name
      }
      patch.fields = f
      break
    }
    case 'heading':
      patch.level = draft.headingLevel
      patch.numbered = draft.headingNumbered
      patch.body = parseInlines(draft.markup)
      break
    case 'source_text':
      patch.title = draft.sourceTitle || undefined
      patch.lineNumbers =
        draft.lineEvery > 0
          ? { every: Math.max(1, Math.floor(draft.lineEvery)), start: Math.max(1, Math.floor(draft.lineStart || 1)) }
          : undefined
      patch.body = parseInlines(draft.markup)
      break
    case 'callout':
      patch.tone = draft.calloutTone
      patch.body = parseInlines(draft.markup)
      break
    case 'table':
      patch.headers = draft.tableHeaders.map((h) => parseInlines(h))
      patch.rows = draft.tableRows.map((row) => row.map((cell) => parseInlines(cell)))
      break
    case 'prose':
    case 'task':
    case 'answer':
      patch.body = parseInlines(draft.markup)
      break
  }

  return patch
}

/**
 * Convert a page-local `ProofHitBand` (`pt`) into clamped CSS percentages `[0..100]`
 * over the rendered SVG page height (`pageHeightPt`) for `ProofView` overlay hit-targets.
 */
export function hitBandToPercentRect(
  band: ProofHitBand,
  pageHeightPt: number,
): { topPct: number; heightPct: number } {
  const h = pageHeightPt > 0 ? pageHeightPt : 841.89
  const rawTop = Math.max(0, Math.min(100, (band.yTopPt / h) * 100))
  const rawBottom = Math.max(rawTop + 1.2, Math.min(100, (band.yBottomPt / h) * 100))
  return {
    topPct: Math.round(rawTop * 100) / 100,
    heightPct: Math.round(Math.max(1.2, rawBottom - rawTop) * 100) / 100,
  }
}
