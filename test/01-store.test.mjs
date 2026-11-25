/**
 * dsh-galley — M1 block-store test (spec 05 §4 gate: "store add/update/remove/
 * reorder + hash + staleness + undo ring 50").
 *
 * Imports the BUILT hermetic core `lib/galley-core.mjs` (run `node build.mjs`
 * first) — the real `GalleyStore`, on a temp dir. Zero dsh boot, < 2 s.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GalleyStore,
  StoreError,
  UNDO_DEPTH,
  JOURNAL_KEEP,
  hashBlock,
  canonicalJson,
  blockContentProjection,
  computeStale,
  recomputeStale,
  createsCycle,
  allocateBlockId,
  findBlock,
  makeDepEdge,
} from '../lib/galley-core.mjs'

const geom = { paper: 'a4', margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } }
const T = (v) => ({ t: 'text', v })

const mkBlock = (id, type = 'prose', extra = {}) => ({
  id,
  type,
  hash: 'x',
  dependsOn: [],
  slot: { mode: 'full' },
  origin: 'agent',
  updatedAt: '',
  ...extra,
})

const mkPacket = (blocks = [], id = 'p-aaaaaaaa') => ({
  id,
  template: 'generic',
  title: 'T',
  rev: 1,
  createdAt: '',
  updatedAt: '',
  sheetOrder: ['s1'],
  sheets: { s1: { id: 's1', title: 'S', geometry: geom, blocks } },
  nextBlockSeq: blocks.length + 1,
  nextProposalSeq: 1,
  nextAnnotationSeq: 1,
  nextAssetSeq: 1,
  assets: {},
})

let store
let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'galley-store-'))
  store = new GalleyStore(root)
})
after(() => rmSync(root, { recursive: true, force: true }))

test('create + load round-trip (derived flags recomputed, rev=1)', () => {
  const created = store.create(mkPacket([mkBlock('b1', 'prose', { body: [T('hi')] })]))
  assert.equal(created.rev, 1)
  const loaded = store.load(created.id)
  assert.ok(loaded)
  assert.equal(loaded.sheets.s1.blocks.length, 1)
  assert.equal(loaded.sheets.s1.blocks[0].id, 'b1')
  // load() recomputes derived `stale` (no deps → null).
  assert.equal(loaded.sheets.s1.blocks[0].stale, null)
})

test('list + delete (including packets with assets/ subdir)', () => {
  const a = store.create(mkPacket([], 'p-aaaaaaaa'))
  const b = store.create(mkPacket([], 'p-bbbbbbbb'))
  store.addAsset(a.id, { id: 'a1', path: 'assets/a1.png', bytesSha256: '00', mimeType: 'image/png' }, Buffer.from([1, 2, 3]))
  const ids = store.list().map((x) => x.id).sort()
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
  store.delete(a.id)
  assert.equal(store.load(a.id), null)
  assert.equal(store.list().length, 1)
  assert.throws(() => store.delete(a.id), (e) => e instanceof StoreError && e.code === 'not_found')
})

test('hash: deterministic, key-order independent, content-only (excludes id + origin)', () => {
  const mk = (body) => mkBlock('b1', 'prose', { body })
  assert.equal(hashBlock(mk([T('hi')])), hashBlock(mk([T('hi')])))
  assert.notEqual(hashBlock(mk([T('hi')])), hashBlock(mk([T('bye')])))
  // non-content fields (id / origin / updatedAt / stale) do not affect the hash (spec 01 §5).
  const base = mkBlock('b1', 'prose', { body: [T('hi')], origin: 'agent' })
  const other = mkBlock('b99', 'prose', {
    body: [T('hi')],
    origin: 'human',
    updatedAt: 'now',
    stale: { state: 'stale_dependency', origin: 'z', sinceHash: 'q' },
  })
  assert.equal(hashBlock(base), hashBlock(other))
  // canonicalJson is key-order independent.
  assert.equal(canonicalJson({ a: 1, b: { x: 2 } }), canonicalJson({ b: { x: 2 }, a: 1 }))
})

test('commit: re-hashes every block + bumps rev + changeHash', () => {
  const body = [T('before')]
  const pid = store.create(mkPacket([mkBlock('b1', 'prose', { body })])).id
  const before = hashBlock(mkBlock('b1', 'prose', { body }))
  const res = store.commit(pid, null, (p) => {
    const b1 = findBlock(p, 'b1').block
    b1.body = [T('after')]
    return 'b1'
  })
  assert.equal(res.rev, 2)
  const after = hashBlock(mkBlock('b1', 'prose', { body: [T('after')] }))
  assert.equal(res.changeHash, after)
  assert.notEqual(before, after)
  // The persisted block carries the recomputed hash.
  assert.equal(store.load(pid).sheets.s1.blocks[0].hash, after)
})

test('optimistic lock: baseHash mismatch → conflict (409)', () => {
  const body = [T('x')]
  const pid = store.create(mkPacket([mkBlock('b1', 'prose', { body })])).id
  store.commit(pid, null, () => null) // re-hash to the real value
  const realHash = store.load(pid).sheets.s1.blocks[0].hash
  // correct baseHash → ok
  store.commit(pid, { blockId: 'b1', baseHash: realHash }, () => null)
  // wrong baseHash → conflict
  assert.throws(
    () => store.commit(pid, { blockId: 'b1', baseHash: 'deadbeef' }, () => null),
    (e) => e instanceof StoreError && e.code === 'conflict',
  )
  // unknown block → not_found
  assert.throws(
    () => store.commit(pid, { blockId: 'zz', baseHash: 'x' }, () => null),
    (e) => e instanceof StoreError && e.code === 'not_found',
  )
})

test('add / remove / reorder via the single commit path', () => {
  const pid = store.create(mkPacket([mkBlock('b1'), mkBlock('b2')])).id
  const ids = () => store.load(pid).sheets.s1.blocks.map((b) => b.id)
  // add
  store.commit(pid, null, (p) => {
    const id = allocateBlockId(p)
    p.sheets.s1.blocks.push(mkBlock(id, 'prose', { body: [T('c')] }))
    p.nextBlockSeq += 1
    return id
  })
  assert.deepEqual(ids(), ['b1', 'b2', 'b3'])
  // reorder (b3 to front)
  store.commit(pid, null, (p) => {
    const i = p.sheets.s1.blocks.findIndex((b) => b.id === 'b3')
    const [blk] = p.sheets.s1.blocks.splice(i, 1)
    p.sheets.s1.blocks.unshift(blk)
    return 'b3'
  })
  assert.deepEqual(ids(), ['b3', 'b1', 'b2'])
  // remove
  store.commit(pid, null, (p) => {
    p.sheets.s1.blocks = p.sheets.s1.blocks.filter((b) => b.id !== 'b1')
    return null
  })
  assert.deepEqual(ids(), ['b3', 'b2'])
})

test('staleness: dependency then missing origin (recomputed on load)', () => {
  const b1 = mkBlock('b1', 'prose', { body: [T('one')] })
  const b1hash = hashBlock(b1)
  const b2 = mkBlock('b2', 'prose', {
    body: [T('two')],
    dependsOn: [makeDepEdge('b1', b1hash, '')],
  })
  const pid = store.create(mkPacket([b1, b2])).id
  store.commit(pid, null, () => null) // re-hash → b1.hash === b1hash

  let loaded = store.load(pid)
  assert.equal(loaded.sheets.s1.blocks.find((b) => b.id === 'b2').stale, null)

  // mutate b1 → b2 goes stale_dependency
  store.commit(pid, null, (p) => {
    findBlock(p, 'b1').block.body = [T('ONE')]
    return 'b1'
  })
  loaded = store.load(pid)
  const staleDep = loaded.sheets.s1.blocks.find((b) => b.id === 'b2').stale
  assert.equal(staleDep.state, 'stale_dependency')
  assert.equal(staleDep.origin, 'b1')

  // remove b1 → b2 goes stale_missing_origin
  store.commit(pid, null, (p) => {
    p.sheets.s1.blocks = p.sheets.s1.blocks.filter((b) => b.id !== 'b1')
    return null
  })
  loaded = store.load(pid)
  const staleMiss = loaded.sheets.s1.blocks.find((b) => b.id === 'b2').stale
  assert.equal(staleMiss.state, 'stale_missing_origin')
  assert.equal(staleMiss.origin, 'b1')
})

test('cycle detection + allocateBlockId never reuses retired ids', () => {
  const a = mkBlock('a', 'prose', { body: [T('')], dependsOn: [makeDepEdge('b', 'x', '')] })
  const b = mkBlock('b', 'prose', { body: [T('')], dependsOn: [makeDepEdge('c', 'x', '')] })
  const c = mkBlock('c', 'prose', { body: [T('')] })
  const byId = new Map([['a', a], ['b', b], ['c', c]])
  assert.equal(createsCycle('a', 'b', byId), false) // a→b already, no cycle
  assert.equal(createsCycle('c', 'a', byId), true) // c→a→b→c
  assert.equal(createsCycle('a', 'a', byId), true) // self

  const pid = store.create(mkPacket([mkBlock('b1'), mkBlock('b2')])).id
  store.commit(pid, null, (p) => {
    p.sheets.s1.blocks = p.sheets.s1.blocks.filter((b) => b.id !== 'b1')
    return null
  })
  // b1 retired → allocator must skip to b3 (nextBlockSeq=3), not reuse b1.
  const packet = store.load(pid)
  assert.equal(allocateBlockId(packet), 'b3')
})

test('undo ring capped at UNDO_DEPTH (50) + undo restores', () => {
  const pid = store.create(mkPacket([mkBlock('b1')])).id
  assert.equal(UNDO_DEPTH, 50)
  for (let i = 0; i < 55; i++) store.commit(pid, null, () => null)
  assert.equal(store.load(pid).rev, 56)
  assert.equal(store.undoDepth(pid), UNDO_DEPTH)
  const beforeUndo = store.load(pid).rev
  store.undo(pid)
  const after = store.load(pid)
  assert.equal(after.rev, beforeUndo - 1)
  assert.equal(store.undoDepth(pid), UNDO_DEPTH - 1)
})

test('journal keeps last JOURNAL_KEEP (3)', () => {
  const pid = store.create(mkPacket([mkBlock('b1')])).id
  for (let i = 0; i < 6; i++) store.commit(pid, null, () => null)
  const journal = JSON.parse(readFileSync(join(root, pid, 'journal.json'), 'utf8'))
  assert.equal(journal.length, JOURNAL_KEEP)
  assert.ok(journal.every((e) => typeof e.rev === 'number' && typeof e.at === 'string'))
})
