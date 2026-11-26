/**
 * dsh-galley — M3 + M3.1 gate: KV-cache-safe `agent/pre-step` inject & Qwen dogfood hardening.
 *
 * Verifies against real `GalleyStore` + `NativeArm` (zero fake render stubs, zero `dsh-skills` coupling):
 *   1. Empty workspace (no active packet) → 0 spliced messages; later open fires delta + 1-line Rules.
 *   2. Delta-only KV-cache law: 1 frozen `dsh-galley` UserMessage spliced after claimed prompt when
 *      rev advances; 0 messages (`decision` reference untouched) when rev === lastInjectedRev.
 *   3. Cross-sheet outline + `Changed since rev N` (incl. attributed sheet/geometry transitions!)
 *      + `Preflight` within < 220-token budget (even on 18-block 3-sheet stress packets).
 *   4. Backward session-surface scan on resume (`0` splice when caught up; exact `Changed since rev N`
 *      recovered from store undo ring when edited offline) + session-sticky isolation + fail-open.
 *   5. M3.1 P0: multi-sheet `insert` without `sheetId` or `beforeId`/`afterId` fails fast with
 *      `GALLEY_INVALID_PARAMS`; `beforeId`/`afterId` infers target sheet (`s2`); receipts echo `sheetId`.
 *   6. M3.1 P1: `sheet-add`, `sheet-update` (`targetPages` 1→2→0 unbounded, `orientation` landscape),
 *      `sheet-remove` on `galley_edit_block`, plus attributed `journal.json` / `recentChanges` (`actor` + diff).
 *   7. M3.1 P2: `galley_export({ format: 'md' })` emits valid GFM pipe tables, complete header fields
 *      (incl. `Klasse`, `Datum`, `Name: ____`), `source_text` title, and deduplicated `Aufgabe N`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Err,
  galleyOpen,
  galleyStatus,
  galleyEditBlock,
  galleyAnnotate,
  galleyExport,
  getStoreForCwd,
  setSessionActivePacket,
  GalleyServiceRegistry,
  _resetGalleyWorkspaceForTests,
} from '../lib/galley-core.mjs'
import {
  apply,
  NativeArm,
  MAX_INJECT_CHARS,
  installGalleyInject,
  formatGalleyDelta,
  estimateTokens,
} from '../lib/index.js'

let arm
let ws

before(async () => {
  _resetGalleyWorkspaceForTests()
  ws = mkdtempSync(join(tmpdir(), 'galley-m31-'))
  arm = new NativeArm()
  await arm.init()
})

after(() => {
  _resetGalleyWorkspaceForTests()
  rmSync(ws, { recursive: true, force: true })
})

function makeDeps(cwd = ws, registry = new GalleyServiceRegistry()) {
  const { store, root, cwd: resolved } = getStoreForCwd(cwd)
  return {
    root,
    cwd: resolved,
    registry,
    deps: {
      store,
      cwd: resolved,
      registry,
      render: (sheet, packet, assetBytes) => arm.render(sheet, packet, assetBytes),
    },
  }
}

function makeMockSession(cwd, id = 'sess-1', initialEvents = []) {
  const events = new Map()
  const seqs = []
  initialEvents.forEach((ev, idx) => {
    const seq = idx + 1
    seqs.push(seq)
    events.set(seq, { seq, ...ev })
  })
  return {
    id,
    header: { id, cwd },
    surface: {
      get nodes() {
        return seqs.slice()
      },
    },
    eventAt(seq) {
      return events.get(seq)
    },
  }
}

function makeStepCall(session, promptText = 'Bitte aktualisiere den Erwartungshorizont.') {
  const userMsg = {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    source: { kind: 'user' },
  }
  const runtimeCtxMsg = {
    id: `ctx-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>runtime clock</system-reminder>' }],
    source: { kind: 'system-prompt' },
  }
  const decisionIn = {
    kind: 'enter',
    messages: [userMsg, runtimeCtxMsg],
  }
  const args = {
    agent: { session },
    messages: [userMsg],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  return { args, decisionIn, userMsg, runtimeCtxMsg }
}

function mountPreStep(injectDeps, loggerWarnings = []) {
  let preStepHandler = null
  let disposed = false
  const ctx = {
    on(name, fn) {
      if (name === 'agent/pre-step') preStepHandler = fn
      return () => {
        disposed = true
      }
    },
    effect() {},
    logger: () => ({
      warn: (fmt, ...rest) => loggerWarnings.push([fmt, ...rest].join(' ')),
      info: () => {},
      error: () => {},
    }),
  }
  const dispose = installGalleyInject(ctx, injectDeps)
  assert.equal(typeof preStepHandler, 'function', 'agent/pre-step listener registered')
  return {
    runStep: (args, decisionIn) => preStepHandler(args, async () => decisionIn),
    dispose,
    isDisposed: () => disposed,
  }
}

test('KV-cache law: 0 messages when unchanged; whole-Mappe delta + attributed sheet/block changes when rev advances', async () => {
  const subWs = mkdtempSync(join(tmpdir(), 'galley-m3-kv-'))
  try {
    const registry = new GalleyServiceRegistry()
    const { runStep, dispose, isDisposed } = mountPreStep({
      registry,
      getDepsForCwd: async (c) => makeDeps(c, registry),
    })
    const session = makeMockSession(subWs, 'sess-kv')

    // 1. No active packet -> 0 messages spliced
    {
      const { args, decisionIn } = makeStepCall(session, 'Hallo!')
      const out = await runStep(args, decisionIn)
      assert.equal(out, decisionIn)
    }

    // 2. Open Arbeitsblatt + Erwartungshorizont and link b4 -> b2
    const { deps, store } = (() => {
      const m = makeDeps(subWs, registry)
      return { deps: m.deps, store: m.deps.store }
    })()
    const opened = await galleyOpen(deps, {
      template: 'arbeitsblatt',
      title: 'Dreißigjähriger Krieg',
    })
    const pid = opened.packetId
    const linked = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'patch',
      blockId: 'b4',
      patch: { body: 'Konfessionskonflikt und habsburgische Machtpolitik.' },
      dependsOn: ['b2'],
      origin: 'agent',
    })
    const revAfterSetup = linked.rev

    // Step A: initial baseline outline + 1-line Rules
    {
      const { args, decisionIn, userMsg, runtimeCtxMsg } = makeStepCall(session, 'Prüfe die Mappe.')
      const out = await runStep(args, decisionIn)
      assert.equal(out.messages.length, 3)
      assert.equal(out.messages[0], userMsg)
      assert.equal(out.messages[2], runtimeCtxMsg)
      const injected = out.messages[1]
      assert.equal(Object.isFrozen(injected), true)
      assert.deepEqual(injected.source, {
        kind: 'dsh-galley',
        form: 'galley-delta',
        version: 1,
        packetId: pid,
        rev: revAfterSetup,
      })
      const text = injected.content[0].text
      assert.match(text, /\[dsh-galley · Mappe "Dreißigjähriger Krieg" · rev \d+ · mode auto\]/)
      assert.match(text, /s1 "Dreißigjähriger Krieg" \(1p, \+0 overflow\):/)
      assert.match(text, /s2 "Erwartungshorizont" \(1p\):/)
      assert.match(text, /b4 answer\(→b2\)/)
      assert.match(text, /Rules: galley_read_block origins verbatim/)
      assert.ok(estimateTokens(text) < 220, `tokens=${estimateTokens(text)} must be < 220`)
    }

    // Step B: unchanged rev -> 0 messages spliced
    {
      const { args, decisionIn } = makeStepCall(session, 'Noch eine Frage.')
      const out = await runStep(args, decisionIn)
      assert.equal(out, decisionIn)
    }

    // Human edits b2 AND flips s1 targetPages 1->2 in the pane!
    await galleyEditBlock(deps, {
      packetId: pid,
      op: 'patch',
      blockId: 'b2',
      patch: { body: 'Arbeite aus Quelle M1 die Ursachen des Prager Fenstersturzes heraus.' },
      origin: 'human',
    })
    store.updateSheet(pid, 's1', { targetPages: 2 }, 'human')
    await galleyAnnotate(deps, {
      packetId: pid,
      blockId: 'b2',
      action: 'add',
      author: 'human',
      body: 'Bitte AFB II beachten!',
    })

    // Step C: delta surfaces BOTH b2 (task) AND attributed `sheet s1 targetPages 1→2 (human)`!
    {
      const { args, decisionIn } = makeStepCall(session, 'Aktualisiere jetzt den Erwartungshorizont.')
      const out = await runStep(args, decisionIn)
      assert.equal(out.messages.length, 3)
      const text = out.messages[1].content[0].text
      assert.match(text, new RegExp(`Changed since rev ${revAfterSetup}: .*b2 \\(task\\)`))
      assert.match(text, /sheet s1 targetPages 1→2 \(human\)/)
      assert.match(text, /b4 answer\(→b2, STALE\)/)
      assert.match(text, /Preflight: .*b4 stale \(origin b2 changed\)/)
      assert.match(text, /human note on b2/)
      assert.ok(estimateTokens(text) < 220, `delta tokens=${estimateTokens(text)} must be < 220`)
    }

    dispose()
    assert.equal(isDisposed(), true)
  } finally {
    rmSync(subWs, { recursive: true, force: true })
  }
})

test('Token ceiling: heavy 3-sheet 18-block packet stays strictly < 220 tokens and <= MAX_INJECT_CHARS', () => {
  const makeBlocks = (prefix, startIdx, count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `b${startIdx + i}`,
      type: i === 0 ? 'header' : i % 2 === 0 ? 'task' : 'prose',
      hash: `h${startIdx + i}`,
      dependsOn: startIdx > 6 && i > 0 ? [{ id: `b${i}`, sinceHash: 'old', at: '' }] : [],
      slot: { mode: 'full' },
      origin: 'human',
      updatedAt: '',
      stale: startIdx > 6 && i > 0 ? { state: 'stale_dependency', origin: `b${i}`, sinceHash: 'old' } : null,
      ...(i === 0
        ? { fields: { titel: `${prefix} Sehr ausführlicher Dokumenttitel für Doppelstunde Geschichte` } }
        : { body: [{ t: 'text', v: 'Ein sehr langer Beispieltext mit vielen Fachbegriffen zur Verfassungsgeschichte und Quellenkritik.' }] }),
    }))

  const packet = {
    id: 'p-stress01',
    template: 'arbeitsblatt',
    title: 'Doppelstunde Dreißigjähriger Krieg & Westfälischer Friede 1648',
    reviewMode: 'review',
    rev: 12,
    createdAt: '',
    updatedAt: '',
    sheetOrder: ['s1', 's2', 's3'],
    sheets: {
      s1: { id: 's1', title: 'Arbeitsblatt Quellen', geometry: { paper: 'a4', margin: { top: 2, right: 2, bottom: 2, left: 2 }, targetPages: 1 }, blocks: makeBlocks('S1', 1, 6) },
      s2: { id: 's2', title: 'Erwartungshorizont', geometry: { paper: 'a4', margin: { top: 2, right: 2, bottom: 2, left: 2 } }, blocks: makeBlocks('S2', 7, 6) },
      s3: { id: 's3', title: 'Verlaufsplan', geometry: { paper: 'a4', orientation: 'landscape', margin: { top: 2, right: 2, bottom: 2, left: 2 }, targetPages: 1 }, blocks: makeBlocks('S3', 13, 6) },
    },
    nextBlockSeq: 19,
    nextProposalSeq: 3,
    nextAnnotationSeq: 2,
    nextAssetSeq: 1,
    assets: {},
  }

  const text = formatGalleyDelta({
    packet,
    prevRev: 0,
    proofs: {
      s1: { pages: 2, overflowLinesOnLastPage: 5 },
      s2: { pages: 1, overflowLinesOnLastPage: 0 },
      s3: { pages: 1, overflowLinesOnLastPage: 0 },
    },
    proposals: [
      { id: 'p1', targetBlockId: 'b2', baseHash: 'x', proposedPatch: {}, status: 'pending', createdAtRev: 11 },
    ],
  })

  assert.ok(text.length <= MAX_INJECT_CHARS, `length=${text.length} exceeds ${MAX_INJECT_CHARS}`)
  assert.ok(estimateTokens(text) < 220, `tokens=${estimateTokens(text)} must be < 220`)
})

test('Resume backward surface scan, session-sticky packet isolation & fail-open single-warn resilience', async () => {
  const subWs = mkdtempSync(join(tmpdir(), 'galley-m3-resume-'))
  try {
    const registry = new GalleyServiceRegistry()
    const { deps, root } = makeDeps(subWs, registry)
    const pA = await galleyOpen(deps, { template: 'arbeitsblatt', title: 'Mappe Alpha' })
    const pB = await galleyOpen(deps, { template: 'generic', title: 'Mappe Beta' })

    // Pin session-alpha to pA even though global active.json points to pB
    setSessionActivePacket(root, 'sess-alpha', pA.packetId)

    const { runStep } = mountPreStep({
      registry,
      getDepsForCwd: async (c) => makeDeps(c, registry),
    })

    // 1. Caught-up resumed session on pA -> 0 messages spliced
    const resumedCaughtUp = makeMockSession(subWs, 'sess-alpha', [
      {
        type: 'user/message',
        data: {
          role: 'user',
          source: { kind: 'dsh-galley', form: 'galley-delta', version: 1, packetId: pA.packetId, rev: pA.rev },
          content: [{ type: 'text', text: '[dsh-galley prior]' }],
        },
      },
    ])
    const c1 = makeStepCall(resumedCaughtUp, 'Weiter!')
    assert.equal(await runStep(c1.args, c1.decisionIn), c1.decisionIn)

    // 2. Offline human edit on pA -> resumed session recovers exact Changed diff from undo ring
    await galleyEditBlock(deps, {
      packetId: pA.packetId,
      op: 'patch',
      blockId: 'b2',
      patch: { body: 'Offline vom Lehrer geänderte Aufgabe.' },
      origin: 'human',
    })
    const resumedBehind = makeMockSession(subWs, 'sess-alpha', [
      {
        type: 'user/message',
        data: {
          role: 'user',
          source: { kind: 'dsh-galley', form: 'galley-delta', version: 1, packetId: pA.packetId, rev: pA.rev },
          content: [{ type: 'text', text: '[dsh-galley prior]' }],
        },
      },
    ])
    const c2 = makeStepCall(resumedBehind, 'Was ist neu?')
    const out2 = await runStep(c2.args, c2.decisionIn)
    assert.equal(out2.messages.length, 3)
    assert.equal(out2.messages[1].source.packetId, pA.packetId)
    assert.match(out2.messages[1].content[0].text, new RegExp(`Changed since rev ${pA.rev}: b2 \\(task\\)`))

    // 3. Fail-open logs at most once per session
    const warnings = []
    const broken = mountPreStep(
      { getDepsForCwd: async () => { throw new Error('disk boom') } },
      warnings,
    )
    const sessBroken = makeMockSession(subWs, 'sess-broken')
    const b1 = makeStepCall(sessBroken)
    assert.equal(await broken.runStep(b1.args, b1.decisionIn), b1.decisionIn)
    const b2 = makeStepCall(sessBroken)
    assert.equal(await broken.runStep(b2.args, b2.decisionIn), b2.decisionIn)
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(subWs, { recursive: true, force: true })
  }
})

test('M3.1 P0 & P1: multi-sheet insert guard, beforeId/afterId sheet inference, receipt sheetId, sheet CRUD/geometry ops & journal attribution', async () => {
  const subWs = mkdtempSync(join(tmpdir(), 'galley-m31-ops-'))
  try {
    const { deps } = makeDeps(subWs)
    const opened = await galleyOpen(deps, { template: 'arbeitsblatt', title: 'Westfälischer Friede' })
    const pid = opened.packetId

    // P0.1: Multi-sheet packet (`s1`, `s2`) rejects un-anchored `insert` without `sheetId`!
    const ambiguous = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'insert',
      origin: 'agent',
      block: { type: 'answer', body: 'Zweite Lösung darf nicht still auf s1 landen!' },
    })
    assert.equal(ambiguous.ok, false)
    assert.equal(ambiguous.code, Err.INVALID_PARAMS)
    assert.match(ambiguous.message, /multi-sheet packet \(s1, s2\): pass sheetId/)

    // P0.2: `afterId: 'b4'` (where b4 is on s2) automatically infers `sheetId: 's2'` and echoes `sheetId` in receipt + proof!
    const anchoredAfter = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'insert',
      afterId: 'b4',
      origin: 'agent',
      block: { type: 'answer', body: 'Zweite Lösung auf s2 hinter b4', dependsOn: ['b2'] },
    })
    assert.equal(anchoredAfter.ok, true)
    assert.equal(anchoredAfter.sheetId, 's2')
    assert.equal(anchoredAfter.proof.sheetId, 's2')
    const loadedAfter = deps.store.load(pid)
    assert.equal(loadedAfter.sheets.s2.blocks.at(-1).id, anchoredAfter.block.id)
    assert.equal(loadedAfter.sheets.s1.blocks.some((b) => b.id === anchoredAfter.block.id), false)

    // P1.1: `sheet-add` creates a 3rd sheet (landscape, targetPages: 1) via `galley_edit_block`
    const s3Res = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'sheet-add',
      origin: 'agent',
      title: 'Verlaufsplan',
      orientation: 'landscape',
      targetPages: 1,
    })
    assert.equal(s3Res.ok, true)
    assert.equal(s3Res.sheetId, 's3')
    assert.deepEqual(s3Res.sheetOrder, ['s1', 's2', 's3'])
    assert.ok(s3Res.proof.perPage[0].wPt > 800, 's3 created in landscape A4')

    // P1.2: `sheet-update` adjusts s1 targetPages 1 -> 2, then 0 clears to unbounded (`null`), with attributed journal!
    const upd1 = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'sheet-update',
      sheetId: 's1',
      targetPages: 2,
      origin: 'human',
    })
    assert.equal(upd1.ok, true)
    assert.equal(upd1.proof.targetPages, 2)

    const status1 = await galleyStatus(deps, { packetId: pid })
    assert.equal(status1.ok, true)
    const lastChange = status1.recentChanges.at(-1)
    assert.equal(lastChange.actor, 'human')
    assert.match(lastChange.note, /sheet s1 targetPages 1→2 \(human\)/)

    const updClear = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'sheet-update',
      sheetId: 's1',
      targetPages: 0,
      origin: 'agent',
    })
    assert.equal(updClear.ok, true)
    assert.equal(updClear.proof.targetPages, null)

    // P1.3: `sheet-remove` removes s3 cleanly
    const remS3 = await galleyEditBlock(deps, {
      packetId: pid,
      op: 'sheet-remove',
      sheetId: 's3',
      origin: 'agent',
    })
    assert.equal(remS3.ok, true)
    assert.deepEqual(remS3.sheetOrder, ['s1', 's2'])
  } finally {
    rmSync(subWs, { recursive: true, force: true })
  }
})

test('M3.1 P2 & zero-skill packaging: GFM pipe tables + full header/task in md export; 6 tools locked; no dsh-skills coupling', async () => {
  const subWs = mkdtempSync(join(tmpdir(), 'galley-m31-md-'))
  try {
    const { deps } = makeDeps(subWs)
    const opened = await galleyOpen(deps, {
      template: 'generic',
      title: 'Markdown Fidelity',
      blocks: [
        {
          type: 'header',
          fields: { titel: 'Der Westfälische Friede', fach: 'Geschichte', klasse: '9b', datum: '24.10.1648', name: '' },
        },
        {
          type: 'source_text',
          title: 'Quelle M1: Friedensvertrag von Osnabrück',
          lineNumbers: { every: 5 },
          body: 'Alle Reichsstände erhalten das Bündnisrecht.',
        },
        {
          type: 'table',
          colWidths: ['20%', '40%', '40%'],
          headers: ['Bereich', 'Regelung 1648', 'Folge'],
          rows: [
            ['Konfession', '**Normaljahr 1624** (inkl. Calvinismus)', 'Ende der Glaubenskriege'],
            ['Reichsrecht', 'Landeshoheit (*ius territoriale*)', 'Machtverlust des Kaisers'],
          ],
        },
        {
          type: 'task',
          body: 'Erläutere die konfessionellen Bestimmungen anhand der Tabelle.',
        },
        {
          type: 'task',
          body: 'Aufgabe 2 (AFB III): Beurteile die Reichsverfassung nach 1648.',
        },
      ],
    })
    assert.equal(opened.ok, true)

    const mdRes = await galleyExport(deps, { packetId: opened.packetId, format: 'md' })
    assert.equal(mdRes.ok, true)
    const md = mdRes.text

    // Header retains Fach, Klasse, Datum, AND student Name fill-in line
    assert.match(md, /\*\*Der Westfälische Friede\*\* · Fach: Geschichte · Klasse: 9b · Datum: 24\.10\.1648 · Name: _{10,}/)
    // Source text retains title
    assert.match(md, /### Quelle M1: Friedensvertrag von Osnabrück/)
    // Valid GFM pipe table with separators between every column and trailing pipes
    assert.match(md, /\| \*\*Bereich\*\* \| \*\*Regelung 1648\*\* \| \*\*Folge\*\* \|/)
    assert.match(md, /\| --- \| --- \| --- \|/)
    assert.match(md, /\| Konfession \| \*\*Normaljahr 1624\*\* \(inkl\. Calvinismus\) \| Ende der Glaubenskriege \|/)
    // Task 1 gets auto-numbered, Task 2 does NOT get double-prefixed
    assert.match(md, /\*\*Aufgabe 1:\*\* Erläutere die konfessionellen Bestimmungen/)
    assert.equal(/Aufgabe 2.*Aufgabe 2/.test(md), false)
    assert.match(md, /Aufgabe 2 \(AFB III\): Beurteile/)

    // Verify 6 tools locked and ZERO dsh-skills dependency in apply() or package.json
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    assert.equal(pkg.files.includes('skills'), false)
    assert.equal(existsSync(join(process.cwd(), 'skills')), false)

    const registeredTools = []
    const injectedDeps = []
    const mockCtx = {
      provide: () => () => {},
      tools: { register: (def) => { registeredTools.push(def); return () => {} } },
      on: () => () => {},
      inject: (depsArr) => { injectedDeps.push(depsArr) },
      effect: () => {},
      logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    }
    assert.doesNotThrow(() => apply(mockCtx))
    assert.equal(registeredTools.length, 6, 'strictly 6 tools registered')
    assert.equal(injectedDeps.some((d) => d.includes('skills')), false, 'zero dsh-skills injection')
  } finally {
    rmSync(subWs, { recursive: true, force: true })
  }
})
