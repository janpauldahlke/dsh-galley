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
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
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

/** The content projection of a block: everything EXCEPT derived/timestamp. */
export function blockContentProjection(block: Block): Record<string, unknown> {
  const b = block as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {
    id: b.id,
    type: b.type,
    dependsOn: b.dependsOn,
    slot: b.slot,
    origin: b.origin,
  }
  if (b.fields !== undefined) out.fields = b.fields
  if (b.body !== undefined) out.body = b.body
  if (b.level !== undefined) out.level = b.level
  if (b.numbered !== undefined) out.numbered = b.numbered
  if (b.headers !== undefined) out.headers = b.headers
  if (b.rows !== undefined) out.rows = b.rows
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
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, 'packet.json')))
      .map((e) => {
        const p = this.load(e.name)!
        return { id: p.id, title: p.title, rev: p.rev, updatedAt: p.updatedAt }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  delete(id: string): void {
    const dir = this.dir(id)
    if (!existsSync(dir)) throw new StoreError('not_found', `packet ${id} not found`)
    if (this.getActivePacket() === id) this.clearActivePacket()
    for (const name of readdirSync(dir)) {
      unlinkSync(join(dir, name))
    }
    rmdirSync(dir)
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

    // Journal: append, keep last JOURNAL_KEEP.
    const journal = this.readJson<{ rev: number; at: string; note: string }[]>(this.journalPath(id), [])
    journal.push({ rev: packet.rev, at: packet.updatedAt, note: touchedId ? `edit ${touchedId}` : 'edit' })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))

    // Undo ring: push previous snapshot, keep last UNDO_DEPTH.
    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    undo.push(prevSnapshot)
    while (undo.length > UNDO_DEPTH) undo.shift()
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo))

    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2))
    return { packet, rev: packet.rev, changeHash }
  }

  /** Pop the last snapshot and restore it (rev is preserved, no bump). */
  undo(id: string): { packet: GalleyPacket; rev: number } {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    const undo = this.readJson<GalleyPacket[]>(this.undoPath(id), [])
    if (undo.length === 0) throw new StoreError('no_undo', `no undo history for ${id}`)
    const prev = undo.pop()!
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo))
    prev.updatedAt = new Date().toISOString()
    recomputeStale(prev)
    this.atomicWrite(this.packetPath(id), JSON.stringify(prev, null, 2))
    const journal = this.readJson<{ rev: number; at: string; note: string }[]>(this.journalPath(id), [])
    journal.push({ rev: prev.rev, at: prev.updatedAt, note: 'undo' })
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)))
    return { packet: prev, rev: prev.rev }
  }

  undoDepth(id: string): number {
    return this.readJson<GalleyPacket[]>(this.undoPath(id), []).length
  }

  // ── proposals + annotations (stored inside the packet file) ──────────────

  addProposal(id: string, proposal: GalleyProposal): GalleyProposal {
    const packet = this.load(id)
    if (!packet) throw new StoreError('not_found', `packet ${id} not found`)
    ;(packet as unknown as Record<string, unknown>)._proposals = [
      ...this.readJson<GalleyProposal[]>(join(this.dir(id), 'proposals.json'), []),
      proposal,
    ]
    this.atomicWrite(join(this.dir(id), 'proposals.json'), JSON.stringify((packet as unknown as Record<string, unknown>)._proposals))
    return proposal
  }
  listProposals(id: string): GalleyProposal[] {
    return this.readJson<GalleyProposal[]>(join(this.dir(id), 'proposals.json'), [])
  }
  setProposalStatus(id: string, proposalId: string, status: GalleyProposal['status']): GalleyProposal | null {
    const list = this.listProposals(id)
    const p = list.find((x) => x.id === proposalId)
    if (!p) return null
    p.status = status
    this.atomicWrite(join(this.dir(id), 'proposals.json'), JSON.stringify(list))
    return p
  }
  /**
   * Accept a proposal (spec 01 §7): apply its patch to the target block as an
   * agent-origin write (the human re-claimed it, so the block becomes agent's),
   * refresh hashes + staleness, and mark it applied. Throws
   * StoreError('proposal_not_found') if the id is unknown, or 'conflict' if the
   * block changed since the proposal was recorded.
   */
  applyProposal(id: string, proposalId: string): GalleyProposal {
    const proposal = this.listProposals(id).find((p) => p.id === proposalId)
    if (!proposal) throw new StoreError('proposal_not_found', `proposal ${proposalId} not found`)
    this.commit(
      id,
      { blockId: proposal.targetBlockId, baseHash: proposal.baseHash },
      (p) => {
        const sheet = Object.values(p.sheets).find((s) => s.blocks.some((b) => b.id === proposal.targetBlockId))
        if (!sheet) throw new StoreError('not_found', `block ${proposal.targetBlockId} not found`)
        const b = sheet.blocks.find((x) => x.id === proposal.targetBlockId)! as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(proposal.proposedPatch)) {
          if (k === 'body') {
            // The proposal stored the raw patch (body may be a string); normalize
            // to Inline[] exactly like the direct patch path.
            b.body = typeof v === 'string' ? [{ t: 'text', v }] : (Array.isArray(v) ? v : [{ t: 'text', v: String(v) }])
          } else {
            b[k] = v
          }
        }
        b.origin = 'agent' // spec 01 §7: accept → origin = 'agent'
        return proposal.targetBlockId
      },
    )
    const updated = this.setProposalStatus(id, proposalId, 'accepted')!
    return updated
  }
  addAnnotation(id: string, annotation: GalleyAnnotation): GalleyAnnotation {
    const list = this.readJson<GalleyAnnotation[]>(join(this.dir(id), 'annotations.json'), [])
    list.push(annotation)
    this.atomicWrite(join(this.dir(id), 'annotations.json'), JSON.stringify(list))
    return annotation
  }
  listAnnotations(id: string, blockId?: BlockId): GalleyAnnotation[] {
    const list = this.readJson<GalleyAnnotation[]>(join(this.dir(id), 'annotations.json'), [])
    return blockId ? list.filter((a) => a.blockId === blockId) : list
  }
  setAnnotationResolved(id: string, annotationId: string, resolved: boolean): GalleyAnnotation | null {
    const list = this.listAnnotations(id)
    const a = list.find((x) => x.id === annotationId)
    if (!a) return null
    a.resolved = resolved
    this.atomicWrite(join(this.dir(id), 'annotations.json'), JSON.stringify(list))
    return a
  }

  // ── assets (metadata in packet; bytes in assets/ dir) ─────────────────────

  addAsset(id: string, meta: AssetMeta, bytes: Buffer): AssetMeta {
    const packet = this.load(id)!
    if (Object.keys(packet.assets ?? {}).length >= MAX_ASSETS_PER_PACKET) {
      throw new StoreError('asset_limit', `packet ${id} already holds ${MAX_ASSETS_PER_PACKET} assets`)
    }
    const assetsDir = join(this.dir(id), 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, basename(meta.path)), bytes)
    packet.assets = { ...(packet.assets ?? {}), [meta.id]: meta }
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
