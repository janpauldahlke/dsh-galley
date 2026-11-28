/**
 * dsh-galley — shared constants + the SPEC-01 TYPE AUTHORITY.
 *
 * Everything in `§types` below is binding across all specs and both faces
 * (host + client import this module). Constants (PLUGIN, routes, tab) are
 * runtime values; the interfaces are the v1 block model, frozen per spec 01.
 */
import type { GalleyLocale } from './i18n.ts'
export type { GalleyLocale }

export const PLUGIN = 'dsh-galley'
export const VERSION = '0.2.5'
export const HEALTH_ROUTE = '/api/galley/health'
export const STATE_ROUTE = '/api/galley/state'
export const EDIT_ROUTE = '/api/galley/edit'
export const EXPORT_ROUTE = '/api/galley/export'
export const DOWNLOAD_ROUTE = '/api/galley/download'
export const PROPOSAL_ROUTE_PREFIX = '/api/galley/proposal'

export const TAB_ID = 'galley'
export const TAB_KIND = 'galley'
export const TAB_TITLE = 'Galley'

// ───────────────────────────────────────────────────────────────────────────
// Spec 01 — block model (v1, frozen). Types only; the runtime store works on
// plain objects of these shapes.
// ───────────────────────────────────────────────────────────────────────────

export type PacketId = string   // p-<base32 8>; also the on-disk dir name
export type SheetId = string    // s1, s2, … — stable per packet
export type BlockId = string    // b1, b2, … — stable per packet, never reused
export type AssetId = string    // a1, a2, … — packet-scoped media

export interface PageGeometry {
  paper: 'a4' | 'letter'
  /** Default 'portrait'; 'landscape' emits Typst `flipped: true`. */
  orientation?: 'portrait' | 'landscape'
  /** cm, per side. */
  margin: { top: number; right: number; bottom: number; left: number }
  /** Fit target (e.g. 1 for a one-page worksheet); undefined = unbounded. */
  targetPages?: number
}

export interface AssetRef {
  id: AssetId
  /** packet-relative, e.g. 'assets/a1.png'; path is derived from id. */
  path: string
  alt: string
  widthCm?: number
}

export interface LayoutSlot {
  mode: 'full' | 'media-right' | 'media-left' | 'media-below' | 'two-column' | 'card-grid'
  /** required for media-right / media-left / media-below. */
  asset?: AssetRef
  /** card-grid only (default 3). */
  columns?: 2 | 3 | 4
  /** card-grid only (default 6 cm). */
  cardHeightCm?: number
}

export interface DepEdge {
  id: BlockId
  sinceHash: string
  at: string
}

export interface StaleInfo {
  state: 'stale_dependency' | 'stale_missing_origin'
  origin: BlockId
  sinceHash: string
}

/**
 * Typed source-grounding metadata slot for companion verifiers (e.g. `dsh-fundus`
 * quote drift checks via `ctx.galley.registerPreflight`).
 */
export interface SourceProvenance {
  sourceId: string
  quoteSha256?: string
  citation?: string
  locator?: string
}

/** Frozen inline rich-text subset (spec 01 §2). Max depth 3, ≤5 000 nodes. */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'emph'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'cloze'; hint?: string }
  | { t: 'math'; v: string }   // Typst math-mode source WITHOUT $…$ delimiters
  | { t: 'newline' }

export type BlockType =
  | 'header'
  | 'heading'
  | 'prose'
  | 'source_text'
  | 'task'
  | 'table'
  | 'callout'
  | 'answer'

interface BlockBase {
  id: BlockId
  type: BlockType
  /** sha256 hex of the canonical content (§5); recomputed on every write. */
  hash: string
  dependsOn: DepEdge[]
  slot: LayoutSlot
  /** Optional archive/mission quote provenance (included in content hash when set). */
  provenance?: SourceProvenance
  origin: 'human' | 'agent'
  updatedAt: string
  /** derived, recomputed on read (§6); never persisted as input. */
  stale?: StaleInfo | null
}

export interface HeaderBlock extends BlockBase {
  type: 'header'
  fields: {
    titel: string
    subtitle?: string
    fach?: string
    klasse?: string
    datum?: string
    name?: string
    _unknownKeys?: string[]
  }
}
export interface HeadingBlock extends BlockBase {
  type: 'heading'
  level: 1 | 2 | 3
  numbered?: boolean
  body: Inline[]
}
export interface ProseBlock extends BlockBase {
  type: 'prose'
  body: Inline[]
}
export interface SourceTextBlock extends BlockBase {
  type: 'source_text'
  title?: string
  body: Inline[]
  lineNumbers?: { every: number; start?: number }
}
export interface TaskBlock extends BlockBase {
  type: 'task'
  body: Inline[]
}
export interface TableBlock extends BlockBase {
  type: 'table'
  /** One row of header cells; each cell is an inline run. */
  headers: Inline[][]
  /** Data rows; each row is a list of cells, each cell an inline run. */
  rows: Inline[][][]
  /** Optional per-column widths, e.g. ['12%', '20%', '34%', '17%', '17%'] or [1, 2, 3] (fr). */
  colWidths?: (string | number)[]
}
export interface CalloutBlock extends BlockBase {
  type: 'callout'
  tone: 'info' | 'hint' | 'warning'
  body: Inline[]
}
export interface AnswerBlock extends BlockBase {
  type: 'answer'
  body: Inline[]
}

export type Block =
  | HeaderBlock
  | HeadingBlock
  | ProseBlock
  | SourceTextBlock
  | TaskBlock
  | TableBlock
  | CalloutBlock
  | AnswerBlock

/**
 * Compact per-block outline for tool receipts (M1.5 H4). Carries identity +
 * origin + a truncated preview — NEVER the full `Inline[]` body, so a tool
 * receipt stays small enough for an LLM context (galley_edit_block < 1500 chars).
 */
export interface BlockOutline {
  id: BlockId
  type: BlockType
  hash: string
  origin: 'human' | 'agent'
  /** approximate word count of the block's rendered text. */
  words: number
  /** first ≤60 chars of the block's rendered text. */
  preview: string
  /** true if this block has a stale dependency (StaleInfo != null). */
  stale: boolean
}

export interface GalleySheet {
  id: SheetId
  title: string
  geometry: PageGeometry
  /** FLAT, ordered — guardrail 1, no nested trees. */
  blocks: Block[]
}

export type ReviewMode = 'auto' | 'review'

export interface GalleyPacket {
  id: PacketId
  /** Built-in ('worksheet' | 'rfc' | 'generic') or custom/Cordis plugin template id. */
  template: string
  title: string
  /** Optional document print locale ('en' default; 'de' set by German domain templates). */
  locale?: GalleyLocale
  /** Opt-in bottom-margin colophon line (`true` uses localized neutral default; `string` renders custom text). */
  colophon?: boolean | string
  /** 'auto' (default): agent patches on human blocks propose; 'review': ALL agent ops propose. */
  reviewMode?: ReviewMode
  /** monotonically increasing; +1 per committed change (incl. undo/redo/proposals). */
  rev: number
  createdAt: string
  updatedAt: string
  sheetOrder: SheetId[]
  sheets: Record<SheetId, GalleySheet>
  /** per-packet block id allocator (ids unique across sheets). */
  nextBlockSeq: number
  nextProposalSeq: number
  nextAnnotationSeq: number
  nextAssetSeq: number
  /** packet-scoped media metadata (bytes live in assets/). */
  assets: Record<AssetId, AssetMeta>
}

export interface GalleyTemplateBlueprint {
  id: string
  title: string
  description?: string
  /** Optional print locale inherited by packets created from this template (default 'en'). */
  locale?: GalleyLocale
  /** Optional opt-in colophon inherited by packets created from this template. */
  colophon?: boolean | string
  source?: 'builtin' | 'plugin' | 'workspace'
  sheets: {
    id: SheetId
    title: string
    geometry: PageGeometry
    starterBlocks: Record<string, unknown>[]
  }[]
}

export interface GalleyPreflightWarning {
  code: string
  severity: 'info' | 'warn' | 'error'
  sheetId?: SheetId
  blockId?: BlockId
  message: string
}

export interface AssetMeta {
  id: AssetId
  path: string
  bytesSha256: string
  mimeType: string
  widthPx?: number
  heightPx?: number
}

export interface GalleyJournalEntry {
  rev: number
  at: string
  actor?: 'human' | 'agent'
  note: string
}

/** A committed proof receipt for one sheet (typed per spec 02 §2 / spec 03 §7). */
export interface SheetProofReceipt {
  sheetId?: SheetId
  pages: number
  perPage: { wPt: number; hPt: number }[]
  lastPageLineCount: number
  overflowLinesOnLastPage: number
  /**Configured page budget (`null` when unbounded). */
  targetPages?: number | null
  /** Explicit boolean check: `pages <= targetPages` (`null` when unbounded). */
  targetPagesMet?: boolean | null
  compiledAtRev: number
}

/** Page-local vertical hit-band derived from `#010000..#ff0000` Typst SVG anchors (0.2.4). */
export interface ProofHitBand {
  pageIndex: number
  yTopPt: number
  yBottomPt: number
  blockId: BlockId
}

/** The full renderer output for one sheet (spec 03 §2, port shape). */
export interface SheetRender {
  sheetId: SheetId
  pdf: Buffer
  svgPages: Buffer[]
  /** the stacked multi-page SVG (rich); parsed for the receipt. */
  svg: string
  pages: number
  perPage: { wPt: number; hPt: number }[]
  lastPageLineCount: number
  overflowLinesOnLastPage: number
  /** per-block page attribution: blockId -> 0-based page index. */
  blockToPage: Record<BlockId, number>
  /** page-local vertical hit-bands for direct-manipulation click-to-block in ProofView. */
  hitBands?: ProofHitBand[]
  diagnostics: RenderDiagnostic[]
  compiledAtRev: number
}

export interface RenderDiagnostic {
  message: string
  blockId: BlockId | null
  line?: number
  col?: number
}

export type ProposalOp = 'insert' | 'patch' | 'move' | 'remove'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'conflicted'
export interface GalleyProposal {
  id: string
  op?: ProposalOp
  sheetId?: SheetId
  targetBlockId: BlockId
  baseHash: string
  beforePatch?: Record<string, unknown>
  proposedPatch: Record<string, unknown>
  status: ProposalStatus
  createdAtRev: number
}

export interface GalleyAnnotation {
  id: string
  blockId: BlockId
  author: 'human' | 'agent'
  body: Inline[]
  provenance?: SourceProvenance
  resolved: boolean
  createdAtRev: number
}

// ───────────────────────────────────────────────────────────────────────────
// Spec 02 §5 & Spec 04 — HTTP pane state & route contracts
// ───────────────────────────────────────────────────────────────────────────

export interface PacketSummaryInfo {
  id: PacketId
  title: string
  rev: number
  updatedAt: string
}

export interface StateSheetView {
  id: SheetId
  title: string
  geometry: PageGeometry
  blocks: Block[]
  annotations: GalleyAnnotation[]
  proposals: GalleyProposal[]
}

export interface StateProofView {
  sheetId: SheetId
  pages: number
  perPage: { wPt: number; hPt: number }[]
  lastPageLineCount: number
  overflowLinesOnLastPage: number
  targetPages?: number | null
  targetPagesMet?: boolean | null
  blockToPage: Record<BlockId, number>
  hitBands?: ProofHitBand[]
  compiledAtRev: number
  /** Per-page SVG data URIs (`data:image/svg+xml;base64,…`), isolated for inline DOM mount. */
  svgPages: string[]
  compileError?: { message: string; blockId: BlockId | null } | null
}

export interface StateActivePayload {
  ok: true
  activePacket: true
  cwd: string
  packets: PacketSummaryInfo[]
  templates: GalleyTemplateBlueprint[]
  rev: number
  packetId: PacketId
  template: string
  title: string
  colophon?: boolean | string
  reviewMode: ReviewMode
  activeSheetId: SheetId
  sheetOrder: SheetId[]
  assets: Record<AssetId, AssetMeta>
  undoDepth: number
  redoDepth: number
  sheets: StateSheetView[]
  staleDependents: { id: BlockId; origin: BlockId; sinceHash: string; state: StaleInfo['state'] }[]
  preflight: GalleyPreflightWarning[]
  proofs: StateProofView[]
}

export interface StateEmptyPayload {
  ok: true
  activePacket: false
  cwd: string
  packets: PacketSummaryInfo[]
  templates: GalleyTemplateBlueprint[]
  rev: 0
  packetId: null
}

export type StateResponsePayload = StateActivePayload | StateEmptyPayload

export interface ExportFileReceipt {
  sheetId: SheetId
  path: string
  format: string
  pages: number | null
  sizeBytes: number
  sha256: string
}
