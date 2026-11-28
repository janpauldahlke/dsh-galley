// src/shared/i18n.ts
var GALLEY_I18N = {
  en: {
    print: {
      typstLang: "en",
      headerEyebrow: "DOCUMENT",
      groupPrefix: "Group: ",
      namePrefix: "Name: ",
      taskPrefix: "Task",
      calloutLabels: {
        info: "Info",
        hint: "Hint",
        warning: "Warning"
      }
    },
    preflight: {
      staleMissingOrigin: (id, origin) => `Block ${id} references removed block ${origin}`,
      staleChangedOrigin: (id, origin) => `Block ${id} is stale (origin ${origin} changed)`,
      unansweredTask: (id) => `Task ${id} has no linked answer (dependsOn) on a follow-up sheet`,
      pageOverflow: (title, target, overflow) => `Sheet "${title}" exceeds target (${target}p) by +${overflow} lines`,
      sourceLineWrap: (id, line, len) => `Source text ${id}: line ${line} (${len} chars) may soft-wrap and shift marginal line numbers`,
      unknownHeaderFields: (id, keys) => `Header ${id} ignored unsupported field(s): ${keys.join(", ")} (supported: title, subtitle, subject/fach, meta/klasse, date/datum, name)`,
      emptyHeaderTitle: (id) => `Header ${id} has an empty title (set fields.title)`,
      preflightInternal: (checkId, err) => `Preflight check "${checkId}" failed internally: ${err}`
    },
    ui: {
      packet: "Packet",
      packets: "Packets",
      sheet: "Sheet",
      sheets: "Sheets",
      addSheet: "+ Sheet",
      proof: "Galley Proof",
      blocks: "Blocks",
      addBlock: "+ Add Block",
      noBlocksYet: 'No blocks on this sheet yet \u2014 click "+ Add Block" to start.',
      template: "Template",
      saveAsTemplate: "\u2605 Save as Template",
      overflowOverTarget: (lines, tp) => `+${lines} lines over ${tp} ${tp === 1 ? "page" : "pages"}`,
      overflowGeneric: (lines) => `+${lines} lines overflow`,
      overflowHint: "Trim text or raise target pages"
    }
  },
  // Stubbed German bundle (used for `locale: 'de'` print labels on German domain templates;
  // UI strings reserved until host/user locale wiring is finalized).
  de: {
    print: {
      typstLang: "de",
      headerEyebrow: "TITEL",
      groupPrefix: "Klasse: ",
      namePrefix: "Name: ",
      taskPrefix: "Aufgabe",
      calloutLabels: {
        info: "Info",
        hint: "Tipp",
        warning: "Achtung"
      }
    },
    preflight: {
      staleMissingOrigin: (id, origin) => `Block ${id} verweist auf entfernten Block ${origin}`,
      staleChangedOrigin: (id, origin) => `Block ${id} ist veraltet (Ursprung ${origin} wurde ge\xE4ndert)`,
      unansweredTask: (id) => `Aufgabe ${id} hat noch keine verkn\xFCpfte L\xF6sung (dependsOn) auf einem Folgebogen`,
      pageOverflow: (title, target, overflow) => `Bogen "${title}" \xFCberschreitet Ziel (${target} S.) um +${overflow} Zeilen`,
      sourceLineWrap: (id, line, len) => `Quellentext ${id}: Zeile ${line} (${len} Zeichen) bricht ggf. um und verschiebt nachfolgende Randzeilennummern`,
      unknownHeaderFields: (id, keys) => `Kopfbereich ${id} ignoriert unbekannte Felder: ${keys.join(", ")} (unterst\xFCtzt: title/titel, subtitle/untertitel, subject/fach, meta/klasse, date/datum, name)`,
      emptyHeaderTitle: (id) => `Kopfbereich ${id} hat keinen Titel (fields.title / fields.titel setzen)`,
      preflightInternal: (checkId, err) => `Vorabpr\xFCfung "${checkId}" intern fehlgeschlagen: ${err}`
    },
    ui: {
      packet: "Mappe",
      packets: "Mappen",
      sheet: "Bogen",
      sheets: "B\xF6gen",
      addSheet: "+ Bogen",
      proof: "Fahnenabzug",
      blocks: "Bl\xF6cke",
      addBlock: "+ Block anf\xFCgen",
      noBlocksYet: "Noch keine Bl\xF6cke auf diesem Bogen \u2014 \xFCber \u201E+ Block anf\xFCgen\u201C starten.",
      template: "Vorlage",
      saveAsTemplate: "\u2605 Als Vorlage speichern",
      overflowOverTarget: (lines, tp) => `+${lines} Zeilen \xFCber ${tp} ${tp === 1 ? "Seite" : "Seiten"}`,
      overflowGeneric: (lines) => `+${lines} Zeilen \xDCberlauf`,
      overflowHint: "Text k\xFCrzen oder Zielseiten erh\xF6hen"
    }
  }
};
function getGalleyStrings(locale) {
  if (locale === "de") return GALLEY_I18N.de;
  return GALLEY_I18N.en;
}

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
  lines.push(`#set text(size: ${opts.sizePt ?? 11}pt, font: ("Liberation Sans", "Liberation Serif", "Libertinus Serif"), lang: "en")`);
  lines.push(`#show raw: set text(font: ("Liberation Mono", "DejaVu Sans Mono"))`);
  lines.push(`#show math.equation: set text(font: ("New Computer Modern Math", "Noto Sans Math"))`);
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
        parts.push(" \\ ");
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
  return `#place(rect(width: 0.001pt, height: 0.001pt, fill: rgb(${i + 1 & 255}, 0, 0)))`;
}
var CALLOUT_TONES = {
  info: { fill: "rgb(232, 240, 254)", accent: "rgb(26, 115, 232)" },
  hint: { fill: "rgb(230, 244, 234)", accent: "rgb(24, 128, 56)" },
  warning: { fill: "rgb(252, 232, 230)", accent: "rgb(217, 48, 37)" }
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
    case "media-below": {
      const img = slot.asset ? mediaImage(assets, slot.asset.id, slot.asset.widthCm) : "";
      if (!img) return body;
      if (!body.trim()) return `#align(center)[${img}]`;
      return `#stack(dir: ttb, spacing: 8pt, [${body}], align(center)[${img}])`;
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
function blockTypst(block, index, assets, taskNum, locale) {
  const pStr = getGalleyStrings(locale).print;
  const lines = [markerComment(block.id), anchorRect(index)];
  switch (block.type) {
    case "header": {
      const f = block.fields ?? {};
      const meta = [];
      if (f.fach) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.fach)})`);
      if (f.klasse) {
        const groupText = f.klasse.includes(":") ? f.klasse : `${pStr.groupPrefix}${f.klasse}`;
        meta.push(`#text(size: 9pt, fill: luma(110), ${typString(groupText)})`);
      }
      if (f.datum) meta.push(`#text(size: 9pt, fill: luma(110), ${typString(f.datum)})`);
      const right = `[${meta.length ? meta.join("#linebreak()") : ""}]`;
      const left = [];
      if (f.titel) left.push(`#text(size: 17pt, weight: "bold", ${typString(f.titel)})`);
      if (f.subtitle) left.push(`#text(size: 10.5pt, fill: luma(85), ${typString(f.subtitle)})`);
      if (f.name !== void 0) {
        const nameVal = f.name.trim() ? f.name : "________________________";
        left.push(`#text(size: 9pt, fill: luma(110), ${typString(pStr.namePrefix + nameVal)})`);
      }
      lines.push(
        `#grid(columns: (1fr, auto), column-gutter: 12pt, align: (top, top))[${left.length ? `${left.join("#linebreak()")}#linebreak()` : ""}]${right}`,
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
        const stateKey = typString(`g_ln_${block.id}_${index}`);
        const kExpr = startOff === 0 ? `(if f == none { 1 } else { n - f + 1 })` : `((if f == none { 1 } else { n - f + 1 }) + ${startOff})`;
        lines.push(
          `#[`,
          `#let _gln = state(${stateKey}, none)`,
          `#set par.line(numbering: n => context { let f = _gln.get(); let k = ${kExpr}; if f == none { _gln.update(n) }; if calc.rem(k, ${every}) == 0 { text(size: 8pt, fill: luma(110))[#k] } }, numbering-scope: "document")`,
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
      if (block.provenance?.citation) {
        const attr = block.provenance.locator ? `${block.provenance.citation}, ${block.provenance.locator}` : block.provenance.citation;
        lines.push("", `#emph[#text(size: 8.5pt, fill: luma(100), ${typString("\u2014 " + attr)})]`);
      }
      break;
    }
    case "task": {
      const firstNode = block.body?.[0];
      const leadingText = firstNode?.t === "text" ? firstNode.v : firstNode?.t === "strong" && firstNode.c?.[0]?.t === "text" ? firstNode.c[0].v : "";
      if (/^\s*(?:Task|Problem|Question|Exercise|Aufgabe)\s+\d+\b/i.test(leadingText)) {
        lines.push(inlineToContent(block.body));
      } else {
        const prefixLabel = taskNum ? `${pStr.taskPrefix} ${taskNum}` : pStr.taskPrefix;
        lines.push(`#text(weight: "bold", ${typString(prefixLabel)}) ${inlineToContent(block.body)}`);
      }
      break;
    }
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
      let columnsSpec = String(cols);
      if (Array.isArray(block.colWidths) && block.colWidths.length > 0) {
        const safeSpecs = [];
        for (let ci = 0; ci < cols; ci++) {
          const w = block.colWidths[ci];
          if (typeof w === "number" && Number.isFinite(w) && w > 0) {
            safeSpecs.push(`${w}fr`);
          } else if (typeof w === "string" && /^(\d+(\.\d+)?(%|fr|pt|cm|mm|em)|auto)$/.test(w.trim())) {
            safeSpecs.push(w.trim());
          } else {
            safeSpecs.push("1fr");
          }
        }
        columnsSpec = `(${safeSpecs.join(", ")})`;
      }
      const tableArgs = [
        `columns: ${columnsSpec}`,
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
      const tone = block.tone ?? "info";
      const t = CALLOUT_TONES[tone];
      const toneLabel = pStr.calloutLabels[tone] ?? tone;
      lines.push(
        `#block(width: 100%, inset: 8pt, fill: ${t.fill}, stroke: (left: 3pt + ${t.accent}))[`,
        `#text(size: 8pt, weight: "bold", fill: ${t.accent}, ${typString(toneLabel)})`,
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
function preamble(sheet, locale) {
  const g = sheet.geometry;
  const m = g.margin;
  const isLandscape = g.orientation === "landscape";
  const typstLang = getGalleyStrings(locale).print.typstLang;
  const L = [];
  L.push(
    `// galley preamble \u2014 sheet ${sheet.id} "${sheet.title}" (${g.paper}${isLandscape ? " landscape" : ""}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} cm)`
  );
  const flippedArg = isLandscape ? ", flipped: true" : "";
  L.push(`#set page(paper: ${typString(g.paper)}${flippedArg}, margin: (top: ${m.top}cm, bottom: ${m.bottom}cm, left: ${m.left}cm, right: ${m.right}cm))`);
  L.push(`#set text(size: 10pt, font: ("Liberation Sans", "Liberation Serif", "Libertinus Serif"), lang: ${typString(typstLang)})`);
  L.push(`#show raw: set text(font: ("Liberation Mono", "DejaVu Sans Mono"))`);
  L.push(`#show math.equation: set text(font: ("New Computer Modern Math", "Noto Sans Math"))`);
  L.push(`#set par(justify: true, leading: 0.75em)`);
  L.push(`#set heading(numbering: none)`);
  const firstBlk = sheet.blocks[0];
  const hasOwnBanner = sheet.blocks.some((b) => b.type === "header") || firstBlk?.type === "heading" && (firstBlk.level ?? 1) === 1;
  if (!hasOwnBanner) {
    L.push(`#title(${typString(sheet.title)})`);
  }
  return L;
}
function compileSheet(sheet, assets, locale) {
  const rawDim = PAPER_PT[sheet.geometry.paper];
  const isLandscape = sheet.geometry.orientation === "landscape";
  const pageWidthPt = isLandscape ? rawDim.h : rawDim.w;
  const pageHeightPt = isLandscape ? rawDim.w : rawDim.h;
  const lines = [...preamble(sheet, locale), ""];
  const anchors = [];
  let taskCount = 0;
  sheet.blocks.forEach((block, i) => {
    if (block.type === "task") taskCount += 1;
    lines.push(blockTypst(block, i, assets, block.type === "task" ? taskCount : void 0, locale));
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
function parseSvgPositions(svg) {
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>/g;
  const stack = [];
  const textYs = [];
  const shapes = [];
  let m;
  while ((m = re.exec(svg)) !== null) {
    const closing = m[1] === "/";
    const name = m[2];
    const attrs = m[3] || "";
    const selfClose = /\/\s*>/.test(attrs.trimEnd());
    if (closing) {
      stack.pop();
      continue;
    }
    let x = 0;
    let y = 0;
    let sx = 1;
    let sy = 1;
    const tr = attrs.match(/transform="([^"]*)"/);
    if (tr) {
      const t = tr[1].match(/translate\(([-\d.]+)[,\s]+([-\d.]+)\)/);
      const sc = tr[1].match(/scale\(([-\d.]+)[,\s]+([-\d.]+)\)/);
      if (t) {
        x = +t[1];
        y = +t[2];
      }
      if (sc) {
        sx = +sc[1];
        sy = +sc[2];
      }
    }
    const p = stack[stack.length - 1];
    const ax = (p ? p.ax : 0) + (p ? p.sx : 1) * x;
    const ay = (p ? p.ay : 0) + (p ? p.sy : 1) * y;
    if (name === "g" && /class="typst-text"/.test(attrs)) {
      textYs.push(Math.round(ay * 100) / 100);
    } else if (name === "path" && /class="typst-shape"/.test(attrs)) {
      const fill = attrs.match(/fill="([^"]+)"/);
      if (fill) shapes.push({ hex: fill[1], ay: Math.round(ay * 100) / 100 });
    }
    if (!selfClose) stack.push({ ax, ay, sx, sy });
  }
  return { textYs, shapes };
}
function clusterLines(ys, tol = 2.5) {
  if (ys.length === 0) return [];
  const sorted = [...ys].sort((a, b) => a - b);
  const out = [];
  for (const y of sorted) {
    if (out.length === 0 || y - out[out.length - 1] > tol) out.push(y);
  }
  return out;
}
function countVisualLinesInSvgSlice(svgSlice) {
  const re = /<(\/?)g\b((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>/g;
  const stack = [];
  const textYs = [];
  let m;
  while ((m = re.exec(svgSlice)) !== null) {
    const closing = m[1] === "/";
    const attrs = m[2] || "";
    const selfClose = /\/\s*>$/.test(m[0]);
    if (closing) {
      stack.pop();
      continue;
    }
    let y = 0;
    let sy = 1;
    const isPageRoot = /\bclass="typst-page"/.test(attrs);
    const tr = !isPageRoot ? attrs.match(/transform="([^"]*)"/) : null;
    if (tr) {
      const t = tr[1].match(/translate\(([-\d.]+)[,\s]+([-\d.]+)\)/);
      const sc = tr[1].match(/scale\(([-\d.]+)[,\s]+([-\d.]+)\)/);
      if (t) y = +t[2];
      if (sc) sy = +sc[2];
    }
    const parent = stack[stack.length - 1];
    const ay = (parent ? parent.ay : 0) + (parent ? parent.sy : 1) * y;
    if (/\bclass="typst-text"/.test(attrs)) {
      textYs.push(Math.round(ay * 100) / 100);
    }
    if (!selfClose) {
      stack.push({ ay, sy: (parent ? parent.sy : 1) * sy });
    }
  }
  return clusterLines(textYs, 2.5).length;
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
  if (pageStarts.length === 0) {
    linesPerPage[0] = countVisualLinesInSvgSlice(svg);
  } else {
    const closeSvg = svg.lastIndexOf("</svg>");
    const endBound = closeSvg > pageStarts[0] ? closeSvg : svg.length;
    for (let p = 0; p < pageStarts.length; p++) {
      const start = pageStarts[p];
      const end = p + 1 < pageStarts.length ? pageStarts[p + 1] : endBound;
      linesPerPage[p] = countVisualLinesInSvgSlice(svg.slice(start, end));
    }
  }
  const anchors = [];
  const pathRe = /<path\b((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let tm;
  while ((tm = pathRe.exec(svg)) !== null) {
    const attrs = tm[1] || "";
    if (/class="typst-shape"/.test(attrs)) {
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
export {
  PAPER_PT,
  PT_PER_CM,
  anchorHexFor,
  blockToTypst,
  blockTypst,
  clusterLines,
  compileSheet,
  deriveReceipt,
  mapDiagnosticsToBlocks,
  markerComment,
  parseCliDiagnostics,
  parseSvgPages,
  parseSvgPositions,
  renderTypstSource,
  splitSvgPages,
  typString,
  typstStringLiteral
};
//# sourceMappingURL=typst-render.mjs.map
