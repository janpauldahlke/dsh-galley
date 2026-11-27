/**
 * CR-001 — full-width `media-below` slot, `.docx` SVG dimensions, `removeAsset`.
 *
 * Hermetic: no dsh bootstrap, no network, no typst binary.
 *   1. `media-below` slot: validator accepts it (with asset), rejects it
 *      without one; the Typst arm emits a full-width figure below the body.
 *   2. `.docx` SVG dimensions: `probeSvgDimensions` / `probeImageDimensions`
 *      read `width`/`height` (and `viewBox` fallback); SVG assets are
 *      rasterized to PNG in the .docx at 2x intrinsic width, and
 *      `wp:extent` preserves the aspect ratio (no more 4:3 stretch).
 *   3. `GalleyStore.removeAsset`: frees capacity, unlinks bytes, refuses to
 *      remove an asset still referenced by a block's slot.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GalleyStore,
  StoreError,
  MAX_ASSETS_PER_PACKET,
  galleyOpen,
  galleyEditBlock,
  galleyExport,
  unpackDocxEntries,
  probeImageDimensions,
  probeSvgDimensions,
  validateSlot,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import { compileSheet } from '../lib/typst-render.mjs'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="220" viewBox="0 0 680 220">' +
    '<rect width="680" height="220" fill="#eef2ff"/>' +
    '<text x="20" y="40" font-size="24">Timeline</text></svg>',
)
const SVG_VIEWBOX_ONLY = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300"/></svg>',
)
const SVG_PERCENT_WIDTH = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 300 150"><rect width="300" height="150"/></svg>',
)

let workspaceDir
let store
let deps

before(() => {
  _resetGalleyWorkspaceForTests()
  workspaceDir = mkdtempSync(join(tmpdir(), 'galley-cr001-'))
  store = new GalleyStore(join(workspaceDir, '.dsh', 'galley'))
  deps = { store, cwd: workspaceDir }
})

after(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

test('CR-001.1: probeSvgDimensions parses width/height, viewBox fallback, rejects junk', () => {
  assert.deepEqual(probeSvgDimensions(SVG), { widthPx: 680, heightPx: 220 })
  assert.deepEqual(probeSvgDimensions(Buffer.from('<svg width="680" height="220"/>')), { widthPx: 680, heightPx: 220 })
  // viewBox fallback when width/height are percentage-based
  assert.deepEqual(probeSvgDimensions(SVG_VIEWBOX_ONLY), { widthPx: 480, heightPx: 300 })
  assert.deepEqual(probeSvgDimensions(SVG_PERCENT_WIDTH), { widthPx: 300, heightPx: 150 })
  // unit suffixes are stripped; non-numeric / missing → null
  assert.deepEqual(probeSvgDimensions(Buffer.from('<svg width="680px" height="220px">')), { widthPx: 680, heightPx: 220 })
  assert.equal(probeSvgDimensions(Buffer.from('<svg width="100%" height="100%"/>')), null)
  assert.equal(probeSvgDimensions(Buffer.from('<svg>')), null)
  assert.equal(probeSvgDimensions(Buffer.from('not an svg')), null)
  // probeImageDimensions now covers SVG and keeps its 400x300 fallback
  assert.deepEqual(probeImageDimensions(SVG), { widthPx: 680, heightPx: 220 })
  assert.deepEqual(probeImageDimensions(Buffer.from('not an image at all')), { widthPx: 400, heightPx: 300 })
})

test('CR-001.1: validateSlot accepts media-below with asset, rejects without', () => {
  assert.equal(validateSlot({ mode: 'media-below' }), 'invalid_slot')
  assert.equal(validateSlot({ mode: 'media-below', asset: { id: 'a1', path: 'assets/a1.svg', alt: 'x' } }), null)
  // existing rules untouched
  assert.equal(validateSlot({ mode: 'full', asset: { id: 'a1', path: 'assets/a1.png', alt: '' } }), 'invalid_slot')
  assert.equal(validateSlot({ mode: 'full' }), null)
})

test('CR-001.1: media-below renders full-width figure below body in Typst', () => {
  const sheet = {
    id: 's1',
    title: 'Media Below',
    geometry: { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } },
    blocks: [
      {
        id: 'b1',
        type: 'prose',
        hash: '',
        dependsOn: [],
        slot: { mode: 'media-below', asset: { id: 'a1', path: 'assets/a1.svg', alt: 'fig' } },
        body: [{ t: 'text', v: 'Hello' }],
        origin: 'agent',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'b2',
        type: 'prose',
        hash: '',
        dependsOn: [],
        slot: { mode: 'media-below', asset: { id: 'a1', path: 'assets/a1.svg', alt: 'fig' } },
        body: [],
        origin: 'agent',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  const { typ } = compileSheet(sheet, { a1: { path: 'assets/a1.svg' } })
  assert.match(
    typ,
    /#stack\(dir: ttb, spacing: 8pt, \[#text\("Hello"\)\], align\(center\)\[#image\("assets\/a1\.svg", width: 100%\)\]\)/,
    'media-below emits body then centered full-width image',
  )
  // empty body → bare centered image, no empty stack item
  assert.match(typ, /#align\(center\)\[#image\("assets\/a1\.svg", width: 100%\)\]/)
})

test('CR-001.1/2.2: media-below in .docx = full-width rasterized SVG, no table wrapper', async () => {
  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'CR001 Docx',
    origin: 'agent',
    assets: [{ id: 'a1', path: 'assets/a1.svg', mimeType: 'image/svg+xml' }],
  })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const pid = opened.packetId
  store.addAsset(pid, { id: 'a1', path: 'assets/a1.svg', bytesSha256: sha256(SVG), mimeType: 'image/svg+xml' }, SVG)

  const ins = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: {
      type: 'prose',
      body: 'Figure below',
      slot: { mode: 'media-below', asset: { id: 'a1', path: 'assets/a1.svg', alt: 'Timeline' } },
    },
  })
  assert.equal(ins.ok, true, JSON.stringify(ins))

  const exp = await galleyExport(deps, { packetId: pid, format: 'docx' })
  assert.equal(exp.ok, true, JSON.stringify(exp))
  const parts = unpackDocxEntries(exp.bytes)

  // SVG was rasterized: the part is a real PNG at 2x intrinsic size (1360x440)
  assert.ok(parts['word/media/a1.png'], 'SVG asset must be embedded as a PNG part')
  assert.equal(parts['word/media/a1.png'].length >= 8, true)
  const png = parts['word/media/a1.png']
  assert.equal(png.readUInt32BE(16), 1360, 'PNG width = 2 x intrinsic width')
  assert.equal(png.readUInt32BE(20), 440, 'PNG height = 2 x intrinsic height')
  assert.ok(!('word/media/a1.svg' in parts), 'raw SVG must not be embedded')
  assert.match(parts['[Content_Types].xml'].toString('utf8'), /Extension="png"/)

  const doc = parts['word/document.xml'].toString('utf8')
  assert.ok(!doc.includes('<w:tbl>'), 'media-below must not use a table wrapper')
  const m = doc.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)
  assert.ok(m, 'inline image extent present')
  const cx = Number(m[1])
  const cy = Number(m[2])
  const expected = 220 / 680
  assert.ok(Math.abs(cy / cx - expected) < 0.01, `aspect ratio ${cy / cx} must match 220/680=${expected}`)
})

test('CR-001.2.2: viewBox-only SVG keeps its ratio in .docx', async () => {
  const opened = await galleyOpen(deps, {
    template: 'generic',
    title: 'CR001 ViewBox',
    origin: 'agent',
    assets: [{ id: 'a1', path: 'assets/a1.svg', mimeType: 'image/svg+xml' }],
  })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const pid = opened.packetId
  store.addAsset(pid, { id: 'a1', path: 'assets/a1.svg', bytesSha256: sha256(SVG_VIEWBOX_ONLY), mimeType: 'image/svg+xml' }, SVG_VIEWBOX_ONLY)

  const ins = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'prose', body: 'x', slot: { mode: 'media-below', asset: { id: 'a1', path: 'assets/a1.svg', alt: '' } } },
  })
  assert.equal(ins.ok, true, JSON.stringify(ins))

  const exp = await galleyExport(deps, { packetId: pid, format: 'docx' })
  assert.equal(exp.ok, true, JSON.stringify(exp))
  const parts = unpackDocxEntries(exp.bytes)
  const png = parts['word/media/a1.png']
  assert.equal(png.readUInt32BE(16), 960, 'viewBox width 480 rasterized at 2x')
  assert.equal(png.readUInt32BE(20), 600, 'viewBox height 300 rasterized at 2x')
  const m = parts['word/document.xml'].toString('utf8').match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)
  assert.ok(m)
  const expected = 300 / 480
  assert.ok(Math.abs(Number(m[2]) / Number(m[1]) - expected) < 0.01, 'viewBox aspect ratio preserved')
})

test('CR-001.3: removeAsset frees the slot, unlinks bytes, refuses referenced assets', async () => {
  const opened = await galleyOpen(deps, { template: 'generic', title: 'CR001 Assets', origin: 'agent' })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const pid = opened.packetId

  // Fill to the 20-asset cap, then show removal frees a slot.
  for (let i = 1; i <= MAX_ASSETS_PER_PACKET; i++) {
    store.addAsset(pid, { id: `a${i}`, path: `assets/a${i}.png`, bytesSha256: sha256(SVG), mimeType: 'image/svg+xml' }, SVG, { bumpRev: false })
  }
  assert.throws(
    () => store.addAsset(pid, { id: 'a21', path: 'assets/a21.png', bytesSha256: sha256(SVG), mimeType: 'image/svg+xml' }, SVG, { bumpRev: false }),
    /asset_limit|already holds/,
  )
  assert.equal(store.removeAsset(pid, 'a20', { bumpRev: false }), true)
  assert.equal(existsSync(join(workspaceDir, '.dsh', 'galley', pid, 'assets', 'a20.svg')), false)
  store.addAsset(pid, { id: 'a21', path: 'assets/a21.png', bytesSha256: sha256(SVG), mimeType: 'image/svg+xml' }, SVG, { bumpRev: false })
  assert.ok('a21' in store.load(pid).assets, 'freed slot is reusable')

  // Unknown asset → false (no throw).
  assert.equal(store.removeAsset(pid, 'a-does-not-exist'), false)

  // A referenced asset cannot be removed: live sheets must never break.
  const ins = await galleyEditBlock(deps, {
    sheetId: 's1',
    op: 'insert',
    origin: 'agent',
    block: { type: 'prose', body: 'ref', slot: { mode: 'media-below', asset: { id: 'a21', path: 'assets/a21.png', alt: '' } } },
  })
  assert.equal(ins.ok, true, JSON.stringify(ins))
  assert.throws(
    () => store.removeAsset(pid, 'a21'),
    (err) => err instanceof StoreError && err.code === 'invalid_op' && /a21/.test(err.message) && /referenced/.test(err.message),
  )
  assert.ok('a21' in store.load(pid).assets, 'referenced asset survives the rejected removal')

  // Unreferenced removal still works and bumps rev.
  const revBefore = store.load(pid).rev
  assert.equal(store.removeAsset(pid, 'a19'), true)
  assert.ok(!('a19' in store.load(pid).assets))
  assert.equal(store.load(pid).rev, revBefore + 1, 'removal bumps rev by default')
})
