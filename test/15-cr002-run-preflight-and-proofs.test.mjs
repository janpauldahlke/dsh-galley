/**
 * CR-002 — expose `ctx.galley.runPreflight` + symmetric `proofs` on single-op
 * `galley_edit_block` receipts (`dsh-galley@0.2.5`).
 *
 * Hermetic: fake renderer, no typst binary, no network.
 *   1. Cordis `toCordisService().runPreflight` runs built-in checks
 *      (`GALLEY_STALE_BLOCK`, `GALLEY_PAGE_OVERFLOW`) and registered
 *      `registerPreflight` hooks synchronously.
 *   2. Single-op `galley_edit_block` (`insert` / `patch`, direct + proposal)
 *      returns `res.proofs[res.sheetId] === res.proof`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyServiceRegistry,
  GalleyStore,
  galleyEditBlock,
  galleyOpen,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import { VERSION } from '../lib/index.js'

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

let workspaceDir
let store
let deps

before(() => {
  _resetGalleyWorkspaceForTests()
  workspaceDir = mkdtempSync(join(tmpdir(), 'galley-cr002-'))
  store = new GalleyStore(join(workspaceDir, '.dsh', 'galley'))
  deps = { store, cwd: workspaceDir, render: fakeRender }
})

after(() => {
  _resetGalleyWorkspaceForTests()
  rmSync(workspaceDir, { recursive: true, force: true })
})

test('CR-002: VERSION is 0.2.5', () => {
  assert.equal(VERSION, '0.2.5')
})

test('CR-002.1: ctx.galley.runPreflight runs built-ins + registered hooks', () => {
  const registry = new GalleyServiceRegistry()
  const cordis = registry.toCordisService()
  assert.equal(typeof cordis.runPreflight, 'function')

  const dispose = cordis.registerPreflight('companion-hook', (packet) => [
    {
      code: 'COMPANION_PROBE',
      severity: 'info',
      sheetId: packet.sheetOrder[0],
      message: 'companion preflight fired',
    },
  ])

  const packet = {
    id: 'p-cr002',
    rev: 1,
    title: 'CR-002',
    locale: 'en',
    sheetOrder: ['s1'],
    sheets: {
      s1: {
        id: 's1',
        title: 'Sheet',
        geometry: {
          paper: 'a4',
          orientation: 'portrait',
          margin: { top: 2, right: 2, bottom: 2, left: 2 },
          targetPages: 1,
        },
        blocks: [
          {
            id: 'b1',
            type: 'prose',
            hash: 'abc',
            dependsOn: [],
            slot: { mode: 'full' },
            origin: 'human',
            updatedAt: '',
            body: [{ t: 'text', v: 'x' }],
            stale: { state: 'stale_dependency', origin: 'b0', sinceHash: 'old' },
          },
        ],
      },
    },
    assets: {},
    reviewMode: 'auto',
    createdAt: '',
    updatedAt: '',
  }

  const warnings = cordis.runPreflight(
    packet,
    { s1: { overflowLinesOnLastPage: 4 } },
    workspaceDir,
  )

  assert.ok(warnings.some((w) => w.code === 'GALLEY_STALE_BLOCK' && w.blockId === 'b1'))
  assert.ok(warnings.some((w) => w.code === 'GALLEY_PAGE_OVERFLOW' && w.sheetId === 's1'))
  assert.ok(warnings.some((w) => w.code === 'COMPANION_PROBE'))

  dispose()
  const afterDispose = cordis.runPreflight(packet, { s1: { overflowLinesOnLastPage: 4 } }, workspaceDir)
  assert.equal(afterDispose.some((w) => w.code === 'COMPANION_PROBE'), false)
})

test('CR-002.2: single-op galley_edit_block returns proofs[sheetId] === proof', async () => {
  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'CR-002 proofs',
    blocks: [{ type: 'prose', body: 'seed' }],
  })
  assert.equal(opened.ok, true)

  const ins = await galleyEditBlock(deps, {
    packetId: opened.packetId,
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'prose', body: 'inserted' },
  })
  assert.equal(ins.ok, true)
  assert.equal(ins.applied, true)
  assert.ok(ins.proof)
  assert.ok(ins.proofs)
  assert.equal(ins.proofs[ins.sheetId], ins.proof)

  const patched = await galleyEditBlock(deps, {
    packetId: opened.packetId,
    sheetId: 's1',
    op: 'patch',
    origin: 'agent',
    blockId: ins.block.id,
    patch: { body: 'patched body' },
  })
  assert.equal(patched.ok, true)
  assert.equal(patched.applied, true)
  assert.ok(patched.proof)
  assert.ok(patched.proofs)
  assert.equal(patched.proofs[patched.sheetId], patched.proof)

  // Proposal path (reviewMode) must also carry symmetric proofs.
  store.setReviewMode(opened.packetId, 'review', 'human')
  const prop = await galleyEditBlock(deps, {
    packetId: opened.packetId,
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'prose', body: 'proposed' },
  })
  assert.equal(prop.ok, true)
  assert.equal(prop.applied, false)
  assert.ok(prop.proposal)
  assert.ok(prop.proofs)
  assert.equal(prop.proofs[prop.sheetId], prop.proof)
})
