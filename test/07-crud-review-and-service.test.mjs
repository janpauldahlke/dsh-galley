/**
 * dsh-galley — M2.5 gate: conflict safety (409 draft preservation + settled
 * human ownership), ReviewMode 4-op proposal gate + Accept-All, Mappe/Sheet/
 * Template CRUD, Landscape A4 proof, optional sheetId, /api/galley/download
 * with path-traversal guard, and the `ctx.galley` Cordis service face.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGalleyHttpDispatcher,
  getStoreForCwd,
  GalleyServiceRegistry,
  _resetGalleyWorkspaceForTests,
  Err,
} from '../lib/galley-core.mjs'
import {
  blockToDraftBuffer,
  applyCommitOutcome,
  reconcileDraftBuffer,
  decodeSvgDataUri,
} from '../lib/galley-pane.mjs'
import { NativeArm, apply as applyHostPlugin } from '../lib/index.js'

let arm
let registry
let server
let baseUrl
let ws

before(async () => {
  _resetGalleyWorkspaceForTests()
  ws = mkdtempSync(join(tmpdir(), 'galley-m25-'))
  arm = new NativeArm()
  await arm.init()
  registry = new GalleyServiceRegistry()

  const dispatch = createGalleyHttpDispatcher({
    registry,
    async getDepsForCwd(cwdParam) {
      const { store, root, cwd } = getStoreForCwd(cwdParam ?? ws)
      return {
        root,
        cwd,
        deps: {
          store,
          cwd,
          registry,
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
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  _resetGalleyWorkspaceForTests()
  rmSync(ws, { recursive: true, force: true })
})

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: ws, ...body }),
  })
  const json = await res.json()
  return { status: res.status, json }
}

test('409 commit race safety: applyCommitOutcome preserves dirty human draft across immediate server poll', () => {
  const initialBlock = {
    id: 'b1',
    type: 'prose',
    hash: 'h-v1',
    dependsOn: [],
    slot: { mode: 'full' },
    origin: 'human',
    updatedAt: '',
    body: [{ t: 'text', v: 'Initial' }],
  }

  let draft = blockToDraftBuffer(initialBlock)
  draft = { ...draft, markup: 'Wichtige Lehrer-Eingabe kurz vor Blur', dirty: true }

  // Server returned 409 because agent changed block concurrently:
  draft = applyCommitOutcome(draft, { ok: false, status: 409 })
  assert.equal(draft.dirty, true, '409 must NEVER clear dirty flag')
  assert.equal(draft.conflict, true)

  // Immediate poll brings remote hash h-v2: draft text MUST survive untouched!
  const remoteBlock = { ...initialBlock, hash: 'h-v2', body: [{ t: 'text', v: 'Agent text' }] }
  draft = reconcileDraftBuffer(draft, remoteBlock)
  assert.equal(draft.dirty, true)
  assert.equal(draft.conflict, true)
  assert.equal(draft.markup, 'Wichtige Lehrer-Eingabe kurz vor Blur')

  // Subsequent explicit Keep-Mine commit (200 OK) clears dirty & conflict
  draft = applyCommitOutcome(draft, { ok: true, status: 200 })
  assert.equal(draft.dirty, false)
  assert.equal(draft.conflict, false)
})

test('ownership safety + ReviewMode 4-op proposal gate + optional sheetId + Accept-All', async () => {
  const opened = await postJson('/api/galley/edit', {
    op: 'open',
    template: 'generic',
    title: 'Review Gate Test',
    blocks: [
      { type: 'prose', body: 'Absatz Eins' },
      { type: 'prose', body: 'Absatz Zwei' },
    ],
  })
  assert.equal(opened.status, 200)

  // 1. Accepting an agent proposal on human block b1 keeps origin === 'human',
  //    so a second agent patch in 'auto' mode STILL stages a proposal!
  const p1 = await postJson('/api/galley/edit', {
    op: 'patch',
    // omit sheetId -> optional sheetId resolution!
    blockId: 'b1',
    source: 'agent',
    patch: { body: 'Lektorat-Vorschlag 1' },
  })
  assert.equal(p1.status, 200)
  assert.equal(p1.json.applied, false)

  const acc1 = await postJson(`/api/galley/proposal/${p1.json.proposal.id}/decide`, { action: 'accept' })
  assert.equal(acc1.status, 200)
  assert.equal(acc1.json.block.origin, 'human', 'accepted block must remain human-settled')

  const p2 = await postJson('/api/galley/edit', {
    op: 'patch',
    blockId: 'b1',
    source: 'agent',
    patch: { body: 'Unguarded follow-up attempt' },
  })
  assert.equal(p2.json.applied, false, 'settled block must NOT be silently overwritten on follow-up agent patch')
  await postJson(`/api/galley/proposal/${p2.json.proposal.id}/decide`, { action: 'revert' })

  // 2. Enable packet-level ReviewMode ('review') -> ALL 4 agent ops stage proposals!
  const modeRes = await postJson('/api/galley/edit', {
    op: 'packet-set-review-mode',
    reviewMode: 'review',
  })
  assert.equal(modeRes.status, 200)
  assert.equal(modeRes.json.reviewMode, 'review')

  // Agent insert (without sheetId!) -> proposal
  const insProp = await postJson('/api/galley/edit', {
    op: 'insert',
    source: 'agent',
    block: { type: 'callout', tone: 'hint', body: 'Neuer Hinweis durch Agent' },
  })
  assert.equal(insProp.status, 200)
  assert.equal(insProp.json.applied, false)
  assert.equal(insProp.json.proposal.op, 'insert')

  // Agent move (without sheetId!) -> proposal
  const moveProp = await postJson('/api/galley/edit', {
    op: 'move',
    blockId: 'b2',
    toBeforeId: 'b1',
    source: 'agent',
  })
  assert.equal(moveProp.status, 200)
  assert.equal(moveProp.json.applied, false)
  assert.equal(moveProp.json.proposal.op, 'move')

  // Verify state lists both pending proposals (including the insert proposal on s1!)
  const stBefore = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.equal(stBefore.reviewMode, 'review')
  const pendingIds = stBefore.sheets[0].proposals.filter((p) => p.status === 'pending').map((p) => p.id)
  assert.equal(pendingIds.length, 2)

  // Accept-All applies both proposals cleanly!
  const acceptAll = await postJson('/api/galley/proposal/_all/decide', { action: 'accept-all' })
  assert.equal(acceptAll.status, 200)
  assert.equal(acceptAll.json.accepted.length, 2)
  assert.equal(acceptAll.json.conflicted.length, 0)

  const stAfter = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  const blockIds = stAfter.sheets[0].blocks.map((b) => b.id)
  assert.equal(blockIds[0], 'b2', 'move proposal applied')
  assert.equal(blockIds.length, 3, 'insert proposal applied')

  // Agent remove in Review mode -> proposal, then accept removes b2
  const remProp = await postJson('/api/galley/edit', {
    op: 'remove',
    blockId: 'b2',
    source: 'agent',
  })
  assert.equal(remProp.json.applied, false)
  assert.equal(remProp.json.proposal.op, 'remove')
  const remAcc = await postJson(`/api/galley/proposal/${remProp.json.proposal.id}/decide`, { action: 'accept' })
  assert.equal(remAcc.status, 200)
  const stAfterRem = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.equal(stAfterRem.sheets[0].blocks.some((b) => b.id === 'b2'), false)
})

test('Mappe CRUD, Sheet CRUD, Landscape A4 orientation & Save-as-Template round-trip', async () => {
  // Rename active Mappe
  const ren = await postJson('/api/galley/edit', { op: 'packet-rename', title: 'Unterrichtsentwurf Physik' })
  assert.equal(ren.status, 200)
  assert.equal(ren.json.title, 'Unterrichtsentwurf Physik')

  // Add a second sheet in Landscape orientation
  const addedSh = await postJson('/api/galley/edit', {
    op: 'sheet-add',
    title: 'Verlaufsplan Querformat',
    orientation: 'landscape',
  })
  assert.equal(addedSh.status, 200)
  const s2Id = addedSh.json.sheetId
  await postJson('/api/galley/edit', {
    op: 'insert',
    sheetId: s2Id,
    block: {
      type: 'table',
      headers: [[{ t: 'text', v: 'Phase' }], [{ t: 'text', v: 'Zeit' }], [{ t: 'text', v: 'Inhalt' }]],
      rows: [[[{ t: 'text', v: 'Einstieg' }], [{ t: 'text', v: '10 min' }], [{ t: 'text', v: 'Experiment' }]]],
    },
  })

  // Verify NativeArm compiled s2 in true Landscape A4 (wPt ~ 842 > hPt ~ 595)!
  const st = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  const s2Proof = st.proofs.find((p) => p.sheetId === s2Id)
  assert.ok(s2Proof.perPage[0].wPt > 800 && s2Proof.perPage[0].hPt < 620, 'landscape A4 must swap width and height')
  const svgLandscape = decodeSvgDataUri(s2Proof.svgPages[0])
  assert.match(svgLandscape, /viewBox="0 0 842(\.0+)? 596(\.0+)?"/)

  // Save current Mappe structure as reusable workspace Template
  const savedTpl = await postJson('/api/galley/edit', {
    op: 'template-save',
    title: 'Physik Verlaufsplan',
  })
  assert.equal(savedTpl.status, 200)
  const tplId = savedTpl.json.template.id
  assert.ok(savedTpl.json.templates.some((t) => t.id === tplId && t.source === 'workspace'))

  // Open a brand-new Mappe from that saved Template -> inherits both sheets + Landscape geometry!
  const fromTpl = await postJson('/api/galley/edit', {
    op: 'open',
    template: tplId,
    title: 'Optik Stunde 1',
  })
  assert.equal(fromTpl.status, 200)
  assert.equal(fromTpl.json.sheetOrder.length, 2)
  assert.ok(fromTpl.json.proofs[s2Id].perPage[0].wPt > 800)

  // Duplicate & Delete Mappe
  const dup = await postJson('/api/galley/edit', { op: 'packet-duplicate' })
  assert.equal(dup.status, 200)
  assert.match(dup.json.title, /\(Kopie\)$/)

  const del = await postJson('/api/galley/edit', { op: 'packet-delete', packetId: dup.json.packetId })
  assert.equal(del.status, 200)
  assert.equal(del.json.activePacketId, fromTpl.json.packetId, 'deleting active packet falls back to next packet')

  // Sheet rename + remove + Undo restores deleted sheet!
  await postJson('/api/galley/edit', { op: 'sheet-rename', sheetId: s2Id, title: 'Tafelbild' })
  await postJson('/api/galley/edit', { op: 'sheet-remove', sheetId: s2Id })
  let st1 = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.equal(st1.sheetOrder.length, 1)

  await postJson('/api/galley/edit', { op: 'undo' })
  st1 = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.equal(st1.sheetOrder.length, 2, 'undo must restore deleted sheet')
  assert.equal(st1.sheets.find((s) => s.id === s2Id).title, 'Tafelbild')
})

test('Download route + path-traversal guard + ctx.galley Cordis service (templates + preflight)', async () => {
  // 1. Export PDF and fetch via /api/galley/download
  const exp = await postJson('/api/galley/export', { format: 'pdf' })
  assert.equal(exp.status, 200)
  assert.ok(exp.json.files.length >= 1)
  const relPath = exp.json.files[0].path

  const dlRes = await fetch(
    `${baseUrl}/api/galley/download?cwd=${encodeURIComponent(ws)}&path=${encodeURIComponent(relPath)}`,
  )
  assert.equal(dlRes.status, 200)
  assert.equal(dlRes.headers.get('content-type'), 'application/pdf')
  assert.match(dlRes.headers.get('content-disposition') ?? '', /^attachment; filename=/)
  const pdfBuf = Buffer.from(await dlRes.arrayBuffer())
  assert.equal(pdfBuf.subarray(0, 5).toString('latin1'), '%PDF-')

  // Path-traversal attempts MUST be rejected with 400!
  for (const traversal of ['../package.json', 'galley-exports/../../etc/passwd', '/etc/passwd']) {
    const bad = await fetch(
      `${baseUrl}/api/galley/download?cwd=${encodeURIComponent(ws)}&path=${encodeURIComponent(traversal)}`,
    )
    assert.equal(bad.status, 400, `expected 400 for traversal '${traversal}', got ${bad.status}`)
  }

  // 2. Cordis `ctx.provide('galley')` service registration & disposers
  let providedName = null
  let providedService = null
  const effects = []
  applyHostPlugin({
    tools: { register: () => () => {} },
    provide(name, svc) {
      providedName = name
      providedService = svc
      return () => {
        providedService = null
      }
    },
    effect(fn) {
      effects.push(fn)
    },
    inject() {},
  })
  assert.equal(providedName, 'galley')
  assert.ok(providedService && typeof providedService.registerTemplate === 'function')
  assert.ok(typeof providedService.registerPreflight === 'function')

  // Register a companion template & preflight check on our test server's registry
  const disposeTpl = registry.registerTemplate({
    id: 'notenliste',
    title: 'Notenliste (Companion Pack)',
    sheets: [
      {
        id: 's1',
        title: 'Notenübersicht',
        geometry: { paper: 'a4', orientation: 'portrait', margin: { top: 2, right: 2, bottom: 2, left: 2 } },
        starterBlocks: [{ type: 'heading', level: 1, body: 'Notenliste' }],
      },
    ],
  })
  const disposeCheck = registry.registerPreflight('fundus-citation-check', (packet) => [
    {
      code: 'FUNDUS_UNCITED_CLAIM',
      severity: 'warn',
      sheetId: packet.sheetOrder[0],
      message: 'Quellenbeleg ausstehend (Companion-Check)',
    },
  ])

  const openedCompanion = await postJson('/api/galley/edit', {
    op: 'open',
    template: 'notenliste',
  })
  assert.equal(openedCompanion.status, 200)

  const stWithCompanion = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.ok(stWithCompanion.templates.some((t) => t.id === 'notenliste' && t.source === 'plugin'))
  assert.ok(stWithCompanion.preflight.some((w) => w.code === 'FUNDUS_UNCITED_CLAIM'))

  // Disposing unregisters both cleanly
  disposeTpl()
  disposeCheck()
  const stAfterDispose = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.equal(stAfterDispose.templates.some((t) => t.id === 'notenliste'), false)
  assert.equal(stAfterDispose.preflight.some((w) => w.code === 'FUNDUS_UNCITED_CLAIM'), false)
})

test('M2.6 dogfood regressions: table cell shape normalization + insert string dependsOn + patch auto-unstale', async () => {
  const opened = await postJson('/api/galley/edit', {
    op: 'open',
    template: 'worksheet',
    title: 'Thirty Years War',
  })
  assert.equal(opened.status, 200)

  // 1. Insert answer on s2 with string dependsOn: ["b2"] -> must NOT be stale on creation!
  const insAns = await postJson('/api/galley/edit', {
    op: 'insert',
    sheetId: 's2',
    source: 'agent',
    block: {
      type: 'answer',
      body: [{ t: 'text', v: 'Initiale Lösung' }],
      dependsOn: ['b2'],
    },
  })
  assert.equal(insAns.status, 200)
  const ansId = insAns.json.block.id
  assert.equal(insAns.json.block.stale, false, 'newly inserted answer with string dependsOn must not start stale')
  assert.equal(insAns.json.staleDependents.includes(ansId), false)

  // 2. Patch upstream task b2 -> ansId turns stale; then patch ansId body -> ansId auto-clears stale!
  const patchTask = await postJson('/api/galley/edit', {
    op: 'patch',
    blockId: 'b2',
    source: 'agent',
    patch: { body: 'Aktualisierte Aufgabe zu 1618' },
  })
  assert.equal(patchTask.status, 200)
  assert.ok(patchTask.json.staleDependents.includes(ansId), 'downstream answer must turn stale after task edit')

  const patchAns = await postJson('/api/galley/edit', {
    op: 'patch',
    blockId: ansId,
    source: 'agent',
    patch: { body: 'Aktualisierte Lösung passend zu 1618' },
  })
  assert.equal(patchAns.status, 200)
  assert.equal(patchAns.json.block.stale, false, 'patching stale answer body must refresh sinceHash and clear stale')
  assert.equal(patchAns.json.staleDependents.includes(ansId), false)

  // 3. Insert table with mixed LLM cell shapes (plain strings, bare Inline objects, and Inline[] arrays)
  const tblRes = await postJson('/api/galley/edit', {
    op: 'insert',
    sheetId: 's1',
    source: 'agent',
    block: {
      type: 'table',
      headers: ['Zeit', { t: 'text', v: 'Phase' }, [{ t: 'text', v: 'Inhalt' }]],
      rows: [
        [
          '15 Min.',
          { t: 'strong', c: [{ t: 'text', v: 'Einstieg' }] },
          [{ t: 'text', v: 'Prager Fenstersturz' }],
        ],
      ],
    },
  })
  assert.equal(tblRes.status, 200)
  assert.equal(tblRes.json.ok, true)
  assert.ok(tblRes.json.proof && tblRes.json.proof.pages >= 1, 'normalized table must compile cleanly on NativeArm')
})

