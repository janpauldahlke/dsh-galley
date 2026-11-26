/**
 * Hermetic Cordis service registry & structural preflight engine (`ctx.galley`, Spec 02 §8).
 *
 * Allows sibling leaf bundles (domain template packs, `dsh-fundus`, RAG/citation
 * verifiers) to register reusable templates and preflight checks with clean
 * disposers while keeping `dsh-galley` strictly within its typesetting bounded context.
 */
import type {
  BlockId,
  GalleyPacket,
  GalleyPreflightWarning,
  GalleyTemplateBlueprint,
  PacketId,
  SheetId,
} from '../shared/types.ts'
import { getGalleyStrings } from '../shared/i18n.ts'
import { StoreError, type GalleyStore } from './store.ts'
import { getSessionActivePacket, getStoreForCwd, setSessionActivePacket } from './workspace.ts'

export const BUILTIN_TEMPLATES: GalleyTemplateBlueprint[] = [
  {
    id: 'worksheet',
    title: 'Problem Sheet + Answer Key',
    description: 'Two linked sheets: Problem Sheet (A4, target 1 page) + Answer Key with stale-tracking dependencies',
    source: 'builtin',
    sheets: [
      {
        id: 's1',
        title: 'Problem Sheet',
        geometry: {
          paper: 'a4',
          orientation: 'portrait',
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          targetPages: 1,
        },
        starterBlocks: [
          { type: 'header', fields: { titel: 'Problem Sheet', fach: '', klasse: '', datum: '', name: '' } },
          { type: 'task', body: 'First task' },
        ],
      },
      {
        id: 's2',
        title: 'Answer Key',
        geometry: {
          paper: 'a4',
          orientation: 'portrait',
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
        },
        starterBlocks: [
          { type: 'heading', level: 1, body: 'Answer Key' },
          { type: 'answer', body: 'Expected answer', dependsOn: ['b2'] },
        ],
      },
    ],
  },
  {
    id: 'rfc',
    title: 'Engineering RFC',
    description: 'Single A4 sheet for technical architecture, design proposals, and specifications',
    source: 'builtin',
    sheets: [
      {
        id: 's1',
        title: 'Document',
        geometry: {
          paper: 'a4',
          orientation: 'portrait',
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
        },
        starterBlocks: [],
      },
    ],
  },
  {
    id: 'generic',
    title: 'Blank Document',
    description: 'Single blank A4 sheet with unbounded page count',
    source: 'builtin',
    sheets: [
      {
        id: 's1',
        title: 'Document',
        geometry: {
          paper: 'a4',
          orientation: 'portrait',
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
        },
        starterBlocks: [],
      },
    ],
  },
]

export type GalleyPreflightCheckFn = (packet: GalleyPacket, cwd: string) => GalleyPreflightWarning[]

export interface GalleyService {
  registerTemplate(blueprint: GalleyTemplateBlueprint): () => void
  listTemplates(cwd?: string): GalleyTemplateBlueprint[]
  registerPreflight(id: string, check: GalleyPreflightCheckFn): () => void
  getStore(cwd?: string): GalleyStore
  getSessionPacketId(cwd: string | undefined, sessionId: string): PacketId | null
  setSessionPacketId(cwd: string | undefined, sessionId: string, packetId: PacketId): void
}

export class GalleyServiceRegistry {
  private readonly pluginTemplates = new Map<string, GalleyTemplateBlueprint>()
  private readonly preflightChecks = new Map<string, GalleyPreflightCheckFn>()

  registerTemplate(blueprint: GalleyTemplateBlueprint): () => void {
    const id = blueprint.id.trim()
    if (!id) throw new Error('template blueprint requires a non-empty id')
    const normalized: GalleyTemplateBlueprint = {
      ...blueprint,
      id,
      source: blueprint.source ?? 'plugin',
    }
    this.pluginTemplates.set(id, normalized)
    return () => {
      if (this.pluginTemplates.get(id) === normalized) {
        this.pluginTemplates.delete(id)
      }
    }
  }

  registerPreflight(id: string, check: GalleyPreflightCheckFn): () => void {
    const key = id.trim()
    if (!key) throw new Error('preflight check requires a non-empty id')
    this.preflightChecks.set(key, check)
    return () => {
      if (this.preflightChecks.get(key) === check) {
        this.preflightChecks.delete(key)
      }
    }
  }

  listTemplates(store?: GalleyStore): GalleyTemplateBlueprint[] {
    const byId = new Map<string, GalleyTemplateBlueprint>()
    for (const t of BUILTIN_TEMPLATES) byId.set(t.id, t)
    for (const [id, t] of this.pluginTemplates) byId.set(id, t)
    if (store) {
      for (const t of store.listSavedTemplates()) {
        byId.set(t.id, { ...t, source: 'workspace' })
      }
    }
    return [...byId.values()]
  }

  getTemplate(id: string, store?: GalleyStore): GalleyTemplateBlueprint | null {
    const all = this.listTemplates(store)
    return all.find((t) => t.id === id) ?? null
  }

  runPreflight(
    packet: GalleyPacket,
    proofs: Record<SheetId, { overflowLinesOnLastPage?: number } | null> | undefined,
    cwd: string,
  ): GalleyPreflightWarning[] {
    const warnings: GalleyPreflightWarning[] = []
    const pf = getGalleyStrings('en').preflight

    // 1. Stale dependency edges
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid]
      if (!sh) continue
      for (const b of sh.blocks) {
        if (b.stale) {
          warnings.push({
            code: 'GALLEY_STALE_BLOCK',
            severity: 'warn',
            sheetId: sid,
            blockId: b.id,
            message:
              b.stale.state === 'stale_missing_origin'
                ? pf.staleMissingOrigin(b.id, b.stale.origin)
                : pf.staleChangedOrigin(b.id, b.stale.origin),
          })
        }
      }
    }

    // 2. Tasks without a linked answer on multi-sheet packets (e.g. Problem Sheet + Answer Key)
    if (packet.sheetOrder.length >= 2) {
      const answeredTaskIds = new Set<BlockId>()
      let hasAnyAnswerBlock = false
      for (const sid of packet.sheetOrder) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          if (b.type === 'answer') {
            hasAnyAnswerBlock = true
            for (const dep of b.dependsOn ?? []) answeredTaskIds.add(dep.id)
          }
        }
      }
      const sheetsToScan = hasAnyAnswerBlock ? packet.sheetOrder : [packet.sheetOrder[0]]
      for (const sid of sheetsToScan) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          if (b.type === 'task' && !answeredTaskIds.has(b.id)) {
            warnings.push({
              code: 'GALLEY_UNANSWERED_TASK',
              severity: 'info',
              sheetId: sid,
              blockId: b.id,
              message: pf.unansweredTask(b.id),
            })
          }
        }
      }
    }

    // 2b. Unsupported keys passed on `header.fields` (surfaced instead of silent drop)
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid]?.blocks ?? []) {
        if (b.type === 'header' && Array.isArray(b.fields?._unknownKeys) && b.fields._unknownKeys.length > 0) {
          warnings.push({
            code: 'GALLEY_UNKNOWN_HEADER_FIELD',
            severity: 'warn',
            sheetId: sid,
            blockId: b.id,
            message: pf.unknownHeaderFields(b.id, b.fields._unknownKeys),
          })
        }
      }
    }

    // 3. Page overflow against targetPages
    if (proofs) {
      for (const sid of packet.sheetOrder) {
        const pr = proofs[sid]
        const target = packet.sheets[sid]?.geometry?.targetPages
        if (pr && (pr.overflowLinesOnLastPage ?? 0) > 0) {
          warnings.push({
            code: 'GALLEY_PAGE_OVERFLOW',
            severity: 'warn',
            sheetId: sid,
            message: pf.pageOverflow(
              packet.sheets[sid]?.title ?? sid,
              target ?? '?',
              pr.overflowLinesOnLastPage ?? 0,
            ),
          })
        }
      }
    }

    // 4. Long hard-broken lines in numbered `source_text` blocks (wrap shifts gutter numbers)
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid]
      if (!sh) continue
      for (const b of sh.blocks) {
        if (b.type === 'source_text' && b.lineNumbers) {
          const flat = (b.body ?? [])
            .map((n) => (n.t === 'newline' ? '\n' : 'v' in n && typeof n.v === 'string' ? n.v : ''))
            .join('')
          const logicalLines = flat.split('\n')
          if (logicalLines.length > 1) {
            const overIdx = logicalLines.findIndex((l) => l.length > 92)
            if (overIdx >= 0) {
              warnings.push({
                code: 'GALLEY_SOURCE_LINE_WRAP',
                severity: 'info',
                sheetId: sid,
                blockId: b.id,
                message: pf.sourceLineWrap(b.id, overIdx + 1, logicalLines[overIdx].length),
              })
            }
          }
        }
      }
    }

    // 5. Companion leaf-plugin checks (fail-open so a third-party check never breaks the host)
    for (const [, fn] of this.preflightChecks) {
      try {
        const extra = fn(packet, cwd)
        if (Array.isArray(extra)) warnings.push(...extra)
      } catch {
        /* fail-open */
      }
    }

    return warnings
  }

  toCordisService(): GalleyService {
    return {
      registerTemplate: (bp) => this.registerTemplate(bp),
      listTemplates: (cwd) => {
        const { store } = getStoreForCwd(cwd)
        return this.listTemplates(store)
      },
      registerPreflight: (id, check) => this.registerPreflight(id, check),
      getStore: (cwd) => getStoreForCwd(cwd).store,
      getSessionPacketId: (cwd, sessionId) => {
        const { root } = getStoreForCwd(cwd)
        return getSessionActivePacket(root, sessionId)
      },
      setSessionPacketId: (cwd, sessionId, packetId) => {
        const { store, root } = getStoreForCwd(cwd)
        if (!store.load(packetId)) {
          throw new StoreError('not_found', `packet ${packetId} not found`)
        }
        setSessionActivePacket(root, sessionId, packetId)
      },
    }
  }

  _resetForTests(): void {
    this.pluginTemplates.clear()
    this.preflightChecks.clear()
  }
}

export const defaultGalleyRegistry = new GalleyServiceRegistry()
