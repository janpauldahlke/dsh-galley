/**
 * dsh-galley — typst module (HERMETIC core).
 *
 * Pure block-model → deterministic `.typ` source + receipt derivation. Zero
 * dsh-harness (provider) imports and zero native imports, so it bundles
 * standalone (`lib/typst-render.mjs`) and `node --test` runs without booting dsh
 * (guardrail 6). The render ARMS (native/WASM/CLI) live in the host face and
 * consume the `.typ` string this module produces + the SVG it returns.
 *
 * ── Escaping (why user text can NEVER break Typst) ────────────────────────
 * Arbitrary text is emitted as a CODE-MODE string literal passed to `text(…)`,
 * e.g. `#text("…")`. A string literal terminates at the first unescaped `"`
 * and treats `\` as an escape introducer, so escaping `\` and `"` is total.
 * A markup-mode `"…"` (no `#`) is NOT inert to `#`/`$`/`_` — only a code-mode
 * literal is (verified in M0). `#text(…)` is that literal, rendered as the
 * surrounding paragraph's text.
 *
 * ── Block attribution (M1 correction to spec 03 §4.2) ─────────────────────
 * 0.14.2 has NO user-definable introspectable element (`element(…)` is not a
 * public function; `query(heading, offset)` returns 0 for every element and
 * there is no `page` field). So block→page cannot come from `query`. Instead:
 *   • LEXICAL: every block is preceded by a `// @@g <id>@@` marker. Compile
 *     errors carry `file:line:col` (CLI arm) or a source span (native), which
 *     map to the nearest preceding marker → `blockId`.
 *   • GEOMETRIC: every block emits a tiny `rect` with a unique fill
 *     `rgb(i+1, 0, 0)` (→ SVG `<path fill="#0(i)0000">`). The stacked SVG is
 *     segmented by `<g class="typst-page">` byte offsets (`parseSvgPages`); an
 *     anchor's page is the page segment whose byte range contains it — no
 *     transform math (more robust on multi-page output than a y-walk).
 */

import type {
  Block,
  GalleySheet,
  Inline,
  BlockId,
  SheetId,
  LayoutSlot,
} from '../shared/types.ts'

// ── M0 legacy API (kept so the 11-test baseline + health probe stay green) ──

export type GalleyBlockKind =
  | 'header'
  | 'heading'
  | 'prose'
  | 'task'
  | 'answer'
  | 'callout'
  | 'source_text'
  | 'table'

/** One block in a sheet (M0 simple model). `id` is a stable short id (b1, …). */
export interface GalleyBlock {
  id: string
  kind: GalleyBlockKind
  text: string
  /** heading level (1–6); only meaningful for kind: 'heading'. */
  level?: number
}

/** Escape arbitrary text into a Typst double-quoted string literal (M0). */
export function typstStringLiteral(raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return '"' + escaped + '"'
}

/** One M0 block → deterministic `.typ` line(s). */
export function blockToTypst(b: GalleyBlock): string {
  const lit = typstStringLiteral(b.text)
  const label = `#label(${typstStringLiteral(b.id)})`
  const content = `#text(${lit})`
  switch (b.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(6, b.level ?? 1))
      return `${'='.repeat(level)} ${label} ${content}`
    }
    case 'header':
      return `${label} ${content}`
    case 'task':
    case 'answer':
      return `${label}   ${content}`
    default:
      return `${label} ${content}`
  }
}

export interface RenderOptions {
  paper?: string
  sizePt?: number
}

/** M0: block list → a complete, self-contained `.typ` document (A4 default). */
export function renderTypstSource(blocks: GalleyBlock[], opts: RenderOptions = {}): string {
  const lines: string[] = []
  lines.push(`#set page(paper: ${typstStringLiteral(opts.paper ?? 'a4')}, margin: (top: 2cm, bottom: 2cm, left: 2.5cm, right: 2.5cm))`)
  lines.push(`#set text(size: ${opts.sizePt ?? 11}pt, lang: "en")`)
  lines.push('')
  for (const b of blocks) {
    lines.push(blockToTypst(b))
    lines.push('')
  }
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// M1 core — spec 01 types, spec 03 §4–§5
// ───────────────────────────────────────────────────────────────────────────

/** Paper dimensions in pt (spec 01 geometry; used for receipt page math). */
export const PAPER_PT: Record<'a4' | 'letter', { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
}
export const PT_PER_CM = 72 / 2.54 // 28.3464566929

/**
 * Exhaustive value → Typst literal (spec 03 §5). Strings go through the
 * total `\`/`"` escape; every other kind is representable as a literal, so a
 * user value can never inject code.
 */
export function typString(v: unknown): string {
  if (v === null) return 'none'
  switch (typeof v) {
    case 'string': {
      // JS string escaping == Typst string-literal escaping for the chars that
      // break a parse; JSON.stringify handles `\`, `"`, and control chars.
      return JSON.stringify(v)
    }
    case 'number':
      return Number.isFinite(v) ? String(v) : '0'
    case 'boolean':
      return v ? 'true' : 'false'
    default:
      return JSON.stringify(String(v))
  }
}

/** `#`-safe inline emitter: text → code-mode literal, markup → balanced. */
function inlineToContent(inlines: Inline[], depth = 0): string {
  const parts: string[] = []
  for (const it of inlines) {
    switch (it.t) {
      case 'text':
        parts.push(`#text(${typString(it.v)})`)
        break
      case 'strong':
        parts.push(`#strong[${inlineToContent(it.c, depth + 1)}]`)
        break
      case 'emph':
        parts.push(`#emph[${inlineToContent(it.c, depth + 1)}]`)
        break
      case 'code':
        parts.push(`#${it.v === '' ? 'raw("")' : `raw(${JSON.stringify(it.v)})`}`)
        break
      case 'cloze': {
        const n = Math.max(1, (it.hint ?? '').length + 1)
        parts.push(`#underline(${typString(' '.repeat(n))})`)
        break
      }
      case 'math':
        // math.v is trusted math-mode source (spec 03 §5). Guard empty input.
        parts.push(it.v.trim() === '' ? '' : `$${it.v}$`)
        break
      case 'newline':
        // Trailing space is mandatory in Typst markup mode so `\` + `#text(...)`
        // never forms `\#` (an escaped literal `#` character!).
        parts.push(' \\ ')
        break
      default:
        break
    }
  }
  return parts.join('')
}

/** Deterministic anchor color for block at 0-based index i (spec 03 §4.2). */
export function anchorHexFor(i: number): string {
  const v = (i + 1) & 0xff // 1..255; sheets never exceed 255 blocks
  return '#' + v.toString(16).padStart(2, '0') + '0000'
}

/** `// @@g <id>@@` lexical marker (spec 03 §4.2). */
export function markerComment(id: string): string {
  return `// @@g ${id}@@`
}

/**
 * The block's geometric anchor: a sub-point, OUT-OF-FLOW colored rect
 * (`#place`) so it contributes zero to document flow while still being
 * measurable in the SVG. `#place` defaults to the current (top-left) position,
 * so the anchor sits at the top of its block.
 */
function anchorRect(i: number): string {
  return `#place(rect(width: 0.001pt, height: 0.001pt, fill: rgb(${(i + 1) & 0xff}, 0, 0)))`
}

/** Callout tone → fill + left accent. 0.14.2 `rgb()` takes 0–255 ints (or %);
 *  0..1 floats and `#hex` literals are NOT valid in code mode. */
const CALLOUT_TONES: Record<'info' | 'hint' | 'warning', { fill: string; accent: string; label: string }> = {
  info: { fill: 'rgb(232, 240, 254)', accent: 'rgb(26, 115, 232)', label: 'Info' },
  hint: { fill: 'rgb(230, 244, 234)', accent: 'rgb(24, 128, 56)', label: 'Tipp' },
  warning: { fill: 'rgb(252, 232, 230)', accent: 'rgb(217, 48, 37)', label: 'Achtung' },
}

/**
 * Resolve a media slot's asset to a `#image(…)` reference (M1.5 H2.2). The
 * `assets` map holds `AssetMeta` records (keyed by id); the reference is the
 * asset's packet-relative `path` (e.g. `assets/a1.png`), JSON-quoted so it is
 * inert to any metacharacters. The arms map that path to the asset bytes
 * (native `mapShadow`) so the image resolves offline.
 */
function mediaImage(
  assets: Record<string, unknown> | undefined,
  assetId: string,
  widthCm?: number,
): string {
  const meta = assets?.[assetId] as { path?: string } | undefined
  if (!meta?.path) return ''
  const w = widthCm !== undefined && Number.isFinite(widthCm) && widthCm > 0 ? `${widthCm}cm` : '100%'
  return `#image(${JSON.stringify(meta.path)}, width: ${w})`
}

/** Split a block's inline body into discrete card cell contents for `card-grid` (spec 01 §3 / spec 03 §5.2). */
function cardCellsFromBlock(block: Block, renderedFallback: string): string[] {
  const body = (block as { body?: Inline[] }).body
  if (!body || body.length === 0) return [renderedFallback]
  // Split on explicit newline runs or `\n` inside text runs first.
  const hasLineBreaks = body.some((it) => it.t === 'newline' || (it.t === 'text' && it.v.includes('\n')))
  if (hasLineBreaks) {
    const groups: Inline[][] = []
    let cur: Inline[] = []
    for (const it of body) {
      if (it.t === 'newline') {
        groups.push(cur)
        cur = []
      } else if (it.t === 'text' && it.v.includes('\n')) {
        const parts = it.v.split('\n')
        parts.forEach((p, idx) => {
          if (idx > 0) {
            groups.push(cur)
            cur = []
          }
          if (p.length > 0) cur.push({ t: 'text', v: p })
        })
      } else {
        cur.push(it)
      }
    }
    groups.push(cur)
    const nonEmpty = groups.filter((g) => g.length > 0)
    if (nonEmpty.length > 0) return nonEmpty.map((g) => inlineToContent(g))
  }
  // Otherwise multiple top-level inline items each become one card cell (spec 01 §3).
  if (body.length > 1) return body.map((it) => inlineToContent([it]))
  return [renderedFallback]
}

/** Wrap a rendered block body in its layout slot (spec 03 §4.1, M1.6). */
function wrapSlot(block: Block, body: string, assets?: Record<string, unknown>): string {
  const slot = block.slot
  switch (slot?.mode) {
    case 'media-right': {
      const img = slot.asset ? mediaImage(assets, slot.asset.id, slot.asset.widthCm) : ''
      return `#grid(columns: (65%, 35%), column-gutter: 12pt)[${body}][${img}]`
    }
    case 'media-left': {
      const img = slot.asset ? mediaImage(assets, slot.asset.id, slot.asset.widthCm) : ''
      return `#grid(columns: (35%, 65%), column-gutter: 12pt)[${img}][${body}]`
    }
    case 'two-column':
      return `#columns(2, gutter: 12pt)[${body}]`
    case 'card-grid': {
      const cols = slot.columns ?? 3
      const h = ((slot.cardHeightCm ?? 6) * PT_PER_CM).toFixed(1)
      const colSpec = `(${Array.from({ length: cols }, () => '1fr').join(', ')})`
      const cards = cardCellsFromBlock(block, body).map(
        (c) =>
          `block(width: 100%, height: ${h}pt, inset: 8pt, fill: luma(251), stroke: (paint: luma(130), thickness: 0.6pt, dash: "dashed"))[${c}]`,
      )
      return `#grid(columns: ${colSpec}, column-gutter: 8pt, row-gutter: 8pt, ${cards.join(', ')})`
    }
    default:
      return body
  }
}

/**
 * One block → deterministic `.typ` (marker + zero-flow anchor + typed body,
 * wrapped in the block's layout slot). `index` is the block's 0-based POSITION
 * in the sheet (the anchor color tracks position so a re-render after reorder
 * stays consistent with the `anchors` array).
 */
export function blockTypst(block: Block, index: number, assets?: Record<string, unknown>, taskNum?: number): string {
  const lines: string[] = [markerComment(block.id), anchorRect(index)]
  switch (block.type) {
    case 'header': {
      const f = block.fields ?? {}
      const meta: string[] = []
      if (f.fach) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.fach)})`)
      if (f.klasse) meta.push(`#text(size: 9pt, fill: luma(110), ${typString('Klasse: ' + f.klasse)})`)
      if (f.datum) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.datum)})`)
      const right = `[${meta.length ? meta.join('#linebreak()') : ''}]`
      const left: string[] = [`#text(size: 8pt, fill: luma(110), ${typString('TITEL')})`]
      if (f.titel) left.push(`#text(size: 17pt, weight: "bold", ${typString(f.titel)})`)
      if (f.name !== undefined) {
        const nameVal = f.name.trim() ? f.name : '________________________'
        left.push(`#text(size: 9pt, fill: luma(110), ${typString('Name: ' + nameVal)})`)
      }
      lines.push(
        `#grid(columns: (1fr, auto), column-gutter: 12pt, align: (top, top))` +
          `[${left.join('#linebreak()')}#linebreak()]${right}`,
        `#rect(width: 100%, height: 0.6pt, fill: luma(170))`,
      )
      break
    }
    case 'heading': {
      const level = block.level ?? 1
      lines.push(`${'='.repeat(level)} ${inlineToContent(block.body)}`)
      break
    }
    case 'prose':
      lines.push(inlineToContent(block.body))
      break
    case 'source_text': {
      // Break the inline body into visual lines (text-run `\n` and explicit
      // newline runs both terminate a line).
      const lineRuns: Inline[][] = []
      let cur: Inline[] = []
      for (const it of block.body) {
        if (it.t === 'text') {
          const parts = it.v.split('\n')
          parts.forEach((p, i) => {
            if (i > 0) {
              lineRuns.push(cur)
              cur = []
            }
            if (p.length > 0) cur.push({ t: 'text', v: p })
          })
        } else if (it.t === 'newline') {
          lineRuns.push(cur)
          cur = []
        } else {
          cur.push(it)
        }
      }
      lineRuns.push(cur)
      const ln = block.lineNumbers
      if (block.title) {
        // Blank line (`''`) ends the title paragraph so `#set par.line` inside `#[...]`
        // starts a fresh paragraph scope (Typst evaluates par.line per paragraph).
        lines.push(`#strong[#text(${typString(block.title)})]`, '')
      }
      if (ln) {
        // Per-block marginal line numbers (Typst 0.14.2): a block-scoped `state`
        // anchors this block's first rendered physical line `f`, so each `source_text`
        // block resets cleanly to `start` (default 1) even when multiple sources sit
        // on the same sheet or span across page breaks.
        const every = Math.max(1, ln.every ?? 1)
        const startOff = (ln.start ?? 1) - 1
        const stateKey = typString(`g_ln_${block.id}_${index}`)
        const kExpr =
          startOff === 0
            ? `(if f == none { 1 } else { n - f + 1 })`
            : `((if f == none { 1 } else { n - f + 1 }) + ${startOff})`
        lines.push(
          `#[`,
          `#let _gln = state(${stateKey}, none)`,
          `#set par.line(numbering: n => context { let f = _gln.get(); let k = ${kExpr}; if f == none { _gln.update(n) }; if calc.rem(k, ${every}) == 0 { text(size: 8pt, fill: luma(110))[#k] } }, numbering-scope: "document")`,
          lineRuns.map((runs) => inlineToContent(runs)).join(' \\ '),
          `]`,
        )
      } else {
        let out = ''
        for (const runs of lineRuns) {
          if (out.length > 0) out += '\\ '
          out += inlineToContent(runs)
        }
        lines.push(out)
      }
      break
    }
    case 'task': {
      // Avoid double "Aufgabe 1 Aufgabe 1:" when an author/model already wrote the prefix in `body`.
      const firstNode = block.body?.[0]
      const leadingText =
        firstNode?.t === 'text'
          ? firstNode.v
          : firstNode?.t === 'strong' && firstNode.c?.[0]?.t === 'text'
            ? firstNode.c[0].v
            : ''
      if (/^\s*Aufgabe\s+\d+\b/i.test(leadingText)) {
        lines.push(inlineToContent(block.body))
      } else {
        lines.push(`#text(weight: "bold", ${typString(taskNum ? 'Aufgabe ' + taskNum : 'Aufgabe')}) ${inlineToContent(block.body)}`)
      }
      break
    }
    case 'table': {
      const cell = (cells: Inline[]): string => `[${inlineToContent(cells)}]`
      const headerCell = (cells: Inline[]): string => `[#strong[${inlineToContent(cells)}]]`
      const cols = Math.max(1, block.headers.length, ...block.rows.map((r) => r.length))
      const pad = (cells: Inline[][], padFn: (c: Inline[]) => string): string[] => {
        const out: Inline[][] = [...cells]
        while (out.length < cols) out.push([])
        return out.map(padFn)
      }
      const hdr = pad(block.headers, headerCell)
      const bodyCells = block.rows.flatMap((r) => pad(r, cell))
      let columnsSpec = String(cols)
      if (Array.isArray(block.colWidths) && block.colWidths.length > 0) {
        const safeSpecs: string[] = []
        for (let ci = 0; ci < cols; ci++) {
          const w = block.colWidths[ci]
          if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
            safeSpecs.push(`${w}fr`)
          } else if (typeof w === 'string' && /^(\d+(\.\d+)?(%|fr|pt|cm|mm|em)|auto)$/.test(w.trim())) {
            safeSpecs.push(w.trim())
          } else {
            safeSpecs.push('1fr')
          }
        }
        columnsSpec = `(${safeSpecs.join(', ')})`
      }
      const tableArgs = [
        `columns: ${columnsSpec}`,
        `inset: 6pt`,
        `fill: (_, y) => if y == 0 { luma(245) } else { rgb(255, 255, 255) }`,
        `stroke: 0.5pt + luma(180)`,
        `table.header(${hdr.join(', ')})`,
        ...bodyCells,
      ]
      lines.push(`#table(${tableArgs.join(', ')})`)
      break
    }
    case 'callout': {
      const t = CALLOUT_TONES[block.tone ?? 'info']
      lines.push(
        `#block(width: 100%, inset: 8pt, fill: ${t.fill}, stroke: (left: 3pt + ${t.accent}))[`,
        `#text(size: 8pt, weight: "bold", fill: ${t.accent}, ${typString(t.label)})`,
        `#linebreak()`,
        inlineToContent(block.body),
        `]`,
      )
      break
    }
    case 'answer':
      lines.push(inlineToContent(block.body))
      break
  }
  // Keep marker (lines[0]) + zero-flow anchor (lines[1]) OUTSIDE the layout slot
  // so multi-column / card-grid wrappers never displace or duplicate the anchor.
  const body = lines.slice(2).join('\n')
  lines.length = 2
  lines.push(wrapSlot(block, body, assets))
  return lines.join('\n')
}

export interface CompileSheetResult {
  /** The complete, self-contained `.typ` document for the sheet. */
  typ: string
  /** Deterministic anchor hex per block (for block→page receipt). */
  anchors: { blockId: BlockId; hex: string }[]
  /** pageHeight in pt (for the receipt page math). */
  pageHeightPt: number
  /** pageWidth in pt. */
  pageWidthPt: number
  /** targetPages from the sheet geometry (undefined = unbounded). */
  targetPages: number | undefined
}

/** Preamble (0.14.2 surface, spec 03 §3; M1.5 H3.2). */
function preamble(sheet: GalleySheet): string[] {
  const g = sheet.geometry
  const m = g.margin
  const isLandscape = g.orientation === 'landscape'
  const L: string[] = []
  L.push(
    `// galley preamble — sheet ${sheet.id} "${sheet.title}" (${g.paper}${isLandscape ? ' landscape' : ''}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} cm)`,
  )
  const flippedArg = isLandscape ? ', flipped: true' : ''
  L.push(`#set page(paper: ${typString(g.paper)}${flippedArg}, margin: (top: ${m.top}cm, bottom: ${m.bottom}cm, left: ${m.left}cm, right: ${m.right}cm))`)
  L.push(`#set text(size: 10pt, lang: "de")`)
  L.push(`#set par(justify: true, leading: 0.75em)`)
  L.push(`#set heading(numbering: none)`)
  // Suppress `#title` when a `header` block carries the title OR block 0 is already
  // a level-1 `heading` (prevents duplicate "Erwartungshorizont" headings on s2).
  const firstBlk = sheet.blocks[0]
  const hasOwnBanner =
    sheet.blocks.some((b) => b.type === 'header') ||
    (firstBlk?.type === 'heading' && (firstBlk.level ?? 1) === 1)
  if (!hasOwnBanner) {
    L.push(`#title(${typString(sheet.title)})`)
  }
  return L
}

/** Deterministic pure function: sheet → `.typ` (spec 03 §4; M1.6). */
export function compileSheet(sheet: GalleySheet, assets?: Record<string, unknown>): CompileSheetResult {
  const rawDim = PAPER_PT[sheet.geometry.paper]
  const isLandscape = sheet.geometry.orientation === 'landscape'
  const pageWidthPt = isLandscape ? rawDim.h : rawDim.w
  const pageHeightPt = isLandscape ? rawDim.w : rawDim.h
  const lines: string[] = [...preamble(sheet), '']
  const anchors: { blockId: BlockId; hex: string }[] = []
  let taskCount = 0
  sheet.blocks.forEach((block, i) => {
    if (block.type === 'task') taskCount += 1
    lines.push(blockTypst(block, i, assets, block.type === 'task' ? taskCount : undefined))
    lines.push('')
    anchors.push({ blockId: block.id, hex: anchorHexFor(i) })
  })
  return {
    typ: lines.join('\n'),
    anchors,
    pageHeightPt,
    pageWidthPt,
    targetPages: sheet.geometry.targetPages,
  }
}

// ── Receipt derivation (pure; SVG in, numbers + block→page out) ───────────

/**
 * Walk a stacked Typst SVG, returning absolute positions of all
 * `typst-text` groups (lines) and `typst-shape` paths (incl. anchors).
 * Matches real `<g>`/`<path>` open/close tags — NOT `<glyph>`/`<outline_glyph>`
 * (which also start with `<g`); self-closing tags never push to the stack.
 */
export function parseSvgPositions(svg: string): { textYs: number[]; shapes: { hex: string; ay: number }[] } {
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>/g
  const stack: { ax: number; ay: number; sx: number; sy: number }[] = []
  const textYs: number[] = []
  const shapes: { hex: string; ay: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const closing = m[1] === '/'
    const name = m[2]
    const attrs = m[3] || ''
    const selfClose = /\/\s*>/.test(attrs.trimEnd())
    if (closing) {
      stack.pop()
      continue
    }
    let x = 0
    let y = 0
    let sx = 1
    let sy = 1
    const tr = attrs.match(/transform="([^"]*)"/)
    if (tr) {
      const t = tr[1].match(/translate\(([-\d.]+)[,\s]+([-\d.]+)\)/)
      const sc = tr[1].match(/scale\(([-\d.]+)[,\s]+([-\d.]+)\)/)
      if (t) {
        x = +t[1]
        y = +t[2]
      }
      if (sc) {
        sx = +sc[1]
        sy = +sc[2]
      }
    }
    const p = stack[stack.length - 1]
    const ax = (p ? p.ax : 0) + (p ? p.sx : 1) * x
    const ay = (p ? p.ay : 0) + (p ? p.sy : 1) * y
    if (name === 'g' && /class="typst-text"/.test(attrs)) {
      textYs.push(Math.round(ay * 100) / 100)
    } else if (name === 'path' && /class="typst-shape"/.test(attrs)) {
      const fill = attrs.match(/fill="([^"]+)"/)
      if (fill) shapes.push({ hex: fill[1], ay: Math.round(ay * 100) / 100 })
    }
    if (!selfClose) stack.push({ ax, ay, sx, sy })
  }
  return { textYs, shapes }
}

/** Cluster y-values into visual lines (tolerance in pt). */
export function clusterLines(ys: number[], tol = 2.5): number[] {
  if (ys.length === 0) return []
  const sorted = [...ys].sort((a, b) => a - b)
  const out: number[] = []
  for (const y of sorted) {
    if (out.length === 0 || y - out[out.length - 1] > tol) out.push(y)
  }
  return out
}

/**
 * Robust page-aware SVG parse (M1 fix). Typst's stacked SVG wraps each page in
 * `<g class="typst-page" transform="translate(x, y)">`; these groups are
 * sequential and non-overlapping, so an element's page index = the count of
 * `typst-page` starts at/before its byte offset, minus 1. No transform math —
 * immune to the nested scale/translate in `outline_glyph` paths that made the
 * old absolute-y walk diverge on multi-page output.
 */
export function parseSvgPages(svg: string): {
  pageCount: number
  linesPerPage: number[]
  anchors: { hex: string; page: number }[]
} {
  const pageStarts: number[] = []
  const pageRe = /<g class="typst-page"/g
  let pm: RegExpExecArray | null
  while ((pm = pageRe.exec(svg)) !== null) pageStarts.push(pm.index)
  const pageCount = Math.max(1, pageStarts.length)
  const pageOf = (off: number): number => {
    let n = 0
    for (const s of pageStarts) if (s <= off) n++
    return Math.max(0, Math.min(pageCount - 1, n - 1))
  }
  const linesPerPage = new Array<number>(pageCount).fill(0)
  const anchors: { hex: string; page: number }[] = []
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(svg)) !== null) {
    const name = tm[1]
    const attrs = tm[2] || ''
    if (name === 'g' && /class="typst-text"/.test(attrs)) {
      linesPerPage[pageOf(tm.index)]++
    } else if (name === 'path' && /class="typst-shape"/.test(attrs)) {
      const fill = attrs.match(/fill="([^"]+)"/)
      if (fill) anchors.push({ hex: fill[1], page: pageOf(tm.index) })
    }
  }
  return { pageCount, linesPerPage, anchors }
}

function scopeTypstCss(svgFragment: string): string {
  return svgFragment.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_full, css: string) => {
    const scoped = css
      .replace(/(^|\}|\s)svg\s*\{/g, '$1svg.typst-doc {')
      .replace(/\.tsel\s+span,\s*\.tsel\s*\{[^}]*\}/g, '.tsel, .tsel span { display: none !important; }')
    return `<style type="text/css">${scoped}</style>`
  })
}

function namespaceSvgIds(svgFragment: string, prefix: string): string {
  const ids = new Set<string>()
  const idRe = /\bid="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = idRe.exec(svgFragment)) !== null) ids.add(m[1])
  if (ids.size === 0) return svgFragment
  return svgFragment
    .replace(/\bid="([^"]+)"/g, (full, id: string) => (ids.has(id) ? `id="${prefix}${id}"` : full))
    .replace(/\b(xlink:href|href)="#([^"]+)"/g, (full, attr: string, id: string) =>
      ids.has(id) ? `${attr}="#${prefix}${id}"` : full,
    )
    .replace(/url\(#([^)]+)\)/g, (full, id: string) => (ids.has(id) ? `url(#${prefix}${id})` : full))
}

function filterPageGlyphDefs(preamble: string, pageBody: string): string {
  const used = new Set<string>()
  const refRe = /\b(?:xlink:href|href)="#([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = refRe.exec(pageBody)) !== null) used.add(m[1])
  return preamble.replace(/<defs class="glyph">([\s\S]*?)<\/defs>/g, (_full, inner: string) => {
    const filtered = inner.replace(/<path\b[^>]*\bid="([^"]+)"[^>]*\/>/g, (tag, id: string) =>
      used.has(id) ? tag : '',
    )
    return `<defs class="glyph">${filtered}</defs>`
  })
}

/**
 * Split a stacked multi-page Typst SVG into standalone, DOM-isolated per-page
 * `<svg class="typst-doc">` strings (spec 04 §3). Scopes embedded `<style>`
 * rules so inline SVGs cannot bleed onto host chrome icons, resets each page's
 * outer `translate(0, y)` to `(0, 0)`, filters unused glyph defs per page, and
 * namespaces internal `<defs>` IDs to prevent cross-page DOM collisions.
 */
export function splitSvgPages(
  svg: string,
  pageCount: number,
  perPageDims: { wPt: number; hPt: number }[],
  scopePrefix = 'galley',
): string[] {
  const count = Math.max(1, pageCount)
  const fallbackDim = perPageDims[0] ?? { wPt: 595.28, hPt: 841.89 }
  const blankPage = (idx: number): string => {
    const dim = perPageDims[idx] ?? fallbackDim
    return `<svg xmlns="http://www.w3.org/2000/svg" class="typst-doc" viewBox="0 0 ${dim.wPt} ${dim.hPt}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;"></svg>`
  }

  const openEnd = svg.indexOf('>')
  const closeStart = svg.lastIndexOf('</svg>')
  if (openEnd < 0 || closeStart <= openEnd) {
    return Array.from({ length: count }, (_, i) => blankPage(i))
  }

  const pageStarts: number[] = []
  const pageRe = /<g class="typst-page"/g
  let pm: RegExpExecArray | null
  while ((pm = pageRe.exec(svg)) !== null) pageStarts.push(pm.index)

  if (pageStarts.length === 0) {
    const dim = perPageDims[0] ?? fallbackDim
    const inner = scopeTypstCss(svg.slice(openEnd + 1, closeStart))
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml" class="typst-doc" viewBox="0 0 ${dim.wPt} ${dim.hPt}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;">${inner}</svg>`
    const first = namespaceSvgIds(wrapped, `${scopePrefix}_p0_`)
    const out = [first]
    for (let i = 1; i < count; i++) out.push(blankPage(i))
    return out
  }

  const preamble = scopeTypstCss(svg.slice(openEnd + 1, pageStarts[0]))
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    if (i >= pageStarts.length) {
      out.push(blankPage(i))
      continue
    }
    const start = pageStarts[i]
    const end = i + 1 < pageStarts.length ? pageStarts[i + 1] : closeStart
    const rawPage = svg
      .slice(start, end)
      .replace(/^<g class="typst-page"([^>]*?)\btransform="translate\([^"]*\)"/, '<g class="typst-page"$1transform="translate(0, 0)"')
    const dim = perPageDims[i] ?? fallbackDim
    // Honour Typst's integer-rounded data-page-width/height if present so viewBox matches glyph coordinates.
    const mw = rawPage.match(/\bdata-page-width="([\d.]+)"/)
    const mh = rawPage.match(/\bdata-page-height="([\d.]+)"/)
    const vw = mw ? Number(mw[1]) : dim.wPt
    const vh = mh ? Number(mh[1]) : dim.hPt
    const pageDefs = filterPageGlyphDefs(preamble, rawPage)
    const assembled = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml" class="typst-doc" viewBox="0 0 ${vw} ${vh}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;">${pageDefs}${rawPage}</svg>`
    const safePrefix = scopePrefix.replace(/[^A-Za-z0-9_-]/g, '_')
    out.push(namespaceSvgIds(assembled, `${safePrefix}_p${i}_`))
  }
  return out
}

export interface Receipt {
  pages: number
  perPage: number[]
  lastPageLineCount: number
  overflowLinesOnLastPage: number
  blockToPage: Record<BlockId, number>
}

/** Pure receipt math: stacked SVG + anchors → per-page lines + block→page. */
export function deriveReceipt(
  svg: string,
  pages: number,
  _pageHeightPt: number,
  targetPages: number | undefined,
  anchors: { blockId: BlockId; hex: string }[],
): Receipt {
  const { linesPerPage, anchors: found } = parseSvgPages(svg)
  // Per-page line counts, padded/truncated to the authoritative page count
  // (the arm's numOfPages, which is the truth — the SVG may omit trailing
  // blank pages).
  const perPage: number[] = []
  for (let p = 0; p < pages; p++) perPage.push(linesPerPage[p] ?? 0)
  const lastPageLineCount = perPage.length > 0 ? perPage[perPage.length - 1] : 0
  const overflowLinesOnLastPage =
    targetPages !== undefined && pages > targetPages ? lastPageLineCount : 0
  const blockToPage: Record<BlockId, number> = {}
  for (const a of anchors) {
    const hit = found.find((f) => f.hex === a.hex)
    blockToPage[a.blockId] = hit ? hit.page : 0
  }
  return { pages, perPage, lastPageLineCount, overflowLinesOnLastPage, blockToPage }
}

/**
 * Map compile diagnostics (with `file:line:col`) to block ids via the
 * `// @@g <id>@@` markers in the generated `.typ`. Nearest preceding marker
 * wins (spec 03 §4.2).
 */
export function mapDiagnosticsToBlocks(
  typ: string,
  diags: { message: string; line?: number }[],
): { message: string; blockId: BlockId | null; line?: number }[] {
  const markers: { line: number; id: BlockId }[] = []
  typ.split('\n').forEach((l, i) => {
    const mm = l.match(/\/\/ @@g (\S+)@@/)
    if (mm) markers.push({ line: i + 1, id: mm[1] })
  })
  return diags.map((d) => {
    let blockId: BlockId | null = null
    if (d.line) {
      for (const mk of markers) if (mk.line <= d.line) blockId = mk.id
    }
    return { message: d.message, blockId, line: d.line }
  })
}

/**
 * Extract `file:line:col` triples from a CLI stderr string (the CLI arm is the
 * only arm that prints source positions).
 */
export function parseCliDiagnostics(stderr: string): { line?: number; col?: number; message?: string }[] {
  const out: { line?: number; col?: number; message?: string }[] = []
  const re = /\.typ:(\d+):(\d+)/g
  const msgRe = /error:\s*([^\n]+)/g
  const msgs: string[] = []
  let mm: RegExpExecArray | null
  while ((mm = msgRe.exec(stderr)) !== null) msgs.push(mm[1].trim())
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    out.push({ line: +m[1], col: +m[2], message: msgs.length > 0 ? msgs[k % msgs.length] : undefined })
    k++
  }
  return out
}

export type { Block, GalleySheet, Inline, BlockId, SheetId }
