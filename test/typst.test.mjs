/**
 * dsh-galley — hermetic core tests (guardrail 6).
 *
 * Import the BUILT standalone module `lib/typst-render.mjs` (run `node
 * build.mjs` first) so we test the real artifact. Zero dsh boot, < 2 s.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typstStringLiteral, blockToTypst, renderTypstSource } from '../lib/typst-render.mjs'

test('typstStringLiteral leaves markup metacharacters inert', () => {
  // # $ [ ] { } _ ^ | are all inert inside a string literal — unchanged.
  assert.equal(typstStringLiteral('a # b $ c [d] {e} f_g ^ h | i'), '"a # b $ c [d] {e} f_g ^ h | i"')
})

test('typstStringLiteral escapes backslash and quote (total escaping)', () => {
  assert.equal(typstStringLiteral('say "hi"'), '"say \\"hi\\""')
  assert.equal(typstStringLiteral('back\\slash'), '"back\\\\slash"')
  assert.equal(typstStringLiteral(''), '""')
})

test('blockToTypst heading honours level (clamped 1..6)', () => {
  assert.equal(blockToTypst({ id: 'b1', kind: 'heading', level: 1, text: 'Title' }), '= #label("b1") #text("Title")')
  assert.equal(blockToTypst({ id: 'b2', kind: 'heading', level: 2, text: 'Sub' }), '== #label("b2") #text("Sub")')
  assert.equal(blockToTypst({ id: 'b3', kind: 'heading', level: 99, text: 'Clamped' }), '====== #label("b3") #text("Clamped")')
  assert.equal(blockToTypst({ id: 'b4', kind: 'heading', text: 'Default' }), '= #label("b4") #text("Default")')
})

test('blockToTypst prose / task / answer / header shapes', () => {
  assert.equal(blockToTypst({ id: 'p', kind: 'prose', text: 'X' }), '#label("p") #text("X")')
  assert.equal(blockToTypst({ id: 't', kind: 'task', text: 'X' }), '#label("t")   #text("X")')
  assert.equal(blockToTypst({ id: 'a', kind: 'answer', text: 'X' }), '#label("a")   #text("X")')
  assert.equal(blockToTypst({ id: 'h', kind: 'header', text: 'X' }), '#label("h") #text("X")')
})

test('renderTypstSource is deterministic and A4 by default', () => {
  const blocks = [
    { id: 'b1', kind: 'heading', level: 1, text: 'T' },
    { id: 'b2', kind: 'prose', text: 'P' },
  ]
  const a = renderTypstSource(blocks)
  const b = renderTypstSource(blocks)
  assert.equal(a, b)
  assert.match(a, /#set page\(paper: "a4"/)
  assert.match(a, /#set text\(size: 11pt/)
  assert.match(a, /#label\("b1"\)/)
})

test('renderTypstSource honours paper + size options', () => {
  const src = renderTypstSource([{ id: 'b1', kind: 'prose', text: 'P' }], { paper: 'letter', sizePt: 12 })
  assert.match(src, /paper: "letter"/)
  assert.match(src, /size: 12pt/)
})

test('adversarial user text never breaks the generated syntax', () => {
  const hostile = 'end #set page() #label("zz") "$" " [unclosed] {x} a\\b c'
  const src = renderTypstSource([{ id: 'b1', kind: 'prose', text: hostile }])
  // The hostile string is emitted inside ONE code-mode literal via #text(…).
  assert.match(src, /#label\("b1"\) #text\("/)
  // No stray unescaped quote escapes the literal: exactly the label quote +
  // the #text( … ) wrapper + the two literal-delimiter quotes around the text.
  const line = src.split('\n').find((l) => l.includes('#label("b1")'))
  assert.ok(line)
  // The whole hostile text is wrapped in ONE string literal, with only `\`
  // and `"` escaped — exactly what typstStringLiteral produces.
  assert.equal(line, `#label("b1") #text(${typstStringLiteral(hostile)})`)
})
