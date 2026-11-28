/**
 * Pure Node HTTP dispatcher for `/api/galley/*` pane routes (spec 02 §5 & spec 04).
 *
 * Kept free of `@deepseek-ai/*` and `@myriaddreamin/*` imports (render arm is
 * injected via `getDepsForCwd`) so hermetic `node --test` suites can mount this
 * exact handler on `node:http` and verify 200/304/409/404 contracts directly.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import {
  DOWNLOAD_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  PROPOSAL_ROUTE_PREFIX,
  STATE_ROUTE,
  type AssetMeta,
  type BlockId,
  type GalleyPacket,
  type LayoutSlot,
  type ReviewMode,
  type SheetId,
  type SourceProvenance,
  type StateActivePayload,
  type StateEmptyPayload,
  type StateProofView,
  type StateSheetView,
} from '../shared/types.ts'
import { compileSheet, mapDiagnosticsToBlocks } from '../typst/index.ts'
import { defaultGalleyRegistry, type GalleyServiceRegistry } from './service.ts'
import { StoreError, findBlock } from './store.ts'
import {
  Err,
  assetBytesForPacket,
  blockOutline,
  galleyAnnotate,
  galleyEditBlock,
  galleyExport,
  galleyOpen,
  mapError,
  type BatchBlockOp,
  type GalleyToolsDeps,
  type ToolFailure,
} from './tools.ts'
import {
  clearSessionActivePacket,
  getSessionActivePacket,
  getStoreForCwd,
  noteGalleyCwd,
  setSessionActivePacket,
} from './workspace.ts'

const BODY_LIMIT_BYTES = 6 * 1024 * 1024 // 6 MB JSON envelope (allows ≤4 MB raw image asset in base64)
const MAX_ASSET_BYTES = 4 * 1024 * 1024

export interface GalleyHttpDispatcherDeps {
  getDepsForCwd: (cwd?: string | null) => Promise<{
    deps: GalleyToolsDeps
    root: string
    cwd: string
  }>
  registry?: GalleyServiceRegistry
}

interface CachedPacketProofs {
  rev: number
  proofs: StateProofView[]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendNotModified(res: ServerResponse): void {
  res.writeHead(304, { 'cache-control': 'no-store' })
  res.end()
}

export function httpStatusForCode(code: string): number {
  switch (code) {
    case Err.NO_ACTIVE_PACKET:
    case Err.PACKET_NOT_FOUND:
    case Err.SHEET_NOT_FOUND:
    case Err.BLOCK_NOT_FOUND:
    case Err.ASSET_NOT_FOUND:
    case Err.PROPOSAL_NOT_FOUND:
    case Err.ANNOTATION_NOT_FOUND:
      return 404
    case Err.PROPOSAL_CONFLICT:
    case Err.EXPORT_BLOCKED_BY_PREFLIGHT:
      return 409
    case Err.INVALID_PARAMS:
    case Err.BLOCK_TYPE_MISMATCH:
    case Err.DEPENDENCY_CYCLE:
    case Err.ASSET_LIMIT_EXCEEDED:
      return 400
    default:
      return 500
  }
}

function sendFailure(res: ServerResponse, failure: ToolFailure): void {
  const fields: Record<string, string> = {}
  if (failure.baseHash) fields.baseHash = failure.baseHash
  if (failure.currentHash) fields.currentHash = failure.currentHash
  if (failure.diagnostics) fields.diagnostics = failure.diagnostics
  sendJson(res, httpStatusForCode(failure.code), {
    ok: false,
    code: failure.code,
    message: failure.message,
    fields,
    ...(failure.preflightWarnings ? { preflightWarnings: failure.preflightWarnings } : {}),
  })
}

function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new StoreError('invalid_op', 'request body exceeds size limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new StoreError('invalid_op', 'JSON object body required'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new StoreError('invalid_op', 'invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function parseUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? '127.0.0.1'
  return new URL(req.url ?? '/', `http://${host}`)
}

function extractSessionId(url: URL, body?: Record<string, unknown>): string | null {
  const fromBody = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (fromBody) return fromBody
  const fromQuery = url.searchParams.get('sessionId')?.trim() ?? ''
  return fromQuery || null
}

function resolveHttpPacketId(
  root: string,
  store: { getActivePacket(): string | null },
  explicitPid: string | undefined,
  sessionId: string | null,
): string | null {
  if (explicitPid !== undefined) return explicitPid
  if (sessionId) {
    // Never fall back to workspace-global `store.getActivePacket()` when a chat
    // `sessionId` is present — keeps the rightbar pane and agent tools in lockstep
    // so a brand-new chat shows the empty-state picker instead of another chat's packet.
    return getSessionActivePacket(root, sessionId)
  }
  return store.getActivePacket()
}

function extForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    case 'image/gif':
      return 'gif'
    default:
      return 'bin'
  }
}

function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.pdf':
      return 'application/pdf'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.typ':
    case '.tex':
    case '.md':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

async function compilePacketProofs(deps: GalleyToolsDeps, packet: GalleyPacket): Promise<StateProofView[]> {
  const proofs: StateProofView[] = []
  const assetBytes = assetBytesForPacket(deps, packet)
  for (const sid of packet.sheetOrder) {
    const sheet = packet.sheets[sid]
    if (!sheet) continue
    const tp = sheet.geometry.targetPages
    if (!deps.render) {
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        targetPages: tp ?? null,
        targetPagesMet: tp !== undefined ? false : null,
        blockToPage: {},
        hitBands: [],
        compiledAtRev: packet.rev,
        svgPages: [],
        compileError: null,
      })
      continue
    }
    try {
      const sr = await deps.render(sheet, packet, assetBytes)
      const svgPages = (sr.svgPages ?? []).map(
        (buf) => `data:image/svg+xml;base64,${Buffer.from(buf).toString('base64')}`,
      )
      proofs.push({
        sheetId: sid,
        pages: sr.pages,
        perPage: sr.perPage,
        lastPageLineCount: sr.lastPageLineCount,
        overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
        targetPages: tp ?? null,
        targetPagesMet: tp !== undefined ? sr.pages <= tp : null,
        blockToPage: sr.blockToPage ?? {},
        hitBands: sr.hitBands ?? [],
        compiledAtRev: packet.rev,
        svgPages,
        compileError: null,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const cs = compileSheet(sheet, packet.assets, packet.locale, { colophon: packet.colophon })
      const mapped = mapDiagnosticsToBlocks(cs.typ, [{ message: msg }])
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        targetPages: tp ?? null,
        targetPagesMet: tp !== undefined ? false : null,
        blockToPage: {},
        hitBands: [],
        compiledAtRev: packet.rev,
        svgPages: [],
        compileError: { message: msg, blockId: mapped[0]?.blockId ?? null },
      })
    }
  }
  return proofs
}

export function createGalleyHttpDispatcher(hostDeps: GalleyHttpDispatcherDeps) {
  const proofCache = new Map<string, CachedPacketProofs>()
  const registry = hostDeps.registry ?? defaultGalleyRegistry

  async function getCachedProofs(root: string, deps: GalleyToolsDeps, packet: GalleyPacket): Promise<StateProofView[]> {
    const key = `${root}::${packet.id}`
    const hit = proofCache.get(key)
    if (hit && hit.rev === packet.rev) return hit.proofs
    const proofs = await compilePacketProofs(deps, packet)
    proofCache.set(key, { rev: packet.rev, proofs })
    if (proofCache.size > 32) {
      const oldest = proofCache.keys().next().value
      if (oldest) proofCache.delete(oldest)
    }
    return proofs
  }

  async function handleState(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: 'method not allowed', fields: {} })
      return
    }
    const cwdParam = url.searchParams.get('cwd')?.trim() || null
    if (cwdParam) noteGalleyCwd(cwdParam)
    const { deps, root, cwd } = await hostDeps.getDepsForCwd(cwdParam)
    const { store } = deps
    const packets = store.list()

    // GET /api/galley/state is strictly read-only — never mutate store.active.json here.
    const explicitPid = url.searchParams.get('packetId')?.trim() || undefined
    if (explicitPid && !store.load(explicitPid)) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${explicitPid} not found` })
      return
    }

    const sessionId = extractSessionId(url)
    const activePid = resolveHttpPacketId(root, store, explicitPid, sessionId)
    const packet = activePid ? store.load(activePid) : null
    const templates = registry.listTemplates(store)
    if (!packet) {
      const empty: StateEmptyPayload = {
        ok: true,
        activePacket: false,
        cwd,
        packets,
        templates,
        rev: 0,
        packetId: null,
      }
      sendJson(res, 200, empty)
      return
    }

    const revParam = url.searchParams.get('rev')
    const knownPacket = url.searchParams.get('knownPacket')?.trim()
    if (
      revParam !== null &&
      revParam !== '' &&
      Number(revParam) === packet.rev &&
      (!knownPacket || knownPacket === packet.id)
    ) {
      sendNotModified(res)
      return
    }

    const allAnnotations = store.listAnnotations(packet.id)
    const allProposals = store.listProposals(packet.id)
    const sheets: StateSheetView[] = []
    const staleDependents: StateActivePayload['staleDependents'] = []

    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid]
      if (!sh) continue
      const blockIds = new Set<BlockId>(sh.blocks.map((b) => b.id))
      for (const b of sh.blocks) {
        if (b.stale) {
          staleDependents.push({
            id: b.id,
            origin: b.stale.origin,
            sinceHash: b.stale.sinceHash,
            state: b.stale.state,
          })
        }
      }
      sheets.push({
        id: sh.id,
        title: sh.title,
        geometry: sh.geometry,
        blocks: sh.blocks,
        annotations: allAnnotations.filter((a) => blockIds.has(a.blockId)),
        proposals: allProposals.filter((p) =>
          p.op === 'insert' ? (p.sheetId ?? packet.sheetOrder[0]) === sh.id : blockIds.has(p.targetBlockId),
        ),
      })
    }

    const proofs = await getCachedProofs(root, deps, packet)
    const proofMap: Record<SheetId, { overflowLinesOnLastPage?: number } | null> = {}
    for (const pr of proofs) proofMap[pr.sheetId] = pr
    const preflight = registry.runPreflight(packet, proofMap, cwd)

    const payload: StateActivePayload = {
      ok: true,
      activePacket: true,
      cwd,
      packets,
      templates,
      rev: packet.rev,
      packetId: packet.id,
      template: packet.template,
      title: packet.title,
      ...(packet.colophon !== undefined ? { colophon: packet.colophon } : {}),
      reviewMode: packet.reviewMode ?? 'auto',
      activeSheetId: packet.sheetOrder[0] ?? 's1',
      sheetOrder: packet.sheetOrder,
      assets: packet.assets ?? {},
      undoDepth: store.undoDepth(packet.id),
      redoDepth: store.redoDepth(packet.id),
      sheets,
      staleDependents,
      preflight,
      proofs,
    }
    sendJson(res, 200, payload)
  }

  async function handleEdit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: 'method not allowed', fields: {} })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendFailure(res, mapError(error))
      return
    }

    const cwdParam = (typeof body.cwd === 'string' ? body.cwd : url.searchParams.get('cwd'))?.trim() || null
    if (cwdParam) noteGalleyCwd(cwdParam)
    const { deps, root } = await hostDeps.getDepsForCwd(cwdParam)
    const { store } = deps
    const sessionId = extractSessionId(url, body)

    const op = typeof body.op === 'string' ? body.op : ''
    const source: 'human' | 'agent' = body.source === 'agent' || body.origin === 'agent' ? 'agent' : 'human'
    const packetIdArg = typeof body.packetId === 'string' ? body.packetId : undefined

    try {
      // 1. Route-only op: open / switch Mappe (`open` or `packet-open`)
      if (op === 'open' || op === 'packet-open') {
        const result = await galleyOpen(
          { ...deps, registry },
          {
            id: typeof body.id === 'string' ? body.id : undefined,
            template: typeof body.template === 'string' ? body.template : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            locale: body.locale === 'de' ? 'de' : body.locale === 'en' ? 'en' : undefined,
            ...(typeof body.colophon === 'boolean' || typeof body.colophon === 'string'
              ? { colophon: body.colophon }
              : {}),
            orientation: body.orientation === 'landscape' ? 'landscape' : body.orientation === 'portrait' ? 'portrait' : undefined,
            targetPages: typeof body.targetPages === 'number' ? body.targetPages : undefined,
            blocks: Array.isArray(body.blocks) ? (body.blocks as Record<string, unknown>[]) : undefined,
            origin: source,
          },
        )
        if (!result.ok) {
          sendFailure(res, result)
          return
        }
        if (sessionId) {
          setSessionActivePacket(root, sessionId, result.packetId)
        }
        sendJson(res, 200, result)
        return
      }

      // 1b. Route-only op: template-delete (does not require an active packet)
      if (op === 'template-delete') {
        const tid = typeof body.templateId === 'string' ? body.templateId.trim() : ''
        if (!tid) {
          sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'templateId required' })
          return
        }
        const removed = store.deleteSavedTemplate(tid)
        sendJson(res, 200, { ok: true, deleted: removed, templates: registry.listTemplates(store) })
        return
      }

      // 1c. Route-only op: packet-delete (may delete any packet id or active packet)
      if (op === 'packet-delete') {
        const targetId = resolveHttpPacketId(root, store, packetIdArg, sessionId)
        if (!targetId) {
          sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no packet to delete' })
          return
        }
        store.delete(targetId)
        clearSessionActivePacket(targetId, root)
        sendJson(res, 200, {
          ok: true,
          deletedId: targetId,
          activePacketId: resolveHttpPacketId(root, store, undefined, sessionId),
          packets: store.list(),
        })
        return
      }

      // Resolve active packet for all other ops
      const pid = resolveHttpPacketId(root, store, packetIdArg, sessionId)
      if (!pid) {
        sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet' })
        return
      }
      const packet = store.load(pid)
      if (!packet) {
        sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` })
        return
      }

      // 2. Route-only Mappe CRUD & Review Mode ops
      if (op === 'packet-rename') {
        const updated = store.renamePacket(pid, typeof body.title === 'string' ? body.title : '', source)
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, title: updated.title })
        return
      }
      if (op === 'packet-duplicate') {
        const dup = store.duplicatePacket(pid, typeof body.title === 'string' ? body.title : undefined)
        if (sessionId) {
          setSessionActivePacket(root, sessionId, dup.id)
        }
        sendJson(res, 200, { ok: true, packetId: dup.id, rev: dup.rev, title: dup.title })
        return
      }
      if (op === 'packet-set-review-mode') {
        const mode = body.reviewMode as ReviewMode
        const updated = store.setReviewMode(pid, mode, source)
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, reviewMode: updated.reviewMode ?? 'auto' })
        return
      }
      if (op === 'packet-set-colophon') {
        const rawColophon = body.colophon
        if (
          rawColophon !== null &&
          rawColophon !== undefined &&
          typeof rawColophon !== 'boolean' &&
          typeof rawColophon !== 'string'
        ) {
          sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'colophon must be boolean, string, or null' })
          return
        }
        const updated = store.setColophon(pid, rawColophon as boolean | string | null | undefined, source)
        sendJson(res, 200, {
          ok: true,
          packetId: pid,
          rev: updated.rev,
          colophon: updated.colophon ?? false,
        })
        return
      }
      if (op === 'template-save') {
        const bp = store.saveAsTemplate(pid, {
          id: typeof body.templateId === 'string' ? body.templateId : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        })
        sendJson(res, 200, { ok: true, template: bp, templates: registry.listTemplates(store) })
        return
      }

      // 2b. Sheet CRUD ops
      if (op === 'sheet-add') {
        const out = store.addSheet(pid, {
          title: typeof body.title === 'string' ? body.title : undefined,
          orientation: body.orientation === 'landscape' ? 'landscape' : 'portrait',
          targetPages: typeof body.targetPages === 'number' ? body.targetPages : undefined,
          paper: body.paper === 'letter' ? 'letter' : 'a4',
          actor: source,
        })
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.packet.rev, sheetId: out.sheetId, sheetOrder: out.packet.sheetOrder })
        return
      }
      if (op === 'sheet-rename') {
        const out = store.renameSheet(pid, String(body.sheetId ?? ''), typeof body.title === 'string' ? body.title : '', source)
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev })
        return
      }
      if (op === 'sheet-remove') {
        const out = store.removeSheet(pid, String(body.sheetId ?? ''), source)
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev, sheetOrder: out.sheetOrder })
        return
      }
      if (op === 'sheet-reorder') {
        const dir = body.direction === 'left' ? 'left' : 'right'
        const out = store.reorderSheet(pid, String(body.sheetId ?? ''), dir)
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev, sheetOrder: out.sheetOrder })
        return
      }

      // 2. Route-only ops: undo / redo
      if (op === 'undo' || op === 'redo') {
        const out = op === 'undo' ? store.undo(pid) : store.redo(pid)
        sendJson(res, 200, {
          ok: true,
          packetId: pid,
          rev: out.rev,
          undoDepth: store.undoDepth(pid),
          redoDepth: store.redoDepth(pid),
        })
        return
      }

      // 3. Route-only ops: annotate-add / annotate-resolve / annotate-unresolve
      if (op === 'annotate-add' || op === 'annotate-resolve' || op === 'annotate-unresolve') {
        const action = op === 'annotate-add' ? 'add' : op === 'annotate-resolve' ? 'resolve' : 'unresolve'
        const annRes = await galleyAnnotate(deps, {
          packetId: pid,
          blockId: String(body.blockId ?? ''),
          action,
          author: source,
          body: (body.body as string | undefined) ?? '',
          ...(body.provenance !== undefined ? { provenance: body.provenance as SourceProvenance } : {}),
          annotationId: typeof body.annotationId === 'string' ? body.annotationId : undefined,
        })
        if (!annRes.ok) {
          sendFailure(res, annRes)
          return
        }
        const reloaded = store.load(pid)!
        sendJson(res, 200, { ...annRes, packetId: pid, rev: reloaded.rev })
        return
      }

      // 4. Sheet geometry / metadata update (`update-geometry` or `sheet-update`)
      if (op === 'update-geometry' || op === 'sheet-update') {
        const sheetId = (typeof body.sheetId === 'string' ? body.sheetId : packet.sheetOrder[0]) as SheetId
        if (!packet.sheets[sheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` })
          return
        }
        const patch: {
          title?: string
          targetPages?: number | null
          orientation?: 'portrait' | 'landscape'
          paper?: 'a4' | 'letter'
        } = {}
        if (typeof body.title === 'string') patch.title = body.title
        if ('targetPages' in body) {
          const tp = body.targetPages
          if (tp === null || tp === undefined || tp === '' || tp === 0) patch.targetPages = null
          else if (typeof tp === 'number' && Number.isFinite(tp) && tp >= 1) patch.targetPages = Math.floor(tp)
          else throw new StoreError('invalid_op', 'targetPages must be positive integer or null')
        }
        if (body.paper === 'a4' || body.paper === 'letter') patch.paper = body.paper
        if (body.orientation === 'portrait' || body.orientation === 'landscape') patch.orientation = body.orientation
        const updated = store.updateSheet(pid, sheetId, patch, source)
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, sheetId })
        return
      }

      // 5. Route-only op: insert-asset (base64 image drop/paste + optional block slot bind)
      if (op === 'insert-asset') {
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : ''
        const rawB64 = typeof body.dataBase64 === 'string' ? body.dataBase64.trim() : ''
        if (!mimeType || !rawB64) {
          sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'insert-asset requires mimeType and dataBase64' })
          return
        }
        const stripped = rawB64.replace(/^data:[^;]+;base64,/, '')
        const bytes = Buffer.from(stripped, 'base64')
        if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
          sendFailure(res, {
            ok: false,
            code: Err.INVALID_PARAMS,
            message: `asset size must be between 1 B and ${MAX_ASSET_BYTES} B`,
          })
          return
        }
        const seq = packet.nextAssetSeq ?? Object.keys(packet.assets ?? {}).length + 1
        let n = seq
        while (packet.assets && `a${n}` in packet.assets) n++
        const assetId = `a${n}`
        const ext = extForMime(mimeType)
        const relPath = `assets/${assetId}.${ext}`
        const meta: AssetMeta = {
          id: assetId,
          path: relPath,
          bytesSha256: createHash('sha256').update(bytes).digest('hex'),
          mimeType,
          widthPx: typeof body.widthPx === 'number' ? body.widthPx : undefined,
          heightPx: typeof body.heightPx === 'number' ? body.heightPx : undefined,
        }
        store.addAsset(pid, meta, bytes)

        const targetBlockId = typeof body.blockId === 'string' ? body.blockId : undefined
        if (targetBlockId) {
          const slotMode: 'media-right' | 'media-left' | 'media-below' =
            body.slotMode === 'media-left'
              ? 'media-left'
              : body.slotMode === 'media-below'
                ? 'media-below'
                : 'media-right'
          const alt = typeof body.alt === 'string' && body.alt.trim() ? body.alt.trim() : assetId
          const widthCm = typeof body.widthCm === 'number' && body.widthCm > 0 ? body.widthCm : undefined
          const slot: LayoutSlot = {
            mode: slotMode,
            asset: { id: assetId, path: relPath, alt, widthCm },
          }
          const found = findBlock(store.load(pid)!, targetBlockId)
          if (!found) {
            sendFailure(res, { ok: false, code: Err.BLOCK_NOT_FOUND, message: `block ${targetBlockId} not found` })
            return
          }
          const editRes = await galleyEditBlock(deps, {
            packetId: pid,
            sheetId: found.sheet.id,
            op: 'patch',
            origin: source,
            blockId: targetBlockId,
            patch: { slot },
          })
          if (!editRes.ok) {
            sendFailure(res, editRes)
            return
          }
          sendJson(res, 200, { ...editRes, asset: meta })
          return
        }

        const reloaded = store.load(pid)!
        sendJson(res, 200, { ok: true, packetId: pid, rev: reloaded.rev, asset: meta })
        return
      }

      // 6a. Atomic batch writer op (`op: 'batch'`)
      if (op === 'batch') {
        const explicitSheetId = typeof body.sheetId === 'string' ? (body.sheetId as SheetId) : undefined
        const result = await galleyEditBlock(
          { ...deps, registry },
          {
            packetId: pid,
            ...(explicitSheetId !== undefined ? { sheetId: explicitSheetId } : {}),
            op: 'batch',
            origin: source,
            ops: Array.isArray(body.ops) ? (body.ops as BatchBlockOp[]) : undefined,
          },
        )
        if (!result.ok) {
          sendFailure(res, result)
          return
        }
        sendJson(res, 200, result)
        return
      }

      // 6. Standard writer ops: insert | patch | move | remove
      if (op === 'insert' || op === 'patch' || op === 'move' || op === 'remove') {
        const blockId = typeof body.blockId === 'string' ? body.blockId : undefined
        const explicitSheetId = typeof body.sheetId === 'string' ? (body.sheetId as SheetId) : undefined
        const located = blockId ? findBlock(packet, blockId) : null
        const previewSheetId = explicitSheetId ?? located?.sheet.id ?? packet.sheetOrder[0]
        if (explicitSheetId && !packet.sheets[explicitSheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${explicitSheetId} not found` })
          return
        }
        const sheetForIndex = packet.sheets[previewSheetId]

        // Normalize Spec 02 §4.4 `afterId` / `afterBlockId` / `index` alongside `beforeId` / `toAfterId`
        let beforeId = typeof body.beforeId === 'string' ? body.beforeId : undefined
        const afterId =
          typeof body.afterId === 'string'
            ? body.afterId
            : typeof body.afterBlockId === 'string'
              ? body.afterBlockId
              : undefined
        if (!beforeId && !afterId && op === 'insert' && sheetForIndex) {
          if (typeof body.index === 'number' && body.index >= 0 && body.index < sheetForIndex.blocks.length) {
            beforeId = sheetForIndex.blocks[body.index].id
          }
        }

        let toBeforeId = typeof body.toBeforeId === 'string' ? body.toBeforeId : undefined
        let toAfterId = typeof body.toAfterId === 'string' ? body.toAfterId : undefined
        if (op === 'move' && !toBeforeId && !toAfterId) {
          const targetSh =
            packet.sheets[(typeof body.toSheetId === 'string' ? body.toSheetId : previewSheetId) as SheetId] ??
            sheetForIndex
          if (typeof body.afterBlockId === 'string') {
            toAfterId = body.afterBlockId
          } else if (typeof body.index === 'number' && targetSh) {
            const without = targetSh.blocks.filter((b) => b.id !== blockId)
            if (body.index <= 0 && without.length > 0) toBeforeId = without[0].id
            else if (body.index > 0 && body.index <= without.length) toAfterId = without[Math.min(body.index, without.length) - 1].id
          }
        }

        // Normalize `patch` vs Spec 02/04 `content` + top-level `slot` + `dependsOn`
        let patchObj =
          body.patch && typeof body.patch === 'object' ? { ...(body.patch as Record<string, unknown>) } : undefined
        if (op === 'patch' && !patchObj) {
          patchObj = {}
          if (body.content && typeof body.content === 'object') {
            Object.assign(patchObj, body.content as Record<string, unknown>)
          }
          if (body.slot !== undefined) patchObj.slot = body.slot
          if (body.dependsOn !== undefined) patchObj.dependsOn = body.dependsOn
          if (body.provenance !== undefined) patchObj.provenance = body.provenance
        }

        const result = await galleyEditBlock(deps, {
          packetId: pid,
          ...(explicitSheetId !== undefined ? { sheetId: explicitSheetId } : {}),
          op,
          origin: source,
          beforeId,
          afterId,
          block: body.block as Record<string, unknown> | undefined,
          blockId,
          baseHash: typeof body.baseHash === 'string' ? body.baseHash : undefined,
          patch: patchObj,
          toSheetId: typeof body.toSheetId === 'string' ? body.toSheetId : undefined,
          toBeforeId,
          toAfterId,
        })
        if (!result.ok) {
          sendFailure(res, result)
          return
        }
        sendJson(res, 200, result)
        return
      }

      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: `unsupported edit op '${op}'` })
    } catch (error) {
      sendFailure(res, mapError(error))
    }
  }

  async function handleProposalDecide(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    proposalId: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: 'method not allowed', fields: {} })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendFailure(res, mapError(error))
      return
    }

    const cwdParam = (typeof body.cwd === 'string' ? body.cwd : url.searchParams.get('cwd'))?.trim() || null
    if (cwdParam) noteGalleyCwd(cwdParam)
    const { deps, root } = await hostDeps.getDepsForCwd(cwdParam)
    const { store } = deps

    const sessionId = extractSessionId(url, body)
    const pid = resolveHttpPacketId(
      root,
      store,
      typeof body.packetId === 'string' ? body.packetId : undefined,
      sessionId,
    )
    if (!pid) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet' })
      return
    }
    if (!store.load(pid)) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` })
      return
    }

    const action = typeof body.action === 'string' ? body.action : ''
    if (proposalId === '_all' || action === 'accept-all') {
      const summary = store.acceptAllProposals(pid)
      const reloaded = store.load(pid)!
      const proofs = await getCachedProofs(root, deps, reloaded)
      sendJson(res, 200, {
        ok: true,
        accepted: summary.accepted,
        conflicted: summary.conflicted,
        rev: summary.rev,
        proofs,
      })
      return
    }
    if (action !== 'accept' && action !== 'revert' && action !== 'reject') {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'action must be accept, revert, or accept-all' })
      return
    }

    if (action === 'revert' || action === 'reject') {
      const updated = store.setProposalStatus(pid, proposalId, 'rejected')
      if (!updated) {
        sendFailure(res, { ok: false, code: Err.PROPOSAL_NOT_FOUND, message: `proposal ${proposalId} not found` })
        return
      }
      const reloaded = store.load(pid)!
      const proofs = await getCachedProofs(root, deps, reloaded)
      const located = findBlock(reloaded, updated.targetBlockId)
      sendJson(res, 200, {
        ok: true,
        proposal: updated,
        block: located ? blockOutline(located.block) : null,
        rev: reloaded.rev,
        proof: located ? proofs.find((p) => p.sheetId === located.sheet.id) ?? null : null,
      })
      return
    }

    try {
      const accepted = store.applyProposal(pid, proposalId)
      const reloaded = store.load(pid)!
      const proofs = await getCachedProofs(root, deps, reloaded)
      const located = findBlock(reloaded, accepted.targetBlockId)
      sendJson(res, 200, {
        ok: true,
        proposal: accepted,
        block: located ? blockOutline(located.block) : null,
        rev: reloaded.rev,
        proof: located ? proofs.find((p) => p.sheetId === located.sheet.id) ?? null : null,
      })
    } catch (error) {
      if (error instanceof StoreError && error.code === 'conflict') {
        store.setProposalStatus(pid, proposalId, 'conflicted')
      }
      sendFailure(res, mapError(error))
    }
  }

  async function handleExport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: 'method not allowed', fields: {} })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendFailure(res, mapError(error))
      return
    }

    const cwdParam = (typeof body.cwd === 'string' ? body.cwd : url.searchParams.get('cwd'))?.trim() || null
    if (cwdParam) noteGalleyCwd(cwdParam)
    const { deps, root, cwd } = await hostDeps.getDepsForCwd(cwdParam)
    const sessionId = extractSessionId(url, body)

    const format = typeof body.format === 'string' ? (body.format as 'pdf' | 'docx' | 'typ' | 'tex' | 'md') : 'pdf'
    const sheetIds =
      Array.isArray(body.sheetIds) && body.sheetIds.length > 0
        ? (body.sheetIds.filter((s): s is string => typeof s === 'string') as SheetId[])
        : undefined
    const sheetId = typeof body.sheetId === 'string' ? body.sheetId : undefined
    const explicitPacketId = typeof body.packetId === 'string' ? body.packetId : undefined
    const hasSession = Boolean(sessionId)
    const resolvedPacketId = resolveHttpPacketId(root, deps.store, explicitPacketId, sessionId)
    if (hasSession && !resolvedPacketId) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet bound to this session' })
      return
    }
    const source: 'human' | 'agent' = body.source === 'agent' || body.origin === 'agent' ? 'agent' : 'human'
    const force = body.force === true

    const result = await galleyExport(
      { ...deps, registry },
      {
        packetId: resolvedPacketId ?? undefined,
        sheetId,
        sheetIds,
        format,
        outDir: cwd,
        origin: source,
        force,
      },
    )
    if (!result.ok) {
      sendFailure(res, result)
      return
    }
    sendJson(res, 200, {
      ok: true,
      packetId: resolvedPacketId ?? deps.store.getActivePacket(),
      format: result.format,
      files: result.files ?? [],
      preflightWarnings: result.preflightWarnings,
    })
  }

  async function handleDownload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: 'method not allowed', fields: {} })
      return
    }
    const cwdParam = url.searchParams.get('cwd')?.trim() || null
    if (cwdParam) noteGalleyCwd(cwdParam)
    const { cwd } = await hostDeps.getDepsForCwd(cwdParam)
    const relPath = url.searchParams.get('path')?.trim() ?? ''
    if (!relPath) {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'path query parameter required' })
      return
    }

    const exportsRoot = resolve(cwd, 'galley-exports')
    const targetAbs = resolve(cwd, relPath)
    if (!targetAbs.startsWith(exportsRoot + sep)) {
      sendFailure(res, {
        ok: false,
        code: Err.INVALID_PARAMS,
        message: 'download path must reside inside galley-exports/',
      })
      return
    }
    if (!existsSync(targetAbs) || !statSync(targetAbs).isFile()) {
      sendFailure(res, { ok: false, code: Err.EXPORT_FAILED, message: `exported file '${relPath}' not found` })
      return
    }

    const bytes = readFileSync(targetAbs)
    const safeName = basename(targetAbs).replace(/[^A-Za-z0-9._-]/g, '_')
    res.writeHead(200, {
      'content-type': contentTypeForExt(extname(targetAbs)),
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }

  return async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = parseUrl(req)
    const pathname = url.pathname

    if (pathname === STATE_ROUTE) {
      await handleState(req, res, url)
      return true
    }
    if (pathname === EDIT_ROUTE) {
      await handleEdit(req, res, url)
      return true
    }
    if (pathname === EXPORT_ROUTE) {
      await handleExport(req, res, url)
      return true
    }
    if (pathname === DOWNLOAD_ROUTE) {
      await handleDownload(req, res, url)
      return true
    }
    if (pathname.startsWith(PROPOSAL_ROUTE_PREFIX + '/')) {
      const rest = pathname.slice(PROPOSAL_ROUTE_PREFIX.length + 1)
      const m = rest.match(/^([^/]+)\/decide$/)
      if (m) {
        await handleProposalDecide(req, res, url, decodeURIComponent(m[1]))
        return true
      }
      sendJson(res, 404, { ok: false, code: Err.PROPOSAL_NOT_FOUND, message: 'route not found', fields: {} })
      return true
    }
    return false
  }
}

export { getStoreForCwd, noteGalleyCwd }
