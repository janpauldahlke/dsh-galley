// src/host/tools.ts
import { createHash as createHash3, randomBytes } from "node:crypto";

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
function makeDepEdge(id, sinceHash, at) {
  return { id, sinceHash, at };
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
  redoPath(id) {
    return join(this.dir(id), "redo.json");
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
  commit(id, expect, apply) {
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
    const touchedId = apply(packet);
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
    const next = [...this.readJson(join(this.dir(id), "proposals.json"), []), proposal];
    this.atomicWrite(join(this.dir(id), "proposals.json"), JSON.stringify(next));
    this.bumpRev(id, `proposal ${proposal.id}`);
    return proposal;
  }
  listProposals(id) {
    return this.readJson(join(this.dir(id), "proposals.json"), []);
  }
  setProposalStatus(id, proposalId, status, opts) {
    const list = this.listProposals(id);
    const p = list.find((x) => x.id === proposalId);
    if (!p) return null;
    p.status = status;
    this.atomicWrite(join(this.dir(id), "proposals.json"), JSON.stringify(list));
    if (opts?.bumpRev !== false) this.bumpRev(id, `proposal ${proposalId} ${status}`);
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
    const updated = this.setProposalStatus(id, proposalId, "accepted", { bumpRev: false });
    return updated;
  }
  addAnnotation(id, annotation) {
    const list = this.readJson(join(this.dir(id), "annotations.json"), []);
    list.push(annotation);
    this.atomicWrite(join(this.dir(id), "annotations.json"), JSON.stringify(list));
    this.bumpRev(id, `annotation ${annotation.id}`);
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
    const assetsDir = join(this.dir(id), "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, basename(meta.path)), bytes);
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

// src/typst/index.ts
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

// src/shared/inlineMarkup.ts
var MAX_DEPTH = 3;
function escapeText(v) {
  return v.replace(/([\\*`${])/g, "\\$1");
}
function serializeInlines(inlines) {
  if (!inlines || inlines.length === 0) return "";
  return inlines.map((node) => {
    switch (node.t) {
      case "text":
        return escapeText(node.v);
      case "strong":
        return `**${serializeInlines(node.c)}**`;
      case "emph":
        return `*${serializeInlines(node.c)}*`;
      case "code":
        return "`" + node.v.replace(/`/g, "\\`") + "`";
      case "math":
        return "$" + node.v.replace(/\$/g, "\\$") + "$";
      case "cloze":
        return `{{${(node.hint ?? "").replace(/\}/g, "\\}")}}}`;
      case "newline":
        return "\n";
      default:
        return "";
    }
  }).join("");
}
function pushText(out, text) {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev && prev.t === "text") {
    prev.v += text;
  } else {
    out.push({ t: "text", v: text });
  }
}
function findClosing(src, from, marker) {
  let i = from;
  while (i <= src.length - marker.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === "\n") return -1;
    if (marker === "**" && ch === "*" && !src.startsWith("**", i)) {
      const innerEmph = findClosing(src, i + 1, "*");
      if (innerEmph >= 0) {
        i = innerEmph + 1;
        continue;
      }
    }
    if (src.startsWith(marker, i)) {
      if (marker === "*" && src.startsWith("**", i)) {
        const inner = findClosing(src, i + 2, "**");
        if (inner >= 0) {
          i = inner + 2;
          continue;
        }
      }
      return i;
    }
    i += 1;
  }
  return -1;
}
function parseSegment(src, depth) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      out.push({ t: "newline" });
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length && src[i + 1] !== "\n" && src[i + 1] !== "\r") {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }
    if (src.startsWith("{{", i)) {
      const end = findClosing(src, i + 2, "}}");
      if (end >= 0) {
        const raw = src.slice(i + 2, end).replace(/\\\}/g, "}");
        out.push(raw ? { t: "cloze", hint: raw } : { t: "cloze" });
        i = end + 2;
        continue;
      }
    }
    if (ch === "`") {
      const end = findClosing(src, i + 1, "`");
      if (end > i + 1) {
        const raw = src.slice(i + 1, end).replace(/\\`/g, "`");
        out.push({ t: "code", v: raw });
        i = end + 1;
        continue;
      }
    }
    if (ch === "$") {
      const end = findClosing(src, i + 1, "$");
      if (end > i + 1) {
        const raw = src.slice(i + 1, end).replace(/\\\$/g, "$");
        out.push({ t: "math", v: raw });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && src.startsWith("**", i)) {
      const end = findClosing(src, i + 2, "**");
      if (end > i + 2) {
        out.push({ t: "strong", c: parseSegment(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MAX_DEPTH && ch === "*" && !src.startsWith("**", i)) {
      const end = findClosing(src, i + 1, "*");
      if (end > i + 1) {
        out.push({ t: "emph", c: parseSegment(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    pushText(out, ch);
    i += 1;
  }
  return out;
}
function parseInlines(input) {
  if (!input) return [{ t: "text", v: "" }];
  const parsed = parseSegment(input, 1);
  return parsed.length > 0 ? parsed : [{ t: "text", v: "" }];
}

// src/host/httpDispatch.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { URL } from "node:url";

// src/shared/types.ts
var STATE_ROUTE = "/api/galley/state";
var EDIT_ROUTE = "/api/galley/edit";
var EXPORT_ROUTE = "/api/galley/export";
var PROPOSAL_ROUTE_PREFIX = "/api/galley/proposal";

// src/host/workspace.ts
import { join as join2 } from "node:path";
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
function resolveGalleyRoot(cwd) {
  if (process.env.GALLEY_ROOT) return process.env.GALLEY_ROOT;
  const resolved = resolveGalleyCwd(cwd);
  return join2(resolved, ".dsh", "galley");
}
function getStoreForCwd(cwd) {
  const resolvedCwd = resolveGalleyCwd(cwd);
  const root = process.env.GALLEY_ROOT ?? join2(resolvedCwd, ".dsh", "galley");
  let store = storesByRoot.get(root);
  if (!store) {
    store = new GalleyStore(root);
    storesByRoot.set(root, store);
  }
  return { store, root, cwd: resolvedCwd };
}
function _resetGalleyWorkspaceForTests() {
  lastGalleyCwd = null;
  storesByRoot.clear();
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
  return new Promise((resolve, reject) => {
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
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new StoreError("invalid_op", "JSON object body required"));
          return;
        }
        resolve(parsed);
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
function slugify(title) {
  const s = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase();
  return s || "galley";
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
    if (!packet) {
      const empty = {
        ok: true,
        activePacket: false,
        cwd,
        packets,
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
        proposals: allProposals.filter((p) => blockIds.has(p.targetBlockId))
      });
    }
    const proofs = await getCachedProofs(root, deps, packet);
    const payload = {
      ok: true,
      activePacket: true,
      cwd,
      packets,
      rev: packet.rev,
      packetId: packet.id,
      template: packet.template,
      title: packet.title,
      activeSheetId: packet.sheetOrder[0] ?? "s1",
      sheetOrder: packet.sheetOrder,
      assets: packet.assets ?? {},
      undoDepth: store.undoDepth(packet.id),
      redoDepth: store.redoDepth(packet.id),
      sheets,
      staleDependents,
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
        const result = await galleyOpen(deps, {
          id: typeof body.id === "string" ? body.id : void 0,
          template: body.template,
          title: typeof body.title === "string" ? body.title : void 0,
          targetPages: typeof body.targetPages === "number" ? body.targetPages : void 0,
          blocks: Array.isArray(body.blocks) ? body.blocks : void 0,
          origin: source
        });
        if (!result.ok) {
          sendFailure(res, result);
          return;
        }
        sendJson(res, 200, result);
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
          bytesSha256: createHash2("sha256").update(bytes).digest("hex"),
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
    if (action !== "accept" && action !== "revert" && action !== "reject") {
      sendFailure(res, { ok: false, code: Err.INVALID_PARAMS, message: "action must be accept or revert" });
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
    const { deps, root, cwd } = await hostDeps.getDepsForCwd(cwdParam);
    const { store } = deps;
    const pid = (typeof body.packetId === "string" ? body.packetId : void 0) ?? store.getActivePacket();
    if (!pid) {
      sendFailure(res, { ok: false, code: Err.NO_ACTIVE_PACKET, message: "no active packet" });
      return;
    }
    const packet = store.load(pid);
    if (!packet) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${pid} not found` });
      return;
    }
    const format = typeof body.format === "string" ? body.format : "pdf";
    const sheetIds = Array.isArray(body.sheetIds) && body.sheetIds.length > 0 ? body.sheetIds.filter((s) => typeof s === "string") : typeof body.sheetId === "string" ? [body.sheetId] : packet.sheetOrder;
    const outDir = join3(cwd, "galley-exports");
    mkdirSync2(outDir, { recursive: true });
    const slug = slugify(packet.title);
    const proofs = await getCachedProofs(root, deps, packet);
    const files = [];
    for (const sid of sheetIds) {
      const result = await galleyExport(deps, { packetId: pid, sheetId: sid, format });
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      const bytes = result.bytes ?? Buffer.from(result.text ?? "", "utf8");
      const filename = sheetIds.length === 1 && sid === "s1" ? `${slug}.${format}` : `${slug}-${sid}.${format}`;
      const relPath = `galley-exports/${filename}`;
      writeFileSync2(join3(cwd, relPath), bytes);
      const sheetProof = proofs.find((p) => p.sheetId === sid);
      files.push({
        sheetId: sid,
        path: relPath,
        format,
        pages: format === "pdf" ? sheetProof?.pages ?? null : null,
        sizeBytes: bytes.length,
        sha256: createHash2("sha256").update(bytes).digest("hex")
      });
    }
    sendJson(res, 200, { ok: true, packetId: pid, rev: packet.rev, files });
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

// src/host/tools.ts
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
function mapStoreCode(code) {
  return toStoreCode(code);
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
        { id: a.id, path: a.path, bytesSha256: createHash3("sha256").update(bytes).digest("hex"), mimeType: a.mimeType },
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
    if (args.op === "patch" && args.origin === "agent" && prePatchOrigin === "human") {
      const target = findBlock(packet, args.blockId);
      if (!target) return fail(Err.BLOCK_NOT_FOUND, `block ${args.blockId} not found`);
      if (args.baseHash && args.baseHash !== target.block.hash) {
        const t = fail(Err.PROPOSAL_CONFLICT, `block ${args.blockId} changed (base hash mismatch)`);
        t.baseHash = args.baseHash;
        t.currentHash = target.block.hash;
        return t;
      }
      const proposedPatch = args.patch ?? {};
      const beforePatch = {};
      const rawBlock = target.block;
      for (const k of Object.keys(proposedPatch)) {
        if (k in rawBlock) beforePatch[k] = JSON.parse(JSON.stringify(rawBlock[k]));
      }
      const seq = store.listProposals(pid).length + 1;
      const prop = {
        id: `prop-${seq}`,
        targetBlockId: args.blockId,
        baseHash: target.block.hash,
        beforePatch,
        proposedPatch,
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
export {
  Err,
  GalleyStore,
  JOURNAL_KEEP,
  MAX_ASSETS_PER_PACKET,
  MAX_INLINE_DEPTH,
  MAX_INLINE_NODES,
  StoreError,
  UNDO_DEPTH,
  _resetGalleyWorkspaceForTests,
  allocateBlockId,
  assetBytesForPacket,
  blockContentProjection,
  blockOutline,
  blockText,
  buildBlock,
  canonicalJson,
  computeStale,
  createGalleyHttpDispatcher,
  createsCycle,
  findBlock,
  galleyAnnotate,
  galleyEditBlock,
  galleyExport,
  galleyOpen,
  galleyReadBlock,
  galleyStatus,
  getStoreForCwd,
  hashBlock,
  hashContent,
  httpStatusForCode,
  inlineText,
  makeDepEdge,
  mapError,
  mapStoreCode,
  noteGalleyCwd,
  parseInlines,
  recomputeStale,
  resolveGalleyCwd,
  resolveGalleyRoot,
  resolvePacketId,
  serializeInlines,
  splitSvgPages,
  staleBlockIds,
  validateInline,
  validateSlot
};
//# sourceMappingURL=galley-core.mjs.map
