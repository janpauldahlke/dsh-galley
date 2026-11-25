/**
 * dsh-galley — M1 native-arm gate (spec 05 §4 guardrails: "native arm < 2 ms
 * warm" + "1+1 page proof").
 *
 * Feeds `compileSheet`'s generated `.typ` (M1 sheet AST + anchors) through the
 * REAL N-API compiler, derives the receipt from the stacked SVG, and proves:
 *   • a 1-block sheet renders to exactly 1 page (block on page 0);
 *   • a large sheet overflows to ≥ 2 pages with a correct block→page mapping;
 *   • a warm native compile averages < 2 ms.
 * Run after `node build.mjs` (imports `lib/typst-render.mjs` + the external arm).
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { compileSheet, deriveReceipt } from '../lib/typst-render.mjs'

let compiler

before(async () => {
  const mod = await import('@myriaddreamin/typst-ts-node-compiler')
  compiler = mod.NodeCompiler.create()
  compiler.compile({ mainFileContent: 'warm' }) // warm the N-API handle
})

const geom = { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } }
const T = (v) => ({ t: 'text', v })
const B = (id, type, extra = {}) => ({
  id, type, hash: '', dependsOn: [], slot: { mode: 'full' }, origin: 'agent', updatedAt: '', ...extra,
})
const sheetOf = (blocks, targetPages) => ({ id: 's1', title: 'T', geometry: { ...geom, targetPages }, blocks })

function render(blocks, targetPages) {
  const cs = compileSheet(sheetOf(blocks, targetPages))
  const r = compiler.compile({ mainFileContent: cs.typ })
  assert.equal(r.hasError(), false, 'native compile must not error')
  const svg = compiler.svg(r.result)
  const receipt = deriveReceipt(
    typeof svg === 'string' ? svg : svg.toString(),
    r.result.numOfPages,
    cs.pageHeightPt,
    cs.targetPages,
    cs.anchors,
  )
  return { receipt, numOfPages: r.result.numOfPages, pdf: compiler.pdf(r.result) }
}

test('1-page proof: one short block renders to exactly 1 page on page 0', () => {
  const { receipt, numOfPages } = render([B('b1', 'prose', { body: [T('one short line')] })])
  assert.equal(numOfPages, 1)
  assert.equal(receipt.pages, 1)
  assert.equal(receipt.blockToPage['b1'], 0)
  assert.equal(receipt.overflowLinesOnLastPage, 0)
})

test('overflow proof: 40 blocks → ≥2 pages, first block p0, last block later', () => {
  const N = 40
  const blocks = Array.from({ length: N }, (_, i) =>
    B('b' + (i + 1), 'prose', { body: [T('Line ' + i + '. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.')] }),
  )
  const { receipt, numOfPages } = render(blocks)
  assert.ok(numOfPages >= 2, `should overflow to ≥2 pages (got ${numOfPages})`)
  assert.equal(receipt.pages, numOfPages)
  assert.equal(receipt.perPage.length, numOfPages) // perPage matches page count
  assert.equal(receipt.blockToPage['b1'], 0)
  const lastPage = receipt.blockToPage['b' + N]
  assert.ok(lastPage >= 1, `last block should be on a later page (got ${lastPage})`)
  // Monotonic-ish: later blocks never precede earlier ones' pages.
  assert.ok(lastPage >= receipt.blockToPage['b' + Math.ceil(N / 2)])
})

test('targetPages overflow: receipt flags overflowLinesOnLastPage when over budget', () => {
  const N = 40
  const blocks = Array.from({ length: N }, (_, i) =>
    B('b' + (i + 1), 'prose', { body: [T('Line ' + i + '. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.')] }),
  )
  const { receipt } = render(blocks, 1) // target 1 page, content needs more
  assert.ok(receipt.pages > 1)
  assert.equal(receipt.overflowLinesOnLastPage, receipt.lastPageLineCount)
  assert.ok(receipt.overflowLinesOnLastPage > 0)
})

test('native arm warm render < 2 ms (avg over 100 warm compiles)', () => {
  const s = [B('b1', 'prose', { body: [T('warm timing probe')] })]
  for (let i = 0; i < 10; i++) compiler.compile({ mainFileContent: compileSheet(sheetOf(s)).typ }) // warm
  const n = 100
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint()
    compiler.compile({ mainFileContent: compileSheet(sheetOf(s)).typ })
    sum += Number(process.hrtime.bigint() - t0)
  }
  const avgMs = sum / n / 1e6
  assert.ok(avgMs < 2, `warm compile avg ${avgMs.toFixed(4)} ms must be < 2 ms`)
})

test('PDF output is valid for a multi-page sheet', () => {
  const N = 40
  const blocks = Array.from({ length: N }, (_, i) =>
    B('b' + (i + 1), 'prose', { body: [T('Line ' + i + '. Lorem ipsum dolor sit amet.')] }),
  )
  const { pdf } = render(blocks)
  assert.ok(pdf.length > 0)
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString('latin1'), '%PDF-')
})
