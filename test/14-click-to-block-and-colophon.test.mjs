/**
 * dsh-galley — 0.2.4 Direct-Manipulation Paper Hit-Bands & Opt-In Colophon Gate:
 *   1. `(pageIndex, yTopPt, yBottomPt, blockId)` hit-bands extracted from `#010000..#ff0000`
 *      Typst SVG anchors across single- and multi-page sheets, exposed on `SheetRender` and
 *      `GET /api/galley/state` (`StateProofView.hitBands`), mapped via `hitBandToPercentRect`,
 *      and omitted from LLM `SheetProofReceipt` to preserve zero token bloat.
 *   2. Opt-in `colophon?: boolean | string` (per packet, template blueprint, `saveAsTemplate`,
 *      `galley_open`, and HTTP `packet-set-colophon`) rendering a subtle `7.5pt` `#8A8379`
 *      bottom-margin line in Typst/PDF (`rgb(138, 131, 121)`) and `.docx` (`word/footer1.xml`,
 *      `<w:sz w:val="15"/>`, `<w:color w:val="8A8379"/>`), with zero overflow line-count drift
 *      and byte-identical legacy `.docx` when disabled.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyServiceRegistry,
  createGalleyHttpDispatcher,
  galleyExport,
  galleyOpen,
  galleyStatus,
  getStoreForCwd,
  resolveColophonText,
  unpackDocxEntries,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import { hitBandToPercentRect, withCwdQuery } from '../lib/galley-pane.mjs'
import { NativeArm, VERSION } from '../lib/index.js'

let tmpRoot
let nativeArm

before(async () => {
  _resetGalleyWorkspaceForTests()
  tmpRoot = mkdtempSync(join(tmpdir(), 'galley-024-'))
  nativeArm = new NativeArm()
  await nativeArm.init()
})

after(() => {
  _resetGalleyWorkspaceForTests()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDeps(cwd, registry = new GalleyServiceRegistry()) {
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
      render: (sheet, packet, assetBytes) => nativeArm.render(sheet, packet, assetBytes),
    },
  }
}

test('0.2.4 Item 1: Direct-manipulation hit-bands partition multi-page Typst SVG anchors without leaking into LLM receipts', async () => {
  assert.equal(VERSION, '0.2.5')
  const ws = join(tmpRoot, 'ws-hitbands')
  const registry = new GalleyServiceRegistry()
  const { deps } = makeDeps(ws, registry)

  // Build a multi-block packet that overflows onto page 2 (`pageIndex: 0` and `pageIndex: 1`)
  const longPara = Array.from(
    { length: 12 },
    (_, i) => `Sentence ${i + 1}: Deterministic block typesetting keeps geometry inspectable.`,
  ).join(' ')
  const blocks = [
    { type: 'header', fields: { title: 'Hit-Band Geometry Probe', subject: 'Typography', date: '2026-11-28' } },
    ...Array.from({ length: 8 }, (_, i) => ({
      type: i % 2 === 0 ? 'prose' : 'task',
      body: `Block ${i + 2}: ${longPara}`,
    })),
  ]

  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'Hit-Band Probe',
    targetPages: 1,
    blocks,
  })
  assert.equal(opened.ok, true)
  const pid = opened.packetId

  // 1. LLM receipt (`SheetProofReceipt`) MUST NOT bloat tokens with `hitBands`
  assert.equal('hitBands' in opened.proofs.s1, false, 'LLM SheetProofReceipt must omit hitBands')
  const st = await galleyStatus(deps, { packetId: pid })
  assert.equal('hitBands' in st.proofs.s1, false)
  assert.ok(st.proofs.s1.pages >= 2, `expected >= 2 pages, got ${st.proofs.s1.pages}`)

  // 2. HTTP `GET /api/galley/state` exposes ordered, non-overlapping `hitBands` on `StateProofView`
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
    const state = await (await fetch(withCwdQuery(`${baseUrl}/api/galley/state`, ws))).json()
    assert.equal(state.activePacket, true)
    const proof = state.proofs[0]
    assert.ok(Array.isArray(proof.hitBands))
    assert.equal(proof.hitBands.length, blocks.length, 'every block must produce one hit-band')

    // Verify page coverage (`pageIndex: 0` and `pageIndex: 1`) and vertical non-overlap per page
    const page0Bands = proof.hitBands.filter((b) => b.pageIndex === 0)
    const page1Bands = proof.hitBands.filter((b) => b.pageIndex === 1)
    assert.ok(page0Bands.length >= 2)
    assert.ok(page1Bands.length >= 1)

    for (const pBands of [page0Bands, page1Bands]) {
      for (let i = 0; i < pBands.length; i++) {
        const b = pBands[i]
        assert.ok(b.yTopPt >= 0 && b.yTopPt < b.yBottomPt, `invalid band bounds: ${JSON.stringify(b)}`)
        assert.ok(b.yBottomPt <= 842, `band exceeds A4 height: ${JSON.stringify(b)}`)
        if (i + 1 < pBands.length) {
          assert.ok(
            b.yBottomPt <= pBands[i + 1].yTopPt + 2,
            `adjacent bands must not overlap: ${JSON.stringify(b)} vs ${JSON.stringify(pBands[i + 1])}`,
          )
        }
        const pct = hitBandToPercentRect(b, 841.89)
        assert.ok(pct.topPct >= 0 && pct.topPct < 100)
        assert.ok(pct.heightPct >= 1.2 && pct.topPct + pct.heightPct <= 100.01)
      }
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

test('0.2.4 Item 2: Opt-in colophon (boolean | string) renders 7.5pt #8A8379 in PDF & .docx without overflow drift', async () => {
  const ws = join(tmpRoot, 'ws-colophon')
  const registry = new GalleyServiceRegistry()
  const { deps, store } = makeDeps(ws, registry)

  // Helper check on `resolveColophonText`
  assert.equal(resolveColophonText(undefined, 'en'), null)
  assert.equal(resolveColophonText(false, 'en'), null)
  assert.equal(resolveColophonText('   ', 'en'), null)
  assert.equal(resolveColophonText(true, 'en'), 'Typeset with dsh-galley')
  assert.equal(resolveColophonText(true, 'de'), 'Gesetzt mit dsh-galley')
  assert.equal(resolveColophonText('  Custom Studio Line  ', 'en'), 'Custom Studio Line')

  // 1. Open packet WITHOUT colophon -> baseline line count & zero `word/footer1.xml` in `.docx`
  const baseOpen = await galleyOpen(deps, {
    template: 'generic',
    title: 'Colophon Check',
    targetPages: 1,
    blocks: [
      { type: 'header', fields: { title: 'Colophon Typography Test', subject: 'Setzerei' } },
      { type: 'prose', body: 'Body paragraph above the bottom margin.' },
    ],
  })
  assert.equal(baseOpen.ok, true)
  const pid = baseOpen.packetId
  const baselineLines = baseOpen.proofs.s1.lastPageLineCount

  const docxOff = await galleyExport(deps, { packetId: pid, format: 'docx' })
  assert.equal(docxOff.ok, true)
  const offEntries = unpackDocxEntries(docxOff.bytes)
  assert.equal('word/footer1.xml' in offEntries, false, 'disabled colophon must omit word/footer1.xml')
  const typOff = await galleyExport(deps, { packetId: pid, format: 'typ' })
  assert.doesNotMatch(typOff.text, /footer:/)

  // 2. Enable `colophon: true` via store / HTTP route -> 7.5pt #8A8379 in Typst, PDF, and `.docx`, with ZERO line-count drift!
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
    const toggleOn = await fetch(`${baseUrl}/api/galley/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, packetId: pid, op: 'packet-set-colophon', colophon: true }),
    })
    assert.equal(toggleOn.status, 200)
    const toggleJson = await toggleOn.json()
    assert.equal(toggleJson.colophon, true)

    const stOn = await galleyStatus(deps, { packetId: pid })
    assert.equal(stOn.colophon, true)
    assert.equal(
      stOn.proofs.s1.lastPageLineCount,
      baselineLines,
      'bottom-margin colophon footer MUST NOT inflate body lastPageLineCount or overflowLinesOnLastPage',
    )

    const typBool = await galleyExport(deps, { packetId: pid, format: 'typ' })
    assert.match(
      typBool.text,
      /footer: align\(left\)\[#text\(size: 7\.5pt, fill: rgb\(138, 131, 121\), "Typeset with dsh-galley"\)\]/,
    )

    // Custom string with Typst/XML metacharacters (`#`, `$`, `&`, `<`) compiles cleanly in PDF & `.docx`!
    const customLine = 'Ivory Tower Studio · #1 Draft & $100% <Verified>'
    const setCustom = await fetch(`${baseUrl}/api/galley/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, packetId: pid, op: 'packet-set-colophon', colophon: customLine }),
    })
    assert.equal(setCustom.status, 200)

    const pdfCustom = await galleyExport(deps, { packetId: pid, format: 'pdf' })
    assert.equal(pdfCustom.ok, true)
    assert.equal(pdfCustom.bytes.subarray(0, 5).toString('utf8'), '%PDF-')
    const pdfPath = join(ws, 'colophon-custom.pdf')
    writeFileSync(pdfPath, pdfCustom.bytes)
    const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' })
    assert.match(pdfText, /Ivory Tower Studio/)

    const docxCustom = await galleyExport(deps, { packetId: pid, format: 'docx' })
    assert.equal(docxCustom.ok, true)
    const docxPath = join(ws, 'colophon-custom.docx')
    writeFileSync(docxPath, docxCustom.bytes)
    execFileSync('unzip', ['-t', docxPath], { stdio: 'pipe' })

    const entries = unpackDocxEntries(docxCustom.bytes)
    assert.ok('word/footer1.xml' in entries, 'enabled colophon must emit word/footer1.xml')
    const footerXml = entries['word/footer1.xml'].toString('utf8')
    assert.match(footerXml, /<w:color w:val="8A8379"\/>/)
    assert.match(footerXml, /<w:sz w:val="15"\/>/)
    assert.match(footerXml, /Ivory Tower Studio · #1 Draft &amp; \$100% &lt;Verified&gt;/)
    assert.match(entries['word/document.xml'].toString('utf8'), /<w:footerReference w:type="default" r:id="rIdFooter1"\/>/)
    assert.match(entries['word/_rels/document.xml.rels'].toString('utf8'), /Id="rIdFooter1"[^>]*Target="footer1\.xml"/)
    assert.match(entries['[Content_Types].xml'].toString('utf8'), /PartName="\/word\/footer1\.xml"/)

    // 3. Template blueprint inheritance (`saveAsTemplate` + `galleyOpen` from colophon-enabled template)
    const savedBp = store.saveAsTemplate(pid, { title: 'Studio Colophon Blueprint' })
    assert.equal(savedBp.colophon, customLine)
    const fromBp = await galleyOpen(deps, { template: savedBp.id, title: 'Inherited Doc' })
    assert.equal(fromBp.ok, true)
    assert.equal(fromBp.colophon, customLine)

    // 4. Turning colophon off (`false`) restores byte-identical footer-free `.docx` structure
    await fetch(`${baseUrl}/api/galley/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws, packetId: pid, op: 'packet-set-colophon', colophon: false }),
    })
    const docxCleared = await galleyExport(deps, { packetId: pid, format: 'docx' })
    assert.equal('word/footer1.xml' in unpackDocxEntries(docxCleared.bytes), false)
  } finally {
    await new Promise((r) => srv.close(r))
  }
})
