// src/shared/types.ts
var PLUGIN = "dsh-galley";
var VERSION = "0.1.0";
var HEALTH_ROUTE = "/api/galley/health";
var STATE_ROUTE = "/api/galley/state";
var EDIT_ROUTE = "/api/galley/edit";
var EXPORT_ROUTE = "/api/galley/export";
var DOWNLOAD_ROUTE = "/api/galley/download";
var PROPOSAL_ROUTE_PREFIX = "/api/galley/proposal";

// src/typst/index.ts
function typstStringLiteral(raw) {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return '"' + escaped + '"';
}
function blockToTypst(b) {
  const lit = typstStringLiteral(b.text);
  const label = `#label(${typstStringLiteral(b.id)})`;
  const content = `#text(${lit})`;
  switch (b.kind) {
    case "heading": {
      const level = Math.max(1, Math.min(6, b.level ?? 1));
      return `${"=".repeat(level)} ${label} ${content}`;
    }
    case "header":
      return `${label} ${content}`;
    case "task":
    case "answer":
      return `${label}   ${content}`;
    default:
      return `${label} ${content}`;
  }
}
function renderTypstSource(blocks, opts = {}) {
  const lines = [];
  lines.push(`#set page(paper: ${typstStringLiteral(opts.paper ?? "a4")}, margin: (top: 2cm, bottom: 2cm, left: 2.5cm, right: 2.5cm))`);
  lines.push(`#set text(size: ${opts.sizePt ?? 11}pt, lang: "en")`);
  lines.push("");
  for (const b of blocks) {
    lines.push(blockToTypst(b));
    lines.push("");
  }
  return lines.join("\n");
}
var PAPER_PT = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 }
};
var PT_PER_CM = 72 / 2.54;
function typString(v) {
  if (v === null) return "none";
  switch (typeof v) {
    case "string": {
      return JSON.stringify(v);
    }
    case "number":
      return Number.isFinite(v) ? String(v) : "0";
    case "boolean":
      return v ? "true" : "false";
    default:
      return JSON.stringify(String(v));
  }
}
function inlineToContent(inlines, depth = 0) {
  const parts = [];
  for (const it of inlines) {
    switch (it.t) {
      case "text":
        parts.push(`#text(${typString(it.v)})`);
        break;
      case "strong":
        parts.push(`#strong[${inlineToContent(it.c, depth + 1)}]`);
        break;
      case "emph":
        parts.push(`#emph[${inlineToContent(it.c, depth + 1)}]`);
        break;
      case "code":
        parts.push(`#${it.v === "" ? 'raw("")' : `raw(${JSON.stringify(it.v)})`}`);
        break;
      case "cloze": {
        const n = Math.max(1, (it.hint ?? "").length + 1);
        parts.push(`#underline(${typString(" ".repeat(n))})`);
        break;
      }
      case "math":
        parts.push(it.v.trim() === "" ? "" : `$${it.v}$`);
        break;
      case "newline":
        parts.push("\\");
        break;
      default:
        break;
    }
  }
  return parts.join("");
}
function anchorHexFor(i) {
  const v = i + 1 & 255;
  return "#" + v.toString(16).padStart(2, "0") + "0000";
}
function markerComment(id) {
  return `// @@g ${id}@@`;
}
function anchorRect(i) {
  return `#place(rect(width: 0.1pt, height: 0.1pt, fill: rgb(${i + 1 & 255}, 0, 0)))`;
}
var CALLOUT_TONES = {
  info: { fill: "rgb(232, 240, 254)", accent: "rgb(26, 115, 232)", label: "Info" },
  hint: { fill: "rgb(230, 244, 234)", accent: "rgb(24, 128, 56)", label: "Tipp" },
  warning: { fill: "rgb(252, 232, 230)", accent: "rgb(217, 48, 37)", label: "Achtung" }
};
function mediaImage(assets, assetId, widthCm) {
  const meta = assets?.[assetId];
  if (!meta?.path) return "";
  const w = widthCm !== void 0 && Number.isFinite(widthCm) && widthCm > 0 ? `${widthCm}cm` : "100%";
  return `#image(${JSON.stringify(meta.path)}, width: ${w})`;
}
function cardCellsFromBlock(block, renderedFallback) {
  const body = block.body;
  if (!body || body.length === 0) return [renderedFallback];
  const hasLineBreaks = body.some((it) => it.t === "newline" || it.t === "text" && it.v.includes("\n"));
  if (hasLineBreaks) {
    const groups = [];
    let cur = [];
    for (const it of body) {
      if (it.t === "newline") {
        groups.push(cur);
        cur = [];
      } else if (it.t === "text" && it.v.includes("\n")) {
        const parts = it.v.split("\n");
        parts.forEach((p, idx) => {
          if (idx > 0) {
            groups.push(cur);
            cur = [];
          }
          if (p.length > 0) cur.push({ t: "text", v: p });
        });
      } else {
        cur.push(it);
      }
    }
    groups.push(cur);
    const nonEmpty = groups.filter((g) => g.length > 0);
    if (nonEmpty.length > 0) return nonEmpty.map((g) => inlineToContent(g));
  }
  if (body.length > 1) return body.map((it) => inlineToContent([it]));
  return [renderedFallback];
}
function wrapSlot(block, body, assets) {
  const slot = block.slot;
  switch (slot?.mode) {
    case "media-right": {
      const img = slot.asset ? mediaImage(assets, slot.asset.id, slot.asset.widthCm) : "";
      return `#grid(columns: (65%, 35%), column-gutter: 12pt)[${body}][${img}]`;
    }
    case "media-left": {
      const img = slot.asset ? mediaImage(assets, slot.asset.id, slot.asset.widthCm) : "";
      return `#grid(columns: (35%, 65%), column-gutter: 12pt)[${img}][${body}]`;
    }
    case "two-column":
      return `#columns(2, gutter: 12pt)[${body}]`;
    case "card-grid": {
      const cols = slot.columns ?? 3;
      const h = ((slot.cardHeightCm ?? 6) * PT_PER_CM).toFixed(1);
      const colSpec = `(${Array.from({ length: cols }, () => "1fr").join(", ")})`;
      const cards = cardCellsFromBlock(block, body).map(
        (c) => `block(width: 100%, height: ${h}pt, inset: 8pt, fill: luma(251), stroke: (paint: luma(130), thickness: 0.6pt, dash: "dashed"))[${c}]`
      );
      return `#grid(columns: ${colSpec}, column-gutter: 8pt, row-gutter: 8pt, ${cards.join(", ")})`;
    }
    default:
      return body;
  }
}
function blockTypst(block, index, assets, taskNum) {
  const lines = [markerComment(block.id), anchorRect(index)];
  switch (block.type) {
    case "header": {
      const f = block.fields ?? {};
      const meta = [];
      if (f.fach) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.fach)})`);
      if (f.klasse) meta.push(`#text(size: 9pt, fill: luma(110), ${typString("Klasse: " + f.klasse)})`);
      if (f.datum) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.datum)})`);
      const right = `[${meta.length ? meta.join("#linebreak()") : ""}]`;
      const left = [`#text(size: 8pt, fill: luma(110), ${typString("TITEL")})`];
      if (f.titel) left.push(`#text(size: 17pt, weight: "bold", ${typString(f.titel)})`);
      if (f.name !== void 0) {
        const nameVal = f.name.trim() ? f.name : "________________________";
        left.push(`#text(size: 9pt, fill: luma(110), ${typString("Name: " + nameVal)})`);
      }
      lines.push(
        `#grid(columns: (1fr, auto), column-gutter: 12pt, align: (top, top))[#linebreak()${left.join("#linebreak()")}#linebreak()]${right}`,
        `#rect(width: 100%, height: 0.6pt, fill: luma(170))`
      );
      break;
    }
    case "heading": {
      const level = block.level ?? 1;
      lines.push(`${"=".repeat(level)} ${inlineToContent(block.body)}`);
      break;
    }
    case "prose":
      lines.push(inlineToContent(block.body));
      break;
    case "source_text": {
      const lineRuns = [];
      let cur = [];
      for (const it of block.body) {
        if (it.t === "text") {
          const parts = it.v.split("\n");
          parts.forEach((p, i) => {
            if (i > 0) {
              lineRuns.push(cur);
              cur = [];
            }
            if (p.length > 0) cur.push({ t: "text", v: p });
          });
        } else if (it.t === "newline") {
          lineRuns.push(cur);
          cur = [];
        } else {
          cur.push(it);
        }
      }
      lineRuns.push(cur);
      const ln = block.lineNumbers;
      if (block.title) {
        lines.push(`#strong[#text(${typString(block.title)})]`, "");
      }
      if (ln) {
        const every = Math.max(1, ln.every ?? 1);
        const startOff = (ln.start ?? 1) - 1;
        const numExpr = startOff === 0 ? "#n" : `#(n + ${startOff})`;
        lines.push(
          `#[`,
          `#set par.line(numbering: n => if calc.rem(n, ${every}) == 0 { text(size: 8pt, fill: luma(110))[${numExpr}] })`,
          lineRuns.map((runs) => inlineToContent(runs)).join(" \\ "),
          `]`
        );
      } else {
        let out = "";
        for (const runs of lineRuns) {
          if (out.length > 0) out += "\\ ";
          out += inlineToContent(runs);
        }
        lines.push(out);
      }
      break;
    }
    case "task":
      lines.push(`#text(weight: "bold", ${typString(taskNum ? "Aufgabe " + taskNum : "Aufgabe")}) ${inlineToContent(block.body)}`);
      break;
    case "table": {
      const cell = (cells) => `[${inlineToContent(cells)}]`;
      const headerCell = (cells) => `[#strong[${inlineToContent(cells)}]]`;
      const cols = Math.max(1, block.headers.length, ...block.rows.map((r) => r.length));
      const pad = (cells, padFn) => {
        const out = [...cells];
        while (out.length < cols) out.push([]);
        return out.map(padFn);
      };
      const hdr = pad(block.headers, headerCell);
      const bodyCells = block.rows.flatMap((r) => pad(r, cell));
      const tableArgs = [
        `columns: ${cols}`,
        `inset: 6pt`,
        `fill: (_, y) => if y == 0 { luma(245) } else { rgb(255, 255, 255) }`,
        `stroke: 0.5pt + luma(180)`,
        `table.header(${hdr.join(", ")})`,
        ...bodyCells
      ];
      lines.push(`#table(${tableArgs.join(", ")})`);
      break;
    }
    case "callout": {
      const t = CALLOUT_TONES[block.tone ?? "info"];
      lines.push(
        `#block(width: 100%, inset: 8pt, fill: ${t.fill}, stroke: (left: 3pt + ${t.accent}))[`,
        `#text(size: 8pt, weight: "bold", fill: ${t.accent}, ${typString(t.label)})`,
        `#linebreak()`,
        inlineToContent(block.body),
        `]`
      );
      break;
    }
    case "answer":
      lines.push(inlineToContent(block.body));
      break;
  }
  const body = lines.slice(2).join("\n");
  lines.length = 2;
  lines.push(wrapSlot(block, body, assets));
  return lines.join("\n");
}
function preamble(sheet) {
  const g = sheet.geometry;
  const m = g.margin;
  const isLandscape = g.orientation === "landscape";
  const L = [];
  L.push(
    `// galley preamble \u2014 sheet ${sheet.id} "${sheet.title}" (${g.paper}${isLandscape ? " landscape" : ""}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} cm)`
  );
  const flippedArg = isLandscape ? ", flipped: true" : "";
  L.push(`#set page(paper: ${typString(g.paper)}${flippedArg}, margin: (top: ${m.top}cm, bottom: ${m.bottom}cm, left: ${m.left}cm, right: ${m.right}cm))`);
  L.push(`#set text(size: 10pt, lang: "de")`);
  L.push(`#set par(justify: true, leading: 0.75em)`);
  L.push(`#set heading(numbering: none)`);
  if (!sheet.blocks.some((b) => b.type === "header")) {
    L.push(`#title(${typString(sheet.title)})`);
  }
  return L;
}
function compileSheet(sheet, assets) {
  const rawDim = PAPER_PT[sheet.geometry.paper];
  const isLandscape = sheet.geometry.orientation === "landscape";
  const pageWidthPt = isLandscape ? rawDim.h : rawDim.w;
  const pageHeightPt = isLandscape ? rawDim.w : rawDim.h;
  const lines = [...preamble(sheet), ""];
  const anchors = [];
  let taskCount = 0;
  sheet.blocks.forEach((block, i) => {
    if (block.type === "task") taskCount += 1;
    lines.push(blockTypst(block, i, assets, block.type === "task" ? taskCount : void 0));
    lines.push("");
    anchors.push({ blockId: block.id, hex: anchorHexFor(i) });
  });
  return {
    typ: lines.join("\n"),
    anchors,
    pageHeightPt,
    pageWidthPt,
    targetPages: sheet.geometry.targetPages
  };
}
function parseSvgPages(svg) {
  const pageStarts = [];
  const pageRe = /<g class="typst-page"/g;
  let pm;
  while ((pm = pageRe.exec(svg)) !== null) pageStarts.push(pm.index);
  const pageCount = Math.max(1, pageStarts.length);
  const pageOf = (off) => {
    let n = 0;
    for (const s of pageStarts) if (s <= off) n++;
    return Math.max(0, Math.min(pageCount - 1, n - 1));
  };
  const linesPerPage = new Array(pageCount).fill(0);
  const anchors = [];
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let tm;
  while ((tm = tagRe.exec(svg)) !== null) {
    const name2 = tm[1];
    const attrs = tm[2] || "";
    if (name2 === "g" && /class="typst-text"/.test(attrs)) {
      linesPerPage[pageOf(tm.index)]++;
    } else if (name2 === "path" && /class="typst-shape"/.test(attrs)) {
      const fill = attrs.match(/fill="([^"]+)"/);
      if (fill) anchors.push({ hex: fill[1], page: pageOf(tm.index) });
    }
  }
  return { pageCount, linesPerPage, anchors };
}
function scopeTypstCss(svgFragment) {
  return svgFragment.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_full, css) => {
    const scoped = css.replace(/(^|\}|\s)svg\s*\{/g, "$1svg.typst-doc {").replace(/\.tsel\s+span,\s*\.tsel\s*\{[^}]*\}/g, ".tsel, .tsel span { display: none !important; }");
    return `<style type="text/css">${scoped}</style>`;
  });
}
function namespaceSvgIds(svgFragment, prefix) {
  const ids = /* @__PURE__ */ new Set();
  const idRe = /\bid="([^"]+)"/g;
  let m;
  while ((m = idRe.exec(svgFragment)) !== null) ids.add(m[1]);
  if (ids.size === 0) return svgFragment;
  return svgFragment.replace(/\bid="([^"]+)"/g, (full, id) => ids.has(id) ? `id="${prefix}${id}"` : full).replace(
    /\b(xlink:href|href)="#([^"]+)"/g,
    (full, attr, id) => ids.has(id) ? `${attr}="#${prefix}${id}"` : full
  ).replace(/url\(#([^)]+)\)/g, (full, id) => ids.has(id) ? `url(#${prefix}${id})` : full);
}
function filterPageGlyphDefs(preamble2, pageBody) {
  const used = /* @__PURE__ */ new Set();
  const refRe = /\b(?:xlink:href|href)="#([^"]+)"/g;
  let m;
  while ((m = refRe.exec(pageBody)) !== null) used.add(m[1]);
  return preamble2.replace(/<defs class="glyph">([\s\S]*?)<\/defs>/g, (_full, inner) => {
    const filtered = inner.replace(
      /<path\b[^>]*\bid="([^"]+)"[^>]*\/>/g,
      (tag, id) => used.has(id) ? tag : ""
    );
    return `<defs class="glyph">${filtered}</defs>`;
  });
}
function splitSvgPages(svg, pageCount, perPageDims, scopePrefix = "galley") {
  const count = Math.max(1, pageCount);
  const fallbackDim = perPageDims[0] ?? { wPt: 595.28, hPt: 841.89 };
  const blankPage = (idx) => {
    const dim = perPageDims[idx] ?? fallbackDim;
    return `<svg xmlns="http://www.w3.org/2000/svg" class="typst-doc" viewBox="0 0 ${dim.wPt} ${dim.hPt}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;"></svg>`;
  };
  const openEnd = svg.indexOf(">");
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart <= openEnd) {
    return Array.from({ length: count }, (_, i) => blankPage(i));
  }
  const pageStarts = [];
  const pageRe = /<g class="typst-page"/g;
  let pm;
  while ((pm = pageRe.exec(svg)) !== null) pageStarts.push(pm.index);
  if (pageStarts.length === 0) {
    const dim = perPageDims[0] ?? fallbackDim;
    const inner = scopeTypstCss(svg.slice(openEnd + 1, closeStart));
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml" class="typst-doc" viewBox="0 0 ${dim.wPt} ${dim.hPt}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;">${inner}</svg>`;
    const first = namespaceSvgIds(wrapped, `${scopePrefix}_p0_`);
    const out2 = [first];
    for (let i = 1; i < count; i++) out2.push(blankPage(i));
    return out2;
  }
  const preamble2 = scopeTypstCss(svg.slice(openEnd + 1, pageStarts[0]));
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i >= pageStarts.length) {
      out.push(blankPage(i));
      continue;
    }
    const start = pageStarts[i];
    const end = i + 1 < pageStarts.length ? pageStarts[i + 1] : closeStart;
    const rawPage = svg.slice(start, end).replace(/^<g class="typst-page"([^>]*?)\btransform="translate\([^"]*\)"/, '<g class="typst-page"$1transform="translate(0, 0)"');
    const dim = perPageDims[i] ?? fallbackDim;
    const mw = rawPage.match(/\bdata-page-width="([\d.]+)"/);
    const mh = rawPage.match(/\bdata-page-height="([\d.]+)"/);
    const vw = mw ? Number(mw[1]) : dim.wPt;
    const vh = mh ? Number(mh[1]) : dim.hPt;
    const pageDefs = filterPageGlyphDefs(preamble2, rawPage);
    const assembled = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml" class="typst-doc" viewBox="0 0 ${vw} ${vh}" width="100%" style="display:block;width:100%;height:auto;background:#ffffff;color:#000000;">${pageDefs}${rawPage}</svg>`;
    const safePrefix = scopePrefix.replace(/[^A-Za-z0-9_-]/g, "_");
    out.push(namespaceSvgIds(assembled, `${safePrefix}_p${i}_`));
  }
  return out;
}
function deriveReceipt(svg, pages, _pageHeightPt, targetPages, anchors) {
  const { linesPerPage, anchors: found } = parseSvgPages(svg);
  const perPage = [];
  for (let p = 0; p < pages; p++) perPage.push(linesPerPage[p] ?? 0);
  const lastPageLineCount = perPage.length > 0 ? perPage[perPage.length - 1] : 0;
  const overflowLinesOnLastPage = targetPages !== void 0 && pages > targetPages ? lastPageLineCount : 0;
  const blockToPage = {};
  for (const a of anchors) {
    const hit = found.find((f) => f.hex === a.hex);
    blockToPage[a.blockId] = hit ? hit.page : 0;
  }
  return { pages, perPage, lastPageLineCount, overflowLinesOnLastPage, blockToPage };
}
function mapDiagnosticsToBlocks(typ, diags) {
  const markers = [];
  typ.split("\n").forEach((l, i) => {
    const mm = l.match(/\/\/ @@g (\S+)@@/);
    if (mm) markers.push({ line: i + 1, id: mm[1] });
  });
  return diags.map((d) => {
    let blockId = null;
    if (d.line) {
      for (const mk of markers) if (mk.line <= d.line) blockId = mk.id;
    }
    return { message: d.message, blockId, line: d.line };
  });
}
function parseCliDiagnostics(stderr) {
  const out = [];
  const re = /\.typ:(\d+):(\d+)/g;
  const msgRe = /error:\s*([^\n]+)/g;
  const msgs = [];
  let mm;
  while ((mm = msgRe.exec(stderr)) !== null) msgs.push(mm[1].trim());
  let k = 0;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    out.push({ line: +m[1], col: +m[2], message: msgs.length > 0 ? msgs[k % msgs.length] : void 0 });
    k++;
  }
  return out;
}

// src/host/arms/native.ts
import { join } from "node:path";
import { tmpdir } from "node:os";

// src/host/arms/types.ts
var ArmError = class extends Error {
  code = "compile_failed";
  diagnostics;
  constructor(message, diagnostics = []) {
    super(message);
    this.diagnostics = diagnostics;
  }
};

// src/host/arms/base.ts
function buildShadows(packet, assetBytes) {
  if (!assetBytes) return [];
  const out = [];
  for (const [id, bytes] of Object.entries(assetBytes)) {
    const meta = packet.assets?.[id];
    if (meta) out.push({ path: meta.path, bytes });
  }
  return out;
}
var BaseArm = class {
  _timeMs = 0;
  _warm = false;
  get timeMs() {
    return this._timeMs;
  }
  get warm() {
    return this._warm;
  }
  async render(sheet, packet, assetBytes) {
    const cs = compileSheet(sheet, packet.assets);
    const shadows = buildShadows(packet, assetBytes);
    const t0 = process.hrtime.bigint();
    let out;
    try {
      out = await this.compileTyp(cs.typ, shadows);
    } catch (e) {
      if (e instanceof ArmError) throw e;
      throw new ArmError(`render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this._timeMs = Number(process.hrtime.bigint() - t0) / 1e6;
    this._warm = true;
    if (!out.svg || out.pages <= 0) {
      throw new ArmError("compile produced no pages");
    }
    const receipt = deriveReceipt(out.svg, out.pages, cs.pageHeightPt, cs.targetPages, cs.anchors);
    const diagnostics = mapDiagnosticsToBlocks(cs.typ, out.diags ?? []);
    const perPage = Array.from({ length: out.pages }, () => ({ wPt: cs.pageWidthPt, hPt: cs.pageHeightPt }));
    const pageSvgs = splitSvgPages(out.svg, out.pages, perPage, `${packet.id}_${sheet.id}_r${packet.rev}`);
    return {
      sheetId: sheet.id,
      pdf: out.pdf,
      svgPages: pageSvgs.map((s) => Buffer.from(s, "utf8")),
      svg: out.svg,
      pages: out.pages,
      perPage,
      lastPageLineCount: receipt.lastPageLineCount,
      overflowLinesOnLastPage: receipt.overflowLinesOnLastPage,
      blockToPage: receipt.blockToPage,
      diagnostics,
      compiledAtRev: packet.rev
    };
  }
};

// src/host/arms/native.ts
var NativeArm = class extends BaseArm {
  name = "native";
  compiler = null;
  /** Stable virtual root the arm compiles against (need not exist on disk). */
  workspace = join(tmpdir(), "dsh-galley-native-ws");
  async init() {
    if (this.compiler) return;
    const mod = await import("@myriaddreamin/typst-ts-node-compiler");
    this.compiler = mod.NodeCompiler.create({ workspace: this.workspace });
  }
  compileTyp(typ, shadows) {
    const c = this.compiler;
    if (!c) throw new ArmError("native arm not initialized");
    if (shadows && shadows.length) {
      for (const s of shadows) c.mapShadow(join(this.workspace, s.path), s.bytes);
    }
    try {
      const r = c.compile({ mainFileContent: typ });
      if (r.hasError()) {
        let msg = "native compile error";
        try {
          const d = r.takeDiagnostics();
          if (d && typeof d === "object") {
            const shorts = d.shortDiagnostics;
            if (Array.isArray(shorts) && shorts.length > 0) {
              msg = shorts.map((s) => s.message ?? "").filter(Boolean).join(" | ") || msg;
            } else if ("message" in d && d.message) {
              msg = String(d.message);
            }
          }
        } catch {
        }
        throw new ArmError(`native compile failed: ${msg}`);
      }
      const doc = r.result;
      const pages = doc.numOfPages ?? 0;
      const pdf = Buffer.from(c.pdf(doc));
      const svg = String(c.svg(doc));
      return { pdf, svg, pages, diags: [] };
    } finally {
      if (shadows && shadows.length) c.resetShadow();
    }
  }
};

// src/host/arms/wasm.ts
function inferPagesFromSvg(svg) {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) return 1;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const pageH = Math.abs(w - 595.28) < 6 ? 841.89 : 792;
  return Math.max(1, Math.round(h / pageH));
}
var WasmArm = class extends BaseArm {
  name = "wasm";
  compiler = null;
  model = null;
  counter = 0;
  async init() {
    if (this.compiler) return;
    const mod = await import("@myriaddreamin/typst.ts");
    this.model = new mod.MemoryAccessModel();
    this.compiler = mod.createTypstCompiler();
    await this.compiler.init({
      beforeBuild: [mod.initOptions.withAccessModel(this.model), mod.loadFonts([], { assets: ["text"] })]
    });
  }
  async compileTyp(typ, shadows) {
    const c = this.compiler;
    const model = this.model;
    if (!c || !model) throw new ArmError("wasm arm not initialized");
    const path = `/@memory/galley-${this.counter++}.typ`;
    for (const s of shadows ?? []) {
      try {
        model.insertFile(`/@memory/${s.path}`, s.bytes, /* @__PURE__ */ new Date());
      } catch {
      }
    }
    model.insertFile(path, new TextEncoder().encode(typ), /* @__PURE__ */ new Date());
    let pdfResult;
    let svgResult;
    try {
      pdfResult = await c.compile({ format: "pdf", mainFilePath: path, diagnostics: "none" });
      svgResult = await c.compile({ format: "svg", mainFilePath: path, diagnostics: "none" });
    } catch (e) {
      throw new ArmError(`wasm compile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const pdf = Buffer.from(pdfResult.result);
    const svg = typeof svgResult.result === "string" ? svgResult.result : Buffer.from(svgResult.result).toString("utf8");
    return { pdf, svg, pages: inferPagesFromSvg(svg), diags: [] };
  }
};

// src/host/arms/cli.ts
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2, resolve, dirname } from "node:path";
var DEFAULT_BIN = resolve("vendor", "typst", "typst-x86_64-unknown-linux-musl", "typst");
var CliArm = class extends BaseArm {
  name = "cli";
  bin;
  dir = null;
  constructor(bin = DEFAULT_BIN) {
    super();
    this.bin = bin;
  }
  async init() {
    if (!existsSync(this.bin)) throw new ArmError(`cli binary not found: ${this.bin}`);
    if (!this.dir) this.dir = mkdtempSync(join2(tmpdir2(), "galley-cli-"));
  }
  compileTyp(typ, shadows) {
    if (!this.dir) this.dir = mkdtempSync(join2(tmpdir2(), "galley-cli-"));
    const src = join2(this.dir, "in.typ");
    const pdfOut = join2(this.dir, "out.pdf");
    const svgOut = join2(this.dir, "out.svg");
    for (const s of shadows ?? []) {
      const p = join2(this.dir, s.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.bytes);
    }
    writeFileSync(src, typ, "utf8");
    const diags = [];
    try {
      execFileSync(this.bin, ["compile", src, pdfOut], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
      execFileSync(this.bin, ["compile", src, svgOut], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      const anyErr = e;
      const errText = (typeof anyErr.stderr === "string" ? anyErr.stderr : Buffer.from(anyErr.stderr ?? "").toString("utf8")) || (anyErr.message ?? String(e));
      const parsed = parseCliDiagnostics(errText);
      throw new ArmError(
        `cli compile failed: ${errText.split("\n").find((l) => l.trim()) ?? "unknown error"}`,
        parsed.map((d) => ({ message: d.message ?? "compile error", blockId: null, line: d.line, col: d.col }))
      );
    }
    const pdf = readFileSync(pdfOut);
    const svg = readFileSync(svgOut, "utf8");
    return { pdf, svg, pages: inferPagesFromSvg(svg), diags };
  }
  /** Clean up the temp dir (call on arm teardown). */
  dispose() {
    if (this.dir && existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
};

// src/host/arms/index.ts
async function createArm(name2 = "native") {
  const a = name2 === "native" ? new NativeArm() : name2 === "wasm" ? new WasmArm() : new CliArm();
  await a.init();
  return a;
}
async function createPrimaryArm() {
  try {
    const arm = new NativeArm();
    await arm.init();
    return { arm, available: ["native"] };
  } catch (e) {
    const arm = new WasmArm();
    await arm.init();
    return { arm, available: ["wasm"], note: `native unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// src/host/httpDispatch.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { basename as basename2, extname, resolve as resolve2, sep } from "node:path";
import { URL } from "node:url";

// src/host/workspace.ts
import { join as join4 } from "node:path";

// src/host/store.ts
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync as mkdirSync2,
  rmSync as rmSync2,
  readFileSync as readFileSync2,
  writeFileSync as writeFileSync2,
  copyFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  existsSync as existsSync2,
  openSync,
  writeSync,
  closeSync,
  fsyncSync
} from "node:fs";
import { join as join3, basename, dirname as dirname2 } from "node:path";
var UNDO_DEPTH = 50;
var JOURNAL_KEEP = 3;
var MAX_ASSETS_PER_PACKET = 20;
var StoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC").replace(/\\/g, "/"));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}
function hashContent(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function blockContentProjection(block) {
  const b = block;
  const out = {
    type: b.type,
    dependsOn: b.dependsOn,
    slot: b.slot
  };
  if (b.fields !== void 0) out.fields = b.fields;
  if (b.body !== void 0) out.body = b.body;
  if (b.level !== void 0) out.level = b.level;
  if (b.numbered !== void 0) out.numbered = b.numbered;
  if (b.headers !== void 0) out.headers = b.headers;
  if (b.rows !== void 0) out.rows = b.rows;
  if (b.tone !== void 0) out.tone = b.tone;
  if (b.title !== void 0) out.title = b.title;
  if (b.lineNumbers !== void 0) out.lineNumbers = b.lineNumbers;
  return out;
}
function hashBlock(block) {
  return hashContent(blockContentProjection(block));
}
function computeStale(block, byId) {
  for (const dep of block.dependsOn) {
    const target = byId.get(dep.id);
    if (!target) {
      return { state: "stale_missing_origin", origin: dep.id, sinceHash: dep.sinceHash };
    }
    if (target.hash !== dep.sinceHash) {
      return { state: "stale_dependency", origin: dep.id, sinceHash: dep.sinceHash };
    }
  }
  return null;
}
function recomputeStale(packet) {
  const byId = /* @__PURE__ */ new Map();
  for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) byId.set(b.id, b);
  for (const [, b] of byId) b.stale = computeStale(b, byId);
}
function createsCycle(from, to, byId) {
  if (from === to) return true;
  const seen = /* @__PURE__ */ new Set();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const b = byId.get(cur);
    if (b) for (const d of b.dependsOn) stack.push(d.id);
  }
  return false;
}
function allocateBlockId(packet) {
  const used = /* @__PURE__ */ new Set();
  for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) used.add(b.id);
  let n = packet.nextBlockSeq;
  while (used.has(`b${n}`)) n++;
  return `b${n}`;
}
function findBlock(packet, id) {
  for (const sid of packet.sheetOrder) {
    const sheet = packet.sheets[sid];
    const index = sheet.blocks.findIndex((b) => b.id === id);
    if (index >= 0) return { sheet, index, block: sheet.blocks[index] };
  }
  return null;
}
var GalleyStore = class {
  root;
  /** @param root default `<cwd>/.dsh/galley`. Pass a temp dir for hermetic tests. */
  constructor(root) {
    this.root = root ?? join3(process.cwd(), ".dsh", "galley");
  }
  dir(id) {
    return join3(this.root, id);
  }
  packetPath(id) {
    return join3(this.dir(id), "packet.json");
  }
  journalPath(id) {
    return join3(this.dir(id), "journal.json");
  }
  undoPath(id) {
    return join3(this.dir(id), "undo.json");
  }
  redoPath(id) {
    return join3(this.dir(id), "redo.json");
  }
  bumpRev(id, note) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    packet.rev += 1;
    packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: packet.rev, at: packet.updatedAt, note });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return packet;
  }
  create(packet) {
    const dir = this.dir(packet.id);
    mkdirSync2(dir, { recursive: true });
    packet.rev = 1;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    packet.createdAt = now;
    packet.updatedAt = now;
    this.atomicWrite(this.packetPath(packet.id), JSON.stringify(packet, null, 2));
    this.atomicWrite(this.undoPath(packet.id), JSON.stringify([JSON.parse(JSON.stringify(packet))]));
    this.atomicWrite(this.journalPath(packet.id), JSON.stringify([{ rev: 1, at: now, note: "create" }]));
    return packet;
  }
  load(id) {
    const p = this.packetPath(id);
    if (!existsSync2(p)) return null;
    const packet = JSON.parse(readFileSync2(p, "utf8"));
    recomputeStale(packet);
    return packet;
  }
  list() {
    if (!existsSync2(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "templates" && existsSync2(join3(this.root, e.name, "packet.json"))).map((e) => {
      const p = this.load(e.name);
      return {
        id: p.id,
        title: p.title,
        template: p.template,
        reviewMode: p.reviewMode ?? "auto",
        rev: p.rev,
        updatedAt: p.updatedAt
      };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  delete(id) {
    const dir = this.dir(id);
    if (!existsSync2(dir)) throw new StoreError("not_found", `packet ${id} not found`);
    if (this.getActivePacket() === id) {
      const remaining = this.list().filter((p) => p.id !== id);
      if (remaining.length > 0) this.setActivePacket(remaining[0].id);
      else this.clearActivePacket();
    }
    rmSync2(dir, { recursive: true, force: true });
  }
  renamePacket(id, title) {
    const trimmed = title.trim();
    if (!trimmed) throw new StoreError("invalid_op", "packet title must be non-empty");
    return this.commit(id, null, (p) => {
      p.title = trimmed;
      return null;
    }).packet;
  }
  setReviewMode(id, mode) {
    if (mode !== "auto" && mode !== "review") {
      throw new StoreError("invalid_op", `invalid reviewMode '${String(mode)}'`);
    }
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    packet.reviewMode = mode;
    packet.rev += 1;
    packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: packet.rev, at: packet.updatedAt, note: `reviewMode ${mode}` });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return packet;
  }
  duplicatePacket(id, newTitle) {
    const src = this.load(id);
    if (!src) throw new StoreError("not_found", `packet ${id} not found`);
    const b32 = "abcdefghijklmnopqrstuvwxyz234567";
    const rand = randomBytes(8);
    let newSuffix = "";
    for (let i = 0; i < 8; i++) newSuffix += b32[rand[i] & 31];
    const newId = `p-${newSuffix}`;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newId;
    copy.title = newTitle?.trim() || `${src.title} (Kopie)`;
    this.create(copy);
    const srcAssetsDir = join3(this.dir(id), "assets");
    if (existsSync2(srcAssetsDir)) {
      const dstAssetsDir = join3(this.dir(newId), "assets");
      mkdirSync2(dstAssetsDir, { recursive: true });
      for (const entry of readdirSync(srcAssetsDir)) {
        copyFileSync(join3(srcAssetsDir, entry), join3(dstAssetsDir, entry));
      }
    }
    this.setActivePacket(newId);
    return this.load(newId);
  }
  // ── Sheet CRUD (all committed through undo-safe single commit path) ───────
  addSheet(id, opts) {
    let createdSheetId = "s1";
    const res = this.commit(id, null, (p) => {
      let n = p.sheetOrder.length + 1;
      while (p.sheets[`s${n}`]) n++;
      createdSheetId = `s${n}`;
      const geometry = {
        paper: opts?.paper ?? "a4",
        orientation: opts?.orientation ?? "portrait",
        margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
        ...opts?.targetPages !== void 0 ? { targetPages: opts.targetPages } : {}
      };
      p.sheets[createdSheetId] = {
        id: createdSheetId,
        title: opts?.title?.trim() || `Bogen ${p.sheetOrder.length + 1}`,
        geometry,
        blocks: []
      };
      p.sheetOrder.push(createdSheetId);
      return null;
    });
    return { packet: res.packet, sheetId: createdSheetId };
  }
  renameSheet(id, sheetId, title) {
    const trimmed = title.trim();
    if (!trimmed) throw new StoreError("invalid_op", "sheet title must be non-empty");
    return this.commit(id, null, (p) => {
      const sh = p.sheets[sheetId];
      if (!sh) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
      sh.title = trimmed;
      return null;
    }).packet;
  }
  removeSheet(id, sheetId) {
    return this.commit(id, null, (p) => {
      if (!p.sheets[sheetId]) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
      if (p.sheetOrder.length <= 1) throw new StoreError("invalid_op", "cannot remove the last remaining sheet");
      delete p.sheets[sheetId];
      p.sheetOrder = p.sheetOrder.filter((sid) => sid !== sheetId);
      return null;
    }).packet;
  }
  reorderSheet(id, sheetId, direction) {
    return this.commit(id, null, (p) => {
      const idx = p.sheetOrder.indexOf(sheetId);
      if (idx < 0) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
      const swapIdx = direction === "left" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= p.sheetOrder.length) return null;
      const nextOrder = [...p.sheetOrder];
      const tmp = nextOrder[idx];
      nextOrder[idx] = nextOrder[swapIdx];
      nextOrder[swapIdx] = tmp;
      p.sheetOrder = nextOrder;
      return null;
    }).packet;
  }
  // ── Workspace Template Blueprints (.dsh/galley/templates/<slug>.json) ─────
  templatesDir() {
    return join3(this.root, "templates");
  }
  saveAsTemplate(packetId, opts) {
    const packet = this.load(packetId);
    if (!packet) throw new StoreError("not_found", `packet ${packetId} not found`);
    const title = opts?.title?.trim() || packet.title;
    const rawSlug = (opts?.id?.trim() || title).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase() || "vorlage";
    const reserved = /* @__PURE__ */ new Set(["arbeitsblatt", "rfc", "generic"]);
    const id = reserved.has(rawSlug) ? `${rawSlug}-vorlage` : rawSlug;
    const blueprint = {
      id,
      title,
      description: opts?.description?.trim() || void 0,
      source: "workspace",
      sheets: packet.sheetOrder.map((sid) => {
        const sh = packet.sheets[sid];
        return {
          id: sh.id,
          title: sh.title,
          geometry: JSON.parse(JSON.stringify(sh.geometry)),
          starterBlocks: sh.blocks.map((b) => {
            const proj = blockContentProjection(b);
            if (proj.slot && typeof proj.slot === "object" && "asset" in proj.slot) {
              proj.slot = { mode: "full" };
            }
            proj.dependsOn = [];
            return proj;
          })
        };
      })
    };
    this.atomicWrite(join3(this.templatesDir(), `${id}.json`), JSON.stringify(blueprint, null, 2));
    return blueprint;
  }
  listSavedTemplates() {
    const dir = this.templatesDir();
    if (!existsSync2(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = this.readJson(join3(dir, entry.name), null);
      if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.sheets)) {
        out.push({ ...parsed, source: "workspace" });
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }
  deleteSavedTemplate(templateId) {
    const safe = templateId.replace(/[^A-Za-z0-9_-]/g, "");
    if (!safe) return false;
    const p = join3(this.templatesDir(), `${safe}.json`);
    if (!existsSync2(p)) return false;
    unlinkSync(p);
    return true;
  }
  // ── active packet (M1.5 H4): the packet tools operate on by default ──────
  // Persisted per-store (single file) so a headless tool session can omit
  // `packetId` and address the most recently opened/active packet.
  activePath() {
    return join3(this.root, "active.json");
  }
  setActivePacket(id) {
    this.atomicWrite(this.activePath(), JSON.stringify({ packetId: id }));
  }
  getActivePacket() {
    const v = this.readJson(this.activePath(), null);
    return v && typeof v.packetId === "string" ? v.packetId : null;
  }
  clearActivePacket() {
    try {
      unlinkSync(this.activePath());
    } catch {
    }
  }
  /**
   * The single commit path (spec 01 §4). `expect`, when given, must match the
   * current content hash of that block or the commit throws `conflict` (409).
   * `apply` mutates the loaded packet in place; the store then re-hashes every
   * block, recomputes staleness, bumps rev, and journals atomically.
   */
  commit(id, expect, apply2) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    if (expect) {
      const found = findBlock(packet, expect.blockId);
      if (!found) throw new StoreError("not_found", `block ${expect.blockId} not found`);
      if (found.block.hash !== expect.baseHash) {
        throw new StoreError("conflict", `block ${expect.blockId} changed (base hash mismatch)`);
      }
    }
    const prevSnapshot = JSON.parse(JSON.stringify(packet));
    const touchedId = apply2(packet);
    if (touchedId) {
      const touched2 = findBlock(packet, touchedId);
      if (touched2) {
        const byId = /* @__PURE__ */ new Map();
        for (const sid of packet.sheetOrder) for (const b of packet.sheets[sid].blocks) byId.set(b.id, b);
        for (const dep of touched2.block.dependsOn ?? []) {
          if (createsCycle(touchedId, dep.id, byId)) {
            throw new StoreError("cycle", `block ${touchedId} creates a dependency cycle`);
          }
        }
      }
    }
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid].blocks) b.hash = hashBlock(b);
    }
    recomputeStale(packet);
    packet.rev += 1;
    packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const touched = touchedId ? findBlock(packet, touchedId) : null;
    const changeHash = touched ? touched.block.hash : null;
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: packet.rev, at: packet.updatedAt, note: touchedId ? `edit ${touchedId}` : "edit" });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    const undo = this.readJson(this.undoPath(id), []);
    undo.push(prevSnapshot);
    while (undo.length > UNDO_DEPTH) undo.shift();
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo));
    this.atomicWrite(this.redoPath(id), "[]");
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    return { packet, rev: packet.rev, changeHash };
  }
  /** Pop the last snapshot and restore it; rev strictly increases (+1, spec 01 §1). */
  undo(id) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const undo = this.readJson(this.undoPath(id), []);
    if (undo.length === 0) throw new StoreError("no_undo", `no undo history for ${id}`);
    const prev = undo.pop();
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo));
    const redo = this.readJson(this.redoPath(id), []);
    redo.push(JSON.parse(JSON.stringify(packet)));
    while (redo.length > UNDO_DEPTH) redo.shift();
    this.atomicWrite(this.redoPath(id), JSON.stringify(redo));
    prev.rev = packet.rev + 1;
    prev.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    recomputeStale(prev);
    this.atomicWrite(this.packetPath(id), JSON.stringify(prev, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: prev.rev, at: prev.updatedAt, note: "undo" });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return { packet: prev, rev: prev.rev };
  }
  /** Re-apply the most recently undone snapshot; rev strictly increases (+1). */
  redo(id) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const redo = this.readJson(this.redoPath(id), []);
    if (redo.length === 0) throw new StoreError("no_redo", `no redo history for ${id}`);
    const next = redo.pop();
    this.atomicWrite(this.redoPath(id), JSON.stringify(redo));
    const undo = this.readJson(this.undoPath(id), []);
    undo.push(JSON.parse(JSON.stringify(packet)));
    while (undo.length > UNDO_DEPTH) undo.shift();
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo));
    next.rev = packet.rev + 1;
    next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    recomputeStale(next);
    this.atomicWrite(this.packetPath(id), JSON.stringify(next, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: next.rev, at: next.updatedAt, note: "redo" });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return { packet: next, rev: next.rev };
  }
  undoDepth(id) {
    return this.readJson(this.undoPath(id), []).length;
  }
  redoDepth(id) {
    return this.readJson(this.redoPath(id), []).length;
  }
  // ── proposals + annotations (bump packet.rev so rev-polling observes deltas) ──
  addProposal(id, proposal) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const next = [...this.readJson(join3(this.dir(id), "proposals.json"), []), proposal];
    this.atomicWrite(join3(this.dir(id), "proposals.json"), JSON.stringify(next));
    this.bumpRev(id, `proposal ${proposal.id}`);
    return proposal;
  }
  listProposals(id) {
    return this.readJson(join3(this.dir(id), "proposals.json"), []);
  }
  setProposalStatus(id, proposalId, status, opts) {
    const list = this.listProposals(id);
    const p = list.find((x) => x.id === proposalId);
    if (!p) return null;
    p.status = status;
    this.atomicWrite(join3(this.dir(id), "proposals.json"), JSON.stringify(list));
    if (opts?.bumpRev !== false) this.bumpRev(id, `proposal ${proposalId} ${status}`);
    return p;
  }
  /**
   * Accept a proposal (spec 01 §7, M2.5 unified review gate):
   * - Supports all 4 proposal ops (`insert` | `patch` | `move` | `remove`).
   * - Sets block `origin = 'human'` (settled human approval — accepting a
   *   suggestion never hands ownership away to unguarded agent rewrites).
   * - Refreshes outgoing `dependsOn` `sinceHash` edges to current origin hashes.
   */
  applyProposal(id, proposalId) {
    const proposal = this.listProposals(id).find((p) => p.id === proposalId);
    if (!proposal) throw new StoreError("proposal_not_found", `proposal ${proposalId} not found`);
    if (proposal.status !== "pending") {
      throw new StoreError("invalid_op", `proposal ${proposalId} is already ${proposal.status}`);
    }
    const op = proposal.op ?? "patch";
    const expect = op === "insert" ? null : { blockId: proposal.targetBlockId, baseHash: proposal.baseHash };
    this.commit(id, expect, (p) => {
      if (op === "insert") {
        const sid = proposal.sheetId ?? p.sheetOrder[0];
        const sh = p.sheets[sid];
        if (!sh) throw new StoreError("invalid_op", `sheet ${sid} not found`);
        const candidate = JSON.parse(JSON.stringify(proposal.proposedPatch.block));
        const existing = findBlock(p, candidate.id);
        if (existing) candidate.id = allocateBlockId(p);
        candidate.origin = "human";
        candidate.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        candidate.hash = hashBlock(candidate);
        const beforeId = typeof proposal.proposedPatch.beforeId === "string" ? proposal.proposedPatch.beforeId : void 0;
        const idx = beforeId ? sh.blocks.findIndex((x) => x.id === beforeId) : sh.blocks.length;
        sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, candidate);
        p.nextBlockSeq += 1;
        return candidate.id;
      }
      if (op === "move") {
        const from = findBlock(p, proposal.targetBlockId);
        if (!from) throw new StoreError("not_found", `block ${proposal.targetBlockId} not found`);
        const targetSid = proposal.proposedPatch.toSheetId ?? proposal.sheetId ?? from.sheet.id;
        const targetSheet = p.sheets[targetSid];
        if (!targetSheet) throw new StoreError("invalid_op", `target sheet ${targetSid} not found`);
        from.sheet.blocks.splice(from.index, 1);
        let to = targetSheet.blocks.length;
        const toBeforeId = proposal.proposedPatch.toBeforeId;
        const toAfterId = proposal.proposedPatch.toAfterId;
        if (toBeforeId) to = targetSheet.blocks.findIndex((x) => x.id === toBeforeId);
        if (toAfterId) {
          const i = targetSheet.blocks.findIndex((x) => x.id === toAfterId);
          to = i >= 0 ? i + 1 : targetSheet.blocks.length;
        }
        from.block.origin = "human";
        targetSheet.blocks.splice(to < 0 ? targetSheet.blocks.length : to, 0, from.block);
        return from.block.id;
      }
      if (op === "remove") {
        const found = findBlock(p, proposal.targetBlockId);
        if (!found) throw new StoreError("not_found", `block ${proposal.targetBlockId} not found`);
        found.sheet.blocks.splice(found.index, 1);
        return null;
      }
      const located = findBlock(p, proposal.targetBlockId);
      if (!located) throw new StoreError("not_found", `block ${proposal.targetBlockId} not found`);
      const b = located.block;
      for (const [k, v] of Object.entries(proposal.proposedPatch)) {
        if (k === "body") {
          b.body = typeof v === "string" ? [{ t: "text", v }] : Array.isArray(v) ? v : [{ t: "text", v: String(v) }];
        } else if (k !== "origin" && k !== "id" && k !== "hash") {
          b[k] = v;
        }
      }
      if (Array.isArray(b.dependsOn) && b.dependsOn.length > 0) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        b.dependsOn = b.dependsOn.map((d) => {
          const origin = findBlock(p, d.id);
          return origin ? { id: d.id, sinceHash: origin.block.hash, at: now } : d;
        });
      }
      b.origin = "human";
      return proposal.targetBlockId;
    });
    const updated = this.setProposalStatus(id, proposalId, "accepted", { bumpRev: false });
    return updated;
  }
  acceptAllProposals(id) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const pending = this.listProposals(id).filter((p) => p.status === "pending");
    const accepted = [];
    const conflicted = [];
    for (const prop of pending) {
      try {
        this.applyProposal(id, prop.id);
        accepted.push(prop.id);
      } catch (err) {
        if (err instanceof StoreError && (err.code === "conflict" || err.code === "not_found")) {
          this.setProposalStatus(id, prop.id, "conflicted", { bumpRev: false });
          conflicted.push(prop.id);
        } else {
          throw err;
        }
      }
    }
    if (accepted.length === 0 && conflicted.length > 0) {
      this.bumpRev(id, "proposals conflicted");
    }
    return { accepted, conflicted, rev: this.load(id).rev };
  }
  addAnnotation(id, annotation) {
    const list = this.readJson(join3(this.dir(id), "annotations.json"), []);
    list.push(annotation);
    this.atomicWrite(join3(this.dir(id), "annotations.json"), JSON.stringify(list));
    this.bumpRev(id, `annotation ${annotation.id}`);
    return annotation;
  }
  listAnnotations(id, blockId) {
    const list = this.readJson(join3(this.dir(id), "annotations.json"), []);
    return blockId ? list.filter((a) => a.blockId === blockId) : list;
  }
  setAnnotationResolved(id, annotationId, resolved) {
    const list = this.listAnnotations(id);
    const a = list.find((x) => x.id === annotationId);
    if (!a) return null;
    a.resolved = resolved;
    this.atomicWrite(join3(this.dir(id), "annotations.json"), JSON.stringify(list));
    this.bumpRev(id, `annotation ${annotationId} ${resolved ? "resolved" : "unresolved"}`);
    return a;
  }
  // ── assets (metadata in packet; bytes in assets/ dir) ─────────────────────
  addAsset(id, meta, bytes, opts) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const existing = packet.assets ?? {};
    if (!(meta.id in existing) && Object.keys(existing).length >= MAX_ASSETS_PER_PACKET) {
      throw new StoreError("asset_limit", `packet ${id} already holds ${MAX_ASSETS_PER_PACKET} assets`);
    }
    const assetsDir = join3(this.dir(id), "assets");
    mkdirSync2(assetsDir, { recursive: true });
    writeFileSync2(join3(assetsDir, basename(meta.path)), bytes);
    packet.assets = { ...existing, [meta.id]: meta };
    const mSeq = meta.id.match(/^a(\d+)$/);
    if (mSeq) packet.nextAssetSeq = Math.max(packet.nextAssetSeq ?? 1, Number(mSeq[1]) + 1);
    if (opts?.bumpRev !== false) {
      packet.rev += 1;
      packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    return meta;
  }
  /**
   * Read the raw bytes of a staged asset (M1.5 H4/H2.2). Returns null if the
   * asset is unknown or its file is missing. The arms use this to map asset
   * bytes into the compiler (native `mapShadow`) so media slots render offline.
   */
  readAsset(id, assetId) {
    const meta = this.load(id)?.assets?.[assetId];
    if (!meta) return null;
    const p = join3(this.dir(id), meta.path);
    return existsSync2(p) ? readFileSync2(p) : null;
  }
  // ── atomic write (spec 01 §9): temp → fsync → rename ─────────────────────
  atomicWrite(path, data) {
    mkdirSync2(dirname2(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, data, 0, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }
  readJson(path, fallback) {
    if (!existsSync2(path)) return fallback;
    try {
      return JSON.parse(readFileSync2(path, "utf8"));
    } catch {
      return fallback;
    }
  }
};

// src/host/workspace.ts
var lastGalleyCwd = null;
var storesByRoot = /* @__PURE__ */ new Map();
function noteGalleyCwd(cwd) {
  const trimmed = cwd?.trim();
  if (trimmed) lastGalleyCwd = trimmed;
}
function getGalleyCwd() {
  return lastGalleyCwd ?? process.cwd();
}
function resolveGalleyCwd(explicitCwd, sessionCwd) {
  const fromExplicit = explicitCwd?.trim();
  if (fromExplicit) {
    noteGalleyCwd(fromExplicit);
    return fromExplicit;
  }
  const fromSession = sessionCwd?.trim();
  if (fromSession) {
    noteGalleyCwd(fromSession);
    return fromSession;
  }
  return getGalleyCwd();
}
function getStoreForCwd(cwd) {
  const resolvedCwd = resolveGalleyCwd(cwd);
  const root = process.env.GALLEY_ROOT ?? join4(resolvedCwd, ".dsh", "galley");
  let store = storesByRoot.get(root);
  if (!store) {
    store = new GalleyStore(root);
    storesByRoot.set(root, store);
  }
  return { store, root, cwd: resolvedCwd };
}

// src/host/service.ts
var BUILTIN_TEMPLATES = [
  {
    id: "arbeitsblatt",
    title: "Arbeitsblatt + Erwartungshorizont",
    description: "Zwei B\xF6gen: Arbeitsblatt (A4, Ziel 1 Seite) + verkn\xFCpfter Erwartungshorizont",
    source: "builtin",
    sheets: [
      {
        id: "s1",
        title: "Arbeitsblatt",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          targetPages: 1
        },
        starterBlocks: [
          { type: "header", fields: { titel: "Arbeitsblatt", fach: "", klasse: "", datum: "", name: "" } },
          { type: "task", body: "Erste Aufgabe" }
        ]
      },
      {
        id: "s2",
        title: "Erwartungshorizont",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 }
        },
        starterBlocks: [
          { type: "heading", level: 1, body: "Erwartungshorizont" },
          { type: "answer", body: "L\xF6sung" }
        ]
      }
    ]
  },
  {
    id: "rfc",
    title: "Engineering RFC",
    description: "Technischer Entwurfsbogen f\xFCr Architektur- und Spezifikationsdokumente",
    source: "builtin",
    sheets: [
      {
        id: "s1",
        title: "Document",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 }
        },
        starterBlocks: []
      }
    ]
  },
  {
    id: "generic",
    title: "Leeres Dokument (Generic)",
    description: "Einzelner leerer A4-Bogen ohne Zielseitenlimit",
    source: "builtin",
    sheets: [
      {
        id: "s1",
        title: "Document",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 }
        },
        starterBlocks: []
      }
    ]
  }
];
var GalleyServiceRegistry = class {
  pluginTemplates = /* @__PURE__ */ new Map();
  preflightChecks = /* @__PURE__ */ new Map();
  registerTemplate(blueprint) {
    const id = blueprint.id.trim();
    if (!id) throw new Error("template blueprint requires a non-empty id");
    const normalized = {
      ...blueprint,
      id,
      source: blueprint.source ?? "plugin"
    };
    this.pluginTemplates.set(id, normalized);
    return () => {
      if (this.pluginTemplates.get(id) === normalized) {
        this.pluginTemplates.delete(id);
      }
    };
  }
  registerPreflight(id, check) {
    const key = id.trim();
    if (!key) throw new Error("preflight check requires a non-empty id");
    this.preflightChecks.set(key, check);
    return () => {
      if (this.preflightChecks.get(key) === check) {
        this.preflightChecks.delete(key);
      }
    };
  }
  listTemplates(store) {
    const byId = /* @__PURE__ */ new Map();
    for (const t of BUILTIN_TEMPLATES) byId.set(t.id, t);
    for (const [id, t] of this.pluginTemplates) byId.set(id, t);
    if (store) {
      for (const t of store.listSavedTemplates()) {
        byId.set(t.id, { ...t, source: "workspace" });
      }
    }
    return [...byId.values()];
  }
  getTemplate(id, store) {
    const all = this.listTemplates(store);
    return all.find((t) => t.id === id) ?? null;
  }
  runPreflight(packet, proofs, cwd) {
    const warnings = [];
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid];
      if (!sh) continue;
      for (const b of sh.blocks) {
        if (b.stale) {
          warnings.push({
            code: "GALLEY_STALE_BLOCK",
            severity: "warn",
            sheetId: sid,
            blockId: b.id,
            message: b.stale.state === "stale_missing_origin" ? `Block ${b.id} verweist auf entfernten Block ${b.stale.origin}` : `Block ${b.id} ist veraltet (Ursprung ${b.stale.origin} wurde ge\xE4ndert)`
          });
        }
      }
    }
    if (packet.sheetOrder.length >= 2) {
      const answeredTaskIds = /* @__PURE__ */ new Set();
      for (const sid of packet.sheetOrder) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          if (b.type === "answer") {
            for (const dep of b.dependsOn ?? []) answeredTaskIds.add(dep.id);
          }
        }
      }
      const primarySid = packet.sheetOrder[0];
      for (const b of packet.sheets[primarySid]?.blocks ?? []) {
        if (b.type === "task" && !answeredTaskIds.has(b.id)) {
          warnings.push({
            code: "GALLEY_UNANSWERED_TASK",
            severity: "info",
            sheetId: primarySid,
            blockId: b.id,
            message: `Aufgabe ${b.id} hat noch keine verkn\xFCpfte L\xF6sung (dependsOn) auf einem Folgebogen`
          });
        }
      }
    }
    if (proofs) {
      for (const sid of packet.sheetOrder) {
        const pr = proofs[sid];
        const target = packet.sheets[sid]?.geometry?.targetPages;
        if (pr && (pr.overflowLinesOnLastPage ?? 0) > 0) {
          warnings.push({
            code: "GALLEY_PAGE_OVERFLOW",
            severity: "warn",
            sheetId: sid,
            message: `Bogen "${packet.sheets[sid]?.title ?? sid}" \xFCberschreitet Ziel (${target ?? "?"} S.) um +${pr.overflowLinesOnLastPage} Zeilen`
          });
        }
      }
    }
    for (const [, fn] of this.preflightChecks) {
      try {
        const extra = fn(packet, cwd);
        if (Array.isArray(extra)) warnings.push(...extra);
      } catch {
      }
    }
    return warnings;
  }
  toCordisService() {
    return {
      registerTemplate: (bp) => this.registerTemplate(bp),
      listTemplates: (cwd) => {
        const { store } = getStoreForCwd(cwd);
        return this.listTemplates(store);
      },
      registerPreflight: (id, check) => this.registerPreflight(id, check),
      getStore: (cwd) => getStoreForCwd(cwd).store
    };
  }
  _resetForTests() {
    this.pluginTemplates.clear();
    this.preflightChecks.clear();
  }
};
var defaultGalleyRegistry = new GalleyServiceRegistry();

// src/host/tools.ts
import { createHash as createHash2, randomBytes as randomBytes2 } from "node:crypto";
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
var Err = {
  NO_ACTIVE_PACKET: "GALLEY_NO_ACTIVE_PACKET",
  PACKET_NOT_FOUND: "GALLEY_PACKET_NOT_FOUND",
  SHEET_NOT_FOUND: "GALLEY_SHEET_NOT_FOUND",
  BLOCK_NOT_FOUND: "GALLEY_BLOCK_NOT_FOUND",
  BLOCK_TYPE_MISMATCH: "GALLEY_BLOCK_TYPE_MISMATCH",
  DEPENDENCY_CYCLE: "GALLEY_DEPENDENCY_CYCLE",
  ASSET_NOT_FOUND: "GALLEY_ASSET_NOT_FOUND",
  ASSET_LIMIT_EXCEEDED: "GALLEY_ASSET_LIMIT_EXCEEDED",
  PROPOSAL_NOT_FOUND: "GALLEY_PROPOSAL_NOT_FOUND",
  PROPOSAL_CONFLICT: "GALLEY_PROPOSAL_CONFLICT",
  ANNOTATION_NOT_FOUND: "GALLEY_ANNOTATION_NOT_FOUND",
  TYPST_COMPILE_ERROR: "GALLEY_TYPST_COMPILE_ERROR",
  EXPORT_FAILED: "GALLEY_EXPORT_FAILED",
  INVALID_PARAMS: "GALLEY_INVALID_PARAMS"
};
function fail(code, message) {
  return { ok: false, code, message };
}
function toStoreCode(code) {
  switch (code) {
    case "conflict":
      return Err.PROPOSAL_CONFLICT;
    case "cycle":
      return Err.DEPENDENCY_CYCLE;
    case "no_undo":
    case "no_redo":
      return Err.INVALID_PARAMS;
    case "asset_limit":
      return Err.ASSET_LIMIT_EXCEEDED;
    case "asset_not_found":
      return Err.ASSET_NOT_FOUND;
    case "proposal_not_found":
      return Err.PROPOSAL_NOT_FOUND;
    case "not_found":
      return Err.BLOCK_NOT_FOUND;
    case "invalid_op":
    case "inline_limit":
    case "invalid_slot":
      return Err.INVALID_PARAMS;
    case "invalid_block":
      return Err.BLOCK_TYPE_MISMATCH;
    default:
      return code;
  }
}
function mapError(error) {
  if (error instanceof StoreError) {
    const t = fail(toStoreCode(error.code), error.message);
    if (t.code === Err.PROPOSAL_CONFLICT && /base hash mismatch/.test(error.message)) {
      t.diagnostics = error.message;
    }
    return t;
  }
  if (error instanceof Error) {
    if (error.message.startsWith("COMPILE")) return fail(Err.TYPST_COMPILE_ERROR, error.message);
    return fail(Err.EXPORT_FAILED, error.message);
  }
  return fail(Err.EXPORT_FAILED, String(error));
}
function inlineText(inlines) {
  if (!inlines) return "";
  return inlines.map((i) => {
    switch (i.t) {
      case "text":
        return i.v;
      case "strong":
        return inlineText(i.c);
      case "emph":
        return inlineText(i.c);
      case "code":
        return i.v;
      case "cloze":
        return i.hint ?? "";
      case "math":
        return i.v;
      case "newline":
        return "\n";
      default:
        return "";
    }
  }).join("");
}
function blockText(block) {
  const b = block;
  switch (block.type) {
    case "header": {
      const f = block.fields ?? {};
      return [f.titel, f.fach, f.klasse, f.datum, f.name].filter(Boolean).join(" \xB7 ");
    }
    case "table": {
      const cell = (c) => inlineText(c);
      const t = block;
      const head = (t.headers ?? []).map(cell).join(" | ");
      const body = (t.rows ?? []).map((r) => r.map(cell).join(" | ")).join("\n");
      return [head, body].filter(Boolean).join("\n");
    }
    default:
      return inlineText(b.body ?? void 0);
  }
}
function blockOutline(block) {
  const text = blockText(block).replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  return {
    id: block.id,
    type: block.type,
    hash: block.hash,
    origin: block.origin,
    words,
    preview: text.slice(0, 60),
    stale: block.stale != null
  };
}
function staleBlockIds(packet) {
  const out = [];
  for (const sid of packet.sheetOrder) {
    for (const b of packet.sheets[sid].blocks) {
      if (b.stale != null) out.push(b.id);
    }
  }
  return out;
}
function resolvePacketId(deps, packetId) {
  const pid = packetId ?? deps.store.getActivePacket();
  if (!pid) return fail(Err.NO_ACTIVE_PACKET, "no active packet (packetId required)");
  if (!deps.store.load(pid)) return fail(Err.PACKET_NOT_FOUND, `packet ${pid} not found`);
  return pid;
}
function assetBytesForPacket(deps, packet) {
  const out = {};
  for (const id of Object.keys(packet.assets ?? {})) {
    const bytes = deps.store.readAsset(packet.id, id);
    if (bytes && bytes.length > 0) out[id] = bytes;
  }
  return out;
}
var MAX_INLINE_NODES = 5e3;
var MAX_INLINE_DEPTH = 3;
function validateSlot(slot) {
  if (!slot || typeof slot !== "object") return "invalid_slot";
  if (slot.mode === "full" && slot.asset) return "invalid_slot";
  if ((slot.mode === "media-right" || slot.mode === "media-left") && !slot.asset) return "invalid_slot";
  if (slot.mode === "card-grid" && slot.columns !== void 0 && ![2, 3, 4].includes(slot.columns)) {
    return "invalid_slot";
  }
  return null;
}
function validateInline(inlines) {
  let count = 0;
  const walk = (node, depth) => {
    count++;
    if (count > MAX_INLINE_NODES) return "inline_limit";
    if (depth > MAX_INLINE_DEPTH) return "inline_limit";
    if (node.t === "strong" || node.t === "emph") {
      for (const c of node.c) {
        const e = walk(c, depth + 1);
        if (e) return e;
      }
    }
    return null;
  };
  for (const i of inlines) {
    const e = walk(i, 1);
    if (e) return e;
  }
  return null;
}
function toInline(body) {
  if (typeof body === "string") return [{ t: "text", v: body }];
  if (Array.isArray(body)) return body;
  return [{ t: "text", v: body === void 0 || body === null ? "" : String(body) }];
}
function buildBlock(packet, raw, origin) {
  const type = raw.type;
  if (!["header", "heading", "prose", "source_text", "task", "table", "callout", "answer"].includes(String(type))) {
    return { block: null, error: "invalid_block" };
  }
  const slot = raw.slot ?? { mode: "full" };
  const slotErr = validateSlot(slot);
  if (slotErr) return { block: null, error: slotErr };
  if ((type === "header" || type === "heading") && slot.mode !== "full") {
    return { block: null, error: "invalid_block" };
  }
  if (slot.asset && !(packet.assets && slot.asset.id in packet.assets)) {
    return { block: null, error: "asset_not_found" };
  }
  const bodyInlines = toInline(raw.body);
  if (bodyInlines.length > 0) {
    const e = validateInline(bodyInlines);
    if (e) return { block: null, error: e };
  }
  const id = raw.id || allocateBlockId(packet);
  const base = {
    id,
    type,
    hash: "",
    dependsOn: raw.dependsOn ?? [],
    slot,
    origin,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    stale: null
  };
  switch (type) {
    case "header":
      base.fields = raw.fields ?? {};
      break;
    case "heading":
      base.level = raw.level ?? 1;
      base.numbered = raw.numbered ?? false;
      base.body = bodyInlines;
      break;
    case "prose":
    case "task":
    case "answer":
      base.body = bodyInlines;
      break;
    case "source_text":
      base.title = raw.title;
      base.body = bodyInlines;
      base.lineNumbers = raw.lineNumbers;
      break;
    case "table":
      base.headers = raw.headers ?? [];
      base.rows = raw.rows ?? [];
      break;
    case "callout":
      base.tone = raw.tone ?? "info";
      base.body = bodyInlines;
      break;
  }
  const block = base;
  block.hash = hashBlock(block);
  return { block, error: null };
}
function toReceipt(sr, packet) {
  return {
    pages: sr.pages,
    perPage: sr.perPage,
    lastPageLineCount: sr.lastPageLineCount,
    overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
    compiledAtRev: packet.rev
  };
}
async function computeProofs(deps, packet, sheetId) {
  const { render } = deps;
  const out = {};
  const ids = sheetId ? [sheetId] : packet.sheetOrder;
  const assetBytes = assetBytesForPacket(deps, packet);
  for (const sid of ids) {
    const sheet = packet.sheets[sid];
    if (!sheet) continue;
    if (!render) {
      out[sid] = null;
      continue;
    }
    try {
      const sr = await render(sheet, packet, assetBytes);
      out[sid] = toReceipt(sr, packet);
    } catch {
      out[sid] = { pages: 0, perPage: [], lastPageLineCount: 0, overflowLinesOnLastPage: 0, compiledAtRev: packet.rev };
    }
  }
  return out;
}
async function galleyOpen(deps, args) {
  const { store } = deps;
  if (args.id !== void 0) {
    if (args.template || args.title || args.orientation || args.blocks || args.targetPages !== void 0 || args.assets) {
      return fail(Err.INVALID_PARAMS, "id is exclusive with packet creation fields");
    }
    const existing = store.load(args.id);
    if (!existing) return fail(Err.PACKET_NOT_FOUND, `packet ${args.id} not found`);
    store.setActivePacket(existing.id);
    const blocks = {};
    for (const sid of existing.sheetOrder) blocks[sid] = existing.sheets[sid].blocks.map(blockOutline);
    return {
      ok: true,
      packetId: existing.id,
      rev: existing.rev,
      title: existing.title,
      template: existing.template,
      reviewMode: existing.reviewMode ?? "auto",
      sheetOrder: existing.sheetOrder,
      blocks,
      active: true,
      proofs: await computeProofs(deps, existing)
    };
  }
  const template = args.template ?? "generic";
  const seedOrigin = args.origin ?? "human";
  const registry = deps.registry ?? defaultGalleyRegistry;
  const isBuiltin = template === "arbeitsblatt" || template === "rfc" || template === "generic";
  const customBlueprint = !isBuiltin ? registry.getTemplate(template, store) : null;
  if (!isBuiltin && !customBlueprint) {
    return fail(Err.INVALID_PARAMS, `unknown template '${template}'`);
  }
  try {
    const id = "p-" + base32(randomBytes2(8), 8);
    const packetTitle = args.title ?? (customBlueprint ? customBlueprint.title : template === "arbeitsblatt" ? "Arbeitsblatt" : "Document");
    const packet = {
      id,
      template,
      title: packetTitle,
      reviewMode: "auto",
      rev: 0,
      createdAt: "",
      updatedAt: "",
      sheetOrder: [],
      sheets: {},
      nextBlockSeq: 1,
      nextProposalSeq: 1,
      nextAnnotationSeq: 1,
      nextAssetSeq: 1,
      assets: {}
    };
    if (customBlueprint) {
      const bpSheets = customBlueprint.sheets.length > 0 ? customBlueprint.sheets : [{ id: "s1", title: packetTitle, geometry: { paper: "a4", margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } }, starterBlocks: [] }];
      for (let idx = 0; idx < bpSheets.length; idx++) {
        const bs = bpSheets[idx];
        const sid = bs.id || `s${idx + 1}`;
        packet.sheetOrder.push(sid);
        packet.sheets[sid] = {
          id: sid,
          title: bs.title || `Sheet ${idx + 1}`,
          geometry: {
            ...JSON.parse(JSON.stringify(bs.geometry)),
            ...idx === 0 && args.orientation ? { orientation: args.orientation } : {},
            ...idx === 0 && args.targetPages !== void 0 ? { targetPages: args.targetPages } : {}
          },
          blocks: []
        };
        for (const raw of bs.starterBlocks ?? []) {
          const clonedRaw = JSON.parse(JSON.stringify(raw));
          if (clonedRaw.type === "header" && args.title && clonedRaw.fields && typeof clonedRaw.fields === "object") {
            ;
            clonedRaw.fields.titel = args.title;
          }
          const { block, error } = buildBlock(packet, clonedRaw, seedOrigin);
          if (error) return fail(toStoreCode(error), `template starter block: ${error}`);
          packet.sheets[sid].blocks.push(block);
          packet.nextBlockSeq += 1;
        }
      }
    } else {
      const sheetId = "s1";
      const sheet = {
        id: sheetId,
        title: packetTitle,
        geometry: {
          paper: "a4",
          ...args.orientation ? { orientation: args.orientation } : {},
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          targetPages: args.targetPages ?? (template === "arbeitsblatt" ? 1 : void 0)
        },
        blocks: []
      };
      packet.sheetOrder = [sheetId];
      packet.sheets[sheetId] = sheet;
      if (template === "arbeitsblatt") {
        const s2Id = "s2";
        packet.sheets[s2Id] = {
          id: s2Id,
          title: "Erwartungshorizont",
          geometry: { paper: "a4", margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 } },
          blocks: []
        };
        packet.sheetOrder.push(s2Id);
        const scaffold = (sid, raw) => {
          const { block, error } = buildBlock(packet, raw, "agent");
          if (error) return fail(toStoreCode(error), `arbeitsblatt scaffold block: ${error}`);
          packet.sheets[sid].blocks.push(block);
          packet.nextBlockSeq += 1;
          return void 0;
        };
        const r1 = scaffold(sheetId, { type: "header", fields: { titel: packet.title, fach: "", klasse: "", datum: "", name: "" } });
        if (r1) return r1;
        const r2 = scaffold(sheetId, { type: "task", body: "Erste Aufgabe" });
        if (r2) return r2;
        const r3 = scaffold(s2Id, { type: "heading", level: 1, body: "Erwartungshorizont" });
        if (r3) return r3;
        const r4 = scaffold(s2Id, { type: "answer", body: "L\xF6sung", dependsOn: [{ id: "b2", sinceHash: packet.sheets[sheetId].blocks[1].hash, at: (/* @__PURE__ */ new Date()).toISOString() }] });
        if (r4) return r4;
      }
    }
    const firstSheet = packet.sheets[packet.sheetOrder[0]];
    for (const raw of args.blocks ?? []) {
      const { block, error } = buildBlock(packet, raw, seedOrigin);
      if (error) return fail(toStoreCode(error), `block ${raw.id ?? "?"}: ${error}`);
      firstSheet.blocks.push(block);
      packet.nextBlockSeq += 1;
    }
    store.create(packet);
    for (const a of args.assets ?? []) {
      const bytes = Buffer.alloc(a.size ?? 0);
      store.addAsset(
        id,
        { id: a.id, path: a.path, bytesSha256: createHash2("sha256").update(bytes).digest("hex"), mimeType: a.mimeType },
        bytes,
        { bumpRev: false }
      );
    }
    const loaded = store.load(id);
    store.setActivePacket(id);
    const blocks = {};
    for (const sid of loaded.sheetOrder) blocks[sid] = loaded.sheets[sid].blocks.map(blockOutline);
    return {
      ok: true,
      packetId: id,
      rev: loaded.rev,
      title: loaded.title,
      template: loaded.template,
      reviewMode: loaded.reviewMode ?? "auto",
      sheetOrder: loaded.sheetOrder,
      blocks,
      active: true,
      proofs: await computeProofs(deps, loaded)
    };
  } catch (e) {
    return mapError(e);
  }
}
async function galleyStatus(deps, args) {
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = deps.store.load(pid);
  if (args.sheetId && !packet.sheets[args.sheetId]) return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`);
  const blocks = {};
  for (const sid of packet.sheetOrder) blocks[sid] = packet.sheets[sid].blocks.map(blockOutline);
  const proofs = await computeProofs(deps, packet, args.sheetId);
  const preflight = (deps.registry ?? defaultGalleyRegistry).runPreflight(
    packet,
    proofs,
    deps.cwd ?? process.cwd()
  );
  return {
    ok: true,
    packetId: pid,
    rev: packet.rev,
    title: packet.title,
    template: packet.template,
    reviewMode: packet.reviewMode ?? "auto",
    sheetOrder: packet.sheetOrder,
    blocks,
    proposals: deps.store.listProposals(pid).filter((p) => p.status === "pending"),
    annotations: deps.store.listAnnotations(pid).filter((a) => !a.resolved),
    preflight,
    proofs
  };
}
async function galleyReadBlock(deps, args) {
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = deps.store.load(pid);
  const ids = args.blockIds ?? (args.blockId ? [args.blockId] : []);
  if (ids.length === 0) return fail(Err.INVALID_PARAMS, "blockId or blockIds required");
  const blocks = [];
  for (const id of ids) {
    const found = findBlock(packet, id);
    if (!found) return fail(Err.BLOCK_NOT_FOUND, `block ${id} not found`);
    const { sheet, index, block } = found;
    const dependencies = block.dependsOn.map((d) => d.id);
    const dependents = [];
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid].blocks) {
        if (b.dependsOn.some((d) => d.id === block.id)) dependents.push(b.id);
      }
    }
    const annotations = deps.store.listAnnotations(pid, block.id);
    const context = sheet.blocks.slice(Math.max(0, index - 2), index + 3).map((b) => (b.id === block.id ? `[${b.id}] ` : "") + summary(b)).join("\n");
    blocks.push({ block, context, dependencies, dependents, annotations });
  }
  return { ok: true, packetId: pid, blocks };
}
function summary(b) {
  if (b.type === "header") return `header: ${b.fields.titel ?? ""}`;
  const body = b.body;
  const text = body ? body.map((i) => i.t === "text" ? i.v : "").join("") : "";
  return `${b.type}: ${text.slice(0, 60)}`;
}
async function galleyEditBlock(deps, args) {
  const { store } = deps;
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = store.load(pid);
  if (args.sheetId !== void 0 && !packet.sheets[args.sheetId]) {
    return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`);
  }
  const locatedPre = args.blockId ? findBlock(packet, args.blockId) : null;
  const resolvedSheetId = args.sheetId ?? (args.op !== "insert" && locatedPre ? locatedPre.sheet.id : packet.sheetOrder[0]);
  const sheet = packet.sheets[resolvedSheetId];
  if (!sheet) return fail(Err.SHEET_NOT_FOUND, `sheet ${resolvedSheetId} not found`);
  try {
    const inReviewMode = (packet.reviewMode ?? "auto") === "review";
    const prePatchOrigin = args.op === "patch" ? locatedPre?.block?.origin : void 0;
    const shouldPropose = args.origin === "agent" && (inReviewMode || args.op === "patch" && prePatchOrigin === "human");
    if (shouldPropose) {
      const seq = store.listProposals(pid).length + 1;
      let prop;
      if (args.op === "insert") {
        if (!args.block) return fail(Err.INVALID_PARAMS, "insert requires a block");
        const { block: built, error } = buildBlock(packet, args.block, "human");
        if (error) return fail(toStoreCode(error), `invalid block: ${error}`);
        prop = {
          id: `prop-${seq}`,
          op: "insert",
          sheetId: resolvedSheetId,
          targetBlockId: built.id,
          baseHash: "",
          proposedPatch: { block: built, beforeId: args.beforeId },
          status: "pending",
          createdAtRev: packet.rev
        };
      } else {
        if (!args.blockId) return fail(Err.INVALID_PARAMS, `${args.op} requires blockId`);
        const target = locatedPre ?? findBlock(packet, args.blockId);
        if (!target) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`);
        if (args.baseHash && args.baseHash !== target.block.hash) {
          const t = fail(Err.PROPOSAL_CONFLICT, `block ${args.blockId} changed (base hash mismatch)`);
          t.baseHash = args.baseHash;
          t.currentHash = target.block.hash;
          return t;
        }
        if (args.op === "patch") {
          const proposedPatch = args.patch ?? {};
          const beforePatch = {};
          const rawBlock = target.block;
          for (const k of Object.keys(proposedPatch)) {
            if (k in rawBlock) beforePatch[k] = JSON.parse(JSON.stringify(rawBlock[k]));
          }
          prop = {
            id: `prop-${seq}`,
            op: "patch",
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch,
            proposedPatch,
            status: "pending",
            createdAtRev: packet.rev
          };
        } else if (args.op === "move") {
          const targetSheetId = args.toSheetId ?? resolvedSheetId;
          if (!packet.sheets[targetSheetId]) return fail(Err.INVALID_PARAMS, "target sheet not found");
          prop = {
            id: `prop-${seq}`,
            op: "move",
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch: { sheetId: target.sheet.id },
            proposedPatch: {
              toSheetId: targetSheetId,
              toBeforeId: args.toBeforeId,
              toAfterId: args.toAfterId
            },
            status: "pending",
            createdAtRev: packet.rev
          };
        } else {
          prop = {
            id: `prop-${seq}`,
            op: "remove",
            sheetId: target.sheet.id,
            targetBlockId: target.block.id,
            baseHash: target.block.hash,
            beforePatch: { type: target.block.type, preview: blockText(target.block).slice(0, 80) },
            proposedPatch: { remove: true },
            status: "pending",
            createdAtRev: packet.rev
          };
        }
      }
      store.addProposal(pid, prop);
      const loadedProp = store.load(pid);
      const renderProp = deps.render;
      const proofProp = renderProp ? await (async () => {
        try {
          return toReceipt(
            await renderProp(loadedProp.sheets[resolvedSheetId], loadedProp, assetBytesForPacket(deps, loadedProp)),
            loadedProp
          );
        } catch {
          return null;
        }
      })() : null;
      return {
        ok: true,
        applied: false,
        packetId: pid,
        rev: loadedProp.rev,
        block: null,
        proposal: { id: prop.id, op: prop.op ?? "patch", targetBlockId: prop.targetBlockId, status: "pending" },
        proof: proofProp,
        staleDependents: staleBlockIds(loadedProp)
      };
    }
    const needsExpect = (args.op === "patch" || args.op === "remove" || args.op === "move") && args.baseHash !== void 0;
    let changedId = null;
    let touchedSheetId = resolvedSheetId;
    store.commit(
      pid,
      needsExpect ? { blockId: args.blockId ?? "", baseHash: args.baseHash } : null,
      (p) => {
        const sh = p.sheets[resolvedSheetId];
        switch (args.op) {
          case "insert": {
            if (!args.block) throw new StoreError("invalid_op", "insert requires a block");
            const { block: block2, error } = buildBlock(p, args.block, args.origin);
            if (error) throw new StoreError(error, "invalid block");
            const idx = args.beforeId ? sh.blocks.findIndex((b) => b.id === args.beforeId) : sh.blocks.length;
            sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, block2);
            p.nextBlockSeq += 1;
            changedId = block2.id;
            return block2.id;
          }
          case "patch": {
            if (!args.blockId) throw new StoreError("invalid_op", "patch requires blockId");
            const found = findBlock(p, args.blockId);
            if (!found) throw new StoreError("not_found", `block ${args.blockId} not found`);
            touchedSheetId = found.sheet.id;
            const b = found.block;
            const now = deps.now ? deps.now() : (/* @__PURE__ */ new Date()).toISOString();
            for (const [k, v] of Object.entries(args.patch ?? {})) {
              if (k === "body") {
                const inlines = toInline(v);
                if (inlines.length > 0) {
                  const e = validateInline(inlines);
                  if (e) throw new StoreError(e, "inline limit");
                }
                b.body = inlines;
              } else if (k === "slot") {
                const slotVal = v;
                const e = validateSlot(slotVal);
                if (e) throw new StoreError(e, "slot");
                if ((found.block.type === "header" || found.block.type === "heading") && slotVal.mode !== "full") {
                  throw new StoreError("invalid_block", "header/heading must use full slot");
                }
                if (slotVal.asset && !(p.assets && slotVal.asset.id in p.assets)) {
                  throw new StoreError("asset_not_found", `asset ${slotVal.asset.id} not found`);
                }
                b.slot = slotVal;
              } else if (k === "dependsOn") {
                if (!Array.isArray(v)) throw new StoreError("invalid_op", "dependsOn must be an array");
                b.dependsOn = v.map((item) => {
                  if (typeof item === "string") {
                    const target = findBlock(p, item);
                    return { id: item, sinceHash: target ? target.block.hash : "", at: now };
                  }
                  return item;
                });
              } else if (["fields", "level", "tone", "headers", "rows", "numbered", "title", "lineNumbers"].includes(k)) {
                b[k] = v;
              }
            }
            if (args.origin === "human") b.origin = "human";
            if (b.body) {
              const e = validateInline(b.body);
              if (e) throw new StoreError(e, "inline limit");
            }
            changedId = found.block.id;
            return found.block.id;
          }
          case "move": {
            const id = args.blockId;
            if (!id) throw new StoreError("invalid_op", "move requires blockId");
            const from = findBlock(p, id);
            if (!from) throw new StoreError("not_found", `block ${id} not found`);
            const targetSheet = p.sheets[args.toSheetId ?? resolvedSheetId];
            if (!targetSheet) throw new StoreError("invalid_op", `target sheet not found`);
            from.sheet.blocks.splice(from.index, 1);
            let to = targetSheet.blocks.length;
            if (args.toBeforeId) to = targetSheet.blocks.findIndex((b) => b.id === args.toBeforeId);
            if (args.toAfterId) {
              const i = targetSheet.blocks.findIndex((b) => b.id === args.toAfterId);
              to = i >= 0 ? i + 1 : targetSheet.blocks.length;
            }
            targetSheet.blocks.splice(to < 0 ? targetSheet.blocks.length : to, 0, from.block);
            touchedSheetId = targetSheet.id;
            changedId = id;
            return id;
          }
          case "remove": {
            if (!args.blockId) throw new StoreError("invalid_op", "remove requires blockId");
            const found = findBlock(p, args.blockId);
            if (!found) throw new StoreError("not_found", `block ${args.blockId} not found`);
            found.sheet.blocks.splice(found.index, 1);
            touchedSheetId = found.sheet.id;
            changedId = found.block.id;
            return found.block.id;
          }
        }
        return null;
      }
    );
    const loaded = store.load(pid);
    const render = deps.render;
    const proof = render ? await (async () => {
      try {
        return toReceipt(await render(loaded.sheets[touchedSheetId], loaded, assetBytesForPacket(deps, loaded)), loaded);
      } catch {
        return null;
      }
    })() : null;
    let block = null;
    if (changedId) {
      const found = findBlock(loaded, changedId);
      if (found) block = blockOutline(found.block);
    }
    return {
      ok: true,
      applied: true,
      packetId: pid,
      rev: loaded.rev,
      block,
      proposal: null,
      proof,
      staleDependents: staleBlockIds(loaded)
    };
  } catch (e) {
    return mapError(e);
  }
}
async function galleyAnnotate(deps, args) {
  const { store } = deps;
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = store.load(pid);
  if (!findBlock(packet, args.blockId)) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`);
  switch (args.action) {
    case "add": {
      const body = toInline(args.body ?? "");
      const annotation = {
        id: `ann-${store.listAnnotations(pid).length + 1}`,
        blockId: args.blockId,
        author: args.author ?? "human",
        body,
        resolved: false,
        createdAtRev: packet.rev
      };
      store.addAnnotation(pid, annotation);
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: annotation };
    }
    case "list":
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: null };
    case "resolve":
    case "unresolve": {
      if (!args.annotationId) return fail(Err.INVALID_PARAMS, `${args.action} requires annotationId`);
      const updated = store.setAnnotationResolved(pid, args.annotationId, args.action === "resolve");
      if (!updated) return fail(Err.ANNOTATION_NOT_FOUND, `annotation ${args.annotationId} not found`);
      return { ok: true, annotations: store.listAnnotations(pid, args.blockId), created: null };
    }
    default:
      return fail(Err.INVALID_PARAMS, `unknown action`);
  }
}
function exportSlug(title) {
  const s = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase();
  return s || "galley";
}
async function galleyExport(deps, args) {
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = deps.store.load(pid);
  if (!["typ", "md", "tex", "pdf", "docx"].includes(args.format)) {
    return fail(Err.INVALID_PARAMS, `unknown export format '${args.format}'`);
  }
  if (args.format === "docx") {
    return fail(Err.EXPORT_FAILED, "docx exporter lands in M4; use pdf or typ");
  }
  const targetIds = args.sheetIds && args.sheetIds.length > 0 ? args.sheetIds : args.sheetId ? [args.sheetId] : args.outDir ? packet.sheetOrder : [packet.sheetOrder[0]];
  for (const sid of targetIds) {
    if (!packet.sheets[sid]) return fail(Err.SHEET_NOT_FOUND, `sheet ${sid} not found`);
  }
  try {
    let firstText;
    let firstBytes;
    const files = [];
    const slug = exportSlug(packet.title);
    if (args.outDir) {
      mkdirSync3(join5(args.outDir, "galley-exports"), { recursive: true });
    }
    for (let i = 0; i < targetIds.length; i++) {
      const sid = targetIds[i];
      const sheet = packet.sheets[sid];
      let text;
      let bytes;
      let pages = null;
      switch (args.format) {
        case "typ":
          text = compileSheet(sheet, packet.assets).typ;
          bytes = Buffer.from(text, "utf8");
          break;
        case "md":
          text = toMarkdown(sheet);
          bytes = Buffer.from(text, "utf8");
          break;
        case "tex":
          text = toTex(sheet);
          bytes = Buffer.from(text, "utf8");
          break;
        case "pdf": {
          if (!deps.render) return fail(Err.TYPST_COMPILE_ERROR, "no render arm available for pdf");
          const sr = await deps.render(sheet, packet, assetBytesForPacket(deps, packet));
          if (!sr.pdf || sr.pdf.length === 0) return fail(Err.EXPORT_FAILED, "render arm produced no pdf bytes");
          bytes = sr.pdf;
          pages = sr.pages;
          break;
        }
        default:
          return fail(Err.INVALID_PARAMS, "unknown format");
      }
      if (i === 0) {
        firstText = text;
        firstBytes = args.format === "pdf" ? bytes : void 0;
      }
      if (args.outDir) {
        const filename = targetIds.length === 1 && sid === "s1" ? `${slug}.${args.format}` : `${slug}-${sid}.${args.format}`;
        const relPath = `galley-exports/${filename}`;
        writeFileSync3(join5(args.outDir, relPath), bytes);
        files.push({
          sheetId: sid,
          path: relPath,
          format: args.format,
          pages,
          sizeBytes: bytes.length,
          sha256: createHash2("sha256").update(bytes).digest("hex")
        });
      }
    }
    return {
      ok: true,
      format: args.format,
      ...firstText !== void 0 ? { text: firstText } : {},
      ...firstBytes !== void 0 ? { bytes: firstBytes } : {},
      ...args.outDir ? { files } : {}
    };
  } catch (e) {
    return mapError(e);
  }
}
function inlineToMarkdown(inlines) {
  return inlines.map((i) => {
    switch (i.t) {
      case "text":
        return i.v;
      case "strong":
        return `**${inlineToMarkdown(i.c)}**`;
      case "emph":
        return `*${inlineToMarkdown(i.c)}*`;
      case "code":
        return `\`${i.v}\``;
      case "cloze":
        return `_${(i.hint ?? "").padStart(Math.max(1, (i.hint ?? "").length + 1), "_")}_`;
      case "math":
        return `$${i.v}$`;
      case "newline":
        return "\n";
      default:
        return "";
    }
  }).join("");
}
function toMarkdown(sheet) {
  const L = [`# ${sheet.title}`, ""];
  for (const b of sheet.blocks) {
    if (b.type === "header") {
      L.push(`**${b.fields.titel ?? ""}**${b.fields.fach ? ` \xB7 ${b.fields.fach}` : ""}${b.fields.name ? ` \xB7 ${b.fields.name}` : ""}`);
    } else if (b.type === "heading") {
      L.push(`${"#".repeat(b.level)} ${inlineToMarkdown(b.body)}`);
    } else if (b.type === "table") {
      const cell = (c) => inlineToMarkdown(c);
      L.push(b.headers.map((c) => `| **${cell(c)}**`).join(" "));
      L.push(`|${b.headers.map(() => " --- ").join("")}`);
      for (const row of b.rows) L.push(`|${row.map((c) => cell(c)).join(" ")}`);
    } else if (b.type === "callout") {
      L.push(`> [${b.tone}] ${inlineToMarkdown(b.body)}`);
    } else {
      const body = b.body;
      L.push(body ? inlineToMarkdown(body) : "");
    }
    L.push("");
  }
  return L.join("\n");
}
function toTex(sheet) {
  const esc = (s) => s.replace(/([&%$#_{}])/g, "\\$1");
  const inlineTex = (inlines) => inlines.map((i) => {
    switch (i.t) {
      case "text":
        return esc(i.v);
      case "strong":
        return `\\textbf{${inlineTex(i.c)}}`;
      case "emph":
        return `\\emph{${inlineTex(i.c)}}`;
      case "code":
        return `\\texttt{${esc(i.v)}}`;
      case "math":
        return `$${i.v}$`;
      case "newline":
        return "\\\\";
      default:
        return "";
    }
  }).join("");
  const L = [
    "\\documentclass[a4paper]{article}",
    `\\title{${esc(sheet.title)}}`,
    "\\begin{document}",
    "\\maketitle"
  ];
  for (const b of sheet.blocks) {
    if (b.type === "heading") L.push(`\\section{${inlineTex(b.body)}}`);
    else if (b.type === "table") {
      const cell = (c) => inlineTex(c);
      L.push(`\\begin{tabular}{${"l".repeat(Math.max(1, b.headers.length))}}`);
      L.push(b.headers.map((c) => `\\textbf{${cell(c)}}`).join(" & ") + " \\\\\\");
      for (const row of b.rows) L.push(row.map((c) => cell(c)).join(" & ") + " \\\\");
      L.push("\\end{tabular}");
    } else {
      const body = b.body;
      if (body) L.push(inlineTex(body));
    }
  }
  L.push("\\end{document}");
  return L.join("\n");
}
var B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(buf, len) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[value << 5 - bits & 31];
  return out.slice(0, len);
}

// src/host/httpDispatch.ts
var BODY_LIMIT_BYTES = 6 * 1024 * 1024;
var MAX_ASSET_BYTES = 4 * 1024 * 1024;
function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}
function sendNotModified(res) {
  res.writeHead(304, { "cache-control": "no-store" });
  res.end();
}
function httpStatusForCode(code) {
  switch (code) {
    case Err.NO_ACTIVE_PACKET:
    case Err.PACKET_NOT_FOUND:
    case Err.SHEET_NOT_FOUND:
    case Err.BLOCK_NOT_FOUND:
    case Err.ASSET_NOT_FOUND:
    case Err.PROPOSAL_NOT_FOUND:
    case Err.ANNOTATION_NOT_FOUND:
      return 404;
    case Err.PROPOSAL_CONFLICT:
      return 409;
    case Err.INVALID_PARAMS:
    case Err.BLOCK_TYPE_MISMATCH:
    case Err.DEPENDENCY_CYCLE:
    case Err.ASSET_LIMIT_EXCEEDED:
      return 400;
    default:
      return 500;
  }
}
function sendFailure(res, failure) {
  const fields = {};
  if (failure.baseHash) fields.baseHash = failure.baseHash;
  if (failure.currentHash) fields.currentHash = failure.currentHash;
  if (failure.diagnostics) fields.diagnostics = failure.diagnostics;
  sendJson(res, httpStatusForCode(failure.code), {
    ok: false,
    code: failure.code,
    message: failure.message,
    fields
  });
}
function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve3, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new StoreError("invalid_op", "request body exceeds size limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve3({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new StoreError("invalid_op", "JSON object body required"));
          return;
        }
        resolve3(parsed);
      } catch {
        reject(new StoreError("invalid_op", "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function parseUrl(req) {
  const host = req.headers.host ?? "127.0.0.1";
  return new URL(req.url ?? "/", `http://${host}`);
}
function extForMime(mimeType) {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}
function contentTypeForExt(ext) {
  switch (ext.toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".typ":
    case ".tex":
    case ".md":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
async function compilePacketProofs(deps, packet) {
  const proofs = [];
  const assetBytes = assetBytesForPacket(deps, packet);
  for (const sid of packet.sheetOrder) {
    const sheet = packet.sheets[sid];
    if (!sheet) continue;
    if (!deps.render) {
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        blockToPage: {},
        compiledAtRev: packet.rev,
        svgPages: [],
        compileError: null
      });
      continue;
    }
    try {
      const sr = await deps.render(sheet, packet, assetBytes);
      const svgPages = (sr.svgPages ?? []).map(
        (buf) => `data:image/svg+xml;base64,${Buffer.from(buf).toString("base64")}`
      );
      proofs.push({
        sheetId: sid,
        pages: sr.pages,
        perPage: sr.perPage,
        lastPageLineCount: sr.lastPageLineCount,
        overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
        blockToPage: sr.blockToPage ?? {},
        compiledAtRev: packet.rev,
        svgPages,
        compileError: null
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const cs = compileSheet(sheet, packet.assets);
      const mapped = mapDiagnosticsToBlocks(cs.typ, [{ message: msg }]);
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        blockToPage: {},
        compiledAtRev: packet.rev,
        svgPages: [],
        compileError: { message: msg, blockId: mapped[0]?.blockId ?? null }
      });
    }
  }
  return proofs;
}
function createGalleyHttpDispatcher(hostDeps) {
  const proofCache = /* @__PURE__ */ new Map();
  const registry = hostDeps.registry ?? defaultGalleyRegistry;
  async function getCachedProofs(root, deps, packet) {
    const key = `${root}::${packet.id}`;
    const hit = proofCache.get(key);
    if (hit && hit.rev === packet.rev) return hit.proofs;
    const proofs = await compilePacketProofs(deps, packet);
    proofCache.set(key, { rev: packet.rev, proofs });
    if (proofCache.size > 32) {
      const oldest = proofCache.keys().next().value;
      if (oldest) proofCache.delete(oldest);
    }
    return proofs;
  }
  async function handleState(req, res, url) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: "method not allowed", fields: {} });
      return;
    }
    const cwdParam = url.searchParams.get("cwd")?.trim() || null;
    if (cwdParam) noteGalleyCwd(cwdParam);
    const { deps, root, cwd } = await hostDeps.getDepsForCwd(cwdParam);
    const { store } = deps;
    const packets = store.list();
    const explicitPid = url.searchParams.get("packetId")?.trim() || void 0;
    if (explicitPid) {
      if (!store.load(explicitPid)) {
        sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${explicitPid} not found` });
        return;
      }
      store.setActivePacket(explicitPid);
    }
    const activePid = explicitPid ?? store.getActivePacket();
    const packet = activePid ? store.load(activePid) : null;
    const templates = registry.listTemplates(store);
    if (!packet) {
      const empty = {
        ok: true,
        activePacket: false,
        cwd,
        packets,
        templates,
        rev: 0,
        packetId: null
      };
      sendJson(res, 200, empty);
      return;
    }
    const revParam = url.searchParams.get("rev");
    if (revParam !== null && revParam !== "" && Number(revParam) === packet.rev) {
      sendNotModified(res);
      return;
    }
    const allAnnotations = store.listAnnotations(packet.id);
    const allProposals = store.listProposals(packet.id);
    const sheets = [];
    const staleDependents = [];
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid];
      if (!sh) continue;
      const blockIds = new Set(sh.blocks.map((b) => b.id));
      for (const b of sh.blocks) {
        if (b.stale) {
          staleDependents.push({
            id: b.id,
            origin: b.stale.origin,
            sinceHash: b.stale.sinceHash,
            state: b.stale.state
          });
        }
      }
      sheets.push({
        id: sh.id,
        title: sh.title,
        geometry: sh.geometry,
        blocks: sh.blocks,
        annotations: allAnnotations.filter((a) => blockIds.has(a.blockId)),
        proposals: allProposals.filter(
          (p) => p.op === "insert" ? (p.sheetId ?? packet.sheetOrder[0]) === sh.id : blockIds.has(p.targetBlockId)
        )
      });
    }
    const proofs = await getCachedProofs(root, deps, packet);
    const proofMap = {};
    for (const pr of proofs) proofMap[pr.sheetId] = pr;
    const preflight = registry.runPreflight(packet, proofMap, cwd);
    const payload = {
      ok: true,
      activePacket: true,
      cwd,
      packets,
      templates,
      rev: packet.rev,
      packetId: packet.id,
      template: packet.template,
      title: packet.title,
      reviewMode: packet.reviewMode ?? "auto",
      activeSheetId: packet.sheetOrder[0] ?? "s1",
      sheetOrder: packet.sheetOrder,
      assets: packet.assets ?? {},
      undoDepth: store.undoDepth(packet.id),
      redoDepth: store.redoDepth(packet.id),
      sheets,
      staleDependents,
      preflight,
      proofs
    };
    sendJson(res, 200, payload);
  }
  async function handleEdit(req, res, url) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: "method not allowed", fields: {} });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendFailure(res, mapError(error));
      return;
    }
    const cwdParam = (typeof body.cwd === "string" ? body.cwd : url.searchParams.get("cwd"))?.trim() || null;
    if (cwdParam) noteGalleyCwd(cwdParam);
    const { deps } = await hostDeps.getDepsForCwd(cwdParam);
    const { store } = deps;
    const op = typeof body.op === "string" ? body.op : "";
    const source = body.source === "agent" || body.origin === "agent" ? "agent" : "human";
    const packetIdArg = typeof body.packetId === "string" ? body.packetId : void 0;
    try {
      if (op === "open") {
        const result = await galleyOpen(
          { ...deps, registry },
          {
            id: typeof body.id === "string" ? body.id : void 0,
            template: typeof body.template === "string" ? body.template : void 0,
            title: typeof body.title === "string" ? body.title : void 0,
            orientation: body.orientation === "landscape" ? "landscape" : body.orientation === "portrait" ? "portrait" : void 0,
            targetPages: typeof body.targetPages === "number" ? body.targetPages : void 0,
            blocks: Array.isArray(body.blocks) ? body.blocks : void 0,
            origin: source
          }
        );
        if (!result.ok) {
          sendFailure(res, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      if (op === "template-delete") {
        const tid = typeof body.templateId === "string" ? body.templateId.trim() : "";
        if (!tid) {
          sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: "templateId required" });
          return;
        }
        const removed = store.deleteSavedTemplate(tid);
        sendJson(res, 200, { ok: true, deleted: removed, templates: registry.listTemplates(store) });
        return;
      }
      if (op === "packet-delete") {
        const targetId = packetIdArg ?? store.getActivePacket();
        if (!targetId) {
          sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: "no packet to delete" });
          return;
        }
        store.delete(targetId);
        sendJson(res, 200, {
          ok: true,
          deletedId: targetId,
          activePacketId: store.getActivePacket(),
          packets: store.list()
        });
        return;
      }
      const pid = packetIdArg ?? store.getActivePacket();
      if (!pid) {
        sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: "no active packet" });
        return;
      }
      const packet = store.load(pid);
      if (!packet) {
        sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` });
        return;
      }
      if (op === "packet-rename") {
        const updated = store.renamePacket(pid, typeof body.title === "string" ? body.title : "");
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, title: updated.title });
        return;
      }
      if (op === "packet-duplicate") {
        const dup = store.duplicatePacket(pid, typeof body.title === "string" ? body.title : void 0);
        sendJson(res, 200, { ok: true, packetId: dup.id, rev: dup.rev, title: dup.title });
        return;
      }
      if (op === "packet-set-review-mode") {
        const mode = body.reviewMode;
        const updated = store.setReviewMode(pid, mode);
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, reviewMode: updated.reviewMode ?? "auto" });
        return;
      }
      if (op === "template-save") {
        const bp = store.saveAsTemplate(pid, {
          id: typeof body.templateId === "string" ? body.templateId : void 0,
          title: typeof body.title === "string" ? body.title : void 0,
          description: typeof body.description === "string" ? body.description : void 0
        });
        sendJson(res, 200, { ok: true, template: bp, templates: registry.listTemplates(store) });
        return;
      }
      if (op === "sheet-add") {
        const out = store.addSheet(pid, {
          title: typeof body.title === "string" ? body.title : void 0,
          orientation: body.orientation === "landscape" ? "landscape" : "portrait",
          targetPages: typeof body.targetPages === "number" ? body.targetPages : void 0,
          paper: body.paper === "letter" ? "letter" : "a4"
        });
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.packet.rev, sheetId: out.sheetId });
        return;
      }
      if (op === "sheet-rename") {
        const out = store.renameSheet(pid, String(body.sheetId ?? ""), typeof body.title === "string" ? body.title : "");
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev });
        return;
      }
      if (op === "sheet-remove") {
        const out = store.removeSheet(pid, String(body.sheetId ?? ""));
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev, sheetOrder: out.sheetOrder });
        return;
      }
      if (op === "sheet-reorder") {
        const dir = body.direction === "left" ? "left" : "right";
        const out = store.reorderSheet(pid, String(body.sheetId ?? ""), dir);
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev, sheetOrder: out.sheetOrder });
        return;
      }
      if (op === "undo" || op === "redo") {
        const out = op === "undo" ? store.undo(pid) : store.redo(pid);
        sendJson(res, 200, {
          ok: true,
          packetId: pid,
          rev: out.rev,
          undoDepth: store.undoDepth(pid),
          redoDepth: store.redoDepth(pid)
        });
        return;
      }
      if (op === "annotate-add" || op === "annotate-resolve" || op === "annotate-unresolve") {
        const action = op === "annotate-add" ? "add" : op === "annotate-resolve" ? "resolve" : "unresolve";
        const annRes = await galleyAnnotate(deps, {
          packetId: pid,
          blockId: String(body.blockId ?? ""),
          action,
          author: source,
          body: body.body ?? "",
          annotationId: typeof body.annotationId === "string" ? body.annotationId : void 0
        });
        if (!annRes.ok) {
          sendFailure(res, annRes);
          return;
        }
        const reloaded = store.load(pid);
        sendJson(res, 200, { ...annRes, packetId: pid, rev: reloaded.rev });
        return;
      }
      if (op === "update-geometry") {
        const sheetId = typeof body.sheetId === "string" ? body.sheetId : packet.sheetOrder[0];
        if (!packet.sheets[sheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` });
          return;
        }
        const resCommit = store.commit(pid, null, (p) => {
          const sh = p.sheets[sheetId];
          if ("targetPages" in body) {
            const tp = body.targetPages;
            if (tp === null || tp === void 0 || tp === "") {
              delete sh.geometry.targetPages;
            } else if (typeof tp === "number" && Number.isFinite(tp) && tp >= 1) {
              sh.geometry.targetPages = Math.floor(tp);
            } else {
              throw new StoreError("invalid_op", "targetPages must be positive integer or null");
            }
          }
          if (body.paper === "a4" || body.paper === "letter") {
            sh.geometry.paper = body.paper;
          }
          if (body.orientation === "portrait" || body.orientation === "landscape") {
            sh.geometry.orientation = body.orientation;
          }
          return null;
        });
        sendJson(res, 200, { ok: true, packetId: pid, rev: resCommit.rev, sheetId });
        return;
      }
      if (op === "insert-asset") {
        const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : "";
        const rawB64 = typeof body.dataBase64 === "string" ? body.dataBase64.trim() : "";
        if (!mimeType || !rawB64) {
          sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: "insert-asset requires mimeType and dataBase64" });
          return;
        }
        const stripped = rawB64.replace(/^data:[^;]+;base64,/, "");
        const bytes = Buffer.from(stripped, "base64");
        if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
          sendFailure(res, {
            ok: false,
            code: Err.INVALID_PARAMS,
            message: `asset size must be between 1 B and ${MAX_ASSET_BYTES} B`
          });
          return;
        }
        const seq = packet.nextAssetSeq ?? Object.keys(packet.assets ?? {}).length + 1;
        let n = seq;
        while (packet.assets && `a${n}` in packet.assets) n++;
        const assetId = `a${n}`;
        const ext = extForMime(mimeType);
        const relPath = `assets/${assetId}.${ext}`;
        const meta = {
          id: assetId,
          path: relPath,
          bytesSha256: createHash3("sha256").update(bytes).digest("hex"),
          mimeType,
          widthPx: typeof body.widthPx === "number" ? body.widthPx : void 0,
          heightPx: typeof body.heightPx === "number" ? body.heightPx : void 0
        };
        store.addAsset(pid, meta, bytes);
        const targetBlockId = typeof body.blockId === "string" ? body.blockId : void 0;
        if (targetBlockId) {
          const slotMode = body.slotMode === "media-left" ? "media-left" : "media-right";
          const alt = typeof body.alt === "string" && body.alt.trim() ? body.alt.trim() : assetId;
          const widthCm = typeof body.widthCm === "number" && body.widthCm > 0 ? body.widthCm : void 0;
          const slot = {
            mode: slotMode,
            asset: { id: assetId, path: relPath, alt, widthCm }
          };
          const found = findBlock(store.load(pid), targetBlockId);
          if (!found) {
            sendFailure(res, { ok: false, code: Err.BLOCK_NOT_FOUND, message: `block ${targetBlockId} not found` });
            return;
          }
          const editRes = await galleyEditBlock(deps, {
            packetId: pid,
            sheetId: found.sheet.id,
            op: "patch",
            origin: source,
            blockId: targetBlockId,
            patch: { slot }
          });
          if (!editRes.ok) {
            sendFailure(res, editRes);
            return;
          }
          sendJson(res, 200, { ...editRes, asset: meta });
          return;
        }
        const reloaded = store.load(pid);
        sendJson(res, 200, { ok: true, packetId: pid, rev: reloaded.rev, asset: meta });
        return;
      }
      if (op === "insert" || op === "patch" || op === "move" || op === "remove") {
        const blockId = typeof body.blockId === "string" ? body.blockId : void 0;
        const located = blockId ? findBlock(packet, blockId) : null;
        const sheetId = typeof body.sheetId === "string" ? body.sheetId : located?.sheet.id ?? packet.sheetOrder[0];
        const sheet = packet.sheets[sheetId];
        if (!sheet) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` });
          return;
        }
        let beforeId = typeof body.beforeId === "string" ? body.beforeId : void 0;
        if (!beforeId && op === "insert") {
          if (typeof body.afterBlockId === "string") {
            const idx = sheet.blocks.findIndex((b) => b.id === body.afterBlockId);
            if (idx >= 0 && idx + 1 < sheet.blocks.length) beforeId = sheet.blocks[idx + 1].id;
          } else if (typeof body.index === "number" && body.index >= 0 && body.index < sheet.blocks.length) {
            beforeId = sheet.blocks[body.index].id;
          }
        }
        let toBeforeId = typeof body.toBeforeId === "string" ? body.toBeforeId : void 0;
        let toAfterId = typeof body.toAfterId === "string" ? body.toAfterId : void 0;
        if (op === "move" && !toBeforeId && !toAfterId) {
          const targetSh = packet.sheets[typeof body.toSheetId === "string" ? body.toSheetId : sheetId] ?? sheet;
          if (typeof body.afterBlockId === "string") {
            toAfterId = body.afterBlockId;
          } else if (typeof body.index === "number") {
            const without = targetSh.blocks.filter((b) => b.id !== blockId);
            if (body.index <= 0 && without.length > 0) toBeforeId = without[0].id;
            else if (body.index > 0 && body.index <= without.length) toAfterId = without[Math.min(body.index, without.length) - 1].id;
          }
        }
        let patchObj = body.patch && typeof body.patch === "object" ? { ...body.patch } : void 0;
        if (op === "patch" && !patchObj) {
          patchObj = {};
          if (body.content && typeof body.content === "object") {
            Object.assign(patchObj, body.content);
          }
          if (body.slot !== void 0) patchObj.slot = body.slot;
          if (body.dependsOn !== void 0) patchObj.dependsOn = body.dependsOn;
        }
        const result = await galleyEditBlock(deps, {
          packetId: pid,
          sheetId,
          op,
          origin: source,
          beforeId,
          block: body.block,
          blockId,
          baseHash: typeof body.baseHash === "string" ? body.baseHash : void 0,
          patch: patchObj,
          toSheetId: typeof body.toSheetId === "string" ? body.toSheetId : void 0,
          toBeforeId,
          toAfterId
        });
        if (!result.ok) {
          sendFailure(res, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: `unsupported edit op '${op}'` });
    } catch (error) {
      sendFailure(res, mapError(error));
    }
  }
  async function handleProposalDecide(req, res, url, proposalId) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: "method not allowed", fields: {} });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendFailure(res, mapError(error));
      return;
    }
    const cwdParam = (typeof body.cwd === "string" ? body.cwd : url.searchParams.get("cwd"))?.trim() || null;
    if (cwdParam) noteGalleyCwd(cwdParam);
    const { deps, root } = await hostDeps.getDepsForCwd(cwdParam);
    const { store } = deps;
    const pid = (typeof body.packetId === "string" ? body.packetId : void 0) ?? store.getActivePacket();
    if (!pid) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: "no active packet" });
      return;
    }
    if (!store.load(pid)) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` });
      return;
    }
    const action = typeof body.action === "string" ? body.action : "";
    if (proposalId === "_all" || action === "accept-all") {
      const summary2 = store.acceptAllProposals(pid);
      const reloaded = store.load(pid);
      const proofs = await getCachedProofs(root, deps, reloaded);
      sendJson(res, 200, {
        ok: true,
        accepted: summary2.accepted,
        conflicted: summary2.conflicted,
        rev: summary2.rev,
        proofs
      });
      return;
    }
    if (action !== "accept" && action !== "revert" && action !== "reject") {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: "action must be accept, revert, or accept-all" });
      return;
    }
    if (action === "revert" || action === "reject") {
      const updated = store.setProposalStatus(pid, proposalId, "rejected");
      if (!updated) {
        sendFailure(res, { ok: false, code: Err.PROPOSAL_NOT_FOUND, message: `proposal ${proposalId} not found` });
        return;
      }
      const reloaded = store.load(pid);
      const proofs = await getCachedProofs(root, deps, reloaded);
      const located = findBlock(reloaded, updated.targetBlockId);
      sendJson(res, 200, {
        ok: true,
        proposal: updated,
        block: located ? blockOutline(located.block) : null,
        rev: reloaded.rev,
        proof: located ? proofs.find((p) => p.sheetId === located.sheet.id) ?? null : null
      });
      return;
    }
    try {
      const accepted = store.applyProposal(pid, proposalId);
      const reloaded = store.load(pid);
      const proofs = await getCachedProofs(root, deps, reloaded);
      const located = findBlock(reloaded, accepted.targetBlockId);
      sendJson(res, 200, {
        ok: true,
        proposal: accepted,
        block: located ? blockOutline(located.block) : null,
        rev: reloaded.rev,
        proof: located ? proofs.find((p) => p.sheetId === located.sheet.id) ?? null : null
      });
    } catch (error) {
      if (error instanceof StoreError && error.code === "conflict") {
        store.setProposalStatus(pid, proposalId, "conflicted");
      }
      sendFailure(res, mapError(error));
    }
  }
  async function handleExport(req, res, url) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: "method not allowed", fields: {} });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendFailure(res, mapError(error));
      return;
    }
    const cwdParam = (typeof body.cwd === "string" ? body.cwd : url.searchParams.get("cwd"))?.trim() || null;
    if (cwdParam) noteGalleyCwd(cwdParam);
    const { deps, cwd } = await hostDeps.getDepsForCwd(cwdParam);
    const format = typeof body.format === "string" ? body.format : "pdf";
    const sheetIds = Array.isArray(body.sheetIds) && body.sheetIds.length > 0 ? body.sheetIds.filter((s) => typeof s === "string") : void 0;
    const sheetId = typeof body.sheetId === "string" ? body.sheetId : void 0;
    const packetId = typeof body.packetId === "string" ? body.packetId : void 0;
    const result = await galleyExport(deps, {
      packetId,
      sheetId,
      sheetIds,
      format,
      outDir: cwd
    });
    if (!result.ok) {
      sendFailure(res, result);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      packetId: packetId ?? deps.store.getActivePacket(),
      format: result.format,
      files: result.files ?? []
    });
  }
  async function handleDownload(req, res, url) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, code: Err.INVALID_PARAMS, message: "method not allowed", fields: {} });
      return;
    }
    const cwdParam = url.searchParams.get("cwd")?.trim() || null;
    if (cwdParam) noteGalleyCwd(cwdParam);
    const { cwd } = await hostDeps.getDepsForCwd(cwdParam);
    const relPath = url.searchParams.get("path")?.trim() ?? "";
    if (!relPath) {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: "path query parameter required" });
      return;
    }
    const exportsRoot = resolve2(cwd, "galley-exports");
    const targetAbs = resolve2(cwd, relPath);
    if (!targetAbs.startsWith(exportsRoot + sep)) {
      sendFailure(res, {
        ok: false,
        code: Err.INVALID_PARAMS,
        message: "download path must reside inside galley-exports/"
      });
      return;
    }
    if (!existsSync3(targetAbs) || !statSync(targetAbs).isFile()) {
      sendFailure(res, { ok: false, code: Err.EXPORT_FAILED, message: `exported file '${relPath}' not found` });
      return;
    }
    const bytes = readFileSync3(targetAbs);
    const safeName = basename2(targetAbs).replace(/[^A-Za-z0-9._-]/g, "_");
    res.writeHead(200, {
      "content-type": contentTypeForExt(extname(targetAbs)),
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${safeName}"`,
      "cache-control": "no-store"
    });
    res.end(bytes);
  }
  return async function dispatch(req, res) {
    const url = parseUrl(req);
    const pathname = url.pathname;
    if (pathname === STATE_ROUTE) {
      await handleState(req, res, url);
      return true;
    }
    if (pathname === EDIT_ROUTE) {
      await handleEdit(req, res, url);
      return true;
    }
    if (pathname === EXPORT_ROUTE) {
      await handleExport(req, res, url);
      return true;
    }
    if (pathname === DOWNLOAD_ROUTE) {
      await handleDownload(req, res, url);
      return true;
    }
    if (pathname.startsWith(PROPOSAL_ROUTE_PREFIX + "/")) {
      const rest = pathname.slice(PROPOSAL_ROUTE_PREFIX.length + 1);
      const m = rest.match(/^([^/]+)\/decide$/);
      if (m) {
        await handleProposalDecide(req, res, url, decodeURIComponent(m[1]));
        return true;
      }
      sendJson(res, 404, { ok: false, code: Err.PROPOSAL_NOT_FOUND, message: "route not found", fields: {} });
      return true;
    }
    return false;
  };
}

// src/host/routes.ts
function safeWrap(ctx, dispatch) {
  return (req, res) => {
    dispatch(req, res).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.logger?.(PLUGIN)?.error?.("galley route handler error: %s", msg);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, code: "GALLEY_EXPORT_FAILED", message: msg, fields: {} }));
        }
      } catch {
      }
    });
  };
}
function registerGalleyRoutes(ctx, deps) {
  const dispatch = createGalleyHttpDispatcher(deps);
  const handler = safeWrap(ctx, dispatch);
  const unregisterState = ctx.webServer.register({
    kind: "exact",
    path: STATE_ROUTE,
    handler
  });
  ctx.effect(() => unregisterState, "galley: /api/galley/state route");
  const unregisterEdit = ctx.webServer.register({
    kind: "exact",
    path: EDIT_ROUTE,
    handler
  });
  ctx.effect(() => unregisterEdit, "galley: /api/galley/edit route");
  const unregisterExport = ctx.webServer.register({
    kind: "exact",
    path: EXPORT_ROUTE,
    handler
  });
  ctx.effect(() => unregisterExport, "galley: /api/galley/export route");
  const unregisterDownload = ctx.webServer.register({
    kind: "exact",
    path: DOWNLOAD_ROUTE,
    handler
  });
  ctx.effect(() => unregisterDownload, "galley: /api/galley/download route");
  const unregisterProposal = ctx.webServer.register({
    kind: "prefix",
    path: PROPOSAL_ROUTE_PREFIX,
    handler
  });
  ctx.effect(() => unregisterProposal, "galley: /api/galley/proposal prefix route");
}

// src/host/index.ts
var name = PLUGIN;
var inject = ["tools"];
var SAMPLE_BLOCKS = [
  { id: "b1", kind: "header", text: "Arbeitsblatt \xB7 Druck und Satz" },
  { id: "b2", kind: "heading", level: 1, text: "Galley Proof" },
  {
    id: "b3",
    kind: "prose",
    text: 'Hello from the native Typst arm. This paragraph contains markup metacharacters that must stay inert: # $ [ ] { } _ ^ | and a quote "here" plus a backslash here.'
  },
  { id: "b4", kind: "task", text: "Aufgabe: prove the dual face loads." },
  { id: "b5", kind: "answer", text: "L\xF6sung: the host compiled and the pane rendered the SVG." }
];
var nativeCompilerPromise = null;
function renderTypstNative(source) {
  const t0 = Date.now();
  if (!nativeCompilerPromise) {
    nativeCompilerPromise = import("@myriaddreamin/typst-ts-node-compiler");
  }
  return nativeCompilerPromise.then((mod) => {
    const { NodeCompiler } = mod;
    const c = NodeCompiler.create();
    const r = c.compile({ mainFileContent: source });
    if (r.hasError()) {
      const d = r.takeDiagnostics();
      const msg = (d?.shortDiagnostics ?? []).map((x) => x.message).join(" | ");
      throw new Error(`GALLEY_TYPST_COMPILE_ERROR: ${msg || "unknown"}`);
    }
    const pdf = c.pdf(r.result);
    const svg = c.svg(r.result);
    return {
      ok: true,
      arm: "native",
      typst: "0.14.2",
      pages: r.result.numOfPages,
      pdfBytes: pdf.length,
      svgBytes: typeof svg === "string" ? svg.length : svg.length,
      ms: Date.now() - t0
    };
  });
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function toolErrorResult(error) {
  return { ok: false, error: errorMessage(error) };
}
function renderJson(_args, value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "bytes" in value) {
    const { bytes: _omit, ...compact } = value;
    return [{ type: "text", text: JSON.stringify(compact, null, 2) }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
var armPromise = null;
function getArm() {
  if (!armPromise) armPromise = createPrimaryArm().then((r) => r.arm);
  return armPromise;
}
async function getDepsForCwd(cwdParam) {
  const arm = await getArm();
  const { store, root, cwd } = getStoreForCwd(cwdParam);
  return {
    root,
    cwd,
    deps: {
      store,
      cwd,
      registry: defaultGalleyRegistry,
      render: (sheet, packet, assetBytes) => arm.render(sheet, packet, assetBytes)
    }
  };
}
async function getToolDeps(args, exec) {
  const explicitCwd = typeof args.cwd === "string" ? args.cwd : void 0;
  const sessionCwd = exec?.agent?.session?.header?.cwd;
  const resolved = resolveGalleyCwd(explicitCwd, sessionCwd);
  const { deps } = await getDepsForCwd(resolved);
  return deps;
}
function registerGalleyTools(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const register = (def) => {
    try {
      disposers.push(tools.register(def));
    } catch (error) {
      ctx.logger?.(PLUGIN)?.warn?.("tool registration failed: %s", errorMessage(error));
    }
  };
  const out = (props) => ({
    schema: { type: "object", additionalProperties: true, properties: props },
    render: renderJson
  });
  register({
    name: "galley_open",
    description: "Open (create) a new galley packet or switch to an existing packet via `id`. It becomes the active packet and returns a compact receipt (packetId, rev, per-sheet block outlines, per-sheet proofs) \u2014 never the full block bodies.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        id: { type: "string", description: "Switch active packet to an existing packetId (exclusive with create fields)." },
        template: {
          type: "string",
          description: 'Built-in ("arbeitsblatt" | "rfc" | "generic") or custom/plugin template id.'
        },
        title: { type: "string" },
        orientation: { type: "string", enum: ["portrait", "landscape"] },
        targetPages: { type: "integer" },
        blocks: {
          type: "array",
          description: "Initial blocks (type + body + optional slot/level/\u2026 per spec 01).",
          items: { type: "object", additionalProperties: true }
        },
        assets: {
          type: "array",
          description: "Assets to stage for this packet (metadata; the pane uploads the bytes). Max 20.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              path: { type: "string" },
              mimeType: { type: "string" },
              size: { type: "integer" }
            },
            required: ["id", "path", "mimeType"]
          }
        }
      }
    },
    output: out({
      ok: { type: "boolean" },
      packetId: { type: "string" },
      rev: { type: "integer" },
      blocks: { type: "object" },
      proofs: { type: "object" }
    }),
    async execute(args, exec) {
      try {
        const a = args.id !== void 0 ? args : { ...args, origin: "agent" };
        return await galleyOpen(await getToolDeps(args, exec), a);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  register({
    name: "galley_status",
    description: "Report a packet\u2019s current revision, block outlines (never full bodies), pending proposals / unresolved annotations, and a fresh proof receipt per sheet. Omit packetId to use the active packet.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        packetId: { type: "string", description: "Omit to use the active packet." },
        sheetId: { type: "string" }
      }
    },
    output: out({
      ok: { type: "boolean" },
      packetId: { type: "string" },
      rev: { type: "integer" },
      blocks: { type: "object" },
      proofs: { type: "object" }
    }),
    async execute(args, exec) {
      try {
        return await galleyStatus(await getToolDeps(args, exec), args);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  register({
    name: "galley_read_block",
    description: "Read one or more blocks with their neighbors, dependency edges, dependents, and annotations. Pass blockId for a single block or blockIds (array) for a batch. Omit packetId to use the active packet.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        packetId: { type: "string", description: "Omit to use the active packet." },
        blockId: { type: "string" },
        blockIds: { type: "array", items: { type: "string" }, description: "Batch: several block ids at once." }
      }
    },
    output: out({ ok: { type: "boolean" }, packetId: { type: "string" }, blocks: { type: "array", items: { type: "object", additionalProperties: true } } }),
    async execute(args, exec) {
      try {
        return await galleyReadBlock(await getToolDeps(args, exec), args);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  register({
    name: "galley_edit_block",
    description: "The single writer: insert / patch / move / remove one block (spec 02 \xA74.4). patch + remove + move require blockId + baseHash (optimistic lock). A human patch records a pending proposal.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        packetId: { type: "string", description: "Omit to use the active packet." },
        sheetId: { type: "string", description: "Optional: auto-resolved from blockId or active sheet when omitted." },
        op: { type: "string", enum: ["insert", "patch", "move", "remove"] },
        beforeId: { type: "string" },
        block: { type: "object", additionalProperties: true },
        blockId: { type: "string" },
        baseHash: { type: "string", description: "Optional optimistic-lock hash; checked when supplied." },
        patch: { type: "object", additionalProperties: true },
        toSheetId: { type: "string", description: "Optional target sheet for cross-sheet move." },
        toBeforeId: { type: "string" },
        toAfterId: { type: "string" }
      },
      required: ["op"]
    },
    output: out({
      ok: { type: "boolean" },
      applied: { type: "boolean" },
      packetId: { type: "string" },
      rev: { type: "integer" },
      staleDependents: { type: "array", items: { type: "string" } }
    }),
    async execute(args, exec) {
      try {
        const a = { ...args, origin: "agent" };
        return await galleyEditBlock(await getToolDeps(args, exec), a);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  register({
    name: "galley_annotate",
    description: "Add / list / resolve / unresolve a margin note (Randnotiz) anchored to a block.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        packetId: { type: "string", description: "Omit to use the active packet." },
        blockId: { type: "string" },
        action: { type: "string", enum: ["add", "list", "resolve", "unresolve"] },
        body: {},
        annotationId: { type: "string" }
      },
      required: ["blockId", "action"]
    },
    output: out({ ok: { type: "boolean" }, annotations: { type: "array", items: { type: "object", additionalProperties: true } } }),
    async execute(args, exec) {
      try {
        const a = { ...args, author: "agent" };
        return await galleyAnnotate(await getToolDeps(args, exec), a);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  register({
    name: "galley_export",
    description: "Export a sheet to typ / md / tex (pure) or pdf (via the render arm). Omit packetId to use the active packet. docx is not available until M4 (fails with GALLEY_EXPORT_FAILED).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Optional project working directory (defaults to session cwd)." },
        packetId: { type: "string", description: "Omit to use the active packet." },
        format: { type: "string", enum: ["typ", "md", "tex", "pdf", "docx"] },
        sheetId: { type: "string" },
        sheetIds: { type: "array", items: { type: "string" } }
      },
      required: ["format"]
    },
    output: out({
      ok: { type: "boolean" },
      format: { type: "string" },
      files: { type: "array", items: { type: "object", additionalProperties: true } }
    }),
    async execute(args, exec) {
      try {
        const deps = await getToolDeps(args, exec);
        const exportArgs = {
          ...args,
          outDir: deps.cwd
        };
        return await galleyExport(deps, exportArgs);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  });
  return () => {
    for (const d of disposers) d();
  };
}
function registerHealthRoute(ctx) {
  const unregister = ctx.webServer.register({
    kind: "exact",
    path: HEALTH_ROUTE,
    handler: (req, res) => {
      if (req.method !== "GET") {
        send(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      renderTypstNative(renderTypstSource(SAMPLE_BLOCKS)).then((receipt) => {
        send(res, 200, {
          ok: true,
          name: PLUGIN,
          version: VERSION,
          arm: receipt.arm,
          typst: receipt.typst,
          sample: { pages: receipt.pages, pdfBytes: receipt.pdfBytes, svgBytes: receipt.svgBytes, ms: receipt.ms },
          time: (/* @__PURE__ */ new Date()).toISOString()
        });
      }).catch((error) => {
        send(res, 500, { ok: false, name: PLUGIN, version: VERSION, error: errorMessage(error) });
      });
    }
  });
  ctx.effect(() => unregister, "galley: /api/galley/health route");
}
function apply(ctx) {
  try {
    if (typeof ctx.provide === "function") {
      const withdraw = ctx.provide("galley", defaultGalleyRegistry.toCordisService());
      if (typeof withdraw === "function") {
        ctx.effect(() => withdraw, "galley: cordis service");
      }
    }
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.("galley service registration failed: %s", errorMessage(error));
  }
  try {
    const disposeTools = registerGalleyTools(ctx);
    ctx.effect(() => disposeTools, "galley: tools");
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.("tool registration failed (continuing without it): %s", errorMessage(error));
  }
  ctx.inject(["webServer"], (webCtx) => {
    try {
      registerHealthRoute(webCtx);
      registerGalleyRoutes(webCtx, { getDepsForCwd, registry: defaultGalleyRegistry });
    } catch (error) {
      webCtx.logger?.(PLUGIN)?.error?.("route registration failed: %s", errorMessage(error));
    }
  });
}
export {
  CliArm,
  DOWNLOAD_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  GalleyServiceRegistry,
  HEALTH_ROUTE,
  NativeArm,
  PLUGIN,
  PROPOSAL_ROUTE_PREFIX,
  STATE_ROUTE,
  VERSION,
  WasmArm,
  apply,
  createArm,
  createPrimaryArm,
  defaultGalleyRegistry,
  inject,
  name,
  registerGalleyTools,
  renderTypstNative
};
//# sourceMappingURL=index.js.map
