/**
 * dsh-galley — M2 routes, SVG page splitter, inlineMarkup & pane-model gate.
 *
 * Drives the real `createGalleyHttpDispatcher` over `node:http` backed by the
 * real `NativeArm`, verifying Spec 02 §5 (200/304/409/404), Spec 04 (pane
 * polling, width split, UTF-8 SVG data-URIs, dirty-buffer conflict protection,
 * overflow banner, media upload), and multi-workspace `?cwd=` isolation.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  createGalleyHttpDispatcher,
  getStoreForCwd,
  _resetGalleyWorkspaceForTests,
  serializeInlines,
  parseInlines,
  Err,
} from '../lib/galley-core.mjs'
import {
  computePaneMode,
  nextPollDelayMs,
  decodeSvgDataUri,
  formatOverflowBanner,
  blockToDraftBuffer,
  reconcileDraftBuffer,
  draftBufferToPatch,
} from '../lib/galley-pane.mjs'
import { NativeArm } from '../lib/index.js'

/** Minimal valid 1×1 truecolour RGBA PNG (accepted by Typst 0.14.2 image decoder). */
function make1x1RgbaPng() {
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td), 0)
    return Buffer.concat([len, td, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = deflateSync(Buffer.from([0, 30, 144, 255, 255]))
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))])
}

const PNG_B64 = make1x1RgbaPng().toString('base64')

let arm
let server
let baseUrl
let wsA
let wsB

before(async () => {
  _resetGalleyWorkspaceForTests()
  wsA = mkdtempSync(join(tmpdir(), 'galley-m2-wsA-'))
  wsB = mkdtempSync(join(tmpdir(), 'galley-m2-wsB-'))
  arm = new NativeArm()
  await arm.init()

  const dispatch = createGalleyHttpDispatcher({
    async getDepsForCwd(cwdParam) {
      const { store, root, cwd } = getStoreForCwd(cwdParam ?? wsA)
      return {
        root,
        cwd,
        deps: {
          store,
          render: (sheet, packet, assetBytes) => arm.render(sheet, packet, assetBytes),
        },
      }
    },
  })

  server = createServer((req, res) => {
    dispatch(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  _resetGalleyWorkspaceForTests()
  rmSync(wsA, { recursive: true, force: true })
  rmSync(wsB, { recursive: true, force: true })
})

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  return { status: res.status, json }
}

test('inlineMarkup: lossless round-trip across all 7 Inline variants + total on unmatched punctuation', () => {
  const ast = [
    { t: 'text', v: 'Berechne ' },
    { t: 'strong', c: [{ t: 'text', v: 'Aufgabe ' }, { t: 'emph', c: [{ t: 'text', v: 'eins' }] }] },
    { t: 'text', v: ' mit ' },
    { t: 'code', v: 'fn(x)' },
    { t: 'text', v: ' und ' },
    { t: 'math', v: 'a^2 + b^2 = c^2' },
    { t: 'newline' },
    { t: 'text', v: 'Ergebnis: ' },
    { t: 'cloze', hint: '42' },
    { t: 'text', v: ' (Literal * $ { ` \\ Ende)' },
  ]
  const text = serializeInlines(ast)
  const reparsed = parseInlines(text)
  assert.deepEqual(reparsed, ast)

  // Unmatched delimiters never throw — preserved as plain text.
  const broken = parseInlines('Offener *Stern und {{halbe Lücke und $offenes Math')
  assert.equal(broken.length, 1)
  assert.equal(broken[0].t, 'text')
  assert.match(broken[0].v, /\*Stern/)
})

test('paneModel: responsive width threshold, poll delays, UTF-8 SVG decode & dirty-buffer conflict guard', () => {
  assert.equal(computePaneMode(360, 'auto'), 'narrow')
  assert.equal(computePaneMode(479, 'auto'), 'narrow')
  assert.equal(computePaneMode(480, 'auto'), 'wide')
  assert.equal(computePaneMode(320, 'wide'), 'wide')
  assert.equal(computePaneMode(700, 'narrow'), 'narrow')

  assert.equal(nextPollDelayMs({ hidden: true, hadError: false, postMutation: true, revAdvanced: true }), 10000)
  assert.equal(nextPollDelayMs({ hidden: false, hadError: true, postMutation: false, revAdvanced: false }), 2000)
  assert.equal(nextPollDelayMs({ hidden: false, hadError: false, postMutation: false, revAdvanced: true }), 150)
  assert.equal(nextPollDelayMs({ hidden: false, hadError: false, postMutation: true, revAdvanced: false }), 1000)
  assert.equal(nextPollDelayMs({ hidden: false, hadError: false, postMutation: false, revAdvanced: false }), 2000)

  const umlautSvg = '<svg class="typst-doc"><text>Übungsblatt · Größe ÄÖÜß</text></svg>'
  const uri = `data:image/svg+xml;base64,${Buffer.from(umlautSvg, 'utf8').toString('base64')}`
  assert.equal(decodeSvgDataUri(uri), umlautSvg)

  // Dirty-buffer conflict state machine (Spec 04 §4.4):
  const blockV1 = {
    id: 'b1',
    type: 'prose',
    hash: 'hash-v1',
    dependsOn: [],
    slot: { mode: 'full' },
    origin: 'human',
    updatedAt: '',
    body: [{ t: 'text', v: 'Original' }],
  }
  let draft = blockToDraftBuffer(blockV1)
  assert.equal(draft.dirty, false)

  // Clean buffer adopts server update
  const blockV2 = { ...blockV1, hash: 'hash-v2', body: [{ t: 'text', v: 'Server v2' }] }
  draft = reconcileDraftBuffer(draft, blockV2)
  assert.equal(draft.markup, 'Server v2')
  assert.equal(draft.baseHash, 'hash-v2')

  // User starts typing locally (dirty = true)
  draft = { ...draft, markup: 'Lokaler Entwurf **wichtig**', dirty: true }
  // Poll brings same baseHash -> dirty buffer kept, no conflict
  draft = reconcileDraftBuffer(draft, blockV2)
  assert.equal(draft.conflict, false)
  assert.equal(draft.markup, 'Lokaler Entwurf **wichtig**')

  // Poll brings a changed remote hash -> conflict flagged, local typing NOT clobbered!
  const blockV3 = { ...blockV1, hash: 'hash-v3', body: [{ t: 'text', v: 'Concurrent agent write' }] }
  draft = reconcileDraftBuffer(draft, blockV3)
  assert.equal(draft.conflict, true)
  assert.equal(draft.remoteHash, 'hash-v3')
  assert.equal(draft.markup, 'Lokaler Entwurf **wichtig**')

  const patch = draftBufferToPatch(draft)
  assert.equal(patch.body[1].t, 'strong')
})

test('HTTP routes: empty state -> open arbeitsblatt -> 200 state + 304 on unchanged rev', async () => {
  const emptyRes = await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}`)
  assert.equal(emptyRes.status, 200)
  const empty = await emptyRes.json()
  assert.equal(empty.activePacket, false)
  assert.equal(empty.rev, 0)

  // Open Arbeitsblatt from the pane
  const opened = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'open',
    template: 'arbeitsblatt',
    title: 'Brüche: Addieren',
  })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.ok, true)
  assert.deepEqual(opened.json.sheetOrder, ['s1', 's2'])

  // Poll state (no rev) -> 200 with sheets + SVG proofs
  const stRes = await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}`)
  assert.equal(stRes.status, 200)
  const st = await stRes.json()
  assert.equal(st.activePacket, true)
  assert.equal(st.rev, 1)
  assert.equal(st.sheets.length, 2)
  assert.equal(st.proofs.length, 2)
  assert.equal(st.proofs[0].pages, 1)
  assert.equal(st.proofs[0].svgPages.length, 1)
  const svg0 = decodeSvgDataUri(st.proofs[0].svgPages[0])
  assert.match(svg0, /^<svg\b[^>]*class="typst-doc"/)
  // Verify CSS scoping: unscoped `svg {` must not appear
  assert.doesNotMatch(svg0, /(^|\}|\s)svg\s*\{/)

  // Poll with matching rev=1 -> 304 Not Modified (zero body!)
  const notMod = await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}&rev=${st.rev}`)
  assert.equal(notMod.status, 304)
  assert.equal((await notMod.text()).length, 0)
})

test('HTTP routes: human patch applies directly (marks dependent stale) + overflow strip + per-page isolated SVGs', async () => {
  // Spec 04 §8: invalid Typst math surfaces as sheet compileError without crashing /state
  await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'patch',
    sheetId: 's1',
    blockId: 'b2',
    source: 'human',
    patch: { body: parseInlines('Kaputtes Math $unclosed($') },
  })
  const errState = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}`)).json()
  assert.ok(errState.proofs.find((p) => p.sheetId === 's1').compileError, 'invalid Typst math must populate compileError')

  // In arbeitsblatt template, b4 (answer on s2) dependsOn b2 (task on s1).
  // Human edits b2 with valid Typst math -> applies directly and marks b4 stale!
  const patchRes = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'patch',
    sheetId: 's1',
    blockId: 'b2',
    source: 'human',
    patch: { body: parseInlines('Berechne $1/2 + 1/3$ vollständig.') },
  })
  assert.equal(patchRes.status, 200)
  assert.equal(patchRes.json.applied, true)
  assert.equal(patchRes.json.proposal, null)
  assert.ok(patchRes.json.staleDependents.includes('b4'), 'answer b4 must turn stale when task b2 changes')

  // Force overflow on s1 (targetPages = 1) by inserting a long source_text with lineNumbers
  const longLines = Array.from({ length: 65 }, (_, i) => `Zeile ${i + 1}: Historischer Quellentext zur Analyse im Unterricht.`).join('\n')
  const insRes = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'insert',
    sheetId: 's1',
    afterBlockId: 'b1',
    block: {
      type: 'source_text',
      title: 'Quelle A',
      lineNumbers: { every: 5, start: 1 },
      body: parseInlines(longLines),
    },
  })
  assert.equal(insRes.status, 200)

  const st = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}`)).json()
  const s1Proof = st.proofs.find((p) => p.sheetId === 's1')
  assert.ok(s1Proof.pages >= 2, `expected ≥2 pages on overflow, got ${s1Proof.pages}`)
  assert.equal(s1Proof.svgPages.length, s1Proof.pages)
  assert.ok(s1Proof.overflowLinesOnLastPage > 0, 'overflowLinesOnLastPage must be > 0 when pages > targetPages (1)')
  assert.match(formatOverflowBanner(s1Proof.overflowLinesOnLastPage, 1), /^\+\d+ Zeilen über 1 Seite$/)

  // Verify each split SVG page is reset to translate(0, 0) and has non-colliding IDs across pages!
  const p1Svg = decodeSvgDataUri(s1Proof.svgPages[0])
  const p2Svg = decodeSvgDataUri(s1Proof.svgPages[1])
  assert.match(p1Svg, /class="typst-page"[^>]*transform="translate\(0,\s*0\)"/)
  assert.match(p2Svg, /class="typst-page"[^>]*transform="translate\(0,\s*0\)"/)
  const collectIds = (s) => [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  const ids1 = new Set(collectIds(p1Svg))
  const ids2 = collectIds(p2Svg)
  assert.ok(ids1.size > 0 && ids2.length > 0)
  for (const id of ids2) {
    assert.equal(ids1.has(id), false, `SVG id '${id}' collided between page 1 and page 2`)
  }
})

test('HTTP routes: media insert-asset + card-grid slot + proposal 409/accept + undo/redo + export + cwd isolation', async () => {
  // 1. Insert a card-grid task block
  const cardRes = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'insert',
    sheetId: 's1',
    block: {
      type: 'task',
      body: [{ t: 'text', v: 'Ordne die Paare zu.\nKarte A\nKarte B\nKarte C' }],
      slot: { mode: 'card-grid', columns: 3, cardHeightCm: 5 },
    },
  })
  assert.equal(cardRes.status, 200)
  const cardId = cardRes.json.block.id

  // 2. Upload real RGBA PNG via insert-asset onto b2 (media-right)
  const assetRes = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'insert-asset',
    blockId: 'b2',
    slotMode: 'media-right',
    mimeType: 'image/png',
    dataBase64: `data:image/png;base64,${PNG_B64}`,
    alt: 'Skizze',
  })
  assert.equal(assetRes.status, 200)
  assert.equal(assetRes.json.asset.id, 'a1')

  const stWithImg = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}`)).json()
  const s1SvgsJoined = stWithImg.proofs.find((p) => p.sheetId === 's1').svgPages.map(decodeSvgDataUri).join('\n')
  assert.match(s1SvgsJoined, /<image\b/, 'rendered SVG proof must embed the uploaded PNG image')

  // 3. Agent patch on human-origin block b2 -> stages pending proposal (rev bumps!)
  const prevRev = stWithImg.rev
  const agentProp = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'patch',
    sheetId: 's1',
    blockId: 'b2',
    source: 'agent',
    patch: { body: [{ t: 'text', v: 'Agent-Formulierung' }] },
  })
  assert.equal(agentProp.status, 200)
  assert.equal(agentProp.json.applied, false)
  const propId = agentProp.json.proposal.id

  // Polling with prevRev must NOT 304 because addProposal bumped rev!
  const afterPropRes = await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsA)}&rev=${prevRev}`)
  assert.equal(afterPropRes.status, 200)
  const afterProp = await afterPropRes.json()
  const staged = afterProp.sheets[0].proposals.find((p) => p.id === propId)
  assert.ok(staged)
  assert.ok(staged.beforePatch.body)

  // Human edits b2 meanwhile -> accepting propId now conflicts with 409 & marks 'conflicted'!
  await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'patch',
    sheetId: 's1',
    blockId: 'b2',
    source: 'human',
    patch: { body: [{ t: 'text', v: 'Zwischenzeitliche Lehrer-Änderung' }] },
  })
  const conflictDecide = await postJson(`/api/galley/proposal/${propId}/decide`, {
    cwd: wsA,
    action: 'accept',
  })
  assert.equal(conflictDecide.status, 409)
  assert.equal(conflictDecide.json.code, Err.PROPOSAL_CONFLICT)

  // Second agent proposal accepted cleanly -> 200, origin stays 'human' (settled)
  const prop2 = await postJson('/api/galley/edit', {
    cwd: wsA,
    op: 'patch',
    sheetId: 's1',
    blockId: 'b2',
    source: 'agent',
    patch: { body: [{ t: 'text', v: 'Angenommener Vorschlag' }] },
  })
  const okDecide = await postJson(`/api/galley/proposal/${prop2.json.proposal.id}/decide`, {
    cwd: wsA,
    action: 'accept',
  })
  assert.equal(okDecide.status, 200)
  assert.equal(okDecide.json.block.origin, 'human')

  // 4. Undo + Redo over HTTP advance rev monotonically
  const undoRes = await postJson('/api/galley/edit', { cwd: wsA, op: 'undo' })
  assert.equal(undoRes.status, 200)
  assert.ok(undoRes.json.rev > okDecide.json.rev)
  const redoRes = await postJson('/api/galley/edit', { cwd: wsA, op: 'redo' })
  assert.equal(redoRes.status, 200)
  assert.equal(redoRes.json.rev, undoRes.json.rev + 1)

  // 5. Export PDF writes real %PDF- deliverables under <cwd>/galley-exports/
  const expRes = await postJson('/api/galley/export', { cwd: wsA, format: 'pdf' })
  assert.equal(expRes.status, 200)
  assert.equal(expRes.json.files.length, 2)
  for (const f of expRes.json.files) {
    const abs = join(wsA, f.path)
    assert.ok(existsSync(abs), `missing exported file ${abs}`)
    assert.equal(readFileSync(abs).subarray(0, 5).toString('latin1'), '%PDF-')
  }

  // 6. Second workspace wsB is completely isolated (no active packet)
  const wsBState = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(wsB)}`)).json()
  assert.equal(wsBState.activePacket, false)
  assert.equal(wsBState.packets.length, 0)
  assert.ok(cardId)
})
