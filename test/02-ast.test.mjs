/**
 * dsh-galley — M1 AST test (spec 05 §4 gate: "AST 8 kinds + typstStringLiteral
 * exhaustive").
 *
 * Imports the BUILT `lib/typst-render.mjs` (run `node build.mjs` first) and
 * asserts:
 *  - typstStringLiteral is exhaustive + total (metacharacters inert, `\`/`"`
 *    escaped, every string maps to a well-formed code-mode literal).
 *  - All 8 block kinds render to the expected Typst surface (0.14.2).
 *  - The Inline union renders each of its 7 members.
 *  - compileSheet is a deterministic pure function (golden byte-stability).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  typstStringLiteral,
  blockTypst,
  compileSheet,
  anchorHexFor,
  markerComment,
} from '../lib/typst-render.mjs'

// A minimal valid Block with content fields from `extra`.
const B = (id, type, extra = {}) => ({
  id,
  type,
  hash: '',
  dependsOn: [],
  slot: { mode: 'full' },
  origin: 'agent',
  updatedAt: '',
  ...extra,
})
const T = (v) => ({ t: 'text', v })

const geometry = { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } }

test('typstStringLiteral is total: metacharacters stay inert', () => {
  // Every Typst markup/code metacharacter survives unchanged inside a literal.
  assert.equal(
    typstStringLiteral('#$[]{}_^|\\<>~'),
    '"#$[]{}_^|\\\\<>~"',
  )
})

test('typstStringLiteral escapes only backslash + quote (exhaustive edge set)', () => {
  assert.equal(typstStringLiteral(''), '""')
  assert.equal(typstStringLiteral('"'), '"\\""')
  assert.equal(typstStringLiteral('\\'), '"\\\\"')
  assert.equal(typstStringLiteral('a"b\\c'), '"a\\"b\\\\c"')
  // Control chars pass through raw (this M0 emitter escapes only \ and ");
  // the M1 inline path uses typString (JSON) for control-char safety.
  assert.equal(typstStringLiteral('tab\there'), '"tab\there"')
  assert.equal(typstStringLiteral('nl\nhere'), '"nl\nhere"')
  // Unicode passes through (JSON.stringify leaves non-ASCII intact).
  assert.equal(typstStringLiteral('Überprüfung'), '"Überprüfung"')
})

test('typstStringLiteral never yields an unterminated literal (property test)', () => {
  for (const s of ['a', 'aa', '"', '\\', '""', '\\\\', 'mixed " \\ and text', '\u0000']) {
    const lit = typstStringLiteral(s)
    assert.ok(lit.startsWith('"') && lit.endsWith('"'), `unterminated: ${JSON.stringify(s)}`)
  }
})

test('block 1/8: header renders a 2-column arbeitsblatt banner (incl. blank Name fill-in)', () => {
  const b = B('b1', 'header', { fields: { titel: 'Mein Blatt', name: 'Anna' } })
  const out = blockTypst(b, 0)
  assert.equal(out.split('\n')[0], markerComment('b1'))
  assert.match(out, /fill: rgb\(1, 0, 0\)/) // zero-flow anchor
  assert.match(out, /#grid\(columns: \(1fr, auto\)/)
  assert.match(out, /#text\(size: 17pt, weight: "bold", "Mein Blatt"\)/)
  assert.match(out, /#text\(size: 9pt, fill: luma\(110\), "Name: Anna"\)/)

  const blank = blockTypst(B('b1', 'header', { fields: { titel: 'Arbeitsblatt', name: '' } }), 0)
  assert.match(blank, /"Name: ____/)
})

test('block 2/8: heading honours level', () => {
  assert.match(blockTypst(B('b1', 'heading', { level: 1, body: [T('Top')] }), 0), /^= /m)
  assert.match(blockTypst(B('b1', 'heading', { level: 2, body: [T('Mid')] }), 0), /^== /m)
  assert.match(blockTypst(B('b1', 'heading', { level: 3, body: [T('Deep')] }), 0), /^=== /m)
  assert.match(blockTypst(B('b1', 'heading', { level: 2, body: [T('Mid')] }), 0), /#text\("Mid"\)/)
})

test('block 3/8: prose renders inline runs (#strong, not markdown)', () => {
  const b = B('b1', 'prose', { body: [T('Hello '), { t: 'strong', c: [T('world')] }] })
  const out = blockTypst(b, 0)
  assert.match(out, /#text\("Hello "\)#strong\[#text\("world"\)\]/)
})

test('block 4/8: source_text emits title + wraps lines + supports lineNumbers', () => {
  const b = B('b1', 'source_text', { title: 'Goethe', body: [T('line one\nline two')], lineNumbers: { every: 5 } })
  const out = blockTypst(b, 0)
  assert.match(out, /#strong\[#text\("Goethe"\)\]\n\n#\[/)
  assert.match(out, /#set par\.line\(numbering:/)
  assert.match(out, /#text\("line one"\) \\ #text\("line two"\)/)
})

test('block 5/8: task renders body', () => {
  assert.match(blockTypst(B('b1', 'task', { body: [T('Do the thing')] }), 0), /#text\("Do the thing"\)/)
})

test('block 6/8: table builds positional cell args + table.header (never trailing bracket soup)', () => {
  const b = B('b1', 'table', {
    headers: [[T('A')], [T('B')]],
    rows: [[[T('1')], [T('2')]], [[T('3')], [T('4')]]],
  })
  const out = blockTypst(b, 0)
  assert.match(
    out,
    /#table\(columns: 2, inset: 6pt, fill: \(_, y\) => if y == 0 \{ luma\(245\) \} else \{ rgb\(255, 255, 255\) \}, stroke: 0\.5pt \+ luma\(180\), table\.header\(\[#strong\[#text\("A"\)\]\], \[#strong\[#text\("B"\)\]\]\), \[#text\("1"\)\], \[#text\("2"\)\], \[#text\("3"\)\], \[#text\("4"\)\]\)/,
  )
})

test('block 7/8: callout renders a full-width tinted block per tone (rgb 0-255, 8pt inset, left stroke)', () => {
  const info = blockTypst(B('b1', 'callout', { tone: 'info', body: [T('note')] }), 0)
  assert.match(info, /#block\(width: 100%, inset: 8pt, fill: rgb\(232, 240, 254\)/)
  assert.match(info, /stroke: \(left: 3pt \+ rgb\(26, 115, 232\)\)/)
  assert.match(blockTypst(B('b1', 'callout', { tone: 'warning', body: [T('w')] }), 0), /fill: rgb\(252, 232, 230\)/)
  assert.match(blockTypst(B('b1', 'callout', { tone: 'hint', body: [T('h')] }), 0), /fill: rgb\(230, 244, 234\)/)
})

test('block 8/8: answer renders body', () => {
  assert.match(blockTypst(B('b1', 'answer', { body: [T('Lösung')] }), 0), /#text\("Lösung"\)/)
})

test('all 8 kinds coexist in one deterministic sheet (golden)', () => {
  const blocks = [
    B('b1', 'header', { fields: { titel: 'T' } }),
    B('b2', 'heading', { level: 1, body: [T('H')] }),
    B('b3', 'prose', { body: [T('P')] }),
    B('b4', 'source_text', { body: [T('S')] }),
    B('b5', 'task', { body: [T('Q')] }),
    B('b6', 'table', { headers: [[T('H1')]], rows: [[[T('c')]]] }),
    B('b7', 'callout', { tone: 'info', body: [T('C')] }),
    B('b8', 'answer', { body: [T('A')] }),
  ]
  const sheet = { id: 's1', title: 'Sheet', geometry, blocks }
  const a = compileSheet(sheet)
  const b = compileSheet(sheet)
  assert.equal(a.typ, b.typ) // pure / deterministic
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(a.anchors[i].blockId, blocks[i].id)
    assert.equal(a.anchors[i].hex, anchorHexFor(i))
  }
  assert.match(a.typ, /#set page\(paper: "a4"/)
  // Every block id is lexically present (for error→block attribution).
  for (const blk of blocks) assert.ok(a.typ.includes(markerComment(blk.id)), `missing ${blk.id}`)
  assert.equal(a.pageHeightPt, 841.89)
  assert.equal(a.pageWidthPt, 595.28)
})

test('Inline union: each of the 7 members renders', () => {
  const one = (inlines) => blockTypst(B('b1', 'prose', { body: inlines }), 0)
  assert.match(one([{ t: 'text', v: 'x' }]), /#text\("x"\)/)
  assert.match(one([{ t: 'strong', c: [T('b')] }]), /#strong\[#text\("b"\)\]/)
  assert.match(one([{ t: 'emph', c: [T('i')] }]), /#emph\[#text\("i"\)\]/)
  assert.match(one([{ t: 'code', v: 'x' }]), /#raw\("x"\)/)
  assert.match(one([{ t: 'cloze', hint: 'ab' }]), /#underline\("   "\)/) // hint len 2 → 3 underscores
  assert.match(one([{ t: 'math', v: 'x^2' }]), /\$x\^2\$/)
  assert.match(one([{ t: 'newline' }]), /\\/)
})
