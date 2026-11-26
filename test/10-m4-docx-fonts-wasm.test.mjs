/**
 * dsh-galley — M4 Hard-Stop Gate:
 *   1. Deterministic zero-dep `.docx` OOXML exporter (Spec 03 §8, all 8 block types × 5 slots,
 *      landscape + `locale: 'de'`, adversarial XML escaping, `AIAssistance: true`, SHA-256 determinism).
 *   2. Multi-sheet 5-format export (`pdf`, `docx`, `typ`, `tex`, `md`) + HTTP `/export` & `/download` MIME check
 *      + `registerGalleyTools` lossless JSON `files[]` receipt.
 *   3. Offline SIL-OFL-1.1 bundled font set (`fonts/`) + 100% offline `WasmArm` fallback parity
 *      (umlauts `ÄÖÜß` + bold/italic/code + `$…$` math + PNG media + multi-page + `GALLEY_TYPST_ARM=wasm`,
 *      with `globalThis.fetch` poisoned to prove zero network access).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyStore,
  galleyOpen,
  galleyEditBlock,
  galleyExport,
  unpackDocxEntries,
  createGalleyHttpDispatcher,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import {
  NativeArm,
  WasmArm,
  createPrimaryArm,
  BUNDLED_FONT_FILES,
  loadBundledFontBlobs,
  resolveBundledFontsDir,
  registerGalleyTools,
} from '../lib/index.js'

/** Valid 1×1 RGBA PNG accepted by both Native and WASM image decoders. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const T = (v) => ({ t: 'text', v })

let workspaceDir
let store
let nativeArm
let deps

before(async () => {
  _resetGalleyWorkspaceForTests()
  workspaceDir = mkdtempSync(join(tmpdir(), 'galley-m4-gate-'))
  store = new GalleyStore(join(workspaceDir, '.dsh', 'galley'))
  nativeArm = new NativeArm()
  await nativeArm.init()
  deps = {
    store,
    cwd: workspaceDir,
    render: (sheet, packet, assetBytes) => nativeArm.render(sheet, packet, assetBytes),
  }
})

after(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

test('M4.1: 5-format multi-sheet export + OOXML structure + unzip CRC + SHA-256 determinism', async () => {
  const opened = await galleyOpen(deps, {
    template: 'worksheet',
    title: 'M4 Prüfungsbogen & ÄÖÜß',
    origin: 'human',
    assets: [
      { id: 'a1', path: 'assets/a1.png', mimeType: 'image/png' },
      { id: 'a2', path: 'assets/a2.png', mimeType: 'image/png' },
    ],
  })
  assert.equal(opened.ok, true)
  const pid = opened.packetId
  store.addAsset(pid, { id: 'a1', path: 'assets/a1.png', bytesSha256: sha256(PNG), mimeType: 'image/png' }, PNG)
  store.addAsset(pid, { id: 'a2', path: 'assets/a2.png', bytesSha256: sha256(PNG), mimeType: 'image/png' }, PNG)

  // Populate s1 with every remaining block type, inline variant, layout slot, and XML-adversarial text.
  const edits = [
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'heading',
        level: 2,
        body: 'Section 1: Umlaute ÄÖÜäöüß & Adversarial <w:p>"\'&]]>',
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'source_text',
        title: 'Primary Source Excerpt',
        body: 'Line one\nLine two\nLine three\nLine four\nLine five with ß',
        lineNumbers: { every: 5, start: 1 },
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: [
          T('Rich inline check: '),
          { t: 'strong', c: [T('bold')] },
          T(', '),
          { t: 'emph', c: [T('italic')] },
          T(', '),
          { t: 'code', v: 'const x = a < b && c > d' },
          T(', cloze '),
          { t: 'cloze', hint: 'answer' },
          T(', formula '),
          { t: 'math', v: 'sum_(i=1)^n x_i^2 = sqrt(a^2 + b^2)' },
          T('.'),
        ],
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'table',
        colWidths: ['25%', '75%'],
        headers: ['Concept', 'Explanation'],
        rows: [
          ['OOXML', '**Borderless** media tables avoid floating anchor drift'],
          ['Determinism', 'Pinned DOS timestamp yields identical SHA-256'],
        ],
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'callout',
        tone: 'info',
        body: 'Remember to check all units before submitting.',
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: 'Media right caption beside embedded PNG diagram.',
        slot: { mode: 'media-right', asset: { id: 'a1', path: 'assets/a1.png', alt: 'Right Diagram', widthCm: 4 } },
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: 'Media left caption beside second embedded PNG diagram.',
        slot: { mode: 'media-left', asset: { id: 'a2', path: 'assets/a2.png', alt: 'Left Diagram' } },
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: 'First balanced column chunk with several words for deterministic splitting across two columns neatly.',
        slot: { mode: 'two-column' },
      },
    },
    {
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: 'Card Alpha\nCard Beta\nCard Gamma\nCard Delta',
        slot: { mode: 'card-grid', columns: 2, cardHeightCm: 4 },
      },
    },
  ]

  // Human edits `b1` header so `b1` transitions to `origin === 'human'` while `b2, b5..b13` stay `agent`
  await galleyEditBlock(deps, {
    packetId: pid,
    sheetId: 's1',
    op: 'patch',
    origin: 'human',
    blockId: 'b1',
    patch: { fields: { titel: 'M4 Prüfungsbogen & ÄÖÜß', fach: 'Physics', klasse: '10a', name: '' } },
  })

  for (const ed of edits) {
    const res = await galleyEditBlock(deps, ed)
    assert.equal(res.ok, true, JSON.stringify(res))
  }

  // Export all 5 formats into `<workspaceDir>/galley-exports/`
  for (const fmt of ['pdf', 'docx', 'typ', 'tex', 'md']) {
    const exp = await galleyExport(deps, { packetId: pid, format: fmt, outDir: workspaceDir })
    assert.equal(exp.ok, true, `export ${fmt} failed: ${JSON.stringify(exp)}`)
    assert.equal(exp.files.length, 2, `${fmt} should emit 2 files for 2-sheet packet`)
    for (const f of exp.files) {
      const abs = join(workspaceDir, f.path)
      assert.ok(existsSync(abs), `missing exported file ${f.path}`)
      const diskBytes = readFileSync(abs)
      assert.equal(diskBytes.length, f.sizeBytes)
      assert.equal(sha256(diskBytes), f.sha256)
    }
  }

  // Byte-for-byte SHA-256 determinism on repeated `.docx` exports at fixed rev
  const docxRun1 = await galleyExport(deps, { packetId: pid, format: 'docx', outDir: workspaceDir })
  const docxRun2 = await galleyExport(deps, { packetId: pid, format: 'docx', outDir: workspaceDir })
  assert.equal(docxRun1.files[0].sha256, docxRun2.files[0].sha256, 's1 .docx SHA-256 must be byte-deterministic')
  assert.equal(docxRun1.files[1].sha256, docxRun2.files[1].sha256, 's2 .docx SHA-256 must be byte-deterministic')

  const s1DocxPath = join(workspaceDir, docxRun1.files[0].path)
  const s2DocxPath = join(workspaceDir, docxRun1.files[1].path)

  // Verify ZIP archive & CRC-32 integrity via system `/usr/bin/unzip -t` if available
  if (existsSync('/usr/bin/unzip')) {
    const uz1 = execFileSync('/usr/bin/unzip', ['-t', s1DocxPath], { encoding: 'utf8' })
    const uz2 = execFileSync('/usr/bin/unzip', ['-t', s2DocxPath], { encoding: 'utf8' })
    assert.match(uz1, /No errors detected in compressed data/)
    assert.match(uz2, /No errors detected in compressed data/)
  }

  // Verify PDF text extraction via `/usr/bin/pdftotext` if available
  if (existsSync('/usr/bin/pdftotext')) {
    const s1PdfPath = join(workspaceDir, 'galley-exports', 'm4-pruefungsbogen-aeoeuess-s1.pdf')
    const txt = execFileSync('/usr/bin/pdftotext', [s1PdfPath, '-'], { encoding: 'utf8' })
    assert.match(txt, /ÄÖÜäöüß/)
    assert.match(txt, /Borderless/)
  }

  // Inspect unpacked OOXML parts on s1 & s2
  const parts1 = unpackDocxEntries(readFileSync(s1DocxPath))
  for (const reqPart of [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/core.xml',
    'docProps/app.xml',
    'docProps/custom.xml',
    'word/_rels/document.xml.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
    'word/media/a1.png',
    'word/media/a2.png',
  ]) {
    assert.ok(parts1[reqPart], `missing OOXML part: ${reqPart}`)
  }
  assert.deepEqual(parts1['word/media/a1.png'], PNG, 'embedded PNG bytes must be lossless')

  const doc1 = parts1['word/document.xml'].toString('utf8')
  const custom1 = parts1['docProps/custom.xml'].toString('utf8')
  const core1 = parts1['docProps/core.xml'].toString('utf8')

  // Spec 03 §8 construct checks
  assert.match(doc1, /<w:pStyle w:val="Heading2"\/>/, 'heading maps to real Word Heading2 style')
  assert.match(doc1, /&lt;w:p&gt;&quot;&apos;&amp;]]&gt;/, 'adversarial XML text is totally escaped')
  assert.ok(!doc1.includes('<wp:anchor'), 'media slots must use inline borderless tables, never floating anchors')
  assert.match(doc1, /<wp:inline\b/, 'media slots embed wp:inline drawing')
  assert.match(doc1, /<w:top w:val="none"/, 'header/media/two-col tables use borderless cells')
  assert.match(doc1, /<w:tblHeader\/>/, 'data table marks repeating header row')
  assert.match(doc1, /<w:left w:val="single" w:sz="24" w:space="8" w:color="1A73E8"\/>/, 'callout 3pt accent border')
  assert.match(doc1, /<w:shd w:val="clear" w:color="auto" w:fill="E8F0FE"\/>/, 'callout light fill')
  assert.match(doc1, /<w:lnNumType w:countBy="5" w:start="1"/, 'source_text sets section line numbers')
  assert.match(doc1, /<m:oMath><m:r><m:t xml:space="preserve">sum_\(i=1\)\^n/, 'math emits m:oMath')
  assert.match(doc1, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/, 'task uses numbering definition')

  // AI-assistance custom & core properties (`b1` was human-edited, so only agent-origin blocks are listed)
  assert.match(custom1, /name="AIAssistance"><vt:bool>true<\/vt:bool>/)
  assert.match(custom1, /name="AIAssistedBlocks"><vt:lpwstr>b2, b5, b6, b7, b8, b9, b10, b11, b12, b13<\/vt:lpwstr>/)
  assert.match(core1, /<dc:creator>dsh-galley<\/dc:creator>/)
  assert.match(core1, /Co-authored with DeepSeek Harness \(dsh-galley\); AI-assisted blocks:/)

  // Check s2 (`answer` block linked via `dependsOn: ['b2']` carries `Answer (Task 1): `)
  const parts2 = unpackDocxEntries(readFileSync(s2DocxPath))
  const doc2 = parts2['word/document.xml'].toString('utf8')
  assert.match(doc2, /Answer \(Task 1\): /)
})

test('M4.1b: Landscape + German locale (`locale: "de"`) .docx & HTTP download MIME + lossless tool JSON', async () => {
  const deOpen = await galleyOpen(deps, {
    title: 'Verlaufsplan Geschichte',
    locale: 'de',
    orientation: 'landscape',
    blocks: [
      { type: 'header', fields: { titel: 'Industrialisierung', fach: 'Geschichte', klasse: '9b', name: '' } },
      { type: 'task', body: 'Analysiere die Quelle.' },
      { type: 'answer', dependsOn: ['b2'], body: 'Industrialisierung veränderte die Arbeitswelt.' },
    ],
  })
  assert.equal(deOpen.ok, true)

  const docxRes = await galleyExport(deps, { packetId: deOpen.packetId, format: 'docx' })
  assert.equal(docxRes.ok, true)
  const parts = unpackDocxEntries(docxRes.bytes)
  const docXml = parts['word/document.xml'].toString('utf8')
  const stylesXml = parts['word/styles.xml'].toString('utf8')

  assert.match(docXml, /w:orient="landscape"/, 'landscape sheet sets w:orient="landscape"')
  assert.match(docXml, />Fach</, 'de locale uses German header label Fach')
  assert.match(docXml, />Klasse</, 'de locale uses German header label Klasse')
  assert.match(docXml, /Lösung \(Aufgabe 1\): /, 'de locale formats linked answer prefix in German')
  assert.match(stylesXml, /<w:lang w:val="de-DE"\/>/, 'de locale sets de-DE proofing language')

  // Verify HTTP `/api/galley/export` + `/api/galley/download` serves official OOXML MIME type
  const dispatch = createGalleyHttpDispatcher({
    getDepsForCwd: async () => ({ deps, root: store.root, cwd: workspaceDir }),
  })
  const srv = createServer(async (req, res) => {
    const handled = await dispatch(req, res)
    if (!handled) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  try {
    const expResp = await fetch(`http://127.0.0.1:${port}/api/galley/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packetId: deOpen.packetId, format: 'docx' }),
    })
    assert.equal(expResp.status, 200)
    const expBody = await expResp.json()
    assert.equal(expBody.ok, true)
    assert.equal(expBody.files.length, 1)
    assert.match(expBody.files[0].path, /\.docx$/)

    const dlResp = await fetch(
      `http://127.0.0.1:${port}/api/galley/download?path=${encodeURIComponent(expBody.files[0].path)}`,
    )
    assert.equal(dlResp.status, 200)
    assert.equal(
      dlResp.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const dlBuf = Buffer.from(await dlResp.arrayBuffer())
    assert.equal(sha256(dlBuf), expBody.files[0].sha256)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }

  // Verify `registerGalleyTools` (`galley_export.execute`) strips `Buffer` for DSH lossless JSON
  const registered = new Map()
  registerGalleyTools({
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => {}
      },
    },
  })
  const exportTool = registered.get('galley_export')
  assert.ok(exportTool)
  const toolOut = await exportTool.execute(
    { cwd: workspaceDir, packetId: deOpen.packetId, format: 'docx' },
    { agent: { session: { id: 'sess-m4', header: { cwd: workspaceDir } } } },
  )
  assert.equal(toolOut.ok, true)
  assert.equal('bytes' in toolOut, false, 'tool execute() must strip raw Buffer for lossless JSON')
  assert.equal(JSON.parse(JSON.stringify(toolOut)).files[0].format, 'docx')
})

test('M4.2: Bundled SIL-OFL-1.1 fonts + 100% offline WasmArm parity (fetch poisoned)', async () => {
  const fontsDir = resolveBundledFontsDir()
  assert.ok(fontsDir && existsSync(join(fontsDir, 'OFL.txt')), 'fonts/OFL.txt must exist in bundle')
  for (const file of BUNDLED_FONT_FILES) {
    assert.ok(existsSync(join(fontsDir, file)), `missing bundled font ${file}`)
  }
  const blobs = loadBundledFontBlobs()
  assert.equal(blobs.length, BUNDLED_FONT_FILES.length)

  // Poison `globalThis.fetch` so ANY attempted CDN font fetch immediately fails the test!
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    throw new Error(`OFFLINE GATE VIOLATION: WasmArm attempted network fetch to ${String(url)}`)
  }

  const prevEnv = process.env.GALLEY_TYPST_ARM
  process.env.GALLEY_TYPST_ARM = 'wasm'
  try {
    const primary = await createPrimaryArm()
    assert.equal(primary.arm.name, 'wasm')
    assert.deepEqual(primary.available, ['wasm'])

    const wasmArm = new WasmArm()
    await wasmArm.init()

    // Build a multi-page packet exercising umlauts, bold/italic/code, math, table, and PNG media
    const fillerParagraphs = Array.from({ length: 36 }, (_, i) => ({
      type: 'prose',
      body: `Paragraph ${i + 1}: Offline WASM & Native parity check with ÄÖÜäöüß, **bold**, *italic*, and \`mono()\` across A4 pages.`,
    }))
    const opened = await galleyOpen(deps, {
      title: 'WASM Offline Parity',
      locale: 'de',
      assets: [{ id: 'a1', path: 'assets/a1.png', mimeType: 'image/png' }],
      blocks: [
        { type: 'header', fields: { titel: 'WASM Offline Test ÄÖÜß', fach: 'Physik', klasse: '11', name: '' } },
        {
          type: 'prose',
          body: [
            T('Formel: '),
            { t: 'math', v: 'E = m c^2 + sum_(k=1)^n alpha_k / sqrt(k)' },
            T(' und Code '),
            { t: 'code', v: 'fn main() {}' },
          ],
        },
        {
          type: 'table',
          headers: ['Größe', 'Einheit'],
          rows: [['Energie', 'Joule (J)'], ['Masse', 'Kilogramm (kg)']],
        },
        ...fillerParagraphs,
      ],
    })
    assert.equal(opened.ok, true)
    store.addAsset(
      opened.packetId,
      { id: 'a1', path: 'assets/a1.png', bytesSha256: sha256(PNG), mimeType: 'image/png' },
      PNG,
    )
    await galleyEditBlock(deps, {
      packetId: opened.packetId,
      sheetId: 's1',
      op: 'insert',
      origin: 'agent',
      block: {
        type: 'prose',
        body: 'Diagramm mit eingebettetem PNG im Offline-Modus.',
        slot: { mode: 'media-right', asset: { id: 'a1', path: 'assets/a1.png', alt: 'Offline PNG' } },
      },
    })

    const packet = store.load(opened.packetId)
    const sheet = packet.sheets.s1
    const nativeRender = await nativeArm.render(sheet, packet, { a1: PNG })
    const wasmRender = await wasmArm.render(sheet, packet, { a1: PNG })

    assert.equal(wasmRender.pdf.subarray(0, 5).toString('utf8'), '%PDF-')
    assert.ok(wasmRender.pages >= 2, `expected multi-page render, got ${wasmRender.pages}`)
    assert.equal(wasmRender.pages, nativeRender.pages, 'WASM and Native arms must agree on page count')
    assert.equal(wasmRender.svgPages.length, wasmRender.pages)
    assert.equal(wasmRender.diagnostics.length, 0)
    assert.equal(
      Object.keys(wasmRender.blockToPage).length,
      sheet.blocks.length,
      'WASM SVG receipt must attribute every block to a page',
    )
    assert.equal(wasmRender.blockToPage.b1, 0)
    assert.ok(
      wasmRender.blockToPage[sheet.blocks[sheet.blocks.length - 1].id] >= 1,
      'last block on multi-page WASM render must sit on page >= 1',
    )

    if (existsSync('/usr/bin/pdftotext')) {
      const wasmPdfFile = join(workspaceDir, 'wasm-offline.pdf')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(wasmPdfFile, wasmRender.pdf)
      const extracted = execFileSync('/usr/bin/pdftotext', [wasmPdfFile, '-'], { encoding: 'utf8' })
      assert.match(extracted, /WASM Offline Test ÄÖÜß/)
      assert.match(extracted, /Kilogramm/)
    }
  } finally {
    globalThis.fetch = realFetch
    if (prevEnv === undefined) delete process.env.GALLEY_TYPST_ARM
    else process.env.GALLEY_TYPST_ARM = prevEnv
  }
})
