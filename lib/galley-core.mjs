// src/host/tools.ts
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/shared/i18n.ts
var DEFAULT_LOCALE = "en";
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
      unknownHeaderFields: (id, keys) => `Header ${id} ignored unsupported field(s): ${keys.join(", ")} (supported: title, subtitle, subject/fach, meta/klasse, date/datum, name)`
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
      unknownHeaderFields: (id, keys) => `Kopfbereich ${id} ignoriert unbekannte Felder: ${keys.join(", ")} (unterst\xFCtzt: title/titel, subtitle/untertitel, subject/fach, meta/klasse, date/datum, name)`
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

// src/host/store.ts
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
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

// src/host/store.ts
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
  if (b.colWidths !== void 0) out.colWidths = b.colWidths;
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
  bumpRev(id, note, actor) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    packet.rev += 1;
    packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      ...actor ? { actor } : {},
      note
    });
    this.atomicWrite(this.journalPath(id), JSON.stringify(journal.slice(-JOURNAL_KEEP)));
    return packet;
  }
  listJournal(id) {
    return this.readJson(this.journalPath(id), []);
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
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "templates" && existsSync(join(this.root, e.name, "packet.json"))).map((e) => {
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
    if (!existsSync(dir)) throw new StoreError("not_found", `packet ${id} not found`);
    if (this.getActivePacket() === id) {
      const remaining = this.list().filter((p) => p.id !== id);
      if (remaining.length > 0) this.setActivePacket(remaining[0].id);
      else this.clearActivePacket();
    }
    rmSync(dir, { recursive: true, force: true });
  }
  renamePacket(id, title, actor = "human") {
    const trimmed = title.trim();
    if (!trimmed) throw new StoreError("invalid_op", "packet title must be non-empty");
    let oldTitle = "";
    return this.commit(
      id,
      null,
      (p) => {
        oldTitle = p.title;
        p.title = trimmed;
        return null;
      },
      { actor, note: () => `packet.title "${oldTitle}"\u2192"${trimmed}" (${actor})` }
    ).packet;
  }
  setReviewMode(id, mode, actor = "human") {
    if (mode !== "auto" && mode !== "review") {
      throw new StoreError("invalid_op", `invalid reviewMode '${String(mode)}'`);
    }
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const prevMode = packet.reviewMode ?? "auto";
    packet.reviewMode = mode;
    packet.rev += 1;
    packet.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.atomicWrite(this.packetPath(id), JSON.stringify(packet, null, 2));
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      actor,
      note: `reviewMode ${prevMode}\u2192${mode} (${actor})`
    });
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
    const srcAssetsDir = join(this.dir(id), "assets");
    if (existsSync(srcAssetsDir)) {
      const dstAssetsDir = join(this.dir(newId), "assets");
      mkdirSync(dstAssetsDir, { recursive: true });
      for (const entry of readdirSync(srcAssetsDir)) {
        copyFileSync(join(srcAssetsDir, entry), join(dstAssetsDir, entry));
      }
    }
    this.setActivePacket(newId);
    return this.load(newId);
  }
  // ── Sheet CRUD (all committed through undo-safe single commit path) ───────
  addSheet(id, opts) {
    let createdSheetId = "s1";
    let createdTitle = "";
    const actor = opts?.actor ?? "human";
    const res = this.commit(
      id,
      null,
      (p) => {
        let n = p.sheetOrder.length + 1;
        while (p.sheets[`s${n}`]) n++;
        createdSheetId = `s${n}`;
        const geometry = {
          paper: opts?.paper ?? "a4",
          orientation: opts?.orientation ?? "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          ...opts?.targetPages !== void 0 && opts.targetPages > 0 ? { targetPages: Math.floor(opts.targetPages) } : {}
        };
        createdTitle = opts?.title?.trim() || `Sheet ${p.sheetOrder.length + 1}`;
        p.sheets[createdSheetId] = {
          id: createdSheetId,
          title: createdTitle,
          geometry,
          blocks: []
        };
        p.sheetOrder.push(createdSheetId);
        return null;
      },
      { actor, note: () => `sheet-add ${createdSheetId} "${createdTitle}" (${actor})` }
    );
    return { packet: res.packet, sheetId: createdSheetId };
  }
  renameSheet(id, sheetId, title, actor = "human") {
    const trimmed = title.trim();
    if (!trimmed) throw new StoreError("invalid_op", "sheet title must be non-empty");
    let oldTitle = "";
    return this.commit(
      id,
      null,
      (p) => {
        const sh = p.sheets[sheetId];
        if (!sh) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
        oldTitle = sh.title;
        sh.title = trimmed;
        return null;
      },
      { actor, note: () => `sheet ${sheetId}.title "${oldTitle}"\u2192"${trimmed}" (${actor})` }
    ).packet;
  }
  updateSheet(id, sheetId, patch, actor = "human") {
    const diffs = [];
    return this.commit(
      id,
      null,
      (p) => {
        const sh = p.sheets[sheetId];
        if (!sh) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
        if (patch.title !== void 0) {
          const t = patch.title.trim();
          if (!t) throw new StoreError("invalid_op", "sheet title must be non-empty");
          if (t !== sh.title) diffs.push(`title "${sh.title}"\u2192"${t}"`);
          sh.title = t;
        }
        if ("targetPages" in patch) {
          const prevTp = sh.geometry.targetPages ?? null;
          const tp = patch.targetPages;
          if (tp === null || tp === void 0 || tp === 0) {
            delete sh.geometry.targetPages;
            if (prevTp !== null) diffs.push(`targetPages ${prevTp}\u2192null`);
          } else if (typeof tp === "number" && Number.isFinite(tp) && tp >= 1) {
            const nextTp = Math.floor(tp);
            sh.geometry.targetPages = nextTp;
            if (prevTp !== nextTp) diffs.push(`targetPages ${prevTp ?? "null"}\u2192${nextTp}`);
          } else {
            throw new StoreError("invalid_op", "targetPages must be positive integer or 0/null to clear");
          }
        }
        if (patch.orientation !== void 0) {
          if (patch.orientation !== "portrait" && patch.orientation !== "landscape") {
            throw new StoreError("invalid_op", `invalid orientation '${String(patch.orientation)}'`);
          }
          const prevOr = sh.geometry.orientation ?? "portrait";
          sh.geometry.orientation = patch.orientation;
          if (prevOr !== patch.orientation) diffs.push(`orientation ${prevOr}\u2192${patch.orientation}`);
        }
        if (patch.paper !== void 0) {
          if (patch.paper !== "a4" && patch.paper !== "letter") {
            throw new StoreError("invalid_op", `invalid paper '${String(patch.paper)}'`);
          }
          const prevPaper = sh.geometry.paper;
          sh.geometry.paper = patch.paper;
          if (prevPaper !== patch.paper) diffs.push(`paper ${prevPaper}\u2192${patch.paper}`);
        }
        return null;
      },
      {
        actor,
        note: () => `sheet ${sheetId} ${diffs.length > 0 ? diffs.join(", ") : "updated"} (${actor})`
      }
    ).packet;
  }
  removeSheet(id, sheetId, actor = "human") {
    return this.commit(
      id,
      null,
      (p) => {
        if (!p.sheets[sheetId]) throw new StoreError("invalid_op", `sheet ${sheetId} not found`);
        if (p.sheetOrder.length <= 1) throw new StoreError("invalid_op", "cannot remove the last remaining sheet");
        delete p.sheets[sheetId];
        p.sheetOrder = p.sheetOrder.filter((sid) => sid !== sheetId);
        return null;
      },
      { actor, note: `sheet-remove ${sheetId} (${actor})` }
    ).packet;
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
    return join(this.root, "templates");
  }
  saveAsTemplate(packetId, opts) {
    const packet = this.load(packetId);
    if (!packet) throw new StoreError("not_found", `packet ${packetId} not found`);
    const title = opts?.title?.trim() || packet.title;
    const rawSlug = (opts?.id?.trim() || title).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase() || "template";
    const reserved = /* @__PURE__ */ new Set(["worksheet", "rfc", "generic"]);
    const id = reserved.has(rawSlug) ? `${rawSlug}-template` : rawSlug;
    const blueprint = {
      id,
      title,
      description: opts?.description?.trim() || void 0,
      ...packet.locale ? { locale: packet.locale } : {},
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
    this.atomicWrite(join(this.templatesDir(), `${id}.json`), JSON.stringify(blueprint, null, 2));
    return blueprint;
  }
  listSavedTemplates() {
    const dir = this.templatesDir();
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = this.readJson(join(dir, entry.name), null);
      if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.sheets)) {
        out.push({ ...parsed, source: "workspace" });
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }
  deleteSavedTemplate(templateId) {
    const safe = templateId.replace(/[^A-Za-z0-9_-]/g, "");
    if (!safe) return false;
    const p = join(this.templatesDir(), `${safe}.json`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
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
  commit(id, expect, apply, meta) {
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
    const resolvedNote = typeof meta?.note === "function" ? meta.note() : meta?.note ?? (touchedId ? `edit ${touchedId}${meta?.actor ? ` (${meta.actor})` : ""}` : "edit");
    const journal = this.readJson(this.journalPath(id), []);
    journal.push({
      rev: packet.rev,
      at: packet.updatedAt,
      ...meta?.actor ? { actor: meta.actor } : {},
      note: resolvedNote
    });
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
  /**
   * Read-only lookup of a prior snapshot at or before `targetRev` from the
   * undo ring (used by `inject.ts` to compute exact changed-block deltas even
   * after session resume). Returns null if pruned or unavailable.
   */
  snapshotAtRev(id, targetRev) {
    if (targetRev <= 0) return null;
    const undo = this.readJson(this.undoPath(id), []);
    for (let i = undo.length - 1; i >= 0; i--) {
      if (undo[i].rev === targetRev) return undo[i];
    }
    for (let i = undo.length - 1; i >= 0; i--) {
      if (undo[i].rev < targetRev) return undo[i];
    }
    return null;
  }
  // ── proposals + annotations (bump packet.rev so rev-polling observes deltas) ──
  addProposal(id, proposal) {
    const packet = this.load(id);
    if (!packet) throw new StoreError("not_found", `packet ${id} not found`);
    const next = [...this.readJson(join(this.dir(id), "proposals.json"), []), proposal];
    this.atomicWrite(join(this.dir(id), "proposals.json"), JSON.stringify(next));
    this.bumpRev(id, `proposal ${proposal.id} (${proposal.op ?? "patch"} ${proposal.targetBlockId})`, "agent");
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
    if (opts?.bumpRev !== false) this.bumpRev(id, `proposal ${proposalId} ${status} (human)`, "human");
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
          b.body = typeof v === "string" ? parseInlines(v) : Array.isArray(v) ? v : parseInlines(String(v));
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
    const list = this.readJson(join(this.dir(id), "annotations.json"), []);
    list.push(annotation);
    this.atomicWrite(join(this.dir(id), "annotations.json"), JSON.stringify(list));
    this.bumpRev(id, `annotation ${annotation.id} on ${annotation.blockId} (${annotation.author})`, annotation.author);
    return annotation;
  }
  listAnnotations(id, blockId) {
    const list = this.readJson(join(this.dir(id), "annotations.json"), []);
    return blockId ? list.filter((a) => a.blockId === blockId) : list;
  }
  setAnnotationResolved(id, annotationId, resolved, actor = "human") {
    const list = this.listAnnotations(id);
    const a = list.find((x) => x.id === annotationId);
    if (!a) return null;
    a.resolved = resolved;
    this.atomicWrite(join(this.dir(id), "annotations.json"), JSON.stringify(list));
    this.bumpRev(id, `annotation ${annotationId} ${resolved ? "resolved" : "unresolved"} (${actor})`, actor);
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
    const nonEmpty = groups.filter((g2) => g2.length > 0);
    if (nonEmpty.length > 0) return nonEmpty.map((g2) => inlineToContent(g2));
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
      const left = [`#text(size: 8pt, fill: luma(110), ${typString(pStr.headerEyebrow)})`];
      if (f.titel) left.push(`#text(size: 17pt, weight: "bold", ${typString(f.titel)})`);
      if (f.subtitle) left.push(`#text(size: 10.5pt, fill: luma(85), ${typString(f.subtitle)})`);
      if (f.name !== void 0) {
        const nameVal = f.name.trim() ? f.name : "________________________";
        left.push(`#text(size: 9pt, fill: luma(110), ${typString(pStr.namePrefix + nameVal)})`);
      }
      lines.push(
        `#grid(columns: (1fr, auto), column-gutter: 12pt, align: (top, top))[${left.join("#linebreak()")}#linebreak()]${right}`,
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
  const g2 = sheet.geometry;
  const m = g2.margin;
  const isLandscape = g2.orientation === "landscape";
  const typstLang = getGalleyStrings(locale).print.typstLang;
  const L = [];
  L.push(
    `// galley preamble \u2014 sheet ${sheet.id} "${sheet.title}" (${g2.paper}${isLandscape ? " landscape" : ""}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} cm)`
  );
  const flippedArg = isLandscape ? ", flipped: true" : "";
  L.push(`#set page(paper: ${typString(g2.paper)}${flippedArg}, margin: (top: ${m.top}cm, bottom: ${m.bottom}cm, left: ${m.left}cm, right: ${m.right}cm))`);
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

// src/host/httpDispatch.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { basename as basename2, extname, resolve, sep } from "node:path";
import { URL } from "node:url";

// src/shared/types.ts
var STATE_ROUTE = "/api/galley/state";
var EDIT_ROUTE = "/api/galley/edit";
var EXPORT_ROUTE = "/api/galley/export";
var DOWNLOAD_ROUTE = "/api/galley/download";
var PROPOSAL_ROUTE_PREFIX = "/api/galley/proposal";

// src/host/workspace.ts
import { join as join2 } from "node:path";
var WORKSPACE_SYM = Symbol.for("dsh-galley.workspace.v1");
var g = globalThis;
if (!g[WORKSPACE_SYM]) {
  g[WORKSPACE_SYM] = {
    lastGalleyCwd: null,
    storesByRoot: /* @__PURE__ */ new Map(),
    sessionActivePackets: /* @__PURE__ */ new Map()
  };
}
var wsState = g[WORKSPACE_SYM];
var storesByRoot = wsState.storesByRoot;
var sessionActivePackets = wsState.sessionActivePackets;
function setSessionActivePacket(root, sessionId, packetId) {
  const sid = sessionId?.trim();
  if (sid && packetId) {
    sessionActivePackets.set(`${root}::${sid}`, packetId);
  }
}
function getSessionActivePacket(root, sessionId) {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return sessionActivePackets.get(`${root}::${sid}`) ?? null;
}
function clearSessionActivePacket(packetId) {
  for (const [k, v] of sessionActivePackets.entries()) {
    if (v === packetId) sessionActivePackets.delete(k);
  }
}
function noteGalleyCwd(cwd) {
  const trimmed = cwd?.trim();
  if (trimmed) wsState.lastGalleyCwd = trimmed;
}
function getGalleyCwd() {
  return wsState.lastGalleyCwd ?? process.cwd();
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
  wsState.lastGalleyCwd = null;
  storesByRoot.clear();
  sessionActivePackets.clear();
}

// src/host/service.ts
var BUILTIN_TEMPLATES = [
  {
    id: "worksheet",
    title: "Problem Sheet + Answer Key",
    description: "Two linked sheets: Problem Sheet (A4, target 1 page) + Answer Key with stale-tracking dependencies",
    source: "builtin",
    sheets: [
      {
        id: "s1",
        title: "Problem Sheet",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 },
          targetPages: 1
        },
        starterBlocks: [
          { type: "header", fields: { titel: "Problem Sheet", fach: "", klasse: "", datum: "", name: "" } },
          { type: "task", body: "First task" }
        ]
      },
      {
        id: "s2",
        title: "Answer Key",
        geometry: {
          paper: "a4",
          orientation: "portrait",
          margin: { top: 2, right: 2.5, bottom: 2, left: 2.5 }
        },
        starterBlocks: [
          { type: "heading", level: 1, body: "Answer Key" },
          { type: "answer", body: "Expected answer", dependsOn: ["b2"] }
        ]
      }
    ]
  },
  {
    id: "rfc",
    title: "Engineering RFC",
    description: "Single A4 sheet for technical architecture, design proposals, and specifications",
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
    title: "Blank Document",
    description: "Single blank A4 sheet with unbounded page count",
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
    const pf = getGalleyStrings("en").preflight;
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
            message: b.stale.state === "stale_missing_origin" ? pf.staleMissingOrigin(b.id, b.stale.origin) : pf.staleChangedOrigin(b.id, b.stale.origin)
          });
        }
      }
    }
    if (packet.sheetOrder.length >= 2) {
      const answeredTaskIds = /* @__PURE__ */ new Set();
      let hasAnyAnswerBlock = false;
      for (const sid of packet.sheetOrder) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          if (b.type === "answer") {
            hasAnyAnswerBlock = true;
            for (const dep of b.dependsOn ?? []) answeredTaskIds.add(dep.id);
          }
        }
      }
      const sheetsToScan = hasAnyAnswerBlock ? packet.sheetOrder : [packet.sheetOrder[0]];
      for (const sid of sheetsToScan) {
        for (const b of packet.sheets[sid]?.blocks ?? []) {
          if (b.type === "task" && !answeredTaskIds.has(b.id)) {
            warnings.push({
              code: "GALLEY_UNANSWERED_TASK",
              severity: "info",
              sheetId: sid,
              blockId: b.id,
              message: pf.unansweredTask(b.id)
            });
          }
        }
      }
    }
    for (const sid of packet.sheetOrder) {
      for (const b of packet.sheets[sid]?.blocks ?? []) {
        if (b.type === "header" && Array.isArray(b.fields?._unknownKeys) && b.fields._unknownKeys.length > 0) {
          warnings.push({
            code: "GALLEY_UNKNOWN_HEADER_FIELD",
            severity: "warn",
            sheetId: sid,
            blockId: b.id,
            message: pf.unknownHeaderFields(b.id, b.fields._unknownKeys)
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
            message: pf.pageOverflow(
              packet.sheets[sid]?.title ?? sid,
              target ?? "?",
              pr.overflowLinesOnLastPage ?? 0
            )
          });
        }
      }
    }
    for (const sid of packet.sheetOrder) {
      const sh = packet.sheets[sid];
      if (!sh) continue;
      for (const b of sh.blocks) {
        if (b.type === "source_text" && b.lineNumbers) {
          const flat = (b.body ?? []).map((n) => n.t === "newline" ? "\n" : "v" in n && typeof n.v === "string" ? n.v : "").join("");
          const logicalLines = flat.split("\n");
          if (logicalLines.length > 1) {
            const overIdx = logicalLines.findIndex((l) => l.length > 92);
            if (overIdx >= 0) {
              warnings.push({
                code: "GALLEY_SOURCE_LINE_WRAP",
                severity: "info",
                sheetId: sid,
                blockId: b.id,
                message: pf.sourceLineWrap(b.id, overIdx + 1, logicalLines[overIdx].length)
              });
            }
          }
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
  return new Promise((resolve2, reject) => {
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
        resolve2({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new StoreError("invalid_op", "JSON object body required"));
          return;
        }
        resolve2(parsed);
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
    const tp = sheet.geometry.targetPages;
    if (!deps.render) {
      proofs.push({
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        targetPages: tp ?? null,
        targetPagesMet: tp !== void 0 ? false : null,
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
        targetPages: tp ?? null,
        targetPagesMet: tp !== void 0 ? sr.pages <= tp : null,
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
        targetPages: tp ?? null,
        targetPagesMet: tp !== void 0 ? false : null,
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
    if (explicitPid && !store.load(explicitPid)) {
      sendFailure(res, { ok: false, code: Err.PACKET_NOT_FOUND, message: `packet ${explicitPid} not found` });
      return;
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
    const knownPacket = url.searchParams.get("knownPacket")?.trim();
    if (revParam !== null && revParam !== "" && Number(revParam) === packet.rev && (!knownPacket || knownPacket === packet.id)) {
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
        clearSessionActivePacket(targetId);
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
        const updated = store.renamePacket(pid, typeof body.title === "string" ? body.title : "", source);
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
        const updated = store.setReviewMode(pid, mode, source);
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
          paper: body.paper === "letter" ? "letter" : "a4",
          actor: source
        });
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.packet.rev, sheetId: out.sheetId, sheetOrder: out.packet.sheetOrder });
        return;
      }
      if (op === "sheet-rename") {
        const out = store.renameSheet(pid, String(body.sheetId ?? ""), typeof body.title === "string" ? body.title : "", source);
        sendJson(res, 200, { ok: true, packetId: pid, rev: out.rev });
        return;
      }
      if (op === "sheet-remove") {
        const out = store.removeSheet(pid, String(body.sheetId ?? ""), source);
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
      if (op === "update-geometry" || op === "sheet-update") {
        const sheetId = typeof body.sheetId === "string" ? body.sheetId : packet.sheetOrder[0];
        if (!packet.sheets[sheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${sheetId} not found` });
          return;
        }
        const patch = {};
        if (typeof body.title === "string") patch.title = body.title;
        if ("targetPages" in body) {
          const tp = body.targetPages;
          if (tp === null || tp === void 0 || tp === "" || tp === 0) patch.targetPages = null;
          else if (typeof tp === "number" && Number.isFinite(tp) && tp >= 1) patch.targetPages = Math.floor(tp);
          else throw new StoreError("invalid_op", "targetPages must be positive integer or null");
        }
        if (body.paper === "a4" || body.paper === "letter") patch.paper = body.paper;
        if (body.orientation === "portrait" || body.orientation === "landscape") patch.orientation = body.orientation;
        const updated = store.updateSheet(pid, sheetId, patch, source);
        sendJson(res, 200, { ok: true, packetId: pid, rev: updated.rev, sheetId });
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
        const explicitSheetId = typeof body.sheetId === "string" ? body.sheetId : void 0;
        const located = blockId ? findBlock(packet, blockId) : null;
        const previewSheetId = explicitSheetId ?? located?.sheet.id ?? packet.sheetOrder[0];
        if (explicitSheetId && !packet.sheets[explicitSheetId]) {
          sendFailure(res, { ok: false, code: Err.SHEET_NOT_FOUND, message: `sheet ${explicitSheetId} not found` });
          return;
        }
        const sheetForIndex = packet.sheets[previewSheetId];
        let beforeId = typeof body.beforeId === "string" ? body.beforeId : void 0;
        const afterId = typeof body.afterId === "string" ? body.afterId : typeof body.afterBlockId === "string" ? body.afterBlockId : void 0;
        if (!beforeId && !afterId && op === "insert" && sheetForIndex) {
          if (typeof body.index === "number" && body.index >= 0 && body.index < sheetForIndex.blocks.length) {
            beforeId = sheetForIndex.blocks[body.index].id;
          }
        }
        let toBeforeId = typeof body.toBeforeId === "string" ? body.toBeforeId : void 0;
        let toAfterId = typeof body.toAfterId === "string" ? body.toAfterId : void 0;
        if (op === "move" && !toBeforeId && !toAfterId) {
          const targetSh = packet.sheets[typeof body.toSheetId === "string" ? body.toSheetId : previewSheetId] ?? sheetForIndex;
          if (typeof body.afterBlockId === "string") {
            toAfterId = body.afterBlockId;
          } else if (typeof body.index === "number" && targetSh) {
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
          ...explicitSheetId !== void 0 ? { sheetId: explicitSheetId } : {},
          op,
          origin: source,
          beforeId,
          afterId,
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
    const exportsRoot = resolve(cwd, "galley-exports");
    const targetAbs = resolve(cwd, relPath);
    if (!targetAbs.startsWith(exportsRoot + sep)) {
      sendFailure(res, {
        ok: false,
        code: Err.INVALID_PARAMS,
        message: "download path must reside inside galley-exports/"
      });
      return;
    }
    if (!existsSync2(targetAbs) || !statSync(targetAbs).isFile()) {
      sendFailure(res, { ok: false, code: Err.EXPORT_FAILED, message: `exported file '${relPath}' not found` });
      return;
    }
    const bytes = readFileSync2(targetAbs);
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

// src/host/docx.ts
import { crc32 as nodeCrc32, deflateRawSync, inflateRawSync } from "node:zlib";
var TWIPS_PER_PT = 20;
var TWIPS_PER_CM = 566.9291338582677;
var EMU_PER_CM = 36e4;
var EMU_PER_PT = 12700;
var PAPER_TWIPS = {
  a4: { w: 11906, h: 16838 },
  // 210 × 297 mm
  letter: { w: 12240, h: 15840 }
  // 8.5 × 11 in
};
var CALLOUT_HEX = {
  info: { fill: "E8F0FE", accent: "1A73E8" },
  hint: { fill: "E6F4EA", accent: "188038" },
  warning: { fill: "FCE8E6", accent: "D93025" }
};
var FIXED_DOS_TIME = 0;
var FIXED_DOS_DATE = 0 << 9 | 1 << 5 | 1;
function escapeXml(raw) {
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function cmToTwips(cm) {
  return Math.max(0, Math.round(cm * TWIPS_PER_CM));
}
function parseIsoTimestamp(raw) {
  if (raw && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) {
    return raw.endsWith("Z") ? raw : `${raw.replace(/\.\d+$/, "")}Z`;
  }
  return "2026-01-01T00:00:00Z";
}
function probeImageDimensions(bytes) {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const widthPx = bytes.readUInt32BE(16);
    const heightPx = bytes.readUInt32BE(20);
    if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
  }
  if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) {
    const widthPx = bytes.readUInt16LE(6);
    const heightPx = bytes.readUInt16LE(8);
    if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let off = 2;
    while (off + 8 < bytes.length) {
      if (bytes[off] !== 255) {
        off++;
        continue;
      }
      const marker = bytes[off + 1];
      if (marker === 255) {
        off++;
        continue;
      }
      if (marker === 217 || marker === 218) break;
      const segLen = bytes.readUInt16BE(off + 2);
      if (segLen < 2 || off + 2 + segLen > bytes.length) break;
      const isSof = marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207;
      if (isSof && segLen >= 7) {
        const heightPx = bytes.readUInt16BE(off + 5);
        const widthPx = bytes.readUInt16BE(off + 7);
        if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
      }
      off += 2 + segLen;
    }
  }
  return { widthPx: 400, heightPx: 300 };
}
function extFromAsset(meta) {
  const mime = (meta?.mimeType ?? "").toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return { ext: "jpg", mime: "image/jpeg" };
  if (mime === "image/gif") return { ext: "gif", mime: "image/gif" };
  if (mime === "image/webp") return { ext: "webp", mime: "image/webp" };
  if (mime === "image/svg+xml") return { ext: "svg", mime: "image/svg+xml" };
  const p = (meta?.path ?? "").toLowerCase();
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return { ext: "jpg", mime: "image/jpeg" };
  if (p.endsWith(".gif")) return { ext: "gif", mime: "image/gif" };
  if (p.endsWith(".webp")) return { ext: "webp", mime: "image/webp" };
  if (p.endsWith(".svg")) return { ext: "svg", mime: "image/svg+xml" };
  return { ext: "png", mime: "image/png" };
}
var crcTable = null;
function computeCrc32(buf) {
  if (typeof nodeCrc32 === "function") {
    return nodeCrc32(buf) >>> 0;
  }
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 4294967295;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function buildDeterministicZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const crc = computeCrc32(raw);
    const compressed = entry.storeOnly ? raw : deflateRawSync(raw, { level: 9 });
    const useStore = entry.storeOnly || compressed.length >= raw.length;
    const payload = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(67324752, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(2048, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(FIXED_DOS_TIME, 10);
    lfh.writeUInt16LE(FIXED_DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, payload);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(33639248, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(2048, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(FIXED_DOS_TIME, 12);
    cdh.writeUInt16LE(FIXED_DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(101010256, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}
function unpackDocxEntries(zip) {
  let eocdOff = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 101010256) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("invalid zip: EOCD signature not found");
  const count = zip.readUInt16LE(eocdOff + 10);
  let cdOff = zip.readUInt32LE(eocdOff + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cdOff) !== 33639248) {
      throw new Error(`invalid zip: central directory signature mismatch at ${cdOff}`);
    }
    const method = zip.readUInt16LE(cdOff + 10);
    const compSize = zip.readUInt32LE(cdOff + 20);
    const nameLen = zip.readUInt16LE(cdOff + 28);
    const extraLen = zip.readUInt16LE(cdOff + 30);
    const commentLen = zip.readUInt16LE(cdOff + 32);
    const lfhOff = zip.readUInt32LE(cdOff + 42);
    const name = zip.subarray(cdOff + 46, cdOff + 46 + nameLen).toString("utf8");
    const lfhNameLen = zip.readUInt16LE(lfhOff + 26);
    const lfhExtraLen = zip.readUInt16LE(lfhOff + 28);
    const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    const slice = zip.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? Buffer.from(slice) : method === 8 ? inflateRawSync(slice) : Buffer.alloc(0);
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function renderRunProps(st) {
  const tags = [];
  if (st.code) {
    tags.push('<w:rStyle w:val="CodeChar"/>');
    tags.push('<w:rFonts w:ascii="Liberation Mono" w:hAnsi="Liberation Mono" w:cs="Liberation Mono"/>');
  }
  if (st.bold) tags.push("<w:b/><w:bCs/>");
  if (st.italic) tags.push("<w:i/><w:iCs/>");
  if (st.underline) tags.push('<w:u w:val="single"/>');
  if (st.colorHex) tags.push(`<w:color w:val="${st.colorHex}"/>`);
  if (st.sizeHalfPt) tags.push(`<w:sz w:val="${st.sizeHalfPt}"/><w:szCs w:val="${st.sizeHalfPt}"/>`);
  return tags.length > 0 ? `<w:rPr>${tags.join("")}</w:rPr>` : "";
}
function renderTextRun(text, st = {}) {
  const rPr = renderRunProps(st);
  const lines = text.split("\n");
  const inner = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) inner.push("<w:br/>");
    if (lines[i].length > 0) {
      inner.push(`<w:t xml:space="preserve">${escapeXml(lines[i])}</w:t>`);
    }
  }
  if (inner.length === 0) return "";
  return `<w:r>${rPr}${inner.join("")}</w:r>`;
}
function inlineToOoxml(inlines, inherited = {}) {
  const out = [];
  for (const node of inlines) {
    switch (node.t) {
      case "text":
        out.push(renderTextRun(node.v, inherited));
        break;
      case "strong":
        out.push(inlineToOoxml(node.c, { ...inherited, bold: true }));
        break;
      case "emph":
        out.push(inlineToOoxml(node.c, { ...inherited, italic: true }));
        break;
      case "code":
        out.push(renderTextRun(node.v, { ...inherited, code: true, sizeHalfPt: inherited.sizeHalfPt ?? 19 }));
        break;
      case "cloze": {
        const width = Math.max(6, (node.hint ?? "").length + 4);
        out.push(renderTextRun("\xA0".repeat(width), { ...inherited, underline: true }));
        break;
      }
      case "math": {
        const expr = node.v.trim();
        if (expr.length > 0) {
          out.push(`<m:oMath><m:r><m:t xml:space="preserve">${escapeXml(expr)}</m:t></m:r></m:oMath>`);
        }
        break;
      }
      case "newline":
        out.push(`<w:r>${renderRunProps(inherited)}<w:br/></w:r>`);
        break;
      default:
        break;
    }
  }
  return out.join("");
}
function inlineCharLen(inlines) {
  let n = 0;
  for (const it of inlines) {
    if (it.t === "text" || it.t === "code" || it.t === "math") n += it.v.length;
    else if (it.t === "strong" || it.t === "emph") n += inlineCharLen(it.c);
    else if (it.t === "cloze") n += Math.max(6, (it.hint ?? "").length + 4);
    else if (it.t === "newline") n += 1;
  }
  return n;
}
function splitInlinesTwoColumn(inlines) {
  const total = inlineCharLen(inlines);
  if (total < 16) return null;
  if (inlines.length === 1 && inlines[0].t === "text") {
    const s = inlines[0].v;
    const mid2 = Math.floor(s.length / 2);
    let best = -1;
    let bestDist2 = Infinity;
    for (let i = 8; i <= s.length - 8; i++) {
      if (/\s/.test(s[i])) {
        const d = Math.abs(i - mid2);
        if (d < bestDist2) {
          bestDist2 = d;
          best = i;
        }
      }
    }
    if (best < 0) return null;
    return [[{ t: "text", v: s.slice(0, best).trimEnd() }], [{ t: "text", v: s.slice(best + 1).trimStart() }]];
  }
  const tokens = [];
  for (const it of inlines) {
    if (it.t === "text") {
      const parts = it.v.match(/\S+\s*|\s+/g) ?? [it.v];
      for (const p of parts) tokens.push({ t: "text", v: p });
    } else {
      tokens.push(it);
    }
  }
  const mid = total / 2;
  let acc = 0;
  let splitIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < tokens.length - 1; i++) {
    acc += inlineCharLen([tokens[i]]);
    if (acc >= 8 && total - acc >= 8) {
      const d = Math.abs(acc - mid);
      if (d < bestDist) {
        bestDist = d;
        splitIdx = i + 1;
      }
    }
  }
  if (splitIdx <= 0) return null;
  return [tokens.slice(0, splitIdx), tokens.slice(splitIdx)];
}
function cardInlineCells(block) {
  const body = block.body;
  if (!body || body.length === 0) return [[]];
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
    const nonEmpty = groups.filter((g2) => g2.length > 0);
    if (nonEmpty.length > 0) return nonEmpty;
  }
  if (body.length > 1) return body.map((it) => [it]);
  return [body];
}
var BORDERLESS_TBL_PR = '<w:tblBorders><w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/></w:tblBorders>';
function singleBordersXml(colorHex, szEighthsPt = 4) {
  return `<w:tblBorders><w:top w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/><w:left w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/><w:bottom w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/><w:right w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/><w:insideH w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/><w:insideV w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/></w:tblBorders>`;
}
function computeColTwips(colCount, totalTwips, colWidths) {
  if (!colWidths || colWidths.length === 0) {
    const base = Math.floor(totalTwips / colCount);
    return Array.from(
      { length: colCount },
      (_, i) => i === colCount - 1 ? totalTwips - base * (colCount - 1) : base
    );
  }
  const fixed = [];
  const flexWeights = [];
  let fixedSum = 0;
  let flexSum = 0;
  for (let i = 0; i < colCount; i++) {
    const spec = colWidths[i];
    if (typeof spec === "number" && Number.isFinite(spec) && spec > 0) {
      fixed.push(null);
      flexWeights.push(spec);
      flexSum += spec;
    } else if (typeof spec === "string") {
      const s = spec.trim();
      const pct = s.match(/^(\d+(?:\.\d+)?)%$/);
      const fr = s.match(/^(\d+(?:\.\d+)?)fr$/);
      const cm = s.match(/^(\d+(?:\.\d+)?)cm$/);
      const mm = s.match(/^(\d+(?:\.\d+)?)mm$/);
      const pt = s.match(/^(\d+(?:\.\d+)?)pt$/);
      if (pct) {
        const w = Math.round(Number(pct[1]) / 100 * totalTwips);
        fixed.push(w);
        flexWeights.push(0);
        fixedSum += w;
      } else if (cm) {
        const w = cmToTwips(Number(cm[1]));
        fixed.push(w);
        flexWeights.push(0);
        fixedSum += w;
      } else if (mm) {
        const w = cmToTwips(Number(mm[1]) / 10);
        fixed.push(w);
        flexWeights.push(0);
        fixedSum += w;
      } else if (pt) {
        const w = Math.round(Number(pt[1]) * TWIPS_PER_PT);
        fixed.push(w);
        flexWeights.push(0);
        fixedSum += w;
      } else if (fr) {
        const val = Math.max(0.1, Number(fr[1]));
        fixed.push(null);
        flexWeights.push(val);
        flexSum += val;
      } else {
        fixed.push(null);
        flexWeights.push(1);
        flexSum += 1;
      }
    } else {
      fixed.push(null);
      flexWeights.push(1);
      flexSum += 1;
    }
  }
  const remaining = Math.max(colCount * 240, totalTwips - fixedSum);
  const out = fixed.map((f, i) => {
    if (f !== null) return Math.max(240, f);
    const share = flexSum > 0 ? flexWeights[i] / flexSum : 1 / colCount;
    return Math.max(240, Math.round(remaining * share));
  });
  const sum = out.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - totalTwips) > 0) {
    const scale = totalTwips / sum;
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      if (i === out.length - 1) {
        out[i] = Math.max(240, totalTwips - acc);
      } else {
        out[i] = Math.max(240, Math.round(out[i] * scale));
        acc += out[i];
      }
    }
  }
  return out;
}
function registerOrGetMedia(ctx, assetId) {
  const existing = ctx.mediaByAssetId.get(assetId);
  if (existing) return existing;
  const bytes = ctx.assetBytes[assetId];
  if (!bytes || bytes.length === 0) return null;
  const meta = ctx.packet.assets?.[assetId];
  const { ext, mime } = extFromAsset(meta);
  const idx = ctx.mediaList.length + 1;
  const embed = {
    relId: `rIdImg${idx}`,
    zipPath: `word/media/${assetId}.${ext}`,
    ext,
    mime,
    bytes,
    docPrId: ctx.nextDocPrId++
  };
  ctx.mediaByAssetId.set(assetId, embed);
  ctx.mediaList.push(embed);
  return embed;
}
function renderMediaParagraphXml(ctx, assetId, alt, maxWidthTwips, explicitWidthCm) {
  const embed = registerOrGetMedia(ctx, assetId);
  if (!embed) {
    return `<w:p><w:r>${renderRunProps({ italic: true, colorHex: "666666" })}<w:t xml:space="preserve">${escapeXml(`[Image: ${alt || assetId}]`)}</w:t></w:r></w:p>`;
  }
  const { widthPx, heightPx } = probeImageDimensions(embed.bytes);
  const maxWidthEmu = Math.round(maxWidthTwips / TWIPS_PER_PT * EMU_PER_PT);
  const desiredWidthEmu = explicitWidthCm && Number.isFinite(explicitWidthCm) && explicitWidthCm > 0 ? Math.min(maxWidthEmu, Math.round(explicitWidthCm * EMU_PER_CM)) : maxWidthEmu;
  const cx = Math.max(91440, desiredWidthEmu);
  const cy = Math.max(91440, Math.round(cx * (heightPx / Math.max(1, widthPx))));
  const docPrId = ctx.nextDocPrId++;
  const safeAlt = escapeXml(alt || assetId);
  const safeName = escapeXml(`${assetId}.${embed.ext}`);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${safeName}" descr="${safeAlt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${safeName}" descr="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embed.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function wrapTableCell(widthTwips, innerXml, extraTcPr = "") {
  const body = innerXml.trim().endsWith("</w:p>") ? innerXml : `${innerXml}<w:p/>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${extraTcPr}</w:tcPr>${body}</w:tc>`;
}
function renderBlockCoreXml(ctx, block, availTwips) {
  const isDe = ctx.locale === "de";
  const pStr = getGalleyStrings(ctx.locale).print;
  switch (block.type) {
    case "header": {
      const f = block.fields ?? { titel: "" };
      const labelColW = Math.min(cmToTwips(4), Math.round(availTwips * 0.4));
      const valColW = Math.max(400, availTwips - labelColW);
      const rowsXml = [];
      const metaRows = [];
      if (f.fach) metaRows.push({ label: isDe ? "Fach" : "Subject", value: f.fach });
      if (f.klasse) {
        const cleanVal = f.klasse.replace(/^(?:Group|Klasse)\s*:\s*/i, "");
        metaRows.push({ label: isDe ? "Klasse" : "Group", value: cleanVal });
      }
      if (f.datum) metaRows.push({ label: isDe ? "Datum" : "Date", value: f.datum });
      if (f.name !== void 0) {
        const hasVal = f.name.trim().length > 0;
        metaRows.push({
          label: "Name",
          value: hasVal ? f.name : "\xA0".repeat(28),
          underlineValue: true
        });
      }
      for (const row of metaRows) {
        const lblCell = wrapTableCell(
          labelColW,
          `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${renderTextRun(row.label, { bold: true, colorHex: "555555", sizeHalfPt: 18 })}</w:p>`
        );
        const valCell = wrapTableCell(
          valColW,
          `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${renderTextRun(row.value, { underline: row.underlineValue, sizeHalfPt: 19 })}</w:p>`
        );
        rowsXml.push(`<w:tr>${lblCell}${valCell}</w:tr>`);
      }
      const parts = [];
      if (f.titel || f.subtitle) {
        const hasSub = Boolean(f.subtitle && f.subtitle.trim().length > 0);
        if (f.titel) {
          const bdrXml = !hasSub ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="AAAAAA"/></w:pBdr>' : "";
          parts.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="${hasSub ? 20 : 80}"/>${bdrXml}</w:pPr>${renderTextRun(f.titel, { bold: true, sizeHalfPt: 32 })}</w:p>`
          );
        }
        if (hasSub) {
          parts.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="AAAAAA"/></w:pBdr></w:pPr>${renderTextRun(f.subtitle, { colorHex: "555555", sizeHalfPt: 21 })}</w:p>`
          );
        }
      }
      if (rowsXml.length > 0) {
        parts.push(
          `<w:tbl><w:tblPr><w:tblW w:w="${availTwips}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="30" w:type="dxa"/><w:bottom w:w="30" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${labelColW}"/><w:gridCol w:w="${valColW}"/></w:tblGrid>` + rowsXml.join("") + "</w:tbl>"
        );
      }
      return parts.join("");
    }
    case "heading": {
      const level = Math.max(1, Math.min(3, block.level ?? 1));
      return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${inlineToOoxml(block.body)}</w:p>`;
    }
    case "prose":
      return `<w:p>${inlineToOoxml(block.body)}</w:p>`;
    case "source_text": {
      const parts = [];
      if (block.title) {
        parts.push(
          `<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr>${renderTextRun(block.title, { bold: true })}</w:p>`
        );
      }
      parts.push(`<w:p>${inlineToOoxml(block.body)}</w:p>`);
      return parts.join("");
    }
    case "task": {
      const firstNode = block.body?.[0];
      const leadingText = firstNode?.t === "text" ? firstNode.v : firstNode?.t === "strong" && firstNode.c?.[0]?.t === "text" ? firstNode.c[0].v : "";
      const alreadyNumbered = /^\s*(?:Task|Problem|Question|Exercise|Aufgabe)\s+\d+\b/i.test(leadingText);
      if (alreadyNumbered) {
        return `<w:p>${inlineToOoxml(block.body)}</w:p>`;
      }
      return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${inlineToOoxml(block.body)}</w:p>`;
    }
    case "table": {
      const cols = Math.max(1, block.headers.length, ...block.rows.map((r) => r.length));
      const colTwips = computeColTwips(cols, availTwips, block.colWidths);
      const gridXml = `<w:tblGrid>${colTwips.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
      const hdrCells = [];
      for (let ci = 0; ci < cols; ci++) {
        const cellInlines = block.headers[ci] ?? [];
        const cellRuns = inlineToOoxml(cellInlines, { bold: true });
        hdrCells.push(
          wrapTableCell(
            colTwips[ci],
            `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${cellRuns}</w:p>`,
            '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>'
          )
        );
      }
      const headerRowXml = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${hdrCells.join("")}</w:tr>`;
      const bodyRowsXml = block.rows.map((row) => {
        const rowCells = [];
        for (let ci = 0; ci < cols; ci++) {
          const cellInlines = row[ci] ?? [];
          rowCells.push(
            wrapTableCell(
              colTwips[ci],
              `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${inlineToOoxml(cellInlines)}</w:p>`
            )
          );
        }
        return `<w:tr>${rowCells.join("")}</w:tr>`;
      });
      return `<w:tbl><w:tblPr><w:tblW w:w="${availTwips}" w:type="dxa"/>${singleBordersXml("B4B4B4", 4)}<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` + gridXml + headerRowXml + bodyRowsXml.join("") + "</w:tbl>";
    }
    case "callout": {
      const tone = block.tone ?? "info";
      const colors = CALLOUT_HEX[tone];
      const label = pStr.calloutLabels[tone] ?? tone;
      return `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${colors.accent}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${colors.fill}"/><w:ind w:left="160" w:right="160"/><w:spacing w:before="100" w:after="100"/></w:pPr>` + renderTextRun(label, { bold: true, colorHex: colors.accent, sizeHalfPt: 18 }) + "<w:r><w:br/></w:r>" + inlineToOoxml(block.body) + "</w:p>";
    }
    case "answer": {
      const firstNode = block.body?.[0];
      const leadingText = firstNode?.t === "text" ? firstNode.v : firstNode?.t === "strong" && firstNode.c?.[0]?.t === "text" ? firstNode.c[0].v : "";
      const alreadyPrefixed = /^\s*(?:Answer|Solution|Lösung)\b/i.test(leadingText);
      let prefixXml = "";
      if (!alreadyPrefixed && block.dependsOn && block.dependsOn.length > 0) {
        const originId = block.dependsOn[0].id;
        const taskNum = ctx.taskIndexByBlockId.get(originId);
        const label = isDe ? taskNum ? `L\xF6sung (${pStr.taskPrefix} ${taskNum}): ` : "L\xF6sung: " : taskNum ? `Answer (${pStr.taskPrefix} ${taskNum}): ` : "Answer: ";
        prefixXml = renderTextRun(label, { bold: true });
      }
      return `<w:p>${prefixXml}${inlineToOoxml(block.body)}</w:p>`;
    }
  }
}
function renderBlockWithSlotXml(ctx, block) {
  const slot = block.slot ?? { mode: "full" };
  const totalW = ctx.contentWidthTwips;
  switch (slot.mode) {
    case "media-right":
    case "media-left": {
      const gutterTwips = 160;
      const mediaW = Math.round((totalW - gutterTwips) * 0.35);
      const textW = totalW - mediaW;
      const bodyXml = renderBlockCoreXml(ctx, block, textW - 120);
      const imgXml = slot.asset ? renderMediaParagraphXml(ctx, slot.asset.id, slot.asset.alt, mediaW - 120, slot.asset.widthCm) : "<w:p/>";
      const leftCell = slot.mode === "media-left" ? wrapTableCell(mediaW, imgXml) : wrapTableCell(textW, bodyXml);
      const rightCell = slot.mode === "media-left" ? wrapTableCell(textW, bodyXml) : wrapTableCell(mediaW, imgXml);
      const col1W = slot.mode === "media-left" ? mediaW : textW;
      const col2W = slot.mode === "media-left" ? textW : mediaW;
      return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${col1W}"/><w:gridCol w:w="${col2W}"/></w:tblGrid><w:tr>${leftCell}${rightCell}</w:tr></w:tbl>`;
    }
    case "two-column": {
      const body = block.body;
      const split = body ? splitInlinesTwoColumn(body) : null;
      if (!split) {
        return renderBlockCoreXml(ctx, block, totalW);
      }
      const col1W = Math.floor(totalW / 2);
      const col2W = totalW - col1W;
      const c1 = wrapTableCell(col1W, `<w:p>${inlineToOoxml(split[0])}</w:p>`);
      const c2 = wrapTableCell(col2W, `<w:p>${inlineToOoxml(split[1])}</w:p>`);
      return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${col1W}"/><w:gridCol w:w="${col2W}"/></w:tblGrid><w:tr>${c1}${c2}</w:tr></w:tbl>`;
    }
    case "card-grid": {
      const cols = slot.columns ?? 3;
      const heightTwips = cmToTwips(slot.cardHeightCm ?? 6);
      const colWidths = computeColTwips(cols, totalW);
      const cells = cardInlineCells(block);
      const rowsXml = [];
      for (let r = 0; r < cells.length; r += cols) {
        const rowTcs = [];
        for (let c = 0; c < cols; c++) {
          const item = cells[r + c];
          const pXml = item ? `<w:p>${inlineToOoxml(item)}</w:p>` : "<w:p/>";
          rowTcs.push(
            wrapTableCell(
              colWidths[c],
              pXml,
              '<w:shd w:val="clear" w:color="auto" w:fill="FBFBFB"/>'
            )
          );
        }
        rowsXml.push(
          `<w:tr><w:trPr><w:trHeight w:val="${heightTwips}" w:hRule="atLeast"/></w:trPr>${rowTcs.join("")}</w:tr>`
        );
      }
      return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${singleBordersXml("828282", 4)}<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${colWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` + rowsXml.join("") + "</w:tbl>";
    }
    default:
      return renderBlockCoreXml(ctx, block, totalW);
  }
}
function buildContentTypesXml(mediaExts) {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>'
  ];
  const sortedExts = [...mediaExts.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [ext, mime] of sortedExts) {
    defaults.push(`<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(mime)}"/>`);
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + defaults.join("") + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>';
}
function buildRootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>';
}
function buildDocumentRelsXml(mediaList) {
  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  ];
  for (const m of mediaList) {
    const relTarget = m.zipPath.replace(/^word\//, "");
    rels.push(
      `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(relTarget)}"/>`
    );
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join("") + "</Relationships>";
}
function buildStylesXml(locale) {
  const langTag = locale === "de" ? "de-DE" : "en-US";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans" w:cs="Liberation Sans"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="${langTag}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="CodeChar"/><w:rPr><w:rFonts w:ascii="Liberation Mono" w:hAnsi="Liberation Mono" w:cs="Liberation Mono"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style></w:styles>`;
}
function buildNumberingXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
}
function buildCorePropsXml(sheet, packet, agentBlockIds) {
  const created = parseIsoTimestamp(packet.createdAt);
  const modified = parseIsoTimestamp(packet.updatedAt);
  const blockList = agentBlockIds.length > 0 ? agentBlockIds.join(", ") : "none";
  const comments = `Co-authored with DeepSeek Harness (dsh-galley); AI-assisted blocks: ${blockList}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(sheet.title)}</dc:title><dc:creator>dsh-galley</dc:creator><dc:description>${escapeXml(comments)}</dc:description><cp:lastModifiedBy>dsh-galley</cp:lastModifiedBy><cp:revision>${Math.max(1, packet.rev)}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(modified)}</dcterms:modified></cp:coreProperties>`;
}
function buildAppPropsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DeepSeek Harness (dsh-galley)</Application></Properties>';
}
function buildCustomPropsXml(agentBlockIds, packetId) {
  const fmtid = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
  const blockList = agentBlockIds.length > 0 ? agentBlockIds.join(", ") : "none";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="${fmtid}" pid="2" name="AIAssistance"><vt:bool>true</vt:bool></property><property fmtid="${fmtid}" pid="3" name="AIAssistedBlocks"><vt:lpwstr>${escapeXml(blockList)}</vt:lpwstr></property><property fmtid="${fmtid}" pid="4" name="GalleyPacketId"><vt:lpwstr>${escapeXml(packetId)}</vt:lpwstr></property></Properties>`;
}
function exportSheetDocx(sheet, packet, assetBytes = {}) {
  const locale = packet.locale === "de" ? "de" : "en";
  const geom = sheet.geometry;
  const isLandscape = geom.orientation === "landscape";
  const basePaper = PAPER_TWIPS[geom.paper] ?? PAPER_TWIPS.a4;
  const pageW = isLandscape ? basePaper.h : basePaper.w;
  const pageH = isLandscape ? basePaper.w : basePaper.h;
  const marginTop = cmToTwips(geom.margin.top);
  const marginRight = cmToTwips(geom.margin.right);
  const marginBottom = cmToTwips(geom.margin.bottom);
  const marginLeft = cmToTwips(geom.margin.left);
  const contentWidthTwips = Math.max(2880, pageW - marginLeft - marginRight);
  const taskIndexByBlockId = /* @__PURE__ */ new Map();
  for (const sid of packet.sheetOrder) {
    const sh = packet.sheets[sid];
    if (!sh) continue;
    let n = 0;
    for (const b of sh.blocks) {
      if (b.type === "task") {
        n += 1;
        taskIndexByBlockId.set(b.id, n);
      }
    }
  }
  const ctx = {
    packet,
    sheet,
    locale,
    contentWidthTwips,
    assetBytes,
    mediaByAssetId: /* @__PURE__ */ new Map(),
    mediaList: [],
    nextDocPrId: 1,
    taskIndexByBlockId
  };
  const bodyParts = [];
  const firstBlk = sheet.blocks[0];
  const hasOwnBanner = sheet.blocks.some((b) => b.type === "header") || firstBlk?.type === "heading" && (firstBlk.level ?? 1) === 1;
  if (!hasOwnBanner && sheet.title.trim().length > 0) {
    bodyParts.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${renderTextRun(sheet.title)}</w:p>`
    );
  }
  let sectionLineNumbers;
  for (const block of sheet.blocks) {
    if (block.type === "source_text" && block.lineNumbers && !sectionLineNumbers) {
      sectionLineNumbers = block.lineNumbers;
    }
    const xml = renderBlockWithSlotXml(ctx, block);
    if (xml) bodyParts.push(xml);
    if (xml.endsWith("</w:tbl>")) {
      bodyParts.push('<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr></w:p>');
    }
  }
  if (bodyParts.length === 0) {
    bodyParts.push("<w:p/>");
  }
  const lnNumXml = sectionLineNumbers ? `<w:lnNumType w:countBy="${Math.max(1, sectionLineNumbers.every)}" w:start="${Math.max(1, sectionLineNumbers.start ?? 1)}" w:restart="newPage"/>` : "";
  const orientAttr = isLandscape ? ' w:orient="landscape"' : "";
  const sectPrXml = `<w:sectPr><w:pgSz w:w="${pageW}" w:h="${pageH}"${orientAttr}/><w:pgMar w:top="${marginTop}" w:right="${marginRight}" w:bottom="${marginBottom}" w:left="${marginLeft}" w:header="708" w:footer="708" w:gutter="0"/>` + lnNumXml + "</w:sectPr>";
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${bodyParts.join("")}${sectPrXml}</w:body></w:document>`;
  const agentBlockIds = sheet.blocks.filter((b) => b.origin === "agent").map((b) => b.id);
  const mediaExts = /* @__PURE__ */ new Map();
  for (const m of ctx.mediaList) mediaExts.set(m.ext, m.mime);
  const zipEntries = [
    { name: "[Content_Types].xml", data: Buffer.from(buildContentTypesXml(mediaExts), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(buildRootRelsXml(), "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(buildAppPropsXml(), "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(buildCorePropsXml(sheet, packet, agentBlockIds), "utf8") },
    { name: "docProps/custom.xml", data: Buffer.from(buildCustomPropsXml(agentBlockIds, packet.id), "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(buildDocumentRelsXml(ctx.mediaList), "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/numbering.xml", data: Buffer.from(buildNumberingXml(), "utf8") },
    { name: "word/styles.xml", data: Buffer.from(buildStylesXml(locale), "utf8") },
    ...ctx.mediaList.map((m) => ({ name: m.zipPath, data: m.bytes, storeOnly: true }))
  ];
  return buildDeterministicZip(zipEntries);
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
  if (!Array.isArray(inlines)) {
    return isInlineObject(inlines) ? inlineText([inlines]) : typeof inlines === "string" ? inlines : "";
  }
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
      const f = block.fields ?? { titel: "" };
      return [f.titel, f.subtitle, f.fach, f.klasse, f.datum, f.name].filter(Boolean).join(" \xB7 ");
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
  if (typeof body === "string") return parseInlines(body);
  if (Array.isArray(body)) return body;
  if (isInlineObject(body)) return [body];
  return parseInlines(body === void 0 || body === null ? "" : String(body));
}
function isInlineObject(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const t = x.t;
  return t === "text" || t === "strong" || t === "emph" || t === "code" || t === "cloze" || t === "math" || t === "newline";
}
function normalizeTableCell(rawCell) {
  if (rawCell === null || rawCell === void 0) return { cell: [], error: null };
  if (typeof rawCell === "string") {
    const parsed = parseInlines(rawCell);
    const e = validateInline(parsed);
    return e ? { cell: [], error: e } : { cell: parsed, error: null };
  }
  if (isInlineObject(rawCell)) {
    const e = validateInline([rawCell]);
    return e ? { cell: [], error: e } : { cell: [rawCell], error: null };
  }
  if (Array.isArray(rawCell)) {
    const out = [];
    for (const item of rawCell) {
      if (typeof item === "string") out.push({ t: "text", v: item });
      else if (isInlineObject(item)) out.push(item);
      else return { cell: [], error: "invalid_block" };
    }
    if (out.length > 0) {
      const e = validateInline(out);
      if (e) return { cell: [], error: e };
    }
    return { cell: out, error: null };
  }
  return { cell: [], error: "invalid_block" };
}
function normalizeTableHeaders(rawHeaders) {
  if (rawHeaders === void 0 || rawHeaders === null) return { headers: [], error: null };
  if (!Array.isArray(rawHeaders)) return { headers: [], error: "invalid_block" };
  const headers = [];
  for (const c of rawHeaders) {
    const res = normalizeTableCell(c);
    if (res.error) return { headers: [], error: res.error };
    headers.push(res.cell);
  }
  return { headers, error: null };
}
function normalizeTableRows(rawRows) {
  if (rawRows === void 0 || rawRows === null) return { rows: [], error: null };
  if (!Array.isArray(rawRows)) return { rows: [], error: "invalid_block" };
  const rows = [];
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) return { rows: [], error: "invalid_block" };
    const row = [];
    for (const c of rawRow) {
      const res = normalizeTableCell(c);
      if (res.error) return { rows: [], error: res.error };
      row.push(res.cell);
    }
    rows.push(row);
  }
  return { rows, error: null };
}
function normalizeTableColWidths(rawWidths) {
  if (rawWidths === void 0 || rawWidths === null) return { colWidths: void 0, error: null };
  if (!Array.isArray(rawWidths)) return { colWidths: void 0, error: "invalid_block" };
  const out = [];
  for (const w of rawWidths) {
    if (typeof w === "number" && Number.isFinite(w) && w > 0) {
      out.push(w);
    } else if (typeof w === "string" && /^(\d+(\.\d+)?(%|fr|pt|cm|mm|em)|auto)$/.test(w.trim())) {
      out.push(w.trim());
    } else {
      return { colWidths: void 0, error: "invalid_block" };
    }
  }
  return { colWidths: out.length > 0 ? out : void 0, error: null };
}
function normalizeDependsOn(packet, rawDeps, now) {
  if (rawDeps === void 0 || rawDeps === null) return { deps: [], error: null };
  if (!Array.isArray(rawDeps)) return { deps: [], error: "invalid_op" };
  const deps = [];
  for (const item of rawDeps) {
    if (typeof item === "string") {
      const target = findBlock(packet, item);
      deps.push({ id: item, sinceHash: target ? target.block.hash : "", at: now });
    } else if (item && typeof item === "object" && typeof item.id === "string") {
      const d = item;
      const target = findBlock(packet, d.id);
      const sinceHash = typeof d.sinceHash === "string" && d.sinceHash.length > 0 ? d.sinceHash : target ? target.block.hash : "";
      deps.push({ id: d.id, sinceHash, at: typeof d.at === "string" ? d.at : now });
    } else {
      return { deps: [], error: "invalid_op" };
    }
  }
  return { deps, error: null };
}
var KNOWN_HEADER_KEYS = /* @__PURE__ */ new Set([
  "titel",
  "title",
  "subtitle",
  "untertitel",
  "fach",
  "subject",
  "klasse",
  "group",
  "meta",
  "datum",
  "date",
  "name",
  "_unknownKeys"
]);
function normalizeHeaderFields(rawFields) {
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) return { titel: "" };
  const f = rawFields;
  const str = (v) => typeof v === "string" ? v : void 0;
  const out = {
    titel: str(f.titel) ?? str(f.title) ?? ""
  };
  const subtitle = str(f.subtitle) ?? str(f.untertitel);
  if (subtitle !== void 0 && subtitle !== "") out.subtitle = subtitle;
  const fach = str(f.fach) ?? str(f.subject);
  if (fach !== void 0) out.fach = fach;
  const klasse = str(f.klasse) ?? str(f.group) ?? str(f.meta);
  if (klasse !== void 0) out.klasse = klasse;
  const datum = str(f.datum) ?? str(f.date);
  if (datum !== void 0) out.datum = datum;
  if ("name" in f && f.name !== void 0 && f.name !== null) {
    out.name = String(f.name);
  }
  const unknown = Object.keys(f).filter(
    (k) => !KNOWN_HEADER_KEYS.has(k) && f[k] !== void 0 && f[k] !== null && f[k] !== ""
  );
  if (unknown.length > 0) {
    out._unknownKeys = unknown.sort();
  }
  return out;
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
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const normDeps = normalizeDependsOn(packet, raw.dependsOn, now);
  if (normDeps.error) return { block: null, error: normDeps.error };
  const id = raw.id || allocateBlockId(packet);
  const base = {
    id,
    type,
    hash: "",
    dependsOn: normDeps.deps,
    slot,
    origin,
    updatedAt: now,
    stale: null
  };
  switch (type) {
    case "header":
      base.fields = normalizeHeaderFields(raw.fields);
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
    case "table": {
      const hRes = normalizeTableHeaders(raw.headers);
      if (hRes.error) return { block: null, error: hRes.error };
      const rRes = normalizeTableRows(raw.rows);
      if (rRes.error) return { block: null, error: rRes.error };
      const wRes = normalizeTableColWidths(raw.colWidths);
      if (wRes.error) return { block: null, error: wRes.error };
      base.headers = hRes.headers;
      base.rows = rRes.rows;
      if (wRes.colWidths) base.colWidths = wRes.colWidths;
      break;
    }
    case "callout":
      base.tone = raw.tone ?? "info";
      base.body = bodyInlines;
      break;
  }
  const block = base;
  block.hash = hashBlock(block);
  return { block, error: null };
}
function toReceipt(sr, packet, sheet) {
  const tp = sheet?.geometry?.targetPages;
  return {
    ...sheet?.id ? { sheetId: sheet.id } : {},
    pages: sr.pages,
    perPage: sr.perPage,
    lastPageLineCount: sr.lastPageLineCount,
    overflowLinesOnLastPage: sr.overflowLinesOnLastPage,
    targetPages: tp ?? null,
    targetPagesMet: tp !== void 0 ? sr.pages <= tp : null,
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
      out[sid] = toReceipt(sr, packet, sheet);
    } catch {
      const tp = sheet.geometry.targetPages;
      out[sid] = {
        sheetId: sid,
        pages: 0,
        perPage: [],
        lastPageLineCount: 0,
        overflowLinesOnLastPage: 0,
        targetPages: tp ?? null,
        targetPagesMet: tp !== void 0 ? false : null,
        compiledAtRev: packet.rev
      };
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
  const isLegacyFastPath = template === "rfc" || template === "generic";
  const customBlueprint = !isLegacyFastPath ? registry.getTemplate(template, store) : null;
  if (!isLegacyFastPath && !customBlueprint) {
    return fail(Err.INVALID_PARAMS, `unknown template '${template}'`);
  }
  try {
    const id = "p-" + base32(randomBytes2(8), 8);
    const packetTitle = args.title ?? (customBlueprint ? customBlueprint.title : "Document");
    const packetLocale = args.locale ?? customBlueprint?.locale;
    const packet = {
      id,
      template,
      title: packetTitle,
      ...packetLocale ? { locale: packetLocale } : {},
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
          title: idx === 0 && args.title ? args.title : bs.title || `Sheet ${idx + 1}`,
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
          const blockOrigin = seedOrigin === "human" && (customBlueprint.source === "builtin" || customBlueprint.source === "plugin") ? "agent" : seedOrigin;
          const { block, error } = buildBlock(packet, clonedRaw, blockOrigin);
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
          ...args.targetPages !== void 0 ? { targetPages: args.targetPages } : {}
        },
        blocks: []
      };
      packet.sheetOrder = [sheetId];
      packet.sheets[sheetId] = sheet;
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
    recentChanges: deps.store.listJournal(pid),
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
  const inReviewMode = (packet.reviewMode ?? "auto") === "review";
  if (args.op === "sheet-add" || args.op === "sheet-update" || args.op === "sheet-remove") {
    if (inReviewMode && args.origin === "agent") {
      return fail(Err.INVALID_PARAMS, "packet is locked in review mode; unlock auto mode before sheet structure edits");
    }
    try {
      let targetSid;
      if (args.op === "sheet-add") {
        if (args.targetPages !== void 0 && args.targetPages !== null && (!Number.isFinite(args.targetPages) || args.targetPages < 0)) {
          return fail(Err.INVALID_PARAMS, "targetPages must be >= 1 (or 0/null for unbounded)");
        }
        if (args.orientation !== void 0 && args.orientation !== "portrait" && args.orientation !== "landscape") {
          return fail(Err.INVALID_PARAMS, `invalid orientation '${String(args.orientation)}'`);
        }
        if (args.paper !== void 0 && args.paper !== "a4" && args.paper !== "letter") {
          return fail(Err.INVALID_PARAMS, `invalid paper '${String(args.paper)}'`);
        }
        const added = store.addSheet(pid, {
          title: args.title,
          orientation: args.orientation,
          targetPages: args.targetPages && args.targetPages > 0 ? args.targetPages : void 0,
          paper: args.paper,
          actor: args.origin
        });
        targetSid = added.sheetId;
      } else if (args.op === "sheet-update") {
        const sid = args.sheetId ?? (packet.sheetOrder.length === 1 ? packet.sheetOrder[0] : void 0);
        if (!sid) {
          return fail(Err.INVALID_PARAMS, `multi-sheet packet (${packet.sheetOrder.join(", ")}): pass sheetId on sheet-update`);
        }
        if (!packet.sheets[sid]) return fail(Err.SHEET_NOT_FOUND, `sheet ${sid} not found`);
        if (args.title === void 0 && args.targetPages === void 0 && args.orientation === void 0 && args.paper === void 0) {
          return fail(Err.INVALID_PARAMS, "sheet-update requires at least one of title, targetPages, orientation, or paper");
        }
        store.updateSheet(
          pid,
          sid,
          {
            ...args.title !== void 0 ? { title: args.title } : {},
            ...args.targetPages !== void 0 ? { targetPages: args.targetPages } : {},
            ...args.orientation !== void 0 ? { orientation: args.orientation } : {},
            ...args.paper !== void 0 ? { paper: args.paper } : {}
          },
          args.origin
        );
        targetSid = sid;
      } else {
        if (!args.sheetId) return fail(Err.INVALID_PARAMS, "sheet-remove requires sheetId");
        if (!packet.sheets[args.sheetId]) return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`);
        const updated = store.removeSheet(pid, args.sheetId, args.origin);
        targetSid = updated.sheetOrder[0];
      }
      const loaded = store.load(pid);
      const sh = loaded.sheets[targetSid];
      const proof = deps.render && sh ? await (async () => {
        try {
          return toReceipt(
            await deps.render(sh, loaded, assetBytesForPacket(deps, loaded)),
            loaded,
            sh
          );
        } catch {
          return null;
        }
      })() : null;
      return {
        ok: true,
        applied: true,
        packetId: pid,
        sheetId: targetSid,
        sheetOrder: loaded.sheetOrder,
        rev: loaded.rev,
        block: null,
        proposal: null,
        proof,
        staleDependents: staleBlockIds(loaded)
      };
    } catch (e) {
      return mapError(e);
    }
  }
  if (args.sheetId !== void 0 && !packet.sheets[args.sheetId]) {
    return fail(Err.SHEET_NOT_FOUND, `sheet ${args.sheetId} not found`);
  }
  const insertAfterId = args.op === "insert" ? args.afterId ?? args.afterBlockId : void 0;
  const insertAnchorId = args.op === "insert" ? args.beforeId ?? insertAfterId : void 0;
  const locatedAnchor = insertAnchorId ? findBlock(packet, insertAnchorId) : null;
  if (insertAnchorId && !locatedAnchor) {
    return fail(Err.BLOCK_NOT_FOUND, `anchor block ${insertAnchorId} not found`);
  }
  if (locatedAnchor && args.sheetId !== void 0 && args.sheetId !== locatedAnchor.sheet.id) {
    return fail(
      Err.INVALID_PARAMS,
      `anchor block ${insertAnchorId} belongs to sheet ${locatedAnchor.sheet.id}, not ${args.sheetId}`
    );
  }
  let resolvedSheetId;
  if (args.op === "insert") {
    if (args.sheetId !== void 0) {
      resolvedSheetId = args.sheetId;
    } else if (locatedAnchor) {
      resolvedSheetId = locatedAnchor.sheet.id;
    } else if (packet.sheetOrder.length === 1) {
      resolvedSheetId = packet.sheetOrder[0];
    } else {
      return fail(
        Err.INVALID_PARAMS,
        `multi-sheet packet (${packet.sheetOrder.join(", ")}): pass sheetId (or beforeId/afterId) on insert`
      );
    }
  } else {
    const locatedPre2 = args.blockId ? findBlock(packet, args.blockId) : null;
    resolvedSheetId = args.sheetId ?? (locatedPre2 ? locatedPre2.sheet.id : packet.sheetOrder[0]);
  }
  const locatedPre = args.blockId ? findBlock(packet, args.blockId) : null;
  const sheet = packet.sheets[resolvedSheetId];
  if (!sheet) return fail(Err.SHEET_NOT_FOUND, `sheet ${resolvedSheetId} not found`);
  let effectiveBeforeId = args.beforeId;
  if (!effectiveBeforeId && insertAfterId) {
    const idx = sheet.blocks.findIndex((b) => b.id === insertAfterId);
    if (idx >= 0 && idx + 1 < sheet.blocks.length) {
      effectiveBeforeId = sheet.blocks[idx + 1].id;
    }
  }
  try {
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
          proposedPatch: { block: built, beforeId: effectiveBeforeId },
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
      const propSheetId = prop.sheetId ?? resolvedSheetId;
      const proofProp = renderProp ? await (async () => {
        try {
          const propSheet = loadedProp.sheets[propSheetId];
          return toReceipt(
            await renderProp(propSheet, loadedProp, assetBytesForPacket(deps, loadedProp)),
            loadedProp,
            propSheet
          );
        } catch {
          return null;
        }
      })() : null;
      return {
        ok: true,
        applied: false,
        packetId: pid,
        sheetId: propSheetId,
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
    let commitNote = "";
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
            const idx = effectiveBeforeId ? sh.blocks.findIndex((b) => b.id === effectiveBeforeId) : sh.blocks.length;
            sh.blocks.splice(idx < 0 ? sh.blocks.length : idx, 0, block2);
            p.nextBlockSeq += 1;
            changedId = block2.id;
            commitNote = `insert ${block2.id} (${block2.type}) on ${resolvedSheetId} (${args.origin})`;
            return block2.id;
          }
          case "patch": {
            if (!args.blockId) throw new StoreError("invalid_op", "patch requires blockId");
            const found = findBlock(p, args.blockId);
            if (!found) throw new StoreError("not_found", `block ${args.blockId} not found`);
            touchedSheetId = found.sheet.id;
            const b = found.block;
            const now = deps.now ? deps.now() : (/* @__PURE__ */ new Date()).toISOString();
            const patchInput = args.patch ?? {};
            let contentTouched = false;
            for (const [k, v] of Object.entries(patchInput)) {
              if (k === "body") {
                const inlines = toInline(v);
                if (inlines.length > 0) {
                  const e = validateInline(inlines);
                  if (e) throw new StoreError(e, "inline limit");
                }
                b.body = inlines;
                contentTouched = true;
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
                const norm = normalizeDependsOn(p, v, now);
                if (norm.error) throw new StoreError(norm.error, "dependsOn must be a valid array");
                b.dependsOn = norm.deps;
              } else if (k === "headers") {
                const hRes = normalizeTableHeaders(v);
                if (hRes.error) throw new StoreError(hRes.error, "invalid table headers");
                b.headers = hRes.headers;
                contentTouched = true;
              } else if (k === "rows") {
                const rRes = normalizeTableRows(v);
                if (rRes.error) throw new StoreError(rRes.error, "invalid table rows");
                b.rows = rRes.rows;
                contentTouched = true;
              } else if (k === "colWidths") {
                const wRes = normalizeTableColWidths(v);
                if (wRes.error) throw new StoreError(wRes.error, "invalid table colWidths");
                if (wRes.colWidths) b.colWidths = wRes.colWidths;
                else delete b.colWidths;
                contentTouched = true;
              } else if (k === "fields") {
                b.fields = normalizeHeaderFields(v);
                contentTouched = true;
              } else if (["level", "tone", "numbered", "title", "lineNumbers"].includes(k)) {
                b[k] = v;
                contentTouched = true;
              }
            }
            if (contentTouched && !("dependsOn" in patchInput) && Array.isArray(b.dependsOn) && b.dependsOn.length > 0) {
              b.dependsOn = b.dependsOn.map((d) => {
                const originBlk = findBlock(p, d.id);
                return originBlk ? { id: d.id, sinceHash: originBlk.block.hash, at: now } : d;
              });
            }
            if (args.origin === "human") b.origin = "human";
            if (b.body) {
              const e = validateInline(b.body);
              if (e) throw new StoreError(e, "inline limit");
            }
            changedId = found.block.id;
            const patchedKeys = Object.keys(patchInput).join(",") || "noop";
            commitNote = `patch ${found.block.id} (${found.block.type}:${patchedKeys}) on ${touchedSheetId} (${args.origin})`;
            return found.block.id;
          }
          case "move": {
            const id = args.blockId;
            if (!id) throw new StoreError("invalid_op", "move requires blockId");
            const from = findBlock(p, id);
            if (!from) throw new StoreError("not_found", `block ${id} not found`);
            const fromSid = from.sheet.id;
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
            commitNote = fromSid === targetSheet.id ? `move ${id} within ${targetSheet.id} (${args.origin})` : `move ${id} ${fromSid}\u2192${targetSheet.id} (${args.origin})`;
            return id;
          }
          case "remove": {
            if (!args.blockId) throw new StoreError("invalid_op", "remove requires blockId");
            const found = findBlock(p, args.blockId);
            if (!found) throw new StoreError("not_found", `block ${args.blockId} not found`);
            found.sheet.blocks.splice(found.index, 1);
            touchedSheetId = found.sheet.id;
            changedId = found.block.id;
            commitNote = `remove ${found.block.id} (${found.block.type}) from ${touchedSheetId} (${args.origin})`;
            return found.block.id;
          }
        }
        return null;
      },
      { actor: args.origin, note: () => commitNote || `edit (${args.origin})` }
    );
    const loaded = store.load(pid);
    const render = deps.render;
    const proof = render ? await (async () => {
      try {
        const touchedSheet = loaded.sheets[touchedSheetId];
        return toReceipt(
          await render(touchedSheet, loaded, assetBytesForPacket(deps, loaded)),
          loaded,
          touchedSheet
        );
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
      sheetId: touchedSheetId,
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
  const de = title.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
  const s = de.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase();
  return s || "galley";
}
async function galleyExport(deps, args) {
  const pid = resolvePacketId(deps, args.packetId);
  if (typeof pid !== "string") return pid;
  const packet = deps.store.load(pid);
  if (!["typ", "md", "tex", "pdf", "docx"].includes(args.format)) {
    return fail(Err.INVALID_PARAMS, `unknown export format '${args.format}'`);
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
    const packetAssetBytes = args.format === "pdf" || args.format === "docx" ? assetBytesForPacket(deps, packet) : {};
    if (args.outDir) {
      mkdirSync2(join3(args.outDir, "galley-exports"), { recursive: true });
    }
    for (let i = 0; i < targetIds.length; i++) {
      const sid = targetIds[i];
      const sheet = packet.sheets[sid];
      let text;
      let bytes;
      let pages = null;
      switch (args.format) {
        case "typ":
          text = compileSheet(sheet, packet.assets, packet.locale).typ;
          bytes = Buffer.from(text, "utf8");
          break;
        case "md":
          text = toMarkdown(sheet, packet.locale);
          bytes = Buffer.from(text, "utf8");
          break;
        case "tex":
          text = toTex(sheet);
          bytes = Buffer.from(text, "utf8");
          break;
        case "docx":
          bytes = exportSheetDocx(sheet, packet, packetAssetBytes);
          break;
        case "pdf": {
          if (!deps.render) return fail(Err.TYPST_COMPILE_ERROR, "no render arm available for pdf");
          const sr = await deps.render(sheet, packet, packetAssetBytes);
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
        firstBytes = args.format === "pdf" || args.format === "docx" ? bytes : void 0;
      }
      if (args.outDir) {
        const omitSheetSuffix = packet.sheetOrder.length === 1;
        const filename = omitSheetSuffix ? `${slug}.${args.format}` : `${slug}-${sid}.${args.format}`;
        const relPath = `galley-exports/${filename}`;
        writeFileSync2(join3(args.outDir, relPath), bytes);
        files.push({
          sheetId: sid,
          path: relPath,
          format: args.format,
          pages,
          sizeBytes: bytes.length,
          sha256: createHash3("sha256").update(bytes).digest("hex")
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
function mdCell(inlines) {
  return inlineToMarkdown(inlines).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}
function toMarkdown(sheet, locale) {
  const pStr = getGalleyStrings(locale).print;
  const isDe = locale === "de";
  const L = [`# ${sheet.title}`, ""];
  let taskNum = 0;
  for (const b of sheet.blocks) {
    if (b.type === "header") {
      const f = b.fields ?? { titel: "" };
      const meta = [];
      if (f.subtitle) meta.push(f.subtitle);
      if (f.fach) meta.push(isDe ? `Fach: ${f.fach}` : f.fach);
      if (f.klasse) meta.push(f.klasse.includes(":") ? f.klasse : `${pStr.groupPrefix}${f.klasse}`);
      if (f.datum) meta.push(isDe ? `Datum: ${f.datum}` : f.datum);
      if (f.name !== void 0) {
        meta.push(f.name ? `${pStr.namePrefix}${f.name}` : `${pStr.namePrefix}________________________`);
      }
      L.push(`**${f.titel ?? ""}**${meta.length > 0 ? ` \xB7 ${meta.join(" \xB7 ")}` : ""}`);
    } else if (b.type === "heading") {
      L.push(`${"#".repeat(b.level)} ${inlineToMarkdown(b.body)}`);
    } else if (b.type === "source_text") {
      if (b.title) L.push(`### ${b.title}`);
      L.push(inlineToMarkdown(b.body));
    } else if (b.type === "task") {
      taskNum += 1;
      const bodyMd = inlineToMarkdown(b.body);
      const hasPrefix = /^\*{0,2}\s*(?:Task|Problem|Question|Exercise|Aufgabe)\s+\d+\b/i.test(bodyMd);
      L.push(hasPrefix ? bodyMd : `**${pStr.taskPrefix} ${taskNum}:** ${bodyMd}`);
    } else if (b.type === "table") {
      const colCount = Math.max(
        b.headers.length,
        ...b.rows.map((r) => r.length),
        1
      );
      const headerCells = Array.from({ length: colCount }, (_, i) => {
        const text = b.headers[i] ? mdCell(b.headers[i]) : "";
        return text ? `**${text}**` : "";
      });
      L.push(`| ${headerCells.join(" | ")} |`);
      L.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
      for (const row of b.rows) {
        const rowCells = Array.from({ length: colCount }, (_, i) => row[i] ? mdCell(row[i]) : "");
        L.push(`| ${rowCells.join(" | ")} |`);
      }
    } else if (b.type === "callout") {
      L.push(`> [${b.tone}] ${inlineToMarkdown(b.body).replace(/\n/g, "\n> ")}`);
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
  BUILTIN_TEMPLATES,
  DEFAULT_LOCALE,
  Err,
  GALLEY_I18N,
  GalleyServiceRegistry,
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
  clearSessionActivePacket,
  computeStale,
  createGalleyHttpDispatcher,
  createsCycle,
  defaultGalleyRegistry,
  exportSheetDocx,
  exportSlug,
  findBlock,
  galleyAnnotate,
  galleyEditBlock,
  galleyExport,
  galleyOpen,
  galleyReadBlock,
  galleyStatus,
  getGalleyStrings,
  getSessionActivePacket,
  getStoreForCwd,
  hashBlock,
  hashContent,
  httpStatusForCode,
  inlineText,
  makeDepEdge,
  mapError,
  mapStoreCode,
  normalizeHeaderFields,
  noteGalleyCwd,
  parseInlines,
  probeImageDimensions,
  recomputeStale,
  resolveGalleyCwd,
  resolveGalleyRoot,
  resolvePacketId,
  serializeInlines,
  setSessionActivePacket,
  splitInlinesTwoColumn,
  splitSvgPages,
  staleBlockIds,
  unpackDocxEntries,
  validateInline,
  validateSlot
};
//# sourceMappingURL=galley-core.mjs.map
