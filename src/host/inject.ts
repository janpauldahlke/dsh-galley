/**
 * KV-cache-safe `agent/pre-step` delta injection for `dsh-galley` (M3, Spec 02 §6).
 *
 * Delivery seam: the `agent/pre-step` waterfall (proven sibling pattern from
 * `dsh-memento/src/host/inject.ts`). Never mutates `systemPrompt`.
 *
 * KV-cache law:
 * - When there is no active packet in the session's workspace `cwd`, or when
 *   `(packetId, rev)` matches the last injected state for this session, splice
 *   **zero** messages and return `decision` untouched (byte-identical prefix).
 * - When `rev > lastInjectedRev` (or the session switched to a different active
 *   Mappe), splice **one** `dsh-galley`-attributed `UserMessage` carrying the
 *   compact whole-Mappe structural outline, changed block IDs, pending
 *   proposals, and preflight warnings (`≤ 200` tokens).
 * - On session resume, scan `session.surface.nodes` backwards to recover
 *   `lastInjectedRev` from durable `user/message` events without sidecar files.
 * - Fail-open: any unexpected error logs at most once per session and returns
 *   `decision` untouched.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  PLUGIN,
  type Block,
  type BlockId,
  type BlockType,
  type GalleyAnnotation,
  type GalleyJournalEntry,
  type GalleyPacket,
  type GalleyPreflightWarning,
  type GalleyProposal,
  type SheetId,
} from '../shared/types.ts'
import { defaultGalleyRegistry, type GalleyServiceRegistry } from './service.ts'
import type { GalleyStore } from './store.ts'
import { assetBytesForPacket, blockText, type GalleyToolsDeps } from './tools.ts'
import { getSessionActivePacket, getStoreForCwd } from './workspace.ts'

/** Attribution for the injected delta (merge-extended `MessageSourceMap`). */
export interface GalleyDeltaSource {
  kind: 'dsh-galley'
  form: 'galley-delta'
  version: 1
  packetId: string
  rev: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-galley': GalleyDeltaSource
  }
}

export interface SheetProofMini {
  pages: number
  overflowLinesOnLastPage: number
}

export interface GalleyInjectDeps {
  getDepsForCwd?: (cwd?: string | null) => Promise<{
    deps: GalleyToolsDeps
    root: string
    cwd: string
  }> | {
    deps: GalleyToolsDeps
    root: string
    cwd: string
  }
  registry?: GalleyServiceRegistry
}

interface BlockSnapshotMeta {
  hash: string
  type: BlockType
}

interface SessionGalleyInjectState {
  lastPacketId: string | null
  revsByPacket: Map<string, number>
  globalMaxRev: number
  snapshotsByPacket: Map<string, Map<BlockId, BlockSnapshotMeta>>
  failed: boolean
}

/** Hard char ceiling (~185 tokens at ~4 chars/token; strictly under 220-token gate). */
export const MAX_INJECT_CHARS = 740

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Construct one identified, immutable user-role message without runtime imports
 * from `@deepseek-ai/*` (matching `dsh-memento`'s `createMementoUserMessage`).
 */
export function createGalleyUserMessage(
  content: readonly ContentBlock[],
  source: GalleyDeltaSource,
): UserMessage {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user',
      content: [...content],
      source,
    }),
  )
}

/** Rough token estimator for budget assertions (max of char/3.8 and lexical splits). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const byChars = Math.ceil(text.length / 3.8)
  const lexical = text.trim().split(/[\s.,;:()[\]"{}]+/).filter(Boolean).length
  return Math.max(byChars, lexical)
}

function snapshotBlocks(packet: GalleyPacket): Map<BlockId, BlockSnapshotMeta> {
  const map = new Map<BlockId, BlockSnapshotMeta>()
  for (const sid of packet.sheetOrder) {
    for (const b of packet.sheets[sid]?.blocks ?? []) {
      map.set(b.id, { hash: b.hash, type: b.type })
    }
  }
  return map
}

function cleanSnippet(raw: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  const flat = raw.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  if (!flat) return ''
  return flat.length <= maxLen ? flat : `${flat.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`
}

function formatBlockEntry(block: Block, previewLen: number): string {
  const tags: string[] = []
  for (const dep of block.dependsOn ?? []) {
    tags.push(`→${dep.id}`)
  }
  if (block.stale) {
    tags.push('STALE')
  }
  const suffix = tags.length > 0 ? `(${tags.join(', ')})` : ''
  const snippet = cleanSnippet(blockText(block), previewLen)
  return snippet ? `${block.id} ${block.type}${suffix} "${snippet}"` : `${block.id} ${block.type}${suffix}`
}

export interface FormatGalleyDeltaInput {
  packet: GalleyPacket
  prevRev: number
  prevBlocks?: Map<BlockId, BlockSnapshotMeta> | null
  proofs?: Record<SheetId, SheetProofMini | null>
  proposals?: GalleyProposal[]
  annotations?: GalleyAnnotation[]
  recentJournal?: GalleyJournalEntry[]
  preflight?: GalleyPreflightWarning[]
}

/**
 * Format the compact whole-Mappe delta message (Spec 02 §6, ≤ 200 tokens).
 * Adaptively shortens block previews on large packets so cross-sheet IDs,
 * `→dep` links, `STALE` markers, changed IDs, and preflight warnings always fit.
 */
export function formatGalleyDelta(input: FormatGalleyDeltaInput): string {
  const {
    packet,
    prevRev,
    prevBlocks,
    proofs,
    proposals = [],
    annotations = [],
    recentJournal = [],
    preflight = [],
  } = input
  const mode = packet.reviewMode ?? 'auto'
  const title = cleanSnippet(packet.title || packet.id, 36) || packet.id

  let totalBlocks = 0
  for (const sid of packet.sheetOrder) {
    totalBlocks += packet.sheets[sid]?.blocks.length ?? 0
  }

  // Changed blocks + attributed sheet/metadata journal notes since prevRev
  const changedItems: string[] = []
  if (prevRev > 0) {
    if (prevBlocks) {
      const currentIds = new Set<BlockId>()
      for (const sid of packet.sheetOrder) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          currentIds.add(b.id)
          const prev = prevBlocks.get(b.id)
          if (!prev || prev.hash !== b.hash) {
            changedItems.push(`${b.id} (${b.type})`)
          }
        }
      }
      for (const [oldId] of prevBlocks) {
        if (!currentIds.has(oldId)) changedItems.push(`${oldId} (removed)`)
      }
    }
    for (const j of recentJournal) {
      if (j.rev > prevRev && /^(sheet|reviewMode|packet\.title)/.test(j.note)) {
        changedItems.push(cleanSnippet(j.note, 44))
      }
    }
  }

  // Preflight summary (concise English per Spec 02 §6)
  const pfItems: string[] = []
  for (const sid of packet.sheetOrder) {
    for (const b of packet.sheets[sid]?.blocks ?? []) {
      if (b.stale) {
        const why =
          b.stale.state === 'stale_missing_origin'
            ? `origin ${b.stale.origin} missing`
            : `origin ${b.stale.origin} changed`
        pfItems.push(`${b.id} stale (${why})`)
      }
    }
  }
  for (const p of proposals) {
    if (p.status === 'pending') {
      const target = p.op === 'insert' ? (p.sheetId ?? packet.sheetOrder[0] ?? 'sheet') : p.targetBlockId
      pfItems.push(`${p.id} pending on ${target}`)
    }
  }
  for (const a of annotations) {
    if (!a.resolved && a.author === 'human') {
      pfItems.push(`${a.id} human note on ${a.blockId}`)
    }
  }
  for (const w of preflight) {
    if (w.code === 'GALLEY_STALE_BLOCK') continue // already rendered concisely above
    if (w.code === 'GALLEY_UNANSWERED_TASK' && w.blockId) {
      pfItems.push(`${w.blockId} unanswered task`)
    } else if (w.code === 'GALLEY_PAGE_OVERFLOW' && w.sheetId) {
      const ov = proofs?.[w.sheetId]?.overflowLinesOnLastPage
      pfItems.push(`${w.sheetId} overflow${ov ? ` (+${ov} lines)` : ''}`)
    } else if (w.code === 'GALLEY_SOURCE_LINE_WRAP' && w.blockId) {
      pfItems.push(`${w.blockId} long numbered line`)
    } else {
      const msg = cleanSnippet(w.message, 32)
      pfItems.push(`${w.blockId ? `${w.blockId}: ` : ''}${w.code}${msg ? ` (${msg})` : ''}`)
    }
  }

  const renderAttempt = (previewLen: number, maxBlocksPerSheet: number): string => {
    const lines: string[] = []
    lines.push(`[dsh-galley · Packet "${title}" · rev ${packet.rev} · mode ${mode}]`)
    lines.push('Outline:')
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid]
      if (!sh) continue
      const shTitle = cleanSnippet(sh.title || sid, 22) || sid
      const pr = proofs?.[sid]
      let pageTag = ''
      if (pr && pr.pages > 0) {
        if (sh.geometry.targetPages !== undefined || pr.overflowLinesOnLastPage > 0) {
          pageTag = ` (${pr.pages}p, +${pr.overflowLinesOnLastPage} overflow)`
        } else {
          pageTag = ` (${pr.pages}p)`
        }
      }
      const visible = sh.blocks.slice(0, maxBlocksPerSheet).map((b) => formatBlockEntry(b, previewLen))
      if (sh.blocks.length > maxBlocksPerSheet) {
        visible.push(`+${sh.blocks.length - maxBlocksPerSheet} more`)
      }
      const blockSummary = visible.length > 0 ? visible.join(', ') : '(empty)'
      lines.push(`  ${sid} "${shTitle}"${pageTag}: ${blockSummary}`)
    }

    if (prevRev > 0) {
      if (changedItems.length > 0) {
        const shown = changedItems.slice(0, 6)
        const extra = changedItems.length > 6 ? `, +${changedItems.length - 6} more` : ''
        lines.push(`Changed since rev ${prevRev}: ${shown.join(', ')}${extra}`)
      } else {
        lines.push(`Changed since rev ${prevRev}: metadata/proposals`)
      }
    }

    if (pfItems.length > 0) {
      const shown = pfItems.slice(0, 5)
      const extra = pfItems.length > 5 ? `; +${pfItems.length - 5} more` : ''
      lines.push(`Preflight: ${shown.join('; ')}${extra}`)
    }

    if (prevRev === 0) {
      lines.push(
        'Rules: galley_read_block origins verbatim; never edit .dsh/galley/ files directly; fix overflow/STALE before export.',
      )
    }

    return lines.join('\n')
  }

  const initialPreview = totalBlocks > 14 ? 0 : totalBlocks > 8 ? 12 : 18
  const candidates: Array<[number, number]> = [
    [initialPreview, 14],
    [10, 12],
    [0, 12],
    [0, 8],
    [0, 5],
  ]
  for (const [pLen, maxB] of candidates) {
    const text = renderAttempt(pLen, maxB)
    if (text.length <= MAX_INJECT_CHARS) return text
  }
  return renderAttempt(0, 4).slice(0, MAX_INJECT_CHARS)
}

/**
 * Scan the session surface backwards to recover `(lastPacketId, revsByPacket)`
 * from durable `user/message` events with `source.kind === 'dsh-galley'`.
 */
export function scanResumedGalleyState(session: Session): {
  lastPacketId: string | null
  revsByPacket: Map<string, number>
  globalMaxRev: number
} {
  let lastPacketId: string | null = null
  let globalMaxRev = 0
  const revsByPacket = new Map<string, number>()

  const nodes = session.surface?.nodes
  if (!nodes) return { lastPacketId, revsByPacket, globalMaxRev }

  for (const seq of [...nodes].reverse()) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const src = (event.data as { source?: Partial<GalleyDeltaSource> } | undefined)?.source
    if (src?.kind !== 'dsh-galley') continue
    const rev = typeof src.rev === 'number' && Number.isFinite(src.rev) ? src.rev : 0
    const pid = typeof src.packetId === 'string' && src.packetId ? src.packetId : null
    if (lastPacketId === null && pid) {
      lastPacketId = pid
    }
    if (rev > globalMaxRev) globalMaxRev = rev
    if (pid) {
      const prev = revsByPacket.get(pid) ?? 0
      if (rev > prev) revsByPacket.set(pid, rev)
    }
  }
  return { lastPacketId, revsByPacket, globalMaxRev }
}

function sessionIdOf(session: Session): string | null {
  const sid = session.id ?? session.header?.id
  return typeof sid === 'string' && sid.trim() ? sid.trim() : null
}

/**
 * Install the KV-cache-safe `agent/pre-step` delta injector on `ctx`.
 */
export function installGalleyInject(ctx: Context, injectDeps: GalleyInjectDeps = {}): () => void {
  if (typeof ctx.on !== 'function') {
    ctx.logger?.(PLUGIN)?.warn?.('ctx.on unavailable — skipping agent/pre-step galley inject')
    return () => {}
  }

  const bySession = new WeakMap<Session, SessionGalleyInjectState>()
  const proofMiniCache = new Map<string, { rev: number; proofs: Record<SheetId, SheetProofMini | null> }>()
  const registry = injectDeps.registry ?? defaultGalleyRegistry

  const recordFailure = (session: Session, state: SessionGalleyInjectState | undefined, error: unknown): void => {
    if (state) {
      state.failed = true
    } else {
      bySession.set(session, {
        lastPacketId: null,
        revsByPacket: new Map(),
        globalMaxRev: 0,
        snapshotsByPacket: new Map(),
        failed: true,
      })
    }
    try {
      ctx.logger?.(PLUGIN)?.warn?.(
        'galley pre-step inject skipped: %s',
        error instanceof Error ? error.message : String(error),
      )
    } catch {
      // Logging must never break the step.
    }
  }

  const resolveForCwd = async (cwd: string): Promise<{
    store: GalleyStore
    root: string
    cwd: string
    deps?: GalleyToolsDeps
  }> => {
    if (injectDeps.getDepsForCwd) {
      const r = await injectDeps.getDepsForCwd(cwd)
      return { store: r.deps.store, root: r.root, cwd: r.cwd, deps: r.deps }
    }
    const { store, root, cwd: resolved } = getStoreForCwd(cwd)
    return { store, root, cwd: resolved }
  }

  const getProofMinis = async (
    root: string,
    packet: GalleyPacket,
    deps?: GalleyToolsDeps,
  ): Promise<Record<SheetId, SheetProofMini | null> | undefined> => {
    if (!deps?.render) return undefined
    const cacheKey = `${root}::${packet.id}`
    const cached = proofMiniCache.get(cacheKey)
    if (cached && cached.rev === packet.rev) return cached.proofs

    const proofs: Record<SheetId, SheetProofMini | null> = {}
    const assetBytes = assetBytesForPacket(deps, packet)
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid]
      if (!sh) continue
      try {
        const sr = await deps.render(sh, packet, assetBytes)
        proofs[sid] = {
          pages: sr.pages,
          overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
        }
      } catch {
        proofs[sid] = null
      }
    }
    proofMiniCache.set(cacheKey, { rev: packet.rev, proofs })
    return proofs
  }

  const sub = ctx.on(
    'agent/pre-step',
    async (
      args: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind !== 'enter' || decision.messages.length === 0) return decision

      const session = args.agent?.session
      if (!session) return decision

      let state = bySession.get(session)
      if (state?.failed) return decision

      try {
        const cwd = session.header?.cwd
        if (typeof cwd !== 'string' || !cwd.trim()) {
          return decision
        }

        if (!state) {
          const resumed = scanResumedGalleyState(session)
          state = {
            lastPacketId: resumed.lastPacketId,
            revsByPacket: resumed.revsByPacket,
            globalMaxRev: resumed.globalMaxRev,
            snapshotsByPacket: new Map(),
            failed: false,
          }
          bySession.set(session, state)
        }

        const { store, root, cwd: resolvedCwd, deps } = await resolveForCwd(cwd)
        const sessionId = sessionIdOf(session)
        let activeId: string | null
        if (sessionId) {
          // Never fall back to workspace-global `store.getActivePacket()` when
          // `sessionId` is present — prevents injecting another chat's packet into
          // Turn 1 of a brand-new session. Resumed sessions with prior galley-delta
          // history (`state.lastPacketId`) recover their own packet cleanly.
          const pinnedId = getSessionActivePacket(root, sessionId)
          const resumedId =
            !pinnedId && state.lastPacketId && store.load(state.lastPacketId) ? state.lastPacketId : null
          activeId = pinnedId && store.load(pinnedId) ? pinnedId : resumedId
        } else {
          activeId = store.getActivePacket()
        }
        if (!activeId) {
          // Session has no bound packet yet — splice 0 messages, keep session healthy
          // so opening a packet on a later turn will inject cleanly.
          return decision
        }

        const packet = store.load(activeId)
        if (!packet) return decision

        const prevPacketRev =
          state.revsByPacket.get(packet.id) ??
          (state.lastPacketId === null ? state.globalMaxRev : 0)
        const switchedPacket = state.lastPacketId !== null && state.lastPacketId !== packet.id

        // KV-cache law: when same packet and rev has not advanced, touch NOTHING.
        if (!switchedPacket && packet.rev <= prevPacketRev) {
          return decision
        }

        // Recover prior block hashes from memory or from the store's undo ring (on resume)
        let prevBlocks = state.snapshotsByPacket.get(packet.id) ?? null
        if (!prevBlocks && prevPacketRev > 0) {
          const snap = store.snapshotAtRev(packet.id, prevPacketRev)
          if (snap) prevBlocks = snapshotBlocks(snap)
        }

        const proofs = await getProofMinis(root, packet, deps)
        const proposals = store.listProposals(packet.id)
        const annotations = store.listAnnotations(packet.id)
        const recentJournal = store.listJournal(packet.id)
        const preflight = registry.runPreflight(packet, proofs, resolvedCwd)

        const text = formatGalleyDelta({
          packet,
          prevRev: switchedPacket ? 0 : prevPacketRev,
          prevBlocks,
          proofs,
          proposals,
          annotations,
          recentJournal,
          preflight,
        })

        const message = createGalleyUserMessage(
          [{ type: 'text', text }],
          {
            kind: 'dsh-galley',
            form: 'galley-delta',
            version: 1,
            packetId: packet.id,
            rev: packet.rev,
          },
        )

        // Splice right after the claimed batch (memento pattern: direct user prompt
        // precedes the galley delta, driver-appended runtime context follows).
        const lastClaimedIndex = decision.messages.findLastIndex((m) => args.messages.includes(m))
        const anchor = lastClaimedIndex < 0 ? 0 : lastClaimedIndex + 1
        const messages = decision.messages.slice()
        messages.splice(anchor, 0, message)

        state.lastPacketId = packet.id
        state.revsByPacket.set(packet.id, packet.rev)
        if (packet.rev > state.globalMaxRev) state.globalMaxRev = packet.rev
        state.snapshotsByPacket.set(packet.id, snapshotBlocks(packet))

        return { ...decision, messages }
      } catch (error) {
        recordFailure(session, state, error)
        return decision
      }
    },
  )

  return () => {
    if (typeof sub === 'function') sub()
    else if (sub && typeof sub.dispose === 'function') sub.dispose()
  }
}
