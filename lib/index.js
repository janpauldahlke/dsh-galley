// src/host/index.ts
import { join as join4 } from "node:path";

// src/shared/types.ts
var PLUGIN = "dsh-galley";
var VERSION = "0.1.0";
var HEALTH_ROUTE = "/api/galley/health";

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
  const L = [];
  L.push(`// galley preamble \u2014 sheet ${sheet.id} "${sheet.title}" (${g.paper}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} cm)`);
  L.push(`#set page(paper: ${typString(g.paper)}, margin: (top: ${m.top}cm, bottom: ${m.bottom}cm, left: ${m.left}cm, right: ${m.right}cm))`);
  L.push(`#set text(size: 10pt, lang: "de")`);
  L.push(`#set par(justify: true, leading: 0.75em)`);
  L.push(`#set heading(numbering: none)`);
  if (!sheet.blocks.some((b) => b.type === "header")) {
    L.push(`#title(${typString(sheet.title)})`);
  }
  return L;
}
function compileSheet(sheet, assets) {
  const dim = PAPER_PT[sheet.geometry.paper];
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
    pageHeightPt: dim.h,
    pageWidthPt: dim.w,
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

// src/host/store.ts
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync
} from "node:fs";
import { join, basename, dirname } from "node:path";
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
    this.root = root ?? join(process.cwd(), ".dsh", "galley");
  }
  dir(id) {
    return join(this.root, id);
  }
  packetPath(id) {
    return join(this.dir(id), "packet.json");
  }
  journalPath(id) {
    return join(this.dir(id), "journal.json");
  }
  undoPath(id) {
    return join(this.dir(id), "undo.json");
  }
  create(packet) {
    const dir = this.dir(packet.id);
    mkdirSync(dir, { recursive: true });
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
    if (!existsSync(p)) return null;
    const packet = JSON.parse(readFileSync(p, "utf8"));
    recomputeStale(packet);
    return packet;
  }
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, "packet.json"))).map((e) => {
      const p = this.load(e.name);
      return { id: p.id, title: p.title, rev: p.rev, updatedAt: p.updatedAt };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
  delete(id) {
    const dir = this.dir(id);
    if (!existsSync(dir)) throw new StoreError("not_found", `packet ${id} not found`);
    if (this.getActivePacket() === id) this.clearActivePacket();
    rmSync(dir, { recursive: true, force: true });
  }
  // ── active packet (M1.5 H4): the packet tools operate on by default ──────
  // Persisted per-store (single file) so a headless tool session can omit
  // `packetId` and address the most recently opened/active packet.
  activePath() {
    return join(this.root, "active.json");
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
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    return { packet, rev: packet.rev, changeHash };
  }
  /** Pop the last snapshot and restore it (rev is preserved, no bump). */
  undo(id) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const undo = this.readJson(this.undoPath(id), []);
    if (undo.length === 0) throw new StoreError("no_undo", `no undo history for ${id}`);
    const prev = undo.pop();
    this.atomicWrite(this.undoPath(id), JSON.stringify(undo));
    prev.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    recomputeStale(prev);
    this.atomicWrite(this.packetPath(id), JSON.stringify(prev, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({ rev: prev.rev, at: prev.updatedAt, note: "undo" });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return { packet: prev, rev: prev.rev };
  }
  undoDepth(id) {
    return this.readJson(this.undoPath(id), []).length;
  }
  // ── proposals + annotations (stored inside the packet file) ──────────────
  addProposal(id, proposal) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    packet._proposals = [
      ...this.readJson(join(this.dir(id), "proposals.json"), []),
      proposal
    ];
    this.atomicWrite(join(this.dir(id), "proposals.json"), JSON.stringify(packet._proposals));
    return proposal;
  }
  listProposals(id) {
    return this.readJson(join(this.dir(id), "proposals.json"), []);
  }
  setProposalStatus(id, proposalId, status) {
    const list = this.listProposals(id);
    const p = list.find((x) => x.id === proposalId);
    if (!p) return null;
    p.status = status;
    this.atomicWrite(join(this.dir(id), "proposals.json"), JSON.stringify(list));
    return p;
  }
  /**
   * Accept a proposal (spec 01 §7): apply its patch to the target block as an
   * agent-origin write (the human re-claimed it, so the block becomes agent's),
   * refresh hashes + staleness, and mark it applied. Throws
   * StoreError('proposal_not_found') if the id is unknown, or 'conflict' if the
   * block changed since the proposal was recorded.
   */
  applyProposal(id, proposalId) {
    const proposal = this.listProposals(id).find((p) => p.id === proposalId);
    if (!proposal) throw new StoreError("proposal_not_found", `proposal ${proposalId} not found`);
    this.commit(
      id,
      { blockId: proposal.targetBlockId, baseHash: proposal.baseHash },
      (p) => {
        const sheet = Object.values(p.sheets).find((s) => s.blocks.some((b2) => b2.id === proposal.targetBlockId));
        if (!sheet) throw new StoreError("not_found", `block ${proposal.targetBlockId} not found`);
        const b = sheet.blocks.find((x) => x.id === proposal.targetBlockId);
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
        b.origin = "agent";
        return proposal.targetBlockId;
      }
    );
    const updated = this.setProposalStatus(id, proposalId, "accepted");
    return updated;
  }
  addAnnotation(id, annotation) {
    const list = this.readJson(join(this.dir(id), "annotations.json"), []);
    list.push(annotation);
    this.atomicWrite(join(this.dir(id), "annotations.json"), JSON.stringify(list));
    return annotation;
  }
  listAnnotations(id, blockId) {
    const list = this.readJson(join(this.dir(id), "annotations.json"), []);
    return blockId ? list.filter((a) => a.blockId === blockId) : list;
  }
  setAnnotationResolved(id, annotationId, resolved) {
    const list = this.listAnnotations(id);
    const a = list.find((x) => x.id === annotationId);
    if (!a) return null;
    a.resolved = resolved;
    this.atomicWrite(join(this.dir(id), "annotations.json"), JSON.stringify(list));
    return a;
  }
  // ── assets (metadata in packet; bytes in assets/ dir) ─────────────────────
  addAsset(id, meta, bytes) {
    const packet = this.load(id);
    if (Object.keys(packet.assets ?? {}).length >= MAX_ASSETS_PER_PACKET) {
      throw new StoreError("asset_limit", `packet ${id} already holds ${MAX_ASSETS_PER_PACKET} assets`);
    }
    const assetsDir = join(this.dir(id), "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, basename(meta.path)), bytes);
    packet.assets = { ...packet.assets ?? {}, [meta.id]: meta };
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
    const p = join(this.dir(id), meta.path);
    return existsSync(p) ? readFileSync(p) : null;
  }
  // ── atomic write (spec 01 §9): temp → fsync → rename ─────────────────────
  atomicWrite(path, data) {
    mkdirSync(dirname(path), { recursive: true });
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
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return fallback;
    }
  }
};

// src/host/arms/native.ts
import { join as join2 } from "node:path";
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
    return {
      sheetId: sheet.id,
      pdf: out.pdf,
      svgPages: [Buffer.from(out.svg, "utf8")],
      svg: out.svg,
      pages: out.pages,
      perPage: Array.from({ length: out.pages }, () => ({ wPt: cs.pageWidthPt, hPt: cs.pageHeightPt })),
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
  workspace = join2(tmpdir(), "dsh-galley-native-ws");
  async init() {
    if (this.compiler) return;
    const mod = await import("@myriaddreamin/typst-ts-node-compiler");
    this.compiler = mod.NodeCompiler.create({ workspace: this.workspace });
  }
  compileTyp(typ, shadows) {
    const c = this.compiler;
    if (!c) throw new ArmError("native arm not initialized");
    if (shadows && shadows.length) {
      for (const s of shadows) c.mapShadow(join2(this.workspace, s.path), s.bytes);
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
import { writeFileSync as writeFileSync2, readFileSync as readFileSync2, mkdtempSync, rmSync as rmSync2, existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join3, resolve, dirname as dirname2 } from "node:path";
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
    if (!existsSync2(this.bin)) throw new ArmError(`cli binary not found: ${this.bin}`);
    if (!this.dir) this.dir = mkdtempSync(join3(tmpdir2(), "galley-cli-"));
  }
  compileTyp(typ, shadows) {
    if (!this.dir) this.dir = mkdtempSync(join3(tmpdir2(), "galley-cli-"));
    const src = join3(this.dir, "in.typ");
    const pdfOut = join3(this.dir, "out.pdf");
    const svgOut = join3(this.dir, "out.svg");
    for (const s of shadows ?? []) {
      const p = join3(this.dir, s.path);
      mkdirSync2(dirname2(p), { recursive: true });
      writeFileSync2(p, s.bytes);
    }
    writeFileSync2(src, typ, "utf8");
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
    const pdf = readFileSync2(pdfOut);
    const svg = readFileSync2(svgOut, "utf8");
    return { pdf, svg, pages: inferPagesFromSvg(svg), diags };
  }
  /** Clean up the temp dir (call on arm teardown). */
  dispose() {
    if (this.dir && existsSync2(this.dir)) rmSync2(this.dir, { recursive: true, force: true });
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

// src/host/tools.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
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
    if (args.template || args.title || args.blocks || args.targetPages !== void 0 || args.assets) {
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
      sheetOrder: existing.sheetOrder,
      blocks,
      active: true,
      proofs: await computeProofs(deps, existing)
    };
  }
  const template = args.template ?? "generic";
  const seedOrigin = args.origin ?? "human";
  try {
    const id = "p-" + base32(randomBytes(8), 8);
    const sheetId = "s1";
    const sheet = {
      id: sheetId,
      title: args.title ?? (template === "arbeitsblatt" ? "Arbeitsblatt" : "Document"),
      geometry: {
        paper: "a4",
        margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
        targetPages: args.targetPages ?? (template === "arbeitsblatt" ? 1 : void 0)
      },
      blocks: []
    };
    const packet = {
      id,
      template,
      title: args.title ?? (template === "arbeitsblatt" ? "Arbeitsblatt" : "Document"),
      rev: 0,
      createdAt: "",
      updatedAt: "",
      sheetOrder: [sheetId],
      sheets: { [sheetId]: sheet },
      nextBlockSeq: 1,
      nextProposalSeq: 1,
      nextAnnotationSeq: 1,
      nextAssetSeq: 1,
      assets: {}
    };
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
    for (const raw of args.blocks ?? []) {
      const { block, error } = buildBlock(packet, raw, seedOrigin);
      if (error) return fail(toStoreCode(error), `block ${raw.id ?? "?"}: ${error}`);
      sheet.blocks.push(block);
      packet.nextBlockSeq += 1;
    }
    store.create(packet);
    for (const a of args.assets ?? []) {
      const bytes = Buffer.alloc(a.size ?? 0);
      store.addAsset(
        id,
        { id: a.id, path: a.path, bytesSha256: createHash2("sha256").update(bytes).digest("hex"), mimeType: a.mimeType },
        bytes
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
  return {
    ok: true,
    packetId: pid,
    rev: packet.rev,
    title: packet.title,
    template: packet.template,
    sheetOrder: packet.sheetOrder,
    blocks,
    proposals: deps.store.listProposals(pid).filter((p) => p.status === "pending"),
    annotations: deps.store.listAnnotations(pid).filter((a) => !a.resolved),
    proofs: await computeProofs(deps, packet, args.sheetId)
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
  const sheet = packet.sheets[args.sheetId];
  if (!sheet) return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`);
  try {
    const prePatchOrigin = args.op === "patch" ? findBlock(packet, args.blockId)?.block?.origin : void 0;
    if (args.op === "patch" && prePatchOrigin === "human") {
      const target = findBlock(packet, args.blockId);
      if (!target) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`);
      if (args.baseHash && args.baseHash !== target.block.hash) {
        const t = fail(Err.PROPOSAL_CONFLICT, `block ${args.blockId} changed (base hash mismatch)`);
        t.baseHash = args.baseHash;
        t.currentHash = target.block.hash;
        return t;
      }
      const seq = store.listProposals(pid).length + 1;
      const prop = {
        id: `prop-${seq}`,
        targetBlockId: args.blockId,
        baseHash: target.block.hash,
        proposedPatch: args.patch ?? {},
        status: "pending",
        createdAtRev: packet.rev
      };
      store.addProposal(pid, prop);
      const loadedProp = store.load(pid);
      const renderProp = deps.render;
      const proofProp = renderProp ? await (async () => {
        try {
          return toReceipt(await renderProp(loadedProp.sheets[args.sheetId], loadedProp, assetBytesForPacket(deps, loadedProp)), loadedProp);
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
        proposal: { id: prop.id, targetBlockId: prop.targetBlockId, status: "pending" },
        proof: proofProp,
        staleDependents: staleBlockIds(loadedProp)
      };
    }
    const needsExpect = (args.op === "patch" || args.op === "remove" || args.op === "move") && args.baseHash !== void 0;
    let changedId = null;
    let touchedSheetId = args.sheetId;
    store.commit(
      pid,
      needsExpect ? { blockId: args.blockId ?? "", baseHash: args.baseHash } : null,
      (p) => {
        const sh = p.sheets[args.sheetId];
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
            const targetSheet = p.sheets[args.toSheetId ?? args.sheetId];
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
async function galleyExport(deps, args) {
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = deps.store.load(pid);
  const sheetId = args.sheetId ?? packet.sheetOrder[0];
  const sheet = packet.sheets[sheetId];
  if (!sheet) return fail(Err.SHEET_NOT_FOUND, `sheet ${sheetId} not found`);
  if (!["typ", "md", "tex", "pdf", "docx"].includes(args.format)) {
    return fail(Err.INVALID_PARAMS, `unknown export format '${args.format}'`);
  }
  try {
    switch (args.format) {
      case "typ":
        return { ok: true, format: "typ", text: compileSheet(sheet, packet.assets).typ };
      case "md":
        return { ok: true, format: "md", text: toMarkdown(sheet) };
      case "tex":
        return { ok: true, format: "tex", text: toTex(sheet) };
      case "pdf":
        if (!deps.render) return fail(Err.TYPST_COMPILE_ERROR, "no render arm available for pdf");
        const sr = await deps.render(sheet, packet, assetBytesForPacket(deps, packet));
        if (!sr.pdf || sr.pdf.length === 0) return fail(Err.EXPORT_FAILED, "render arm produced no pdf bytes");
        return { ok: true, format: "pdf", bytes: sr.pdf };
      case "docx":
        return fail(Err.EXPORT_FAILED, "docx exporter lands in M4; use pdf or typ");
      default:
        return fail(Err.INVALID_PARAMS, `unknown format`);
    }
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
function renderJson(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
function getStore() {
  return new GalleyStore(process.env.GALLEY_ROOT ?? join4(process.cwd(), ".dsh", "galley"));
}
var armPromise = null;
function getArm() {
  if (!armPromise) armPromise = createPrimaryArm().then((r) => r.arm);
  return armPromise;
}
async function getDeps() {
  const arm = await getArm();
  return {
    store: getStore(),
    render: (sheet, packet, assetBytes) => arm.render(sheet, packet, assetBytes)
  };
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
        id: { type: "string", description: "Switch active packet to an existing packetId (exclusive with create fields)." },
        template: { type: "string", enum: ["arbeitsblatt", "rfc", "generic"] },
        title: { type: "string" },
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
    async execute(args) {
      try {
        const a = args.id !== void 0 ? args : { ...args, origin: "agent" };
        return await galleyOpen(await getDeps(), a);
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
    async execute(args) {
      try {
        return await galleyStatus(await getDeps(), args);
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
        packetId: { type: "string", description: "Omit to use the active packet." },
        blockId: { type: "string" },
        blockIds: { type: "array", items: { type: "string" }, description: "Batch: several block ids at once." }
      }
    },
    output: out({ ok: { type: "boolean" }, packetId: { type: "string" }, blocks: { type: "array" } }),
    async execute(args) {
      try {
        return await galleyReadBlock(await getDeps(), args);
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
        packetId: { type: "string", description: "Omit to use the active packet." },
        sheetId: { type: "string" },
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
      required: ["sheetId", "op"]
    },
    output: out({
      ok: { type: "boolean" },
      packetId: { type: "string" },
      rev: { type: "integer" },
      block: { type: ["object", "null"] },
      proposal: { type: ["object", "null"] },
      proof: { type: ["object", "null"] },
      staleDependents: { type: "array" }
    }),
    async execute(args) {
      try {
        const a = { ...args, origin: "agent" };
        return await galleyEditBlock(await getDeps(), a);
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
        packetId: { type: "string", description: "Omit to use the active packet." },
        blockId: { type: "string" },
        action: { type: "string", enum: ["add", "list", "resolve", "unresolve"] },
        body: {},
        annotationId: { type: "string" }
      },
      required: ["blockId", "action"]
    },
    output: out({ ok: { type: "boolean" }, annotations: { type: "array" } }),
    async execute(args) {
      try {
        const a = { ...args, author: "agent" };
        return await galleyAnnotate(await getDeps(), a);
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
        packetId: { type: "string", description: "Omit to use the active packet." },
        format: { type: "string", enum: ["typ", "md", "tex", "pdf", "docx"] },
        sheetId: { type: "string" }
      },
      required: ["format"]
    },
    output: out({ ok: { type: "boolean" }, format: { type: "string" } }),
    async execute(args) {
      try {
        return await galleyExport(await getDeps(), args);
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
    const disposeTools = registerGalleyTools(ctx);
    ctx.effect(() => disposeTools, "galley: tools");
  } catch (error) {
    ctx.logger?.(PLUGIN)?.warn?.("tool registration failed (continuing without it): %s", errorMessage(error));
  }
  ctx.inject(["webServer"], (webCtx) => {
    try {
      registerHealthRoute(webCtx);
    } catch (error) {
      webCtx.logger?.(PLUGIN)?.error?.("route registration failed: %s", errorMessage(error));
    }
  });
}
export {
  CliArm,
  HEALTH_ROUTE,
  NativeArm,
  PLUGIN,
  VERSION,
  WasmArm,
  apply,
  createArm,
  createPrimaryArm,
  inject,
  name,
  registerGalleyTools,
  renderTypstNative
};
//# sourceMappingURL=index.js.map
