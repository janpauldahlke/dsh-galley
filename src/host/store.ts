/**
 * dsh-galley — block store (HERMETIC; node: only).
 *
 * Owns the packet model on disk and the single commit path (spec 01 §4):
 *   1. load packet → 2. require pre-change block hash === baseHash (else 409)
 *   3. apply mutation → 4. recompute per-block content hashes (§5) →
 *   5. recompute stale flags (§6) → 6. rev++ → 7. atomic journal (§9, keep 3).
 * Undo = a ring of the last 50 full snapshots (§4); oldest evicted on overflow.
 *
 * Canonical JSON (spec 01 §5): NFC-normalize all strings, file paths use
 * forward slashes, omit timestamps (createdAt/updatedAt/stale), key-sorted
 * objects (recursive), compact — then sha256 hex. Timestamps and derived
 * fields are OUTSIDE the hash, so the hash is stable across save/load.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type {
  GalleyPacket,
  GalleySheet,
  Block,
  BlockId,
  SheetId,
  StaleInfo,
  DepEdge,
  AssetMeta,
  GalleyProposal,
  GalleyAnnotation,
  GalleyJournalEntry,
  GalleyTemplateBlueprint,
  PageGeometry,
  ReviewMode,
} from '../shared/types.ts'

export const UNDO_DEPTH = 50
export const JOURNAL_KEEP = 3
/** Max assets per packet (spec 02 §3 GALLEY_ASSET_LIMIT_EXCEEDED). */
export const MAX_ASSETS_PER_PACKET = 20

/** Typed store error → mapped to tool error codes in the tools layer. */
export class StoreError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ── Canonical JSON + hash (spec 01 §5) ──────────────────────────────────────

/** Recursively key-sorted, compact, NFC + forward-slash canonical string. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value.normalize('NFC').replace(/\\/g, '/'))
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

/** sha256 hex of the canonical form of a value. */
export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** The content projection of a block: content + structural fields ONLY (spec 01 §5: excludes id, hash, stale, origin, updatedAt). */
export function blockContentProjection(block: Block): Record<string, unknown> {
  const b = block as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {
    type: b.type,
    dependsOn: b.dependsOn,
    slot: b.slot,
  }
  if (b.fields !== undefined) out.fields = b.fields
  if (b.body !== undefined) out.body = b.body
  if (b.level !== undefined) out.level = b.level
  if (b.numbered !== undefined) out.numbered = b.numbered
  if (b.headers !== undefined) out.headers = b.headers
  if (b.rows !== undefined) out.rows = b.rows
  if (b.colWidths !== undefined) out.colWidths = b.colWidths
  if (b.tone !== undefined) out.tone = b.tone
  if (b.title !== undefined) out.title = b.title
  if (b.lineNumbers !== undefined) out.lineNumbers = b.lineNumbers
  return out
}

export function hashBlock(block: Block): string {
  return hashContent(blockContentProjection(block))
}

// ── Staleness (spec 01 §6) ──────────────────────────────────────────────────

/** First failing dep in list order wins; missing origin beats stale hash. */
export function computeStale(block: Block, byId: Map<BlockId, Block>): StaleInfo | null {
  for (const dep of block.dependsOn) {
    const target = byId.get(dep.id)
    if (!target) {
      return { state: 'stale_missing_origin', origin: dep.id, sinceHash: dep.sinceHash }
    }
    if (target.hash !== dep.sinceHash) {
      return { state: 'stale_dependency', origin: dep.id, sinceHash: dep.sinceHash }
    }
  }
  return null
}

/** Recompute `stale` for every block in the packet (in-place). */
export function recomputeStale(packet: GalleyPacket): void {
  const byId = new Map<BlockId, Block>()
  for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) byId.set(b.id, b)
  for (const [, b] of byId) b.stale = computeStale(b, byId)
}

/** True if making `from` depend on `to` would create a dependency cycle. */
export function createsCycle(from: BlockId, to: BlockId, byId: Map<BlockId, Block>): boolean {
  if (from === to) return true
  const seen = new Set<BlockId>()
  const stack: BlockId[] = [to]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === from) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const b = byId.get(cur)
    if (b) for (const d of b.dependsOn) stack.push(d.id)
  }
  return false
}

// ── Block id allocation ──────────────────────────────────────────────────────

/** Next free block id in the packet (b1, b2, …); never reuses retired ids. */
export function allocateBlockId(packet: GalleyPacket): BlockId {
  const used = new Set<BlockId>()
  for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) used.add(b.id)
  let n = packet.nextBlockSeq
  while (used.has(`b${n}`)) n++
  return `b${n}`
}

/** Find a block by id across all sheets. */
export function findBlock(packet: GalleyPacket, id: BlockId): { sheet: GalleySheet; index: number; block: Block } | null {
  for (const sid of packet.sheetOrder) {
    const sheet = packet.sheets[sid]
    const index = sheet.blocks.findIndex((b) => b.id === id)
    if (index >= 0) return { sheet, index, block: sheet.blocks[index] }
  }
  return null
}

export function makeDepEdge(id: BlockId, sinceHash: string, at: string): DepEdge {
  return { id, sinceHash, at }
}

// ── The store ───────────────────────────────────────────────────────────────

export interface PacketSummary {
  id: string
  title: string
  template: string
  reviewMode: ReviewMode
  rev: number
  updatedAt: string
}

export interface CommitResult {
  packet: GalleyPacket
  rev: number
  /** the new content hash of the (primary) touched block, or null. */
  changeHash: string | null
}

export class GalleyStore {
  private readonly root: string

  /** @param root default `<cwd>/.dsh/galley`. Pass a temp dir for hermetic tests. */
  constructor(root?: string) {
    this.root = root ?? join(process.cwd(), '.dsh', 'galley')
  }

  private dir(id: string): string {
    return join(this.root, id)
  }
  private packetPath(id: string): string {
    return join(this.dir(id), 'packet.json')
  }
  private journalPath(id: string): string {
    return join(this.dir(id), 'journal.json')
  }
  private undoPath(id: string): string {
    return join(this.dir(id), 'undo.json')
  }
  private redoPath(id: string): string {
    return join(this.dir(id), 'redo.json')
  }

  private bumpRev(id: string, note: string, actor?: 'human' | 'agent'): GalleyPacket {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    packet.rev += 1
    packet.updatedAt = new Date().toISOString()
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2))
    const journal = this.readJson<GalleyJournalEntry[]>(this.journalPath(id), [])
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      ...(actor ? { actor } : {}),
      note,
    })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))
    return packet
  }

  listJournal(id: string): GalleyJournalEntry[] {
    return this.readJson<GalleyJournalEntry[]>(this.journalPath(id), [])
  }

  create(packet: GalleyPacket): GalleyPacket {
    const dir = this.dir(packet.id)
    mkdirSync(dir, { recursive: true })
    packet.rev = 1
    const now = new Date().toISOString()
    packet.createdAt = now
    packet.updatedAt = now
    this.atomicWrite(this.packetPath(packet.id), JSON.stringify(packet, null, 2))
    this.atomicWrite(this.undoPath(packet.id), JSON.stringify([JSON.parse(JSON.stringify(packet))]))
    this.atomicWrite(this.journalPath(packet.id), JSON.stringify([{ rev: 1, at: now, note: 'create' }]))
    return packet
  }

  load(id: string): GalleyPacket | null {
    const p = this.packetPath(id)
    if (!existsSync(p)) return null
    const packet = JSON.parse(readFileSync(p, 'utf8')) as GalleyPacket
    // Derived flags are never persisted as input — always recompute on load.
    recomputeStale(packet)
    return packet
  }

  list(): PacketSummary[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'templates' && existsSync(join(this.root, e.name, 'packet.json')))
      .map((e) => {
        const p = this.load(e.name)!
        return {
          id: p.id,
          title: p.title,
          template: p.template,
          reviewMode: p.reviewMode ?? 'auto',
          rev: p.rev,
          updatedAt: p.updatedAt,
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  delete(id: string): void {
    const dir = this.dir(id)
    if (!existsSync(dir)) throw new StoreError('not_found', `packet ${id} not found`)
    if (this.getActivePacket() === id) {
      const remaining = this.list().filter((p) => p.id !== id)
      if (remaining.length > 0) this.setActivePacket(remaining[0].id)
      else this.clearActivePacket()
    }
    rmSync(dir, { recursive: true, force: true })
  }

  renamePacket(id: string, title: string, actor: 'human' | 'agent' = 'human'): GalleyPacket {
    const trimmed = title.trim()
    if (!trimmed) throw new StoreError('invalid_op', 'packet title must be non-empty')
    let oldTitle = ''
    return this.commit(
      id,
      null,
      (p) => {
        oldTitle = p.title
        p.title = trimmed
        return null
      },
      { actor, note: () => `packet.title "${oldTitle}"→"${trimmed}" (${actor})` },
    ).packet
  }

  setReviewMode(id: string, mode: ReviewMode, actor: 'human' | 'agent' = 'human'): GalleyPacket {
    if (mode !== 'auto' && mode !== 'review') {
      throw new StoreError('invalid_op', `invalid reviewMode '${String(mode)}'`)
    }
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const prevMode = packet.reviewMode ?? 'auto'
    packet.reviewMode = mode
    packet.rev += 1
    packet.updatedAt = new Date().toISOString()
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2))
    const journal = this.readJson<GalleyJournalEntry[]>(this.journalPath(id), [])
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      actor,
      note: `reviewMode ${prevMode}→${mode} (${actor})`,
    })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))
    return packet
  }

  duplicatePacket(id: string, newTitle?: string): GalleyPacket {
    const src = this.load(id)
    if (!src) throw new StoreError('not_found', `packet ${id} not found`)
    const b32 = 'abcdefghijklmnopqrstuvwxyz234567'
    const rand = randomBytes(8)
    let newSuffix = ''
    for (let i = 0; i < 8; i++) newSuffix += b32[rand[i] & 31]
    const newId = `p-${newSuffix}`

    const copy = JSON.parse(JSON.stringify(src)) as GalleyPacket
    copy.id = newId
    copy.title = newTitle?.trim() || `${src.title} (Kopie)`
    this.create(copy)

    // Copy binary assets if present
    const srcAssetsDir = join(this.dir(id), 'assets')
    if (existsSync(srcAssetsDir)) {
      const dstAssetsDir = join(this.dir(newId), 'assets')
      mkdirSync(dstAssetsDir, { recursive: true })
      for (const entry of readdirSync(srcAssetsDir)) {
        copyFileSync(join(srcAssetsDir, entry), join(dstAssetsDir, entry))
      }
    }

    this.setActivePacket(newId)
    return this.load(newId)!
  }

  // ── Sheet CRUD (all committed through undo-safe single commit path) ───────

  addSheet(
    id: string,
    opts?: {
      title?: string
      orientation?: 'portrait' | 'landscape'
      targetPages?: number
      paper?: 'a4' | 'letter'
      actor?: 'human' | 'agent'
    },
  ): { packet: GalleyPacket; sheetId: SheetId } {
    let createdSheetId: SheetId = 's1'
    let createdTitle = ''
    const actor = opts?.actor ?? 'human'
    const res = this.commit(
      id,
      null,
      (p) => {
        let n = p.sheetOrder.length + 1
        while (p.sheets[`s${n}`]) n++
        createdSheetId = `s${n}`
        const geometry: PageGeometry = {
          paper: opts?.paper ?? 'a4',
          orientation: opts?.orientation ?? 'portrait',
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          ...(opts?.targetPages !== undefined && opts.targetPages > 0 ? { targetPages: Math.floor(opts.targetPages) } : {}),
        }
        createdTitle = opts?.title?.trim() || `Sheet ${p.sheetOrder.length + 1}`
        p.sheets[createdSheetId] = {
          id: createdSheetId,
          title: createdTitle,
          geometry,
          blocks: [],
        }
        p.sheetOrder.push(createdSheetId)
        return null
      },
      { actor, note: () => `sheet-add ${createdSheetId} "${createdTitle}" (${actor})` },
    )
    return { packet: res.packet, sheetId: createdSheetId }
  }

  renameSheet(id: string, sheetId: SheetId, title: string, actor: 'human' | 'agent' = 'human'): GalleyPacket {
    const trimmed = title.trim()
    if (!trimmed) throw new StoreError('invalid_op', 'sheet title must be non-empty')
    let oldTitle = ''
    return this.commit(
      id,
      null,
      (p) => {
        const sh = p.sheets[sheetId]
        if (!sh) throw new StoreError('invalid_op', `sheet ${sheetId} not found`)
        oldTitle = sh.title
        sh.title = trimmed
        return null
      },
      { actor, note: () => `sheet ${sheetId}.title "${oldTitle}"→"${trimmed}" (${actor})` },
    ).packet
  }

  updateSheet(
    id: string,
    sheetId: SheetId,
    patch: {
      title?: string
      targetPages?: number | null
      orientation?: 'portrait' | 'landscape'
      paper?: 'a4' | 'letter'
    },
    actor: 'human' | 'agent' = 'human',
  ): GalleyPacket {
    const diffs: string[] = []
    return this.commit(
      id,
      null,
      (p) => {
        const sh = p.sheets[sheetId]
        if (!sh) throw new StoreError('invalid_op', `sheet ${sheetId} not found`)
        if (patch.title !== undefined) {
          const t = patch.title.trim()
          if (!t) throw new StoreError('invalid_op', 'sheet title must be non-empty')
          if (t !== sh.title) diffs.push(`title "${sh.title}"→"${t}"`)
          sh.title = t
        }
        if ('targetPages' in patch) {
          const prevTp = sh.geometry.targetPages ?? null
          const tp = patch.targetPages
          if (tp === null || tp === undefined || tp === 0) {
            delete sh.geometry.targetPages
            if (prevTp !== null) diffs.push(`targetPages ${prevTp}→null`)
          } else if (typeof tp === 'number' && Number.isFinite(tp) && tp >= 1) {
            const nextTp = Math.floor(tp)
            sh.geometry.targetPages = nextTp
            if (prevTp !== nextTp) diffs.push(`targetPages ${prevTp ?? 'null'}→${nextTp}`)
          } else {
            throw new StoreError('invalid_op', 'targetPages must be positive integer or 0/null to clear')
          }
        }
        if (patch.orientation !== undefined) {
          if (patch.orientation !== 'portrait' && patch.orientation !== 'landscape') {
            throw new StoreError('invalid_op', `invalid orientation '${String(patch.orientation)}'`)
          }
          const prevOr = sh.geometry.orientation ?? 'portrait'
          sh.geometry.orientation = patch.orientation
          if (prevOr !== patch.orientation) diffs.push(`orientation ${prevOr}→${patch.orientation}`)
        }
        if (patch.paper !== undefined) {
          if (patch.paper !== 'a4' && patch.paper !== 'letter') {
            throw new StoreError('invalid_op', `invalid paper '${String(patch.paper)}'`)
          }
          const prevPaper = sh.geometry.paper
          sh.geometry.paper = patch.paper
          if (prevPaper !== patch.paper) diffs.push(`paper ${prevPaper}→${patch.paper}`)
        }
        return null
      },
      {
        actor,
        note: () => `sheet ${sheetId} ${diffs.length > 0 ? diffs.join(', ') : 'updated'} (${actor})`,
      },
    ).packet
  }

  removeSheet(id: string, sheetId: SheetId, actor: 'human' | 'agent' = 'human'): GalleyPacket {
    return this.commit(
      id,
      null,
      (p) => {
        if (!p.sheets[sheetId]) throw new StoreError('invalid_op', `sheet ${sheetId} not found`)
        if (p.sheetOrder.length <= 1) throw new StoreError('invalid_op', 'cannot remove the last remaining sheet')
        delete p.sheets[sheetId]
        p.sheetOrder = p.sheetOrder.filter((sid) => sid !== sheetId)
        return null
      },
      { actor, note: `sheet-remove ${sheetId} (${actor})` },
    ).packet
  }

  reorderSheet(id: string, sheetId: SheetId, direction: 'left' | 'right'): GalleyPacket {
    return this.commit(id, null, (p) => {
      const idx = p.sheetOrder.indexOf(sheetId)
      if (idx < 0) throw new StoreError('invalid_op', `sheet ${sheetId} not found`)
      const swapIdx = direction === 'left' ? idx - 1 : idx + 1
      if (swapIdx < 0 || swapIdx >= p.sheetOrder.length) return null
      const nextOrder = [...p.sheetOrder]
      const tmp = nextOrder[idx]
      nextOrder[idx] = nextOrder[swapIdx]
      nextOrder[swapIdx] = tmp
      p.sheetOrder = nextOrder
      return null
    }).packet
  }

  // ── Workspace Template Blueprints (.dsh/galley/templates/<slug>.json) ─────

  private templatesDir(): string {
    return join(this.root, 'templates')
  }

  saveAsTemplate(
    packetId: string,
    opts?: { id?: string; title?: string; description?: string },
  ): GalleyTemplateBlueprint {
    const packet = this.load(packetId)
    if (!packet) throw new StoreError('not_found', `packet ${packetId} not found`)
    const title = opts?.title?.trim() || packet.title
    const rawSlug = (opts?.id?.trim() || title)
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .toLowerCase() || 'template'
    const reserved = new Set(['worksheet', 'rfc', 'generic'])
    const id = reserved.has(rawSlug) ? `${rawSlug}-template` : rawSlug

    const blueprint: GalleyTemplateBlueprint = {
      id,
      title,
      description: opts?.description?.trim() || undefined,
      ...(packet.locale ? { locale: packet.locale } : {}),
      source: 'workspace',
      sheets: packet.sheetOrder.map((sid) => {
        const sh = packet.sheets[sid]
        return {
          id: sh.id,
          title: sh.title,
          geometry: JSON.parse(JSON.stringify(sh.geometry)) as PageGeometry,
          starterBlocks: sh.blocks.map((b) => {
            const proj = blockContentProjection(b)
            // Strip packet-specific binary asset binding so starter blocks open cleanly anywhere
            if (proj.slot && typeof proj.slot === 'object' && 'asset' in (proj.slot as Record<string, unknown>)) {
              proj.slot = { mode: 'full' }
            }
            proj.dependsOn = []
            return proj
          }),
        }
      }),
    }
    this.atomicWrite(join(this.templatesDir(), `${id}.json`), JSON.stringify(blueprint, null, 2))
    return blueprint
  }

  listSavedTemplates(): GalleyTemplateBlueprint[] {
    const dir = this.templatesDir()
    if (!existsSync(dir)) return []
    const out: GalleyTemplateBlueprint[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const parsed = this.readJson<GalleyTemplateBlueprint | null>(join(dir, entry.name), null)
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.sheets)) {
        out.push({ ...parsed, source: 'workspace' })
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title))
  }

  deleteSavedTemplate(templateId: string): boolean {
    const safe = templateId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!safe) return false
    const p = join(this.templatesDir(), `${safe}.json`)
    if (!existsSync(p)) return false
    unlinkSync(p)
    return true
  }

  // ── active packet (M1.5 H4): the packet tools operate on by default ──────
  // Persisted per-store (single file) so a headless tool session can omit
  // `packetId` and address the most recently opened/active packet.

  private activePath(): string {
    return join(this.root, 'active.json')
  }
  setActivePacket(id: string): void {
    this.atomicWrite(this.activePath(), JSON.stringify({ packetId: id }))
  }
  getActivePacket(): string | null {
    const v = this.readJson<{ packetId: string } | null>(this.activePath(), null)
    return v && typeof v.packetId === 'string' ? v.packetId : null
  }
  clearActivePacket(): void {
    try {
      unlinkSync(this.activePath())
    } catch {
      /* no active file — nothing to clear */
    }
  }

  /**
   * The single commit path (spec 01 §4). `expect`, when given, must match the
   * current content hash of that block or the commit throws `conflict` (409).
   * `apply` mutates the loaded packet in place; the store then re-hashes every
   * block, recomputes staleness, bumps rev, and journals atomically.
   */
  commit(
    id: string,
    expect: { blockId: BlockId; baseHash: string } | null,
    apply: (p: GalleyPacket) => BlockId | null,
    meta?: { actor?: 'human' | 'agent'; note?: string | (() => string) },
  ): CommitResult {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)

    if (expect) {
      const found = findBlock(packet, expect.blockId)
      if (!found) throw new StoreError('not_found', `block ${expect.blockId} not found`)
      if (found.block.hash !== expect.baseHash) {
        throw new StoreError('conflict', `block ${expect.blockId} changed (base hash mismatch)`)
      }
    }

    const prevSnapshot = JSON.parse(JSON.stringify(packet)) as GalleyPacket
    const touchedId = apply(packet)

    // Cycle guard (spec 01 §4 / 02 §3 GALLEY_DEPENDENCY_CYCLE): the touched
    // block's (possibly new) outgoing edges must not close a dependency loop.
    // Only the touched block's edges changed, so a new cycle must include it.
    if (touchedId) {
      const touched = findBlock(packet, touchedId)
      if (touched) {
        const byId = new Map<BlockId, Block>()
        for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) byId.set(b.id, b)
        for (const dep of touched.block.dependsOn ?? []) {
          if (createsCycle(touchedId, dep.id, byId)) {
            throw new StoreError('cycle', `block ${touchedId} creates a dependency cycle`)
          }
        }
      }
    }

    // Re-hash every block (safe superset of "touched blocks").
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid].blocks) b.hash = hashBlock(b)
    }
    recomputeStale(packet)
    packet.rev += 1
    packet.updatedAt = new Date().toISOString()

    const touched = touchedId ? findBlock(packet, touchedId) : null
    const changeHash = touched ? touched.block.hash : null

    // Journal: append attributed entry, keep last JOURNAL_KEEP.
    const resolvedNote =
      typeof meta?.note === 'function'
        ? meta.note()
        : meta?.note ?? (touchedId ? `edit ${touchedId}${meta?.actor ? ` (${meta.actor})` : ''}` : 'edit')
    const journal = this.readJson<GalleyJournalEntry[]>(this.journalPath(id), [])
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      ...(meta?.actor ? { actor: meta.actor } : {}),
      note: resolvedNote,
    })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))

    // Undo ring: push previous snapshot, keep last UNDO_DEPTH. Forward mutation clears redo.
    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    undo.push(prevSnapshot)
    while (undo.length > UNDO_DEPTH) undo.shift()
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo))
    this.atomicWrite(this.redoPath(id), '[]')

    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2))
    return { packet, rev: packet.rev, changeHash }
  }

  /** Pop the last snapshot and restore it; rev strictly increases (+1, spec 01 §1). */
  undo(id: string): { packet: GalleyPacket; rev: number } {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    if (undo.length === 0) throw new StoreError('no_undo', `no undo history for ${id}`)
    const prev = undo.pop()!
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo))

    const redo = this.readJson<GalleyPacket[]>(this.redoPath(id), [])
    redo.push(JSON.parse(JSON.stringify(packet)) as GalleyPacket)
    while (redo.length > UNDO_DEPTH) redo.shift()
    this.atomicWrite(this.redoPath(id), JSON.stringify(redo))

    prev.rev = packet.rev + 1
    prev.updatedAt = new Date().toISOString()
    recomputeStale(prev)
    this.atomicWrite(this.packetPath(id), JSON.stringify(prev, null, 2))
    const journal = this.readJson<{ rev: number; at: string; note: string }[]>(this.journalPath(id), [])
    journal.push({ rev: prev.rev, at: prev.updatedAt, note: 'undo' })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))
    return { packet: prev, rev: prev.rev }
  }

  /** Re-apply the most recently undone snapshot; rev strictly increases (+1). */
  redo(id: string): { packet: GalleyPacket; rev: number } {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const redo = this.readJson<GalleyPacket[]>(this.redoPath(id), [])
    if (redo.length === 0) throw new StoreError('no_redo', `no redo history for ${id}`)
    const next = redo.pop()!
    this.atomicWrite(this.redoPath(id), JSON.stringify(redo))

    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    undo.push(JSON.parse(JSON.stringify(packet)) as GalleyPacket)
    while (undo.length > UNDO_DEPTH) undo.shift()
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo))

    next.rev = packet.rev + 1
    next.updatedAt = new Date().toISOString()
    recomputeStale(next)
    this.atomicWrite(this.packetPath(id), JSON.stringify(next, null, 2))
    const journal = this.readJson<{ rev: number; at: string; note: string }[]>(this.journalPath(id), [])
    journal.push({ rev: next.rev, at: next.updatedAt, note: 'redo' })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))
    return { packet: next, rev: next.rev }
  }

  undoDepth(id: string): number {
    return this.readJson<GalleyPacket[]>(this.undoPath(id), []).length
  }

  redoDepth(id: string): number {
    return this.readJson<GalleyPacket[]>(this.redoPath(id), []).length
  }

  /**
   * Read-only lookup of a prior snapshot at or before `targetRev` from the
   * undo ring (used by `inject.ts` to compute exact changed-block deltas even
   * after session resume). Returns null if pruned or unavailable.
   */
  snapshotAtRev(id: string, targetRev: number): GalleyPacket | null {
    if (targetRev <= 0) return null
    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    for (let i = undo.length - 1; i >= 0; i--) {
      if (undo[i].rev === targetRev) return undo[i]
    }
    for (let i = undo.length - 1; i >= 0; i--) {
      if (undo[i].rev < targetRev) return undo[i]
    }
    return null
  }

  // ── proposals + annotations (bump packet.rev so rev-polling observes deltas) ──

  addProposal(id: string, proposal: GalleyProposal): GalleyProposal {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const next = [...this.readJson<GalleyProposal[]>(join(this.dir(id), 'proposals.json'), []), proposal]
    this.atomicWrite(join(this.dir(id), 'proposals.json'), JSON.stringify(next))
    this.bumpRev(id, `proposal ${proposal.id} (${proposal.op ?? 'patch'} ${proposal.targetBlockId})`, 'agent')
    return proposal
  }
  listProposals(id: string): GalleyProposal[] {
    return this.readJson<GalleyProposal[]>(join(this.dir(id), 'proposals.json'), [])
  }
  setProposalStatus(id: string, proposalId: string, status: GalleyProposal['status'], opts?: { bumpRev?: boolean }): GalleyProposal | null {
    const list = this.listProposals(id)
    const p = list.find((x) => x.id === proposalId)
    if (!p) return null
    p.status = status
    this.atomicWrite(join(this.dir(id), 'proposals.json'), JSON.stringify(list))
    if (opts?.bumpRev !== false) this.bumpRev(id, `proposal ${proposalId} ${status} (human)`, 'human')
    return p
  }
  /**
   * Accept a proposal (spec 01 §7, M2.5 unified review gate):
   * - Supports all 4 proposal ops (`insert` | `patch` | `move` | `remove`).
   * - Sets block `origin = 'human'` (settled human approval — accepting a
   *   suggestion never hands ownership away to unguarded agent rewrites).
   * - Refreshes outgoing `dependsOn` `sinceHash` edges to current origin hashes.
   */
  applyProposal(id: string, proposalId: string): GalleyProposal {
    const proposal = this.listProposals(id).find((p) => p.id === proposalId)
    if (!proposal) throw new StoreError('proposal_not_found', `proposal ${proposalId} not found`)
    if (proposal.status !== 'pending') {
      throw new StoreError('invalid_op', `proposal ${proposalId} is already ${proposal.status}`)
    }
    const op = proposal.op ?? 'patch'
    const expect =
      op === 'insert' ? null : { blockId: proposal.targetBlockId, baseHash: proposal.baseHash }

    this.commit(id, expect, (p) => {
      if (op === 'insert') {
        const sid = proposal.sheetId ?? p.sheetOrder[0]
        const sh = p.sheets[sid]
        if (!sh) throw new StoreError('invalid_op', `sheet ${sid} not found`)
        const candidate = JSON.parse(JSON.stringify(proposal.proposedPatch.block)) as Block
        // Re-allocate id if the staged id was already claimed meanwhile
        const existing = findBlock(p, candidate.id)
        if (existing) candidate.id = allocateBlockId(p)
        candidate.origin = 'human'
        candidate.updatedAt = new Date().toISOString()
        candidate.hash = hashBlock(candidate)
        const beforeId = typeof proposal.proposedPatch.beforeId === 'string' ? proposal.proposedPatch.beforeId : undefined
        const idx = beforeId ? sh.blocks.findIndex((x) => x.id === beforeId) : sh.blocks.length
        sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, candidate)
        p.nextBlockSeq += 1
        return candidate.id
      }

      if (op === 'move') {
        const from = findBlock(p, proposal.targetBlockId)
        if (!from) throw new StoreError('not_found', `block ${proposal.targetBlockId} not found`)
        const targetSid = (proposal.proposedPatch.toSheetId as SheetId | undefined) ?? proposal.sheetId ?? from.sheet.id
        const targetSheet = p.sheets[targetSid]
        if (!targetSheet) throw new StoreError('invalid_op', `target sheet ${targetSid} not found`)
        from.sheet.blocks.splice(from.index, 1)
        let to = targetSheet.blocks.length
        const toBeforeId = proposal.proposedPatch.toBeforeId as BlockId | undefined
        const toAfterId = proposal.proposedPatch.toAfterId as BlockId | undefined
        if (toBeforeId) to = targetSheet.blocks.findIndex((x) => x.id === toBeforeId)
        if (toAfterId) {
          const i = targetSheet.blocks.findIndex((x) => x.id === toAfterId)
          to = i >= 0 ? i + 1 : targetSheet.blocks.length
        }
        from.block.origin = 'human'
        targetSheet.blocks.splice(to < 0 ? targetSheet.blocks.length : to, 0, from.block)
        return from.block.id
      }

      if (op === 'remove') {
        const found = findBlock(p, proposal.targetBlockId)
        if (!found) throw new StoreError('not_found', `block ${proposal.targetBlockId} not found`)
        found.sheet.blocks.splice(found.index, 1)
        return null
      }

      // Default: 'patch'
      const located = findBlock(p, proposal.targetBlockId)
      if (!located) throw new StoreError('not_found', `block ${proposal.targetBlockId} not found`)
      const b = located.block as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(proposal.proposedPatch)) {
        if (k === 'body') {
          b.body = typeof v === 'string' ? [{ t: 'text', v }] : Array.isArray(v) ? v : [{ t: 'text', v: String(v) }]
        } else if (k !== 'origin' && k !== 'id' && k !== 'hash') {
          b[k] = v
        }
      }
      if (Array.isArray(b.dependsOn) && b.dependsOn.length > 0) {
        const now = new Date().toISOString()
        b.dependsOn = (b.dependsOn as DepEdge[]).map((d) => {
          const origin = findBlock(p, d.id)
          return origin ? { id: d.id, sinceHash: origin.block.hash, at: now } : d
        })
      }
      b.origin = 'human' // spec 01 §7 (M2.5): accepted proposal becomes settled human content
      return proposal.targetBlockId
    })

    // commit() above already bumped packet.rev; record status without double-bumping.
    const updated = this.setProposalStatus(id, proposalId, 'accepted', { bumpRev: false })!
    return updated
  }

  acceptAllProposals(id: string): { accepted: string[]; conflicted: string[]; rev: number } {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const pending = this.listProposals(id).filter((p) => p.status === 'pending')
    const accepted: string[] = []
    const conflicted: string[] = []
    for (const prop of pending) {
      try {
        this.applyProposal(id, prop.id)
        accepted.push(prop.id)
      } catch (err) {
        if (err instanceof StoreError && (err.code === 'conflict' || err.code === 'not_found')) {
          this.setProposalStatus(id, prop.id, 'conflicted', { bumpRev: false })
          conflicted.push(prop.id)
        } else {
          throw err
        }
      }
    }
    if (accepted.length === 0 && conflicted.length > 0) {
      this.bumpRev(id, 'proposals conflicted')
    }
    return { accepted, conflicted, rev: this.load(id)!.rev }
  }
  addAnnotation(id: string, annotation: GalleyAnnotation): GalleyAnnotation {
    const list = this.readJson<GalleyAnnotation[]>(join(this.dir(id), 'annotations.json'), [])
    list.push(annotation)
    this.atomicWrite(join(this.dir(id), 'annotations.json'), JSON.stringify(list))
    this.bumpRev(id, `annotation ${annotation.id} on ${annotation.blockId} (${annotation.author})`, annotation.author)
    return annotation
  }
  listAnnotations(id: string, blockId?: BlockId): GalleyAnnotation[] {
    const list = this.readJson<GalleyAnnotation[]>(join(this.dir(id), 'annotations.json'), [])
    return blockId ? list.filter((a) => a.blockId === blockId) : list
  }
  setAnnotationResolved(id: string, annotationId: string, resolved: boolean, actor: 'human' | 'agent' = 'human'): GalleyAnnotation | null {
    const list = this.listAnnotations(id)
    const a = list.find((x) => x.id === annotationId)
    if (!a) return null
    a.resolved = resolved
    this.atomicWrite(join(this.dir(id), 'annotations.json'), JSON.stringify(list))
    this.bumpRev(id, `annotation ${annotationId} ${resolved ? 'resolved' : 'unresolved'} (${actor})`, actor)
    return a
  }

  // ── assets (metadata in packet; bytes in assets/ dir) ─────────────────────

  addAsset(id: string, meta: AssetMeta, bytes: Buffer, opts?: { bumpRev?: boolean }): AssetMeta {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const existing = packet.assets ?? {}
    if (!(meta.id in existing) && Object.keys(existing).length >= MAX_ASSETS_PER_PACKET) {
      throw new StoreError('asset_limit', `packet ${id} already holds ${MAX_ASSETS_PER_PACKET} assets`)
    }
    const assetsDir = join(this.dir(id), 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, basename(meta.path)), bytes)
    packet.assets = { ...existing, [meta.id]: meta }
    const mSeq = meta.id.match(/^a(\d+)$/)
    if (mSeq) packet.nextAssetSeq = Math.max(packet.nextAssetSeq ?? 1, Number(mSeq[1]) + 1)
    if (opts?.bumpRev !== false) {
      packet.rev += 1
      packet.updatedAt = new Date().toISOString()
    }
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2))
    return meta
  }

  /**
   * Read the raw bytes of a staged asset (M1.5 H4/H2.2). Returns null if the
   * asset is unknown or its file is missing. The arms use this to map asset
   * bytes into the compiler (native `mapShadow`) so media slots render offline.
   */
  readAsset(id: string, assetId: string): Buffer | null {
    const meta = this.load(id)?.assets?.[assetId]
    if (!meta) return null
    const p = join(this.dir(id), meta.path)
    return existsSync(p) ? readFileSync(p) : null
  }

  // ── atomic write (spec 01 §9): temp → fsync → rename ─────────────────────

  atomicWrite(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data, 0, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path) // atomic: readers see old or new, never partial
  }

  private readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch {
      return fallback
    }
  }
}
