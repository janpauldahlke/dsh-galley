/**
 * dsh-galley — 0.2.3 Fable Audit Hardening Gate (`agent/reviews/2026-11-27-fable-audit.md`):
 *   1. Cross-chat active-packet leak killed across `inject.ts`, `registerGalleyTools`, and
 *      `httpDispatch.ts` (`sessionId` present + unbound -> `0` inject messages, `GALLEY_NO_ACTIVE_PACKET`
 *      on tools, `activePacket: false` on HTTP state; headless fallback preserved) + `cwd` confined
 *      to `session.header.cwd` with zero process-global `lastGalleyCwd` bleed.
 *   2. Header blank-title & `"TITEL"` / `"DOCUMENT"` eyebrow fix: `title` / flattened `body` fallback
 *      on `insert` & `patch`, `GALLEY_INVALID_PARAMS` on empty `header` insert, no `headerEyebrow`
 *      noise in Typst/SVG/PDF (`en` & `de`), and `GALLEY_EMPTY_HEADER_TITLE` preflight warning.
 *   3. Agent `move` & `remove` on `origin === 'human'` blocks stage pending proposals in `auto` mode.
 *   4. Throwing preflight checkers isolated as `GALLEY_PREFLIGHT_INTERNAL` (`warn`), and `galley_export`
 *      runs preflight, returns `preflightWarnings`, blocks `severity === 'error'` with
 *      `GALLEY_EXPORT_BLOCKED_BY_PREFLIGHT` (409 on HTTP, 0 files written), and honors `force: true`
 *      only for human routes.
 *   5. `galley_edit_block({ op: 'batch', ops })` applies up to 25 ops in `1` `store.commit` (`rev + 1`)
 *      + `1` render per touched sheet (with intra-batch `dependsOn` + mixed proposal support + atomic
 *      all-or-nothing rollback), and `galley_export` description curbs export spam.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Err,
  GalleyServiceRegistry,
  createGalleyHttpDispatcher,
  galleyEditBlock,
  galleyExport,
  galleyOpen,
  galleyReadBlock,
  galleyStatus,
  getStoreForCwd,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import { withCwdQuery } from '../lib/galley-pane.mjs'
import { compileSheet } from '../lib/typst-render.mjs'
import {
  NativeArm,
  VERSION,
  installGalleyInject,
  registerGalleyTools,
} from '../lib/index.js'

let tmpRoot
let nativeArm

before(async () => {
  _resetGalleyWorkspaceForTests()
  tmpRoot = mkdtempSync(join(tmpdir(), 'galley-023-fable-'))
  nativeArm = new NativeArm()
  await nativeArm.init()
})

after(() => {
  _resetGalleyWorkspaceForTests()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDeps(cwd, registry = new GalleyServiceRegistry(), onRender = null) {
  const { store, root, cwd: resolved } = getStoreForCwd(cwd)
  return {
    store,
    root,
    cwd: resolved,
    registry,
    deps: {
      store,
      cwd: resolved,
      registry,
      render: (sheet, packet, assetBytes) => {
        if (onRender) onRender(sheet.id, packet.rev)
        return nativeArm.render(sheet, packet, assetBytes)
      },
    },
  }
}

test('Finding 1: Brand-new chat never leaks another session packet across inject, tools, or HTTP + confines session cwd', async () => {
  assert.match(VERSION, /^0\.2\.\d+$/)
  const wsA = join(tmpRoot, 'ws-course-a')
  const outsideDir = join(tmpRoot, 'outside-escape')
  const registry = new GalleyServiceRegistry()

  const registered = new Map()
  const disposeTools = registerGalleyTools({
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  })

  let preStep = null
  const disposeInject = installGalleyInject(
    {
      on(name, fn) {
        if (name === 'agent/pre-step') preStep = fn
        return () => {}
      },
      logger: () => ({ warn() {}, info() {}, error() {} }),
    },
    { registry, getDepsForCwd: async (c) => makeDeps(c, registry) },
  )

  const dispatch = createGalleyHttpDispatcher({
    registry,
    getDepsForCwd: async (c) => makeDeps(c ?? wsA, registry),
  })
  const srv = createServer(async (req, res) => {
    if (!(await dispatch(req, res))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${srv.address().port}`

  try {
    const execS1 = { agent: { session: { id: 'chat-s1', header: { id: 'chat-s1', cwd: wsA } } } }
    const execS2New = { agent: { session: { id: 'chat-s2-fresh', header: { id: 'chat-s2-fresh', cwd: wsA } } } }

    // 1. S1 opens a packet; attempt to pass out-of-workspace `cwd: outsideDir` MUST be ignored & confined to wsA!
    const openedS1 = await registered.get('galley_open').execute(
      { cwd: outsideDir, template: 'worksheet', title: 'S1 Confidential Exam' },
      execS1,
    )
    assert.equal(openedS1.ok, true)
    assert.equal(existsSync(join(outsideDir, '.dsh', 'galley')), false, 'out-of-workspace args.cwd must never be touched')
    assert.equal(existsSync(join(wsA, '.dsh', 'galley', openedS1.packetId)), true, 'confined to session.header.cwd')

    // 2. Brand-new chat S2: Turn-1 pre-step inject MUST splice 0 messages (never leak S1's packet!)
    const userMsg = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hi!' }], source: { kind: 'user' } }
    const decisionIn = { kind: 'enter', messages: [userMsg] }
    const injectedOut = await preStep(
      {
        agent: execS2New.agent,
        messages: [userMsg],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => decisionIn,
    )
    assert.equal(injectedOut, decisionIn, 'fresh unbound chat must splice 0 galley messages')

    // 3. Unbound chat S2 calling status / read / edit / annotate / export without packetId -> GALLEY_NO_ACTIVE_PACKET
    for (const [toolName, sampleArgs] of [
      ['galley_status', {}],
      ['galley_read_block', { blockId: 'b1' }],
      ['galley_edit_block', { op: 'insert', sheetId: 's1', block: { type: 'prose', body: 'leak?' } }],
      ['galley_annotate', { blockId: 'b1', action: 'list' }],
      ['galley_export', { format: 'md' }],
    ]) {
      const res = await registered.get(toolName).execute(sampleArgs, execS2New)
      assert.equal(res.ok, false, `${toolName} must fail on unbound session`)
      assert.equal(res.code, Err.NO_ACTIVE_PACKET)
    }

    // 4. Browser pane for fresh chat S2 (`?sessionId=chat-s2-fresh`) gets `activePacket: false` (no UI split-brain!)
    const paneS2 = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, wsA, 'chat-s2-fresh'))).json()
    assert.equal(paneS2.activePacket, false)
    assert.equal(paneS2.packetId, null)
    assert.equal(paneS2.packets.length, 1)

    // 5. Headless tool call WITHOUT sessionId still resolves `active.json` fallback cleanly
    const headlessStatus = await registered.get('galley_status').execute({ cwd: wsA }, undefined)
    assert.equal(headlessStatus.ok, true)
    assert.equal(headlessStatus.packetId, openedS1.packetId)

    // 6. Once S2 calls `galley_open`, S2 is bound to its own packet and Turn-2 inject splices S2's packet!
    const openedS2 = await registered.get('galley_open').execute(
      { template: 'generic', title: 'S2 Own Handout', blocks: [{ type: 'prose', body: 'Hello S2' }] },
      execS2New,
    )
    assert.equal(openedS2.ok, true)
    assert.notEqual(openedS2.packetId, openedS1.packetId)

    const injectedS2 = await preStep(
      {
        agent: execS2New.agent,
        messages: [userMsg],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => decisionIn,
    )
    assert.equal(injectedS2.messages.length, 2)
    assert.equal(injectedS2.messages[1].source.packetId, openedS2.packetId)
  } finally {
    disposeInject()
    disposeTools()
    await new Promise((r) => srv.close(r))
  }
})

test('Finding 2: Header title/body fallback, empty insert rejection, no TITEL/DOCUMENT eyebrow, and GALLEY_EMPTY_HEADER_TITLE warning', async () => {
  const ws = join(tmpRoot, 'ws-header')
  const { deps } = makeDeps(ws)

  const opened = await galleyOpen(deps, {
    template: 'generic',
    locale: 'de',
    title: 'Header Check',
  })
  assert.equal(opened.ok, true)
  const pid = opened.packetId

  // 1. Empty header insert (no fields.title, no title, no body) -> GALLEY_INVALID_PARAMS with clear hint
  const badInsert = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'insert',
    origin: 'agent',
    block: { type: 'header', fields: { fach: 'Geschichte' } },
  })
  assert.equal(badInsert.ok, false)
  assert.equal(badInsert.code, Err.INVALID_PARAMS)
  assert.match(badInsert.message, /header block requires fields\.title \(or title\)/)

  // 2. Insert with `{ type: 'header', body: 'Arbeitsblatt: **Weimarer Republik**' }` falls back to flattened body!
  const bodyInsert = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'insert',
    origin: 'agent',
    block: { type: 'header', body: 'Arbeitsblatt: **Weimarer Republik**', fields: { fach: 'Geschichte', klasse: '10b' } },
  })
  assert.equal(bodyInsert.ok, true)
  const h1 = (await galleyReadBlock(deps, { packetId: pid, blockId: bodyInsert.block.id })).blocks[0].block
  assert.equal(h1.fields.titel, 'Arbeitsblatt: Weimarer Republik')
  assert.equal(h1.fields.fach, 'Geschichte')

  // 3. Patch on header with top-level `{ title: '...' }` updates `fields.titel` WITHOUT wiping `fach`/`klasse`!
  const patchedTitle = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'patch',
    origin: 'agent',
    blockId: h1.id,
    patch: { title: 'Quellenblatt: 1923 Krisenjahr' },
  })
  assert.equal(patchedTitle.ok, true)
  const h1After = (await galleyReadBlock(deps, { packetId: pid, blockId: h1.id })).blocks[0].block
  assert.equal(h1After.fields.titel, 'Quellenblatt: 1923 Krisenjahr')
  assert.equal(h1After.fields.fach, 'Geschichte')
  assert.equal(h1After.fields.klasse, '10b')

  // 4. Typst & real NativeArm SVG output NEVER emit `"TITEL"` or `"DOCUMENT"` eyebrow (`de` & `en`)
  const loaded = deps.store.load(pid)
  const typDe = compileSheet(loaded.sheets.s1, loaded.assets, 'de').typ
  const typEn = compileSheet(loaded.sheets.s1, loaded.assets, 'en').typ
  assert.doesNotMatch(typDe, /"TITEL"/)
  assert.doesNotMatch(typEn, /"DOCUMENT"/)
  const rendered = await nativeArm.render(loaded.sheets.s1, loaded)
  assert.equal(rendered.pages, 1)

  // 5. Explicitly blanking `fields.titel` on an existing packet emits `GALLEY_EMPTY_HEADER_TITLE` preflight warning
  await galleyEditBlock(deps, {
    packetId: pid,
    op: 'patch',
    origin: 'human',
    blockId: h1.id,
    patch: { fields: { titel: '', fach: 'Geschichte' } },
  })
  const st = await galleyStatus(deps, { packetId: pid })
  assert.ok(
    st.preflight.some((w) => w.code === 'GALLEY_EMPTY_HEADER_TITLE' && w.severity === 'warn' && w.blockId === h1.id),
    'blank header title must emit GALLEY_EMPTY_HEADER_TITLE warning',
  )
})

test('Finding 3: Agent move and remove on human-authored blocks stage proposals in auto mode', async () => {
  const ws = join(tmpRoot, 'ws-human-guard')
  const { deps, store } = makeDeps(ws)

  // Seed human-authored blocks (`origin` omitted on galleyOpen -> human blocks)
  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'Human Guard',
    blocks: [
      { type: 'prose', body: 'Human Lead Paragraph' },
      { type: 'prose', body: 'Human Second Paragraph' },
    ],
  })
  const pid = opened.packetId

  // 1. Agent `move` on human block b2 in `auto` mode MUST stage a proposal (`applied: false`)
  const mvProp = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'move',
    origin: 'agent',
    blockId: 'b2',
    toBeforeId: 'b1',
  })
  assert.equal(mvProp.ok, true)
  assert.equal(mvProp.applied, false)
  assert.equal(mvProp.proposal.op, 'move')
  assert.deepEqual(
    store.load(pid).sheets.s1.blocks.map((b) => b.id),
    ['b1', 'b2'],
    'human block order must stay unchanged until proposal is accepted',
  )

  store.applyProposal(pid, mvProp.proposal.id)
  assert.deepEqual(store.load(pid).sheets.s1.blocks.map((b) => b.id), ['b2', 'b1'])
  assert.equal(store.load(pid).sheets.s1.blocks[0].origin, 'human')

  // 2. Agent `remove` on human block b1 in `auto` mode MUST stage a proposal (`applied: false`)
  const rmProp = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'remove',
    origin: 'agent',
    blockId: 'b1',
  })
  assert.equal(rmProp.ok, true)
  assert.equal(rmProp.applied, false)
  assert.equal(rmProp.proposal.op, 'remove')
  assert.equal(store.load(pid).sheets.s1.blocks.length, 2, 'human block must not be deleted before approval')

  store.applyProposal(pid, rmProp.proposal.id)
  assert.deepEqual(store.load(pid).sheets.s1.blocks.map((b) => b.id), ['b2'])
})

test('Finding 4: Throwing preflight checker isolation + galley_export preflight gate & human force override', async () => {
  const ws = join(tmpRoot, 'ws-export-preflight')
  const registry = new GalleyServiceRegistry()
  const { deps } = makeDeps(ws, registry)

  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'Preflight Gate Doc',
    blocks: [{ type: 'prose', body: 'Verified source passage.' }],
  })
  const pid = opened.packetId

  // 1. Throwing checker is isolated into GALLEY_PREFLIGHT_INTERNAL (`warn`), never crashes status or export
  const disposeThrowing = registry.registerPreflight('broken-checker', () => {
    throw new Error('unexpected null pointer')
  })
  const stWithThrow = await galleyStatus(deps, { packetId: pid })
  assert.equal(stWithThrow.ok, true)
  assert.ok(
    stWithThrow.preflight.some(
      (w) =>
        w.code === 'GALLEY_PREFLIGHT_INTERNAL' &&
        w.severity === 'warn' &&
        w.message.includes('broken-checker') &&
        w.message.includes('unexpected null pointer'),
    ),
  )

  // Export with only `warn` preflight succeeds and returns `preflightWarnings`
  const okExportWithWarn = await galleyExport(deps, {
    packetId: pid,
    format: 'md',
    origin: 'agent',
  })
  assert.equal(okExportWithWarn.ok, true)
  assert.ok(okExportWithWarn.preflightWarnings.some((w) => w.code === 'GALLEY_PREFLIGHT_INTERNAL'))

  // 2. Register an error-severity checker -> blocks agent export (even if agent tries force:true!) & writes 0 files
  const disposeBlocking = registry.registerPreflight('integrity-gate', () => [
    {
      code: 'SOURCE_HASH_DRIFT',
      severity: 'error',
      sheetId: 's1',
      blockId: 'b1',
      message: 'Primary source quote SHA-256 mismatch',
    },
  ])

  const blockedAgent = await galleyExport(deps, {
    packetId: pid,
    format: 'pdf',
    outDir: ws,
    origin: 'agent',
    force: true, // agent cannot bypass!
  })
  assert.equal(blockedAgent.ok, false)
  assert.equal(blockedAgent.code, Err.EXPORT_BLOCKED_BY_PREFLIGHT)
  assert.ok(blockedAgent.preflightWarnings.some((w) => w.code === 'SOURCE_HASH_DRIFT'))
  assert.equal(existsSync(join(ws, 'galley-exports', 'preflight-gate-doc.pdf')), false, 'blocked export must write 0 files')

  // 3. Verify HTTP `/api/galley/export`: returns 409 without `force: true`, and 200 WITH `force: true` on human route
  const dispatch = createGalleyHttpDispatcher({
    registry,
    getDepsForCwd: async (c) => makeDeps(c ?? ws, registry),
  })
  const srv = createServer(async (req, res) => {
    if (!(await dispatch(req, res))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${srv.address().port}`

  try {
    const httpBlocked = await fetch(`${baseUrl}/api/galley/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, packetId: pid, format: 'pdf' }),
    })
    assert.equal(httpBlocked.status, 409)
    const blockedBody = await httpBlocked.json()
    assert.equal(blockedBody.code, Err.EXPORT_BLOCKED_BY_PREFLIGHT)
    assert.ok(blockedBody.preflightWarnings.some((w) => w.code === 'SOURCE_HASH_DRIFT'))

    const httpForced = await fetch(`${baseUrl}/api/galley/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, packetId: pid, format: 'pdf', force: true }),
    })
    assert.equal(httpForced.status, 200)
    const forcedBody = await httpForced.json()
    assert.equal(forcedBody.ok, true)
    assert.ok(forcedBody.preflightWarnings.some((w) => w.code === 'SOURCE_HASH_DRIFT'))
    assert.equal(existsSync(join(ws, 'galley-exports', 'preflight-gate-doc.pdf')), true)
  } finally {
    disposeBlocking()
    disposeThrowing()
    await new Promise((r) => srv.close(r))
  }
})

test('Finding 5: op:"batch" commits N ops in 1 rev + 1 render per sheet, supports intra-batch dependsOn & mixed proposals, rolls back atomically, and curbs export spam', async () => {
  const ws = join(tmpRoot, 'ws-batch')
  let renderCount = 0
  const { deps, store } = makeDeps(ws, new GalleyServiceRegistry(), () => {
    renderCount += 1
  })

  // Check tool description guidance against export spam
  const registered = new Map()
  const disposeTools = registerGalleyTools({
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => {}
      },
    },
  })
  assert.match(
    registered.get('galley_export').description,
    /ONLY when the user asks for final deliverable files/i,
  )
  assert.ok(registered.get('galley_edit_block').parameters.properties.op.enum.includes('batch'))
  disposeTools()

  const opened = await galleyOpen(deps, {
    template: 'worksheet',
    title: 'Batch Benchmark',
    origin: 'agent',
  })
  assert.equal(opened.ok, true)
  const pid = opened.packetId
  const revBefore = opened.rev

  // Reset render counter right before 6-op cross-sheet batch
  renderCount = 0
  const batchRes = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'batch',
    origin: 'agent',
    ops: [
      { op: 'patch', blockId: 'b1', patch: { title: 'Thermodynamics Sheet', subtitle: 'Physics 11' } },
      { op: 'patch', blockId: 'b2', patch: { body: 'State the First Law of Thermodynamics.' } },
      { op: 'insert', sheetId: 's1', block: { type: 'task', body: 'Derive adiabatic work for an ideal gas.' } }, // -> b5
      { op: 'insert', afterId: 'b5', block: { type: 'callout', tone: 'hint', body: 'Use $p V^\\gamma = \\text{const}$.' } }, // -> b6 on s1!
      { op: 'patch', blockId: 'b4', patch: { body: 'Energy is conserved: $\\Delta U = Q - W$.' } },
      { op: 'insert', sheetId: 's2', block: { type: 'answer', dependsOn: ['b5'], body: '$W = (p_2 V_2 - p_1 V_1)/(1 - \\gamma)$.' } }, // -> b7 referencing b5 created in ops[2]!
    ],
  })

  assert.equal(batchRes.ok, true)
  assert.equal(batchRes.applied, true)
  assert.equal(batchRes.appliedCount, 6)
  assert.equal(batchRes.proposedCount, 0)
  assert.equal(batchRes.rev, revBefore + 1, '6-op batch MUST bump packet.rev by exactly +1')
  assert.equal(renderCount, 2, '6-op batch touching s1 & s2 MUST run exactly 2 sheet renders (not 6)')
  assert.deepEqual(batchRes.staleDependents, [], 'intra-batch dependsOn must snapshot live b5 hash with 0 staleness')

  // Verify mixed batch (direct agent insert + human-block patch proposal -> still 1 rev bump!)
  await galleyEditBlock(deps, {
    packetId: pid,
    op: 'patch',
    origin: 'human',
    blockId: 'b2',
    patch: { body: 'Human-locked Task 1 wording.' },
  })
  const revBeforeMixed = store.load(pid).rev

  const mixedRes = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'batch',
    origin: 'agent',
    ops: [
      { op: 'insert', sheetId: 's1', block: { type: 'prose', body: 'Agent intro note.' } },
      { op: 'patch', blockId: 'b2', patch: { body: 'Suggested refinement on human task.' } },
    ],
  })
  assert.equal(mixedRes.ok, true)
  assert.equal(mixedRes.applied, false)
  assert.equal(mixedRes.appliedCount, 1)
  assert.equal(mixedRes.proposedCount, 1)
  assert.equal(mixedRes.proposals.length, 1)
  assert.equal(mixedRes.rev, revBeforeMixed + 1, 'mixed direct+proposal batch must still bump rev only once')

  // Atomic all-or-nothing rollback when a late sub-op fails validation
  const revBeforeFail = store.load(pid).rev
  const blockCountBeforeFail = store.load(pid).sheets.s1.blocks.length
  const failedBatch = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'batch',
    origin: 'agent',
    ops: [
      { op: 'insert', sheetId: 's1', block: { type: 'prose', body: 'Must roll back!' } },
      { op: 'patch', blockId: 'b-nonexistent', patch: { body: 'boom' } },
    ],
  })
  assert.equal(failedBatch.ok, false)
  assert.equal(failedBatch.code, Err.BLOCK_NOT_FOUND)
  assert.equal(store.load(pid).rev, revBeforeFail, 'failed batch must leave rev untouched')
  assert.equal(store.load(pid).sheets.s1.blocks.length, blockCountBeforeFail, 'failed batch must write 0 blocks')

  // Cap check (> 25 ops rejected)
  const overCap = await galleyEditBlock(deps, {
    packetId: pid,
    op: 'batch',
    origin: 'agent',
    ops: Array.from({ length: 26 }, (_, i) => ({
      op: 'insert',
      sheetId: 's1',
      block: { type: 'prose', body: `p${i}` },
    })),
  })
  assert.equal(overCap.ok, false)
  assert.equal(overCap.code, Err.INVALID_PARAMS)
})
