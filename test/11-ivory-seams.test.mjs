/**
 * dsh-galley — M4.2b Ivory Tower Seam Alignment Gate (`agent/reviews/02-m4-review-findings-when-planning-ahead.md`):
 *   1. `SourceProvenance` round-trip on blocks & annotations, legacy SHA-256 hash invariance,
 *      hash sensitivity when `provenance` changes, `patch: { provenance: null }` clearing
 *      (both direct and via accepted human proposal), `.typ` / `.docx` / `.md` citation footer
 *      outside `source_text` marginal line-number scope, and `ctx.galley.registerPreflight` hook.
 *   2. End-to-end two-session concurrency in one `cwd` (`node:http` + `createGalleyHttpDispatcher`):
 *      independent `GET /state` + `304` rev polling, isolated `POST /edit` / `/export` / `/proposal/:id/decide`,
 *      durable `<root>/sessions.json` survival across `_resetGalleyWorkspaceForTests()` host restart,
 *      stale-binding auto-prune on `packet-delete`, `withCwdQuery(path, cwd, sessionId)`,
 *      and `ctx.galley.{getSessionPacketId, setSessionPacketId}` service helpers.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyStore,
  GalleyServiceRegistry,
  galleyOpen,
  galleyStatus,
  galleyReadBlock,
  galleyEditBlock,
  galleyAnnotate,
  galleyExport,
  unpackDocxEntries,
  createGalleyHttpDispatcher,
  getStoreForCwd,
  _resetGalleyWorkspaceForTests,
  Err,
} from '../lib/galley-core.mjs'
import { withCwdQuery } from '../lib/galley-pane.mjs'
import { NativeArm } from '../lib/index.js'

let wsRoot
let nativeArm

before(async () => {
  _resetGalleyWorkspaceForTests()
  wsRoot = mkdtempSync(join(tmpdir(), 'galley-ivory-seams-'))
  nativeArm = new NativeArm()
  await nativeArm.init()
})

after(() => {
  _resetGalleyWorkspaceForTests()
  rmSync(wsRoot, { recursive: true, force: true })
})

test('Seam 1: SourceProvenance round-trip, hash invariance, patch:null clear, exporters & preflight hook', async () => {
  const cwd = join(wsRoot, 'prov-ws')
  const { store } = getStoreForCwd(cwd)
  const registry = new GalleyServiceRegistry()
  const deps = {
    store,
    cwd,
    registry,
    render: (sheet, packet, assetBytes) => nativeArm.render(sheet, packet, assetBytes),
  }

  // Open packet with a plain `source_text` block (NO provenance) and capture its baseline hash
  const opened = await galleyOpen(deps, {
    title: 'Lueth Urteil Grounding',
    blocks: [
      {
        type: 'source_text',
        title: 'Quelle M1',
        lineNumbers: { every: 1, start: 1 },
        body: 'Die Grundrechte sind in erster Linie Abwehrrechte des Bürgers gegen den Staat.\nIn den Grundrechtsbestimmungen verkörpert sich aber auch eine objektive Wertordnung.',
      },
      {
        type: 'answer',
        dependsOn: ['b1'],
        body: 'Grundrechte wirken als objektive Wertordnung.',
      },
    ],
  })
  assert.equal(opened.ok, true)
  const pid = opened.packetId
  const baselineB1 = (await galleyReadBlock(deps, { packetId: pid, blockId: 'b1' })).blocks[0].block
  assert.equal(baselineB1.provenance, undefined)
  const unprovHash = baselineB1.hash

  // Plain block exports have NO attribution line
  const plainTyp = await galleyExport(deps, { packetId: pid, format: 'typ' })
  assert.doesNotMatch(plainTyp.text, /#emph\[#text\(size: 8\.5pt/)

  // Invalid provenance (blank sourceId) is cleanly rejected
  const badProv = await galleyEditBlock(deps, {
    packetId: pid,
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'prose', body: 'x', provenance: { sourceId: '   ' } },
  })
  assert.equal(badProv.ok, false)
  assert.equal(badProv.code, Err.INVALID_PARAMS)

  // Patch `b1` (agent-editable? Note `galleyOpen` without origin defaults seedOrigin='human',
  // so patching `b1` as `human` applies directly, and we also test proposal accept below!)
  const prov1 = {
    sourceId: 'fundus:p1',
    quoteSha256: 'abc123def456',
    citation: 'BVerfGE 7, 198 (Lüth)',
    locator: 'S. 205',
  }
  const patchedProv = await galleyEditBlock(deps, {
    packetId: pid,
    sheetId: 's1',
    op: 'patch',
    origin: 'human',
    blockId: 'b1',
    patch: { provenance: prov1 },
  })
  assert.equal(patchedProv.ok, true)
  assert.equal(patchedProv.applied, true)

  const readWithProv = (await galleyReadBlock(deps, { packetId: pid, blockId: 'b1' })).blocks[0].block
  assert.deepEqual(readWithProv.provenance, prov1)
  assert.notEqual(readWithProv.hash, unprovHash, 'setting provenance must update block content hash')
  assert.deepEqual(patchedProv.staleDependents, ['b2'], 'changing provenance on origin marks dependent stale')

  // Add annotation with `provenance`
  const annAdd = await galleyAnnotate(deps, {
    packetId: pid,
    blockId: 'b1',
    action: 'add',
    author: 'agent',
    body: 'Compare exact wording against archive scan.',
    provenance: { sourceId: 'fundus:note-1', citation: 'Archiv Akte 4', locator: 'Bl. 12r' },
  })
  assert.equal(annAdd.ok, true)
  assert.equal(annAdd.created.provenance.sourceId, 'fundus:note-1')
  assert.equal(annAdd.created.provenance.locator, 'Bl. 12r')
  const readBackAnns = (await galleyReadBlock(deps, { packetId: pid, blockId: 'b1' })).blocks[0].annotations
  assert.equal(readBackAnns[0].provenance.citation, 'Archiv Akte 4')

  // Verify `.typ`, `.docx`, and `.md` render subtle attribution, and `.typ` keeps it OUTSIDE `#[ #set par.line ... ]`
  const typWithProv = await galleyExport(deps, { packetId: pid, format: 'typ' })
  assert.match(typWithProv.text, /\]\n\n#emph\[#text\(size: 8\.5pt, fill: luma\(100\), "— BVerfGE 7, 198 \(Lüth\), S\. 205"\)\]/)
  // Ensure NativeArm compiles the attributed numbered `source_text` with zero diagnostics
  const pdfWithProv = await galleyExport(deps, { packetId: pid, format: 'pdf' })
  assert.equal(pdfWithProv.ok, true)
  assert.equal(pdfWithProv.bytes.subarray(0, 5).toString('utf8'), '%PDF-')

  const mdWithProv = await galleyExport(deps, { packetId: pid, format: 'md' })
  assert.match(mdWithProv.text, /\*— BVerfGE 7, 198 \(Lüth\), S\. 205\*/)

  const docxWithProv = await galleyExport(deps, { packetId: pid, format: 'docx' })
  const docxXml = unpackDocxEntries(docxWithProv.bytes)['word/document.xml'].toString('utf8')
  assert.match(docxXml, /— BVerfGE 7, 198 \(Lüth\), S\. 205/)

  // Register a companion `dsh-fundus` preflight check inspecting `block.provenance` & `annotation.provenance`
  const cordisGalley = registry.toCordisService()
  const disposePf = cordisGalley.registerPreflight('dsh-fundus:quote-verify', (pkt) => {
    const out = []
    for (const sid of pkt.sheetOrder) {
      for (const b of pkt.sheets[sid].blocks) {
        if (b.provenance?.sourceId === 'fundus:p1' && b.provenance.quoteSha256 !== 'expected-sha') {
          out.push({
            code: 'FUNDUS_QUOTE_MISMATCH',
            severity: 'warn',
            sheetId: sid,
            blockId: b.id,
            message: `Quote hash drift against ${b.provenance.sourceId}`,
          })
        }
      }
    }
    return out
  })
  const stWarn = await galleyStatus(deps, { packetId: pid })
  assert.ok(stWarn.preflight.some((w) => w.code === 'FUNDUS_QUOTE_MISMATCH' && w.blockId === 'b1'))
  disposePf()

  // Agent proposes `provenance: null` on human block `b1` -> human accepts -> provenance is cleared & hash matches `unprovHash`!
  const propClear = await galleyEditBlock(deps, {
    packetId: pid,
    sheetId: 's1',
    op: 'patch',
    origin: 'agent',
    blockId: 'b1',
    patch: { provenance: null },
  })
  assert.equal(propClear.ok, true)
  assert.equal(propClear.applied, false)
  store.applyProposal(pid, propClear.proposal.id)

  const clearedB1 = (await galleyReadBlock(deps, { packetId: pid, blockId: 'b1' })).blocks[0].block
  assert.equal('provenance' in clearedB1, false, 'provenance key must be deleted when patched with null')
  assert.equal(
    clearedB1.hash,
    unprovHash,
    'clearing provenance must restore the exact byte-identical legacy SHA-256 block hash',
  )
})

test('Seam 2 & 3: Two-session concurrency in one cwd + durable sessions.json across restart + ctx.galley helpers', async () => {
  const cwd = join(wsRoot, 'shared-course-history-9b')
  const registry = new GalleyServiceRegistry()
  const cordisGalley = registry.toCordisService()

  // Pure helper check for client query builder
  assert.equal(withCwdQuery('/api/galley/state', '/tmp/a'), '/api/galley/state?cwd=%2Ftmp%2Fa')
  assert.equal(
    withCwdQuery('/api/galley/state', '/tmp/a', 'S1'),
    '/api/galley/state?cwd=%2Ftmp%2Fa&sessionId=S1',
  )

  const getDepsForCwd = async (cwdParam) => {
    const { store, root, cwd: resolved } = getStoreForCwd(cwdParam)
    return {
      root,
      cwd: resolved,
      deps: {
        store,
        cwd: resolved,
        registry,
        render: (sheet, packet, assetBytes) => nativeArm.render(sheet, packet, assetBytes),
      },
    }
  }

  const dispatch = createGalleyHttpDispatcher({ getDepsForCwd, registry })
  const srv = createServer(async (req, res) => {
    if (!(await dispatch(req, res))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${srv.address().port}`

  const post = async (path, body) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  try {
    // 1. Session S1 opens P1; Session S2 (same cwd!) opens P2 via `packet-open`
    const open1 = await post('/api/galley/edit', {
      cwd,
      sessionId: 'S1',
      op: 'open',
      title: 'Packet One (S1)',
      blocks: [{ type: 'prose', body: 'Initial S1 content' }],
    })
    assert.equal(open1.status, 200)
    const p1 = open1.json.packetId

    const open2 = await post('/api/galley/edit', {
      cwd,
      sessionId: 'S2',
      op: 'packet-open',
      title: 'Packet Two (S2)',
      blocks: [{ type: 'prose', body: 'Initial S2 content' }],
    })
    assert.equal(open2.status, 200)
    const p2 = open2.json.packetId
    assert.notEqual(p1, p2)

    // 2. GET /api/galley/state isolates S1 -> P1 and S2 -> P2 despite active.json pointing to P2
    const st1 = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S1'))).json()
    const st2 = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S2'))).json()
    assert.equal(st1.packetId, p1)
    assert.equal(st2.packetId, p2)

    // 3. Mutating from S2 mutates P2 only; S1's 304 rev-poll stays undisturbed!
    const editS2 = await post('/api/galley/edit', {
      cwd,
      sessionId: 'S2',
      op: 'insert',
      sheetId: 's1',
      block: { type: 'task', body: 'S2 exclusive task' },
    })
    assert.equal(editS2.status, 200)
    assert.equal(editS2.json.packetId, p2)

    const pollS1Unchanged = await fetch(
      `${withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S1')}&rev=${st1.rev}&knownPacket=${p1}`,
    )
    assert.equal(pollS1Unchanged.status, 304, 'S1 rev poll must return 304 when only S2 mutated P2')

    const pollS2Changed = await fetch(
      `${withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S2')}&rev=${st2.rev}&knownPacket=${p2}`,
    )
    assert.equal(pollS2Changed.status, 200, 'S2 rev poll must return 200 after S2 mutation')
    const st2After = await pollS2Changed.json()
    assert.equal(st2After.rev, st2.rev + 1)
    assert.equal(st2After.sheets[0].blocks.length, 2)

    // Verify P1 still has exactly 1 block
    const st1Verify = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S1'))).json()
    assert.equal(st1Verify.sheets[0].blocks.length, 1)

    // Export from S1 exports P1 (`packet-one-s1.md`), not P2
    const expS1 = await post('/api/galley/export', { cwd, sessionId: 'S1', format: 'md' })
    assert.equal(expS1.status, 200)
    assert.equal(expS1.json.packetId, p1)
    assert.match(expS1.json.files[0].path, /packet-one-s1\.md$/)

    // 4. Simulate full process restart: clear in-memory workspace state and confirm `<root>/sessions.json` restores bindings
    const sessionsFile = join(cwd, '.dsh', 'galley', 'sessions.json')
    assert.ok(existsSync(sessionsFile), '<root>/sessions.json must exist on disk')
    const persistedMap = JSON.parse(readFileSync(sessionsFile, 'utf8'))
    assert.equal(persistedMap.S1, p1)
    assert.equal(persistedMap.S2, p2)

    _resetGalleyWorkspaceForTests()

    // Seam 3: `ctx.galley` service reads restored bindings & can bind S3 -> P1
    assert.equal(cordisGalley.getSessionPacketId(cwd, 'S1'), p1)
    assert.equal(cordisGalley.getSessionPacketId(cwd, 'S2'), p2)
    cordisGalley.setSessionPacketId(cwd, 'S3', p1)
    assert.equal(cordisGalley.getSessionPacketId(cwd, 'S3'), p1)
    assert.throws(() => cordisGalley.setSessionPacketId(cwd, 'S3', 'p-missing0'), /not found/)

    // HTTP state after simulated restart still resolves S1 -> P1 and S2 -> P2
    const st1Restart = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S1'))).json()
    const st2Restart = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S2'))).json()
    assert.equal(st1Restart.packetId, p1)
    assert.equal(st2Restart.packetId, p2)

    // 5. Deleting P2 prunes S2's binding from `sessions.json` so S2 falls back cleanly to P1 (`active.json`)
    const delP2 = await post('/api/galley/edit', { cwd, sessionId: 'S2', op: 'packet-delete' })
    assert.equal(delP2.status, 200)
    assert.equal(delP2.json.deletedId, p2)
    assert.equal(cordisGalley.getSessionPacketId(cwd, 'S2'), null)

    const st2Fallback = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, cwd, 'S2'))).json()
    assert.equal(st2Fallback.activePacket, true)
    assert.equal(st2Fallback.packetId, p1, 'after deleting P2, S2 must fall back cleanly to P1')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})
