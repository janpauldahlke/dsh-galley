/**
 * Pure Node HTTP dispatcher for `/api/galley/*` pane routes (spec 02 §5 & spec 04).
 *
 * Kept free of `@deepseek-ai/*` and `@myriaddreamin/*` imports (render arm is
 * injected via `getDepsForCwd`) so hermetic `node --test` suites can mount this
 * exact handler on `node:http` and verify 200/304/409/404 contracts directly.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { URL } from 'node:url'
import {
  EDIT_ROUTE,
  EXPORT_ROUTE,
  PROPOSAL_ROUTE_PREFIX,
  STATE_ROUTE,
  type AssetMeta,
  type BlockId,
  type ExportFileReceipt,
  type GalleyPacket,
  type LayoutSlot,
  type SheetId,
  type StateActivePayload,
  type StateEmptyPayload,
  type StateProofView,
  type StateSheetView,
} from '../shared/types.ts'
import { compileSheet, mapDiagnosticsToBlocks } from '../typst/index.ts'
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
  type GalleyToolsDeps,
  type ToolFailure,
} from './tools.ts'
import { getStoreForCwd, noteGalleyCwd } from './workspace.ts'

const BODY_LIMIT_BYTES = 6 * 1024 * 1024 // 6 MB JSON envelope (allows ≤4 MB raw image asset in base64)
const MAX_ASSET_BYTES = 4 * 1024 * 1024

export interface GalleyHttpDispatcherDeps {
  getDepsForCwd: (cwd?: string | null) => Promise<{
    deps: GalleyToolsDeps
    root: string
    cwd: string
  }>
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

function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
  return s || 'galley'
}

async function compilePacketProofs(deps: GalleyToolsDeps, packet: GalleyPacket): Promise<StateProofView[]> {
  const proofs: StateProofView[] = []
  const assetBytes = assetBytesForPacket(deps, packet)
  for (const sid of packet.sheetOrder) {
    const sheet = packet.sheets[sid]
    if (!sheet) continue
    if (!deps.render) {
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        blockToPage: {},
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
        blockToPage: sr.blockToPage ?? {},
        compiledAtRev: packet.rev,
        svgPages,
        compileError: null,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const cs = compileSheet(sheet, packet.assets)
      const mapped = mapDiagnosticsToBlocks(cs.typ, [{ message: msg }])
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        blockToPage: {},
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

    const explicitPid = url.searchParams.get('packetId')?.trim() || undefined
    if (explicitPid) {
      if (!store.load(explicitPid)) {
        sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${explicitPid} not found` })
        return
      }
      store.setActivePacket(explicitPid)
    }

    const activePid = explicitPid ?? store.getActivePacket()
    const packet = activePid ? store.load(activePid) : null
    if (!packet) {
      const empty: StateEmptyPayload = {
        ok: true,
        activePacket: false,
        cwd,
        packets,
        rev: 0,
        packetId: null,
      }
      sendJson(res, 200, empty)
      return
    }

    const revParam = url.searchParams.get('rev')
    if (revParam !== null && revParam !== '' && Number(revParam) === packet.rev) {
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
        proposals: allProposals.filter((p) => blockIds.has(p.targetBlockId)),
      })
    }

    const proofs = await getCachedProofs(root, deps, packet)
    const payload: StateActivePayload = {
      ok: true,
      activePacket: true,
      cwd,
      packets,
      rev: packet.rev,
      packetId: packet.id,
      template: packet.template,
      title: packet.title,
      activeSheetId: packet.sheetOrder[0] ?? 's1',
      sheetOrder: packet.sheetOrder,
      assets: packet.assets ?? {},
      undoDepth: store.undoDepth(packet.id),
      redoDepth: store.redoDepth(packet.id),
      sheets,
      staleDependents,
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
    const { deps } = await hostDeps.getDepsForCwd(cwdParam)
    const { store } = deps

    const op = typeof body.op === 'string' ? body.op : ''
    const source: 'human' | 'agent' = body.source === 'agent' || body.origin === 'agent' ? 'agent' : 'human'
    const packetIdArg = typeof body.packetId === 'string' ? body.packetId : undefined

    try {
      // 1. Route-only op: open / switch Mappe
      if (op === 'open') {
        const result = await galleyOpen(deps, {
          id: typeof body.id === 'string' ? body.id : undefined,
          template: body.template as 'arbeitsblatt' | 'rfc' | 'generic' | undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          targetPages: typeof body.targetPages === 'number' ? body.targetPages : undefined,
          blocks: Array.isArray(body.blocks) ? (body.blocks as Record<string, unknown>[]) : undefined,
          origin: source,
        })
        if (!result.ok) {
          sendFailure(res, result)
          return
        }
        sendJson(res, 200, result)
        return
      }

      // Resolve active packet for all other ops
      const pid = packetIdArg ?? store.getActivePacket()
      if (!pid) {
        sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet' })
        return
      }
      const packet = store.load(pid)
      if (!packet) {
        sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` })
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

      // 4. Route-only op: update-geometry (targetPages / paper / margin)
      if (op === 'update-geometry') {
        const sheetId = (typeof body.sheetId === 'string' ? body.sheetId : packet.sheetOrder[0]) as SheetId
        if (!packet.sheets[sheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` })
          return
        }
        const resCommit = store.commit(pid, null, (p) => {
          const sh = p.sheets[sheetId]
          if ('targetPages' in body) {
            const tp = body.targetPages
            if (tp === null || tp === undefined || tp === '') {
              delete sh.geometry.targetPages
            } else if (typeof tp === 'number' && Number.isFinite(tp) && tp >= 1) {
              sh.geometry.targetPages = Math.floor(tp)
            } else {
              throw new StoreError('invalid_op', 'targetPages must be positive integer or null')
            }
          }
          if (body.paper === 'a4' || body.paper === 'letter') {
            sh.geometry.paper = body.paper
          }
          return null
        })
        sendJson(res, 200, { ok: true, packetId: pid, rev: resCommit.rev, sheetId })
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
          const slotMode: 'media-right' | 'media-left' =
            body.slotMode === 'media-left' ? 'media-left' : 'media-right'
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

      // 6. Standard writer ops: insert | patch | move | remove
      if (op === 'insert' || op === 'patch' || op === 'move' || op === 'remove') {
        const blockId = typeof body.blockId === 'string' ? body.blockId : undefined
        const located = blockId ? findBlock(packet, blockId) : null
        const sheetId = (typeof body.sheetId === 'string' ? body.sheetId : located?.sheet.id ?? packet.sheetOrder[0]) as SheetId
        const sheet = packet.sheets[sheetId]
        if (!sheet) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` })
          return
        }

        // Normalize Spec 02 §4.4 `afterBlockId` / `index` alongside `beforeId` / `toAfterId`
        let beforeId = typeof body.beforeId === 'string' ? body.beforeId : undefined
        if (!beforeId && op === 'insert') {
          if (typeof body.afterBlockId === 'string') {
            const idx = sheet.blocks.findIndex((b) => b.id === body.afterBlockId)
            if (idx >= 0 && idx + 1 < sheet.blocks.length) beforeId = sheet.blocks[idx + 1].id
          } else if (typeof body.index === 'number' && body.index >= 0 && body.index < sheet.blocks.length) {
            beforeId = sheet.blocks[body.index].id
          }
        }

        let toBeforeId = typeof body.toBeforeId === 'string' ? body.toBeforeId : undefined
        let toAfterId = typeof body.toAfterId === 'string' ? body.toAfterId : undefined
        if (op === 'move' && !toBeforeId && !toAfterId) {
          const targetSh = packet.sheets[(typeof body.toSheetId === 'string' ? body.toSheetId : sheetId) as SheetId] ?? sheet
          if (typeof body.afterBlockId === 'string') {
            toAfterId = body.afterBlockId
          } else if (typeof body.index === 'number') {
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
        }

        const result = await galleyEditBlock(deps, {
          packetId: pid,
          sheetId,
          op,
          origin: source,
          beforeId,
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

    const pid = (typeof body.packetId === 'string' ? body.packetId : undefined) ?? store.getActivePacket()
    if (!pid) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet' })
      return
    }
    if (!store.load(pid)) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` })
      return
    }

    const action = typeof body.action === 'string' ? body.action : ''
    if (action !== 'accept' && action !== 'revert' && action !== 'reject') {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: 'action must be accept or revert' })
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
    const { store } = deps

    const pid = (typeof body.packetId === 'string' ? body.packetId : undefined) ?? store.getActivePacket()
    if (!pid) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: 'no active packet' })
      return
    }
    const packet = store.load(pid)
    if (!packet) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` })
      return
    }

    const format = typeof body.format === 'string' ? (body.format as 'pdf' | 'docx' | 'typ' | 'tex' | 'md') : 'pdf'
    const sheetIds = Array.isArray(body.sheetIds) && body.sheetIds.length > 0
      ? (body.sheetIds.filter((s): s is string => typeof s === 'string') as SheetId[])
      : typeof body.sheetId === 'string'
        ? [body.sheetId]
        : packet.sheetOrder

    const outDir = join(cwd, 'galley-exports')
    mkdirSync(outDir, { recursive: true })
    const slug = slugify(packet.title)
    const proofs = await getCachedProofs(root, deps, packet)
    const files: ExportFileReceipt[] = []

    for (const sid of sheetIds) {
      const result = await galleyExport(deps, { packetId: pid, sheetId: sid, format })
      if (!result.ok) {
        sendFailure(res, result)
        return
      }
      const bytes = result.bytes ?? Buffer.from(result.text ?? '', 'utf8')
      const filename = sheetIds.length === 1 && sid === 's1' ? `${slug}.${format}` : `${slug}-${sid}.${format}`
      const relPath = `galley-exports/${filename}`
      writeFileSync(join(cwd, relPath), bytes)
      const sheetProof = proofs.find((p) => p.sheetId === sid)
      files.push({
        sheetId: sid,
        path: relPath,
        format,
        pages: format === 'pdf' ? (sheetProof?.pages ?? null) : null,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }

    sendJson(res, 200, { ok: true, packetId: pid, rev: packet.rev, files })
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
