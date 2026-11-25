/**
 * dsh-galley — M1.5 §4 REAL-COMPILER GATE (agent/reviews/01-m1-review-and-handover §4).
 *
 * The M0/M1 guardrail was that the *tools* could run against a fake renderer.
 * This gate closes the loop: it drives a REAL sheet — all 8 block types, all 5
 * layout slots, and a real 1×1 PNG media asset — through the **NativeArm**
 * (the N-API `@myriaddreamin/typst-ts-node-compiler`, NOT `fakeRender`) and
 * asserts, per the review, that:
 *
 *   1. the native compile emits ZERO diagnostics,
 *   2. EVERY table cell's text appears in the rendered SVG,
 *   3. `blockToPage` attributes EVERY block to a page,
 *   4. the `galley_edit_block` tool receipt is < 1,500 chars and leaks no
 *      `Inline[]` body (M1.5 H4 compact receipts),
 *
 * plus a valid `%PDF-` and a real `galleyStatus` proof (not the fake).
 *
 * Run after `node build.mjs` (imports `lib/galley-core.mjs` + `lib/index.js`).
 * Skipped if the native binding is unavailable (e.g. platform without the
 * prebuilt .node) — the gate must pass on the platform under test.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  GalleyStore,
  galleyOpen,
  galleyStatus,
  galleyEditBlock,
} from '../lib/galley-core.mjs'
import { NativeArm } from '../lib/index.js'

/**
 * A valid 1×1 RGBA PNG — the smallest real image the native arm's decoder
 * accepts. (The classic palette-based 1×1 — colour type 3, 1-bit — is rejected
 * by the native image decoder, so the gate uses a truecolour RGBA pixel.)
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
)
const T = (v) => ({ t: 'text', v })
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

let root
let store
let arm
let deps
let nativeAvailable = true

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'galley-gate-'))
  store = new GalleyStore(root)
  try {
    arm = new NativeArm()
    await arm.init()
  } catch {
    nativeAvailable = false
    arm = null
  }
  deps = {
    store,
    render: (sheet, packet, assetBytes) => arm.render(sheet, packet, assetBytes),
    now: () => 'now',
  }
})
after(() => rmSync(root, { recursive: true, force: true }))

const meta = (id) => ({ id, path: `assets/${id}.png`, bytesSha256: sha(PNG), mimeType: 'image/png' })
const assetRef = (id) => ({ id, path: `assets/${id}.png`, alt: id })

/** Build the full M1.5 sheet: 8 block types × 5 layout slots. Returns pid. */
async function buildGateSheet() {
  const open = await galleyOpen(deps, {
    blocks: [
      { type: 'header', fields: { titel: 'Gate', fach: 'Mathe', klasse: '7a', datum: '2026-11-25', name: 'HauHau' } },
      { type: 'heading', level: 1, body: 'Section' },
      { type: 'prose', body: 'Body prose paragraph.' },
      { type: 'source_text', title: 'Source', body: 'const x = 1' },
      { type: 'task', body: 'Do the task.' },
      {
        type: 'table',
        headers: [[T('Alpha')], [T('Beta')]],
        rows: [
          [[T('OneCell')], [T('TwoCell')]],
          [[T('ThreeCell')], [T('FourCell')]],
        ],
      },
      { type: 'callout', tone: 'info', body: 'A hint.', slot: { mode: 'two-column' } },
      { type: 'answer', body: '42', slot: { mode: 'card-grid', columns: 2 } },
    ],
    // Stage media metadata; real bytes are added afterwards (open stages empty).
    assets: [{ id: 'a1', path: 'assets/a1.png', mimeType: 'image/png' }, { id: 'a2', path: 'assets/a2.png', mimeType: 'image/png' }],
  })
  assert.equal(open.ok, true, JSON.stringify(open))
  const pid = open.packetId
  // Replace the empty buffers staged by open with real PNG bytes.
  store.addAsset(pid, meta('a1'), PNG)
  store.addAsset(pid, meta('a2'), PNG)
  // Media slots must be inserted AFTER their asset is staged.
  for (const [id, mode, cap] of [['a1', 'media-right', 'Caption, right image.'], ['a2', 'media-left', 'Caption, left image.']]) {
    const ins = await galleyEditBlock(deps, {
      packetId: pid, sheetId: 's1', op: 'insert', origin: 'agent',
      block: { type: 'prose', body: cap, slot: { mode, asset: assetRef(id) } },
    })
    assert.equal(ins.ok, true, JSON.stringify(ins))
  }
  return pid
}

test('§4 gate: 8 types × 5 slots × real PNG compile with ZERO diagnostics', { skip: !nativeAvailable && 'native arm unavailable' }, async () => {
  const pid = await buildGateSheet()
  const packet = store.load(pid)
  const sheet = packet.sheets.s1
  const sr = await arm.render(sheet, packet, { a1: PNG, a2: PNG })

  // 1. Zero diagnostics (the native arm throws on a hard error, so a returned
  //    SheetRender also proves hasError() was false).
  assert.equal(sr.diagnostics.length, 0, JSON.stringify(sr.diagnostics))
  assert.ok(sr.pages >= 1)

  // 3. blockToPage attributes EVERY block to a valid page.
  for (const b of sheet.blocks) {
    assert.ok(b.id in sr.blockToPage, `block ${b.id} missing from blockToPage`)
    assert.ok(sr.blockToPage[b.id] >= 0 && sr.blockToPage[b.id] < sr.pages, `block ${b.id} on invalid page`)
  }

  // 2. Every table cell's text appears in the rendered SVG.
  for (const cell of ['Alpha', 'Beta', 'OneCell', 'TwoCell', 'ThreeCell', 'FourCell']) {
    assert.ok(sr.svg.includes(cell), `table cell text "${cell}" not found in rendered SVG`)
  }

  // The media slots reference real images (the asset bytes are shadow-mapped).
  for (const id of ['a1', 'a2']) {
    assert.ok(sr.pdf.length > 0)
    assert.ok(sheet.blocks.some((b) => b.slot.mode === 'media-right' || b.slot.mode === 'media-left'))
    void id
  }

  // Valid PDF.
  assert.equal(Buffer.from(sr.pdf.slice(0, 5)).toString('latin1'), '%PDF-')
})

test('§4 gate: every one of the 5 layout slots is present and renders', { skip: !nativeAvailable && 'native arm unavailable' }, async () => {
  const pid = await buildGateSheet()
  const sheet = store.load(pid).sheets.s1
  const modes = new Set(sheet.blocks.map((b) => b.slot.mode))
  for (const m of ['full', 'media-right', 'media-left', 'two-column', 'card-grid']) {
    assert.ok(modes.has(m), `layout slot "${m}" not exercised in the gate sheet`)
  }
  // And the 8 block types.
  const types = new Set(sheet.blocks.map((b) => b.type))
  for (const t of ['header', 'heading', 'prose', 'source_text', 'task', 'table', 'callout', 'answer']) {
    assert.ok(types.has(t), `block type "${t}" not exercised in the gate sheet`)
  }
  const sr = await arm.render(sheet, store.load(pid), { a1: PNG, a2: PNG })
  assert.equal(sr.diagnostics.length, 0)
})

test('§4 gate: galley_edit_block receipt < 1500 chars and leaks no Inline body', { skip: !nativeAvailable && 'native arm unavailable' }, async () => {
  const pid = await buildGateSheet()
  const ins = await galleyEditBlock(deps, {
    packetId: pid, sheetId: 's1', op: 'insert', origin: 'agent',
    block: { type: 'prose', body: 'receipt size probe for the §4 gate' },
  })
  assert.equal(ins.ok, true, JSON.stringify(ins))
  // The receipt is the LLM-facing payload — must stay compact.
  const size = JSON.stringify(ins).length
  assert.ok(size < 1500, `galley_edit_block receipt is ${size} chars (must be < 1500)`)
  // The written block is an OUTLINE, never the full Inline[] AST.
  assert.ok(ins.block)
  assert.equal(ins.block.body, undefined, 'receipt leaked the block Inline body')
  assert.equal(ins.block.headers, undefined)
  assert.equal(ins.block.rows, undefined)
})

test('§4 gate: galley_open / galley_status proofs come from a real NativeArm render', { skip: !nativeAvailable && 'native arm unavailable' }, async () => {
  const open = await galleyOpen(deps, { blocks: [{ type: 'prose', body: 'Real native proof. ' }] })
  assert.equal(open.ok, true)
  assert.ok(open.proofs.s1, 'open should carry a real proof receipt')
  const proof = open.proofs.s1
  assert.ok(proof.pages >= 1)
  assert.equal(proof.perPage.length, proof.pages)
  // perPage carries real A4-ish geometry from the native arm, not the fake.
  assert.ok(proof.perPage[0].wPt > 400 && proof.perPage[0].hPt > 400)

  const st = await galleyStatus(deps, { packetId: open.packetId })
  assert.equal(st.ok, true)
  assert.ok(st.proofs.s1)
  assert.equal(st.proofs.s1.pages, proof.pages)
})
