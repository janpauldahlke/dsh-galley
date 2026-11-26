/**
 * dsh-galley — M2.7 print fidelity & multi-session co-authoring regression gate.
 *
 * Covers every finding from the cold-start 3-Mappe Doppelstunde dogfood run:
 *   1. `newline` followed by `#text(...)` never escapes `#` into literal `#text(…)`.
 *   2. Per-session sticky `activePacket`: concurrent human pane switches or
 *      read-only `GET /state?packetId=…` never hijack an in-flight agent session;
 *      `?rev=N&knownPacket=…` prevents false 304s across same-rev packet switches.
 *   3. `targetPages` + `targetPagesMet` proof fields, optional `header.fields.name`,
 *      suppression of duplicate `"Aufgabe 1"` & duplicate `"Erwartungshorizont"`.
 *   4. Per-block `source_text` marginal line-number reset, `GALLEY_SOURCE_LINE_WRAP`
 *      preflight warning, `table.colWidths`, German umlaut/ß slugifier, and
 *      single-sheet export filenames without `-s1` noise.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGalleyHttpDispatcher,
  getStoreForCwd,
  GalleyServiceRegistry,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import { compileSheet } from '../lib/typst-render.mjs'
import { NativeArm, registerGalleyTools } from '../lib/index.js'

let arm
let registry
let server
let baseUrl
let ws

before(async () => {
  _resetGalleyWorkspaceForTests()
  ws = mkdtempSync(join(tmpdir(), 'galley-m27-'))
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

test('newline escape bug: { t: "newline" } before { t: "text" } never leaks literal #text(…) into SVG', async () => {
  const sheet = {
    id: 's1',
    title: 'Escape Check',
    geometry: { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } },
    blocks: [
      {
        id: 'b1',
        type: 'prose',
        hash: '',
        dependsOn: [],
        slot: { mode: 'full' },
        origin: 'agent',
        updatedAt: '',
        body: [
          { t: 'text', v: 'Erster Satz Mitteleuropas.' },
          { t: 'newline' },
          { t: 'text', v: 'Hinter dem Krieg stehen zwei Ursachenkreise.' },
        ],
      },
      {
        id: 'b2',
        type: 'answer',
        hash: '',
        dependsOn: [],
        slot: { mode: 'full' },
        origin: 'agent',
        updatedAt: '',
        body: [
          { t: 'strong', c: [{ t: 'text', v: 'Lösung zu Aufgabe 1:' }] },
          { t: 'newline' },
          { t: 'text', v: 'Konfessionskonflikt und Machtpolitik.' },
        ],
      },
    ],
  }
  const packet = {
    id: 'p-esc',
    template: 'generic',
    title: 'T',
    rev: 1,
    createdAt: '',
    updatedAt: '',
    sheetOrder: ['s1'],
    sheets: { s1: sheet },
    nextBlockSeq: 3,
    nextProposalSeq: 1,
    nextAnnotationSeq: 1,
    nextAssetSeq: 1,
    assets: {},
  }
  const sr = await arm.render(sheet, packet)
  assert.doesNotMatch(sr.svg, /#text\(/, 'rendered SVG must never contain leaked #text( code syntax')
})

test('session-sticky activePacket prevents cross-packet contamination + knownPacket guards 304', async () => {
  const registered = new Map()
  const dispose = registerGalleyTools({
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  })

  try {
    const execSessionA = { agent: { session: { id: 'sess-agent-A', header: { id: 'sess-agent-A', cwd: ws } } } }
    const execSessionB = { agent: { session: { id: 'sess-agent-B', header: { id: 'sess-agent-B', cwd: ws } } } }

    // Session A opens Mappe 1 (rev 1)
    const m1 = await registered.get('galley_open').execute({ template: 'generic', title: 'Mappe Eins' }, execSessionA)
    assert.equal(m1.ok, true)

    // Session B opens Mappe 2 (rev 1 -> flips global store active.json to m2.packetId!)
    const m2 = await registered.get('galley_open').execute({ template: 'generic', title: 'Mappe Zwei' }, execSessionB)
    assert.equal(m2.ok, true)
    assert.notEqual(m1.packetId, m2.packetId)

    // Read-only GET /state?packetId=m1 must NOT overwrite global active.json (remains m2)
    const readM1 = await fetch(
      `${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}&packetId=${encodeURIComponent(m1.packetId)}`,
    )
    assert.equal(readM1.status, 200)
    assert.equal(getStoreForCwd(ws).store.getActivePacket(), m2.packetId)

    // Poll with rev=1 & knownPacket=m1 when active packet is m2 (also rev=1!) MUST return 200, NOT false 304!
    const switchPoll = await fetch(
      `${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}&rev=1&knownPacket=${encodeURIComponent(m1.packetId)}`,
    )
    assert.equal(switchPoll.status, 200)
    const switchJson = await switchPoll.json()
    assert.equal(switchJson.packetId, m2.packetId)

    // Same rev AND matching knownPacket -> 304 Not Modified!
    const hit304 = await fetch(
      `${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}&rev=1&knownPacket=${encodeURIComponent(m2.packetId)}`,
    )
    assert.equal(hit304.status, 304)

    // Session A now calls galley_edit_block WITHOUT packetId -> MUST still write into m1 (session-sticky!), NOT m2!
    const editA = await registered.get('galley_edit_block').execute(
      { op: 'insert', block: { type: 'prose', body: 'Geschrieben von Session A' } },
      execSessionA,
    )
    assert.equal(editA.ok, true)
    assert.equal(editA.packetId, m1.packetId, 'Session A un-anchored edit must stay pinned to Mappe 1')

    const stM2 = await registered.get('galley_status').execute({}, execSessionB)
    assert.equal(stM2.packetId, m2.packetId)
    assert.equal(stM2.blocks.s1.length, 0, 'Mappe 2 must have zero stray blocks from Session A')
  } finally {
    dispose()
  }
})

test('typography & receipts: targetPagesMet, optional header.name, no double Aufgabe/Erwartungshorizont, per-block line reset, colWidths & German slug', async () => {
  // 1. Open single-sheet Mappe with German umlauts & ß + targetPages: 1
  const opened = await postJson('/api/galley/edit', {
    op: 'open',
    template: 'generic',
    title: 'Dreißigjähriger Krieg — Einführung',
    targetPages: 1,
    blocks: [
      // Teacher header WITHOUT `name` field -> must NOT emit "Name:"
      { type: 'header', fields: { titel: 'Quellensammlung', fach: 'Geschichte', klasse: '9' } },
      // Task already starting with "Aufgabe 1:" -> must NOT double-prepend
      { type: 'task', body: 'Aufgabe 1 (AB I): Nenne die Ursachen.' },
      // Two source_text blocks with lineNumbers + one overlong line (>92 chars) for wrap warning
      {
        type: 'source_text',
        title: 'Quelle M1',
        lineNumbers: { every: 5, start: 1 },
        body: 'Z1\nZ2\nZ3\nZ4\nZ5\n' + 'L'.repeat(105),
      },
      {
        type: 'source_text',
        title: 'Quelle M2',
        lineNumbers: { every: 5, start: 1 },
        body: 'Q1\nQ2\nQ3\nQ4\nQ5\nQ6',
      },
      // 5-column table with explicit colWidths + mini-markup inside 2D string cells!
      {
        type: 'table',
        colWidths: ['12%', '18%', '34%', '18%', '18%'],
        headers: ['Zeit', 'Phase', 'Leitfrage', 'Material', 'Anmerkungen'],
        rows: [['10 Min.', '**Einstieg** – Fenstersturz', 'Prager Fenstersturz?', 'Bild', 'Plenum']],
      },
    ],
  })
  assert.equal(opened.status, 200)
  const s1Proof = opened.json.proofs.s1
  assert.equal(s1Proof.targetPages, 1)
  assert.equal(s1Proof.targetPagesMet, true)

  // Inspect generated .typ for clean header (no Name:), no double Aufgabe 1, colWidths, and per-block state
  const { store } = getStoreForCwd(ws)
  const loaded = store.load(opened.json.packetId)
  const cs = compileSheet(loaded.sheets.s1, loaded.assets)
  assert.doesNotMatch(cs.typ, /Name:/)
  assert.doesNotMatch(cs.typ, /Aufgabe 1.*Aufgabe 1/)
  assert.match(cs.typ, /columns: \(12%, 18%, 34%, 18%, 18%\)/)
  assert.match(cs.typ, /#strong\[#text\("Einstieg"\)\]#text\(" – Fenstersturz"\)/)
  assert.match(cs.typ, /state\("g_ln_b3_2", none\)/)
  assert.match(cs.typ, /state\("g_ln_b4_3", none\)/)

  // Sheet starting with level-1 heading must NOT duplicate #title(...)
  const s2Sheet = {
    id: 's2',
    title: 'Erwartungshorizont',
    geometry: { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } },
    blocks: [
      {
        id: 'b9',
        type: 'heading',
        level: 1,
        hash: '',
        dependsOn: [],
        slot: { mode: 'full' },
        origin: 'agent',
        updatedAt: '',
        body: [{ t: 'text', v: 'Erwartungshorizont' }],
      },
    ],
  }
  assert.doesNotMatch(compileSheet(s2Sheet).typ, /#title\(/)

  // Verify preflight flags GALLEY_SOURCE_LINE_WRAP on overlong line in b3
  const st = await (await fetch(`${baseUrl}/api/galley/state?cwd=${encodeURIComponent(ws)}`)).json()
  assert.ok(
    st.preflight.some((w) => w.code === 'GALLEY_SOURCE_LINE_WRAP' && w.blockId === 'b3'),
    'overlong hard-broken source_text line must emit GALLEY_SOURCE_LINE_WRAP preflight hint',
  )

  // Export single-sheet packet -> clean German slug `dreissigjaehriger-krieg-einfuehrung.pdf` (no `-s1`!)
  const exp = await postJson('/api/galley/export', { format: 'pdf' })
  assert.equal(exp.status, 200)
  assert.equal(exp.json.files.length, 1)
  assert.equal(exp.json.files[0].path, 'galley-exports/dreissigjaehriger-krieg-einfuehrung.pdf')
  assert.ok(existsSync(join(ws, exp.json.files[0].path)))
})
