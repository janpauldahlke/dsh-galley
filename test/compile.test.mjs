/**
 * dsh-galley — native-arm integration test (the "first working Typst" proof).
 *
 * Feeds renderTypstSource's output through the REAL N-API compiler and asserts
 * a clean compile + valid PDF bytes. This proves the generated `.typ` is valid
 * Typst, not just a plausible-looking string. Run after `node build.mjs`
 * (imports the built `lib/typst-render.mjs` + the external native arm).
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { renderTypstSource } from '../lib/typst-render.mjs'

let NodeCompiler
let compiler

before(async () => {
  const mod = await import('@myriaddreamin/typst-ts-node-compiler')
  NodeCompiler = mod.NodeCompiler
  compiler = NodeCompiler.create()
})

const SAMPLE = [
  { id: 'b1', kind: 'header', text: 'Arbeitsblatt · Druck und Satz' },
  { id: 'b2', kind: 'heading', level: 1, text: 'Galley M0 Proof' },
  {
    id: 'b3',
    kind: 'prose',
    text: 'Hello from the native arm. Metacharacters that must stay inert: # $ [ ] { } _ ^ | plus a quote "here" and a backslash here.',
  },
  { id: 'b4', kind: 'task', text: 'Aufgabe: prove the dual face loads.' },
  { id: 'b5', kind: 'answer', text: 'Lösung: the host compiled the packet.' },
]

function compileOk(source) {
  const r = compiler.compile({ mainFileContent: source })
  assert.equal(r.hasError(), false, 'compile must not error')
  return r
}

test('native arm: M0 sample compiles to a valid non-empty PDF', () => {
  const r = compileOk(renderTypstSource(SAMPLE))
  const pdf = compiler.pdf(r.result)
  assert.ok(pdf.length > 0, 'PDF must be non-empty')
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString('latin1'), '%PDF-')
  assert.ok(r.result.numOfPages >= 1, 'at least one page')
})

test('native arm: every heading level (1..6) compiles', () => {
  for (let level = 1; level <= 6; level++) {
    const r = compileOk(
      renderTypstSource([
        { id: `h${level}`, kind: 'heading', level, text: `Level ${level}` },
        { id: 'p', kind: 'prose', text: 'body' },
      ]),
    )
    assert.ok(r.result.numOfPages >= 1)
  }
})

test('native arm: adversarial text cannot break the document', () => {
  const hostile =
    'end #set page() #label("zz") "$" " [unclosed] {x} a\\b \\n \\t \\" escaped \\\\ done #show: _\n\n\n'
  const r = compileOk(renderTypstSource([{ id: 'b1', kind: 'prose', text: hostile }]))
  const pdf = compiler.pdf(r.result)
  assert.ok(pdf.length > 0, 'hostile text still produces a PDF')
})

test('native arm: empty block list still yields a valid (blank) page', () => {
  const r = compileOk(renderTypstSource([]))
  const pdf = compiler.pdf(r.result)
  assert.ok(pdf.length > 0)
  assert.ok(r.result.numOfPages >= 1)
})
