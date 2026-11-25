/**
 * dsh-galley — M1.5 tools test (spec 05 §1 gate + M1.5 H4 compact receipts).
 *
 * Imports the BUILT hermetic core `lib/galley-core.mjs` (run `node build.mjs`
 * first) and drives all six tools against a real `GalleyStore` on a temp dir,
 * with a FAKE renderer (no arm needed) so the suite stays hermetic + < 2 s.
 *
 * M1.5 H4: tool receipts are COMPACT — open/status/edit return a `packetId` +
 * `rev` + per-sheet `BlockOutline[]` (id/type/hash/origin/words/preview/stale)
 * and a proof, never the full block AST (no `body`/Inline). This test asserts:
 *   - the compact receipt shapes,
 *   - that a freshly-opened packet is the ACTIVE packet (packetId omitted →
 *     resolves to it),
 *   - galley_read_block batch (`blockIds: string[]`),
 *   - the galley_edit_block receipt is < 1500 chars and leaks no Inline body,
 *   - every one of the 14 GALLEY_* error codes is produced at least once.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyStore,
  galleyOpen,
  galleyStatus,
  galleyReadBlock,
  galleyEditBlock,
  galleyAnnotate,
  galleyExport,
  Err,
  mapStoreCode,
  MAX_ASSETS_PER_PACKET,
} from '../lib/galley-core.mjs'

/** A deterministic fake SheetRender — proves the tools without the arm. */
function fakeRender(sheet, packet) {
  return {
    sheetId: sheet.id,
    pdf: Buffer.from('%PDF-1.4 fake-pdf'),
    svgPages: [Buffer.from('<svg/>')],
    svg: '<svg viewBox="0 0 595 842"/>',
    pages: 1,
    perPage: [{ wPt: 595.28, hPt: 841.89 }],
    lastPageLineCount: 3,
    overflowLinesOnLastPage: 0,
    blockToPage: Object.fromEntries(sheet.blocks.map((b) => [b.id, 0])),
    diagnostics: [],
    compiledAtRev: packet.rev,
  }
}

let root
let store
let deps

before(() => {
  root = mkdtempSync(join(tmpdir(), 'galley-tools-'))
  store = new GalleyStore(root)
  deps = { store, render: fakeRender, now: () => 'now' }
})
after(() => rmSync(root, { recursive: true, force: true }))

const openPacket = async (blocks, extra = {}) => (await galleyOpen(deps, { blocks, ...extra }))
/** Full block list for a sheet (via the store — the receipt is compact). */
const blocksOf = async (pid, sheetId = 's1') => (await store.load(pid)).sheets[sheetId].blocks
const blockAt = async (pid, idx, sheetId = 's1') => (await blocksOf(pid, sheetId))[idx]

// ── Happy paths (compact receipts) ──────────────────────────────────────────

test('galley_open: creates packet, assigns ids, returns compact receipt + proof', async () => {
  const r = await openPacket([
    { type: 'heading', level: 1, body: 'T' },
    { type: 'prose', body: 'P' },
  ])
  assert.equal(r.ok, true)
  assert.match(r.packetId, /^p-/)
  assert.equal(r.rev, 1)
  assert.equal(r.active, true)
  // Compact per-sheet outlines (NOT the full block AST).
  const blocks = r.blocks.s1
  assert.deepEqual(blocks.map((b) => b.id), ['b1', 'b2'])
  assert.equal(blocks[0].type, 'heading')
  assert.match(blocks[0].hash, /^[0-9a-f]{64}$/)
  assert.equal(blocks[0].origin, 'human') // seed blocks from open are human
  assert.equal(blocks[0].stale, false)
  // The outline carries NO inline body — the AST is not leaked.
  assert.equal(blocks[0].body, undefined)
  assert.equal(r.proofs.s1.pages, 1)
  assert.equal(r.proofs.s1.compiledAtRev, 1)
})

test('galley_status: returns packetId + rev + compact blocks + fresh proofs', async () => {
  const r = await openPacket([{ type: 'prose', body: 'P' }])
  const s = await galleyStatus(deps, { packetId: r.packetId })
  assert.equal(s.ok, true)
  assert.equal(s.packetId, r.packetId)
  assert.equal(s.rev, 1)
  assert.equal(s.blocks.s1[0].id, 'b1')
  assert.equal(s.proofs.s1.pages, 1)
})

test('galley_read_block: returns block + context + deps + dependents', async () => {
  const r = await openPacket([
    { type: 'prose', body: 'A', dependsOn: [] },
    { type: 'prose', body: 'B', dependsOn: [{ id: 'b1', sinceHash: 'x', at: '' }] },
  ])
  const got = await galleyReadBlock(deps, { packetId: r.packetId, sheetId: 's1', blockId: 'b1' })
  assert.equal(got.ok, true)
  assert.equal(got.packetId, r.packetId)
  assert.equal(got.blocks.length, 1)
  assert.equal(got.blocks[0].block.id, 'b1')
  assert.equal(got.blocks[0].dependencies.length, 0)
  assert.equal(got.blocks[0].dependents.length, 1)
  assert.equal(got.blocks[0].dependents[0], 'b2')
})

test('galley_read_block: batch blockIds returns one BlockRead per id', async () => {
  const r = await openPacket([
    { type: 'prose', body: 'A' },
    { type: 'prose', body: 'B' },
    { type: 'prose', body: 'C' },
  ])
  const got = await galleyReadBlock(deps, { packetId: r.packetId, blockIds: ['b3', 'b1'] })
  assert.equal(got.ok, true)
  assert.deepEqual(got.blocks.map((x) => x.block.id), ['b3', 'b1'])
})

test('galley_edit_block: insert before a block (compact receipt)', async () => {
  const r = await openPacket([{ type: 'prose', body: 'one' }])
  const ins = await galleyEditBlock(deps, {
    packetId: r.packetId, sheetId: 's1', op: 'insert', origin: 'agent',
    beforeId: 'b1', block: { type: 'task', body: 'do it' },
  })
  assert.equal(ins.ok, true)
  assert.equal(ins.applied, true)
  assert.equal(ins.packetId, r.packetId)
  assert.equal(ins.rev, 2)
  // The receipt carries the written block as an OUTLINE (no Inline body).
  assert.equal(ins.block.id, 'b2')
  assert.equal(ins.block.type, 'task')
  assert.match(ins.block.hash, /^[0-9a-f]{64}$/)
  assert.equal(ins.block.body, undefined)
  assert.equal(ins.proposal, null)
  // Order verified via the store (the receipt does not list all blocks).
  assert.deepEqual((await blocksOf(r.packetId)).map((b) => b.id), ['b2', 'b1'])
  // The compact edit receipt is small — the full packet AST is not leaked.
  assert.ok(JSON.stringify(ins).length < 1500, `edit receipt too large: ${JSON.stringify(ins).length}`)
})

test('galley_edit_block: move + remove (compact receipt)', async () => {
  const r = await openPacket([
    { type: 'prose', body: 'a' },
    { type: 'prose', body: 'b' },
    { type: 'prose', body: 'c' },
  ])
  const mv = await galleyEditBlock(deps, {
    packetId: r.packetId, sheetId: 's1', op: 'move', origin: 'agent',
    blockId: 'b3', baseHash: (await blockAt(r.packetId, 2)).hash, toBeforeId: 'b1',
  })
  assert.equal(mv.ok, true)
  assert.deepEqual((await blocksOf(r.packetId)).map((b) => b.id), ['b3', 'b1', 'b2'])
  const b2hash = (await blocksOf(r.packetId)).find((b) => b.id === 'b2').hash
  const rm = await galleyEditBlock(deps, {
    packetId: r.packetId, sheetId: 's1', op: 'remove', origin: 'agent',
    blockId: 'b2', baseHash: b2hash,
  })
  assert.equal(rm.ok, true)
  assert.deepEqual((await blocksOf(r.packetId)).map((b) => b.id), ['b3', 'b1'])
})

test('galley_annotate: add / list / resolve / unresolve', async () => {
  const r = await openPacket([{ type: 'prose', body: 'x' }])
  const add = await galleyAnnotate(deps, {
    packetId: r.packetId, blockId: 'b1', action: 'add', author: 'agent', body: 'a note',
  })
  assert.equal(add.ok, true)
  assert.equal(add.created.id, 'ann-1')
  assert.equal(add.created.resolved, false)

  const list = await galleyAnnotate(deps, { packetId: r.packetId, blockId: 'b1', action: 'list' })
  assert.equal(list.annotations.length, 1)

  const res = await galleyAnnotate(deps, {
    packetId: r.packetId, blockId: 'b1', action: 'resolve', annotationId: 'ann-1',
  })
  assert.equal(res.annotations[0].resolved, true)

  const unres = await galleyAnnotate(deps, {
    packetId: r.packetId, blockId: 'b1', action: 'unresolve', annotationId: 'ann-1',
  })
  assert.equal(unres.annotations[0].resolved, false)
})

test('galley_export: typ / md / tex are pure text; pdf via bytes; docx fails (M4)', async () => {
  const r = await openPacket([
    { type: 'heading', level: 1, body: 'Title' },
    { type: 'prose', body: 'Body text' },
  ])
  const typ = await galleyExport(deps, { packetId: r.packetId, format: 'typ' })
  assert.equal(typ.ok, true)
  assert.match(typ.text, /#set page\(paper: "a4"/)
  assert.match(typ.text, /#text\("Title"\)/)

  const md = await galleyExport(deps, { packetId: r.packetId, format: 'md' })
  assert.match(md.text, /Title/)
  assert.match(md.text, /Body text/)

  const tex = await galleyExport(deps, { packetId: r.packetId, format: 'tex' })
  assert.match(tex.text, /Title/)

  const pdf = await galleyExport(deps, { packetId: r.packetId, format: 'pdf' })
  assert.equal(pdf.ok, true)
  assert.ok(pdf.bytes instanceof Buffer && pdf.bytes.length > 0)

  // M1.5 H6: docx is a clean failure until M4 — never faked with Markdown bytes.
  const docx = await galleyExport(deps, { packetId: r.packetId, format: 'docx' })
  assert.equal(docx.ok, false)
  assert.equal(docx.code, Err.EXPORT_FAILED)
  assert.equal(docx.bytes, undefined)
  assert.match(docx.message, /M4/)
})

// ── Active-packet resolution (M1.5 H4) ──────────────────────────────────────

test('active packet: open sets it; status/read/edit/export resolve when packetId omitted', async () => {
  const r = await openPacket([{ type: 'prose', body: 'active' }])
  assert.equal(r.active, true)

  // Omitted packetId → the active packet.
  const s = await galleyStatus(deps, {})
  assert.equal(s.ok, true)
  assert.equal(s.packetId, r.packetId)

  const rd = await galleyReadBlock(deps, { blockId: 'b1' })
  assert.equal(rd.ok, true)
  assert.equal(rd.packetId, r.packetId)
  assert.equal(rd.blocks[0].block.id, 'b1')

  const ed = await galleyEditBlock(deps, {
    sheetId: 's1', op: 'insert', origin: 'agent',
    block: { type: 'prose', body: 'active-edited' },
  })
  assert.equal(ed.ok, true)
  assert.equal(ed.applied, true)
  assert.equal(ed.packetId, r.packetId)
  assert.ok((await blocksOf(r.packetId)).some((b) => b.body[0].v === 'active-edited'))

  const ex = await galleyExport(deps, { format: 'md' })
  assert.equal(ex.ok, true)
  assert.match(ex.text, /active-edited/)
})

test('active packet: a later open re-points it; an explicit id wins', async () => {
  const a = await openPacket([{ type: 'prose', body: 'first' }])
  const b = await openPacket([{ type: 'prose', body: 'second' }])
  // Active is now b.
  assert.equal((await galleyStatus(deps, {})).packetId, b.packetId)
  // An explicit id still resolves to that packet.
  assert.equal((await galleyStatus(deps, { packetId: a.packetId })).packetId, a.packetId)
})

// ── Proposal rule: 4/4 quadrants (spec 01 §7 — decision on the BLOCK's own origin) ──

test('proposal rule: 4/4 quadrants (agent/human block × patch/direct-op)', async () => {
  // Q1 — patch on a HUMAN block → proposal (applied:false), block UNCHANGED.
  const q1 = await openPacket([{ type: 'prose', body: 'human text' }])
  const q1hash = (await blockAt(q1.packetId, 0)).hash
  const r1 = await galleyEditBlock(deps, {
    packetId: q1.packetId, sheetId: 's1', op: 'patch', origin: 'agent',
    blockId: 'b1', baseHash: q1hash, patch: { body: 'agent wants this' },
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.applied, false)
  assert.ok(r1.proposal)
  assert.equal(r1.proposal.status, 'pending')
  assert.equal(r1.proposal.targetBlockId, 'b1')
  assert.equal(r1.block, null) // proposal path writes nothing
  // The block was NOT written (proposal is not a direct write).
  const b1 = (await blockAt(q1.packetId, 0))
  assert.equal(b1.body[0].v, 'human text')
  assert.equal(b1.hash, q1hash)

  // Q2 — patch on an AGENT block → direct apply (applied:true), no proposal.
  const q2 = await openPacket([{ type: 'prose', body: 'seed' }])
  const ins = await galleyEditBlock(deps, {
    packetId: q2.packetId, sheetId: 's1', op: 'insert', origin: 'agent',
    block: { type: 'prose', body: 'agent text' },
  })
  assert.equal(ins.applied, true)
  assert.equal(ins.proposal, null)
  const q2blocks = await blocksOf(q2.packetId)
  const agentBlockId = q2blocks.find((b) => b.body[0].v === 'agent text').id
  const q2hash = q2blocks.find((b) => b.id === agentBlockId).hash
  const r2 = await galleyEditBlock(deps, {
    packetId: q2.packetId, sheetId: 's1', op: 'patch', origin: 'agent',
    blockId: agentBlockId, baseHash: q2hash, patch: { body: 'rewritten by agent' },
  })
  assert.equal(r2.ok, true)
  assert.equal(r2.applied, true)
  assert.equal(r2.proposal, null)
  assert.equal((await blocksOf(q2.packetId)).find((b) => b.id === agentBlockId).body[0].v, 'rewritten by agent')

  // Q3 — a NON-patch op on a HUMAN block (remove) → direct apply (applied:true).
  const q3 = await openPacket([{ type: 'prose', body: 'to remove' }])
  const r3 = await galleyEditBlock(deps, {
    packetId: q3.packetId, sheetId: 's1', op: 'remove', origin: 'human',
    blockId: 'b1', baseHash: (await blockAt(q3.packetId, 0)).hash,
  })
  assert.equal(r3.ok, true)
  assert.equal(r3.applied, true)
  assert.equal(r3.proposal, null)
  assert.equal((await blocksOf(q3.packetId)).length, 0)

  // Q4 — a NON-patch op on an AGENT block (move) → direct apply (applied:true).
  const q4 = await openPacket([
    { type: 'prose', body: 'a' },
    { type: 'prose', body: 'b' },
  ])
  const r4 = await galleyEditBlock(deps, {
    packetId: q4.packetId, sheetId: 's1', op: 'move', origin: 'agent',
    blockId: 'b2', baseHash: (await blockAt(q4.packetId, 1)).hash, toBeforeId: 'b1',
  })
  assert.equal(r4.ok, true)
  assert.equal(r4.applied, true)
  assert.equal(r4.proposal, null)
  assert.deepEqual((await blocksOf(q4.packetId)).map((b) => b.id), ['b2', 'b1'])
})

test('accept a proposal → block content + origin = agent (spec 01 §7)', async () => {
  const r = await openPacket([{ type: 'prose', body: 'human text' }])
  const baseHash = (await blockAt(r.packetId, 0)).hash
  const p = await galleyEditBlock(deps, {
    packetId: r.packetId, sheetId: 's1', op: 'patch', origin: 'agent',
    blockId: 'b1', baseHash, patch: { body: 'accepted text' },
  })
  assert.equal(p.applied, false)
  assert.ok(p.proposal)
  const accepted = store.applyProposal(r.packetId, p.proposal.id)
  assert.equal(accepted.status, 'accepted')
  const b = (await blockAt(r.packetId, 0))
  assert.equal(b.body[0].v, 'accepted text')
  assert.equal(b.origin, 'agent')
})

// ── Every typed error code (spec 02 §3) at least once ───────────────────────

test('error codes: all 14 GALLEY_* codes are produced at least once (spec 02 §3)', async () => {
  const r = await openPacket([{ type: 'prose', body: 'human-block' }])
  const id = r.packetId

  // 1. NO_ACTIVE_PACKET — explicit empty id is falsy, so it does NOT fall back.
  assert.equal((await galleyStatus(deps, { packetId: '' })).code, Err.NO_ACTIVE_PACKET)

  // 2. PACKET_NOT_FOUND
  assert.equal((await galleyStatus(deps, { packetId: 'p-zzzzzzzz' })).code, Err.PACKET_NOT_FOUND)

  // 3. SHEET_NOT_FOUND
  assert.equal((await galleyStatus(deps, { packetId: id, sheetId: 's99' })).code, Err.SHEET_NOT_FOUND)

  // 4. BLOCK_NOT_FOUND
  assert.equal((await galleyReadBlock(deps, { packetId: id, sheetId: 's1', blockId: 'zz' })).code, Err.BLOCK_NOT_FOUND)

  // 5. BLOCK_TYPE_MISMATCH
  assert.equal(
    (await galleyEditBlock(deps, {
      packetId: id, sheetId: 's1', op: 'insert', origin: 'agent', block: { type: 'banana', body: 'x' },
    })).code,
    Err.BLOCK_TYPE_MISMATCH,
  )

  // 6. DEPENDENCY_CYCLE — patch an AGENT block so the edge is actually written.
  const c = await openPacket([{ type: 'prose', body: 'x' }])
  await galleyEditBlock(deps, {
    packetId: c.packetId, sheetId: 's1', op: 'insert', origin: 'agent', block: { type: 'prose', body: 'y' },
  }) // b2 (agent)
  await galleyEditBlock(deps, {
    packetId: c.packetId, sheetId: 's1', op: 'insert', origin: 'agent',
    block: { type: 'prose', body: 'z', dependsOn: [{ id: 'b2', sinceHash: 'x', at: '' }] },
  }) // b3 (agent) → b2
  const b2hash = (await store.load(c.packetId)).sheets.s1.blocks.find((b) => b.id === 'b2').hash
  assert.equal(
    (await galleyEditBlock(deps, {
      packetId: c.packetId, sheetId: 's1', op: 'patch', origin: 'agent',
      blockId: 'b2', baseHash: b2hash, patch: { dependsOn: [{ id: 'b3', sinceHash: 'x', at: '' }] },
    })).code,
    Err.DEPENDENCY_CYCLE,
  )

  // 7. ASSET_NOT_FOUND — media slot references an asset that was never staged.
  assert.equal(
    (await galleyEditBlock(deps, {
      packetId: id, sheetId: 's1', op: 'insert', origin: 'agent',
      block: { type: 'prose', body: 'x', slot: { mode: 'media-right', asset: { id: 'a1', path: 'assets/a1.png', alt: 'x' } } },
    })).code,
    Err.ASSET_NOT_FOUND,
  )

  // 8. ASSET_LIMIT_EXCEEDED — open a packet with one more than the max assets.
  const manyAssets = Array.from({ length: MAX_ASSETS_PER_PACKET + 1 }, (_, i) => ({
    id: `a${i}`, path: `assets/a${i}.png`, mimeType: 'image/png',
  }))
  assert.equal((await galleyOpen(deps, { assets: manyAssets })).code, Err.ASSET_LIMIT_EXCEEDED)

  // 9. PROPOSAL_NOT_FOUND — accept a proposal id that does not exist.
  let pnf
  try {
    store.applyProposal(id, 'prop-999')
  } catch (e) {
    pnf = e
  }
  assert.ok(pnf, 'applyProposal should throw for an unknown proposal id')
  assert.equal(pnf.code, 'proposal_not_found')
  assert.equal(mapStoreCode(pnf.code), Err.PROPOSAL_NOT_FOUND)

  // 10. PROPOSAL_CONFLICT — stale baseHash on a human-block patch (carries both hashes).
  const baseHash = (await blockAt(id, 0)).hash
  const conf = await galleyEditBlock(deps, {
    packetId: id, sheetId: 's1', op: 'patch', origin: 'agent',
    blockId: 'b1', baseHash: 'deadbeef', patch: { body: 'y' },
  })
  assert.equal(conf.code, Err.PROPOSAL_CONFLICT)
  assert.equal(conf.baseHash, 'deadbeef')
  assert.equal(conf.currentHash, baseHash)

  // 11. ANNOTATION_NOT_FOUND — resolve an unknown annotation.
  assert.equal(
    (await galleyAnnotate(deps, { packetId: id, blockId: 'b1', action: 'resolve', annotationId: 'ann-999' })).code,
    Err.ANNOTATION_NOT_FOUND,
  )

  // 12. TYPST_COMPILE_ERROR — pdf with no render arm.
  assert.equal((await galleyExport({ store }, { packetId: id, format: 'pdf' })).code, Err.TYPST_COMPILE_ERROR)

  // 13. EXPORT_FAILED — pdf with a render arm that throws a non-compile error.
  const badRender = { store, render: () => { throw new Error('render boom') } }
  assert.equal((await galleyExport(badRender, { packetId: id, format: 'pdf' })).code, Err.EXPORT_FAILED)

  // 14. INVALID_PARAMS — unknown annotate action.
  assert.equal(
    (await galleyAnnotate(deps, { packetId: id, blockId: 'b1', action: 'frobnicate' })).code,
    Err.INVALID_PARAMS,
  )
})

test('error codes: invalid slot / unknown export format are INVALID_PARAMS', async () => {
  const r = await openPacket([{ type: 'prose', body: 'x' }])
  // media-right with no asset reference is an invalid slot.
  const badSlot = await galleyEditBlock(deps, {
    packetId: r.packetId, sheetId: 's1', op: 'insert', origin: 'agent',
    block: { type: 'prose', body: 'x', slot: { mode: 'media-right' } },
  })
  assert.equal(badSlot.code, Err.INVALID_PARAMS)

  // unknown export format.
  const badFmt = await galleyExport(deps, { packetId: r.packetId, format: 'docx-9000' })
  assert.equal(badFmt.code, Err.INVALID_PARAMS)
})

test('M1.6 hardening: Inline[] + lineNumbers patch, optional baseHash, cross-sheet move/remove, arbeitsblatt scaffold + id switch', async () => {
  const ab = await galleyOpen(deps, { template: 'arbeitsblatt', title: 'Brüche' })
  assert.equal(ab.ok, true)
  assert.deepEqual(ab.sheetOrder, ['s1', 's2'])
  assert.ok(ab.proofs.s1 && ab.proofs.s2, 'arbeitsblatt open computes proofs for both s1 and s2')
  const loadedAb = store.load(ab.packetId)
  assert.equal(loadedAb.sheets.s1.geometry.targetPages, 1)
  assert.equal(loadedAb.sheets.s2.title, 'Erwartungshorizont')

  // Patching Inline[] body + lineNumbers WITHOUT baseHash works on agent blocks.
  const srcIns = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'source_text', body: 'initial' },
  })
  assert.equal(srcIns.ok, true)
  const srcId = srcIns.block.id
  const patched = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'patch',
    origin: 'agent',
    blockId: srcId,
    patch: {
      title: 'Kurztext',
      body: [{ t: 'strong', c: [{ t: 'text', v: 'Fett' }] }, { t: 'text', v: ' und klar' }],
      lineNumbers: { every: 5, start: 1 },
    },
  })
  assert.equal(patched.ok, true)
  assert.equal(patched.applied, true)
  const updatedSrc = store.load(ab.packetId).sheets.s1.blocks.find((b) => b.id === srcId)
  assert.equal(updatedSrc.title, 'Kurztext')
  assert.equal(updatedSrc.body[0].t, 'strong')
  assert.deepEqual(updatedSrc.lineNumbers, { every: 5, start: 1 })

  // Cross-sheet move: move srcId from s1 → s2 via toSheetId (without baseHash).
  const moved = await galleyEditBlock(deps, {
    sheetId: 's1',
    toSheetId: 's2',
    op: 'move',
    origin: 'agent',
    blockId: srcId,
  })
  assert.equal(moved.ok, true)
  assert.ok(!store.load(ab.packetId).sheets.s1.blocks.some((b) => b.id === srcId))
  assert.ok(store.load(ab.packetId).sheets.s2.blocks.some((b) => b.id === srcId))

  // Remove block living on s2 even if caller passed sheetId: 's1' (never corrupts s1).
  const s1CountBefore = store.load(ab.packetId).sheets.s1.blocks.length
  const removed = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'remove',
    origin: 'agent',
    blockId: srcId,
  })
  assert.equal(removed.ok, true)
  assert.equal(store.load(ab.packetId).sheets.s1.blocks.length, s1CountBefore)
  assert.ok(!store.load(ab.packetId).sheets.s2.blocks.some((b) => b.id === srcId))

  // Switch active packet via galleyOpen({ id }).
  const other = await openPacket([{ type: 'prose', body: 'other' }])
  assert.equal((await galleyStatus(deps, {})).packetId, other.packetId)
  const switched = await galleyOpen(deps, { id: ab.packetId })
  assert.equal(switched.ok, true)
  assert.equal((await galleyStatus(deps, {})).packetId, ab.packetId)
})
