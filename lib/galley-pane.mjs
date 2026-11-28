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

// src/shared/i18n.ts
var GALLEY_I18N = {
  en: {
    print: {
      typstLang: "en",
      headerEyebrow: "DOCUMENT",
      groupPrefix: "Group: ",
      namePrefix: "Name: ",
      taskPrefix: "Task",
      defaultColophon: "Typeset with dsh-galley",
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
      defaultColophon: "Gesetzt mit dsh-galley",
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

// src/client/paneModel.ts
var WIDE_PANE_MIN_PX = 480;
var POLL_IDLE_MS = 2e3;
var POLL_POST_MUTATION_MS = 1e3;
var POLL_CATCHUP_MS = 150;
var POLL_HIDDEN_MS = 1e4;
var POLL_RETRY_MS = 2e3;
function computePaneMode(widthPx, override) {
  if (override === "wide") return "wide";
  if (override === "narrow") return "narrow";
  return widthPx >= WIDE_PANE_MIN_PX ? "wide" : "narrow";
}
function nextPollDelayMs(opts) {
  if (opts.hidden) return POLL_HIDDEN_MS;
  if (opts.hadError) return POLL_RETRY_MS;
  if (opts.revAdvanced) return POLL_CATCHUP_MS;
  if (opts.postMutation) return POLL_POST_MUTATION_MS;
  return POLL_IDLE_MS;
}
function withCwdQuery(path, cwd, sessionId) {
  const params = [];
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) params.push(`cwd=${encodeURIComponent(trimmedCwd)}`);
  const trimmedSid = sessionId?.trim();
  if (trimmedSid) params.push(`sessionId=${encodeURIComponent(trimmedSid)}`);
  if (params.length === 0) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${params.join("&")}`;
}
function shortCwdLabel(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd.startsWith("/") ? cwd : parts.join("/");
  return `\u2026/${parts.slice(-2).join("/")}`;
}
function decodeSvgDataUri(uriOrSvg) {
  if (!uriOrSvg) return "";
  const trimmed = uriOrSvg.trim();
  if (trimmed.startsWith("<svg")) return trimmed;
  const prefix = "data:image/svg+xml;base64,";
  if (trimmed.startsWith(prefix)) {
    const b64 = trimmed.slice(prefix.length);
    if (typeof globalThis.atob === "function") {
      const bin = globalThis.atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }
    return Buffer.from(b64, "base64").toString("utf8");
  }
  return "";
}
function formatOverflowBanner(overflowLines, targetPages, locale) {
  if (!overflowLines || overflowLines <= 0) return null;
  const ui = getGalleyStrings(locale).ui;
  if (targetPages && targetPages > 0) {
    return ui.overflowOverTarget(overflowLines, targetPages);
  }
  return ui.overflowGeneric(overflowLines);
}
function plainInlineText(inlines) {
  if (!inlines || inlines.length === 0) return "";
  return inlines.map((n) => {
    switch (n.t) {
      case "text":
      case "code":
      case "math":
        return n.v;
      case "strong":
      case "emph":
        return plainInlineText(n.c);
      case "cloze":
        return `[${n.hint ?? "___"}]`;
      case "newline":
        return " ";
      default:
        return "";
    }
  }).join("");
}
function flattenBlockPreview(block, maxChars = 60) {
  if (block.type === "header") {
    const f = block.fields ?? {};
    const joined = [f.titel, f.subtitle, f.fach, f.klasse, f.datum].filter(Boolean).join(" \xB7 ");
    return (joined || "Header").slice(0, maxChars);
  }
  if (block.type === "table") {
    const head = (block.headers ?? []).map((c) => plainInlineText(c)).join(" | ");
    return (head || `${block.rows?.length ?? 0} rows`).slice(0, maxChars);
  }
  const body = block.body;
  const raw = plainInlineText(body).replace(/\s+/g, " ").trim();
  return raw.slice(0, maxChars);
}
function createStarterBlockPayload(type) {
  switch (type) {
    case "header":
      return {
        type: "header",
        fields: { titel: "Document", fach: "", klasse: "", datum: "", name: "" }
      };
    case "heading":
      return {
        type: "heading",
        level: 2,
        numbered: false,
        body: [{ t: "text", v: "Section" }]
      };
    case "prose":
      return {
        type: "prose",
        body: [{ t: "text", v: "New paragraph." }]
      };
    case "source_text":
      return {
        type: "source_text",
        title: "Source Excerpt",
        lineNumbers: { every: 5, start: 1 },
        body: [{ t: "text", v: "First line of source text.\nSecond line." }]
      };
    case "task":
      return {
        type: "task",
        body: [{ t: "text", v: "Complete the following task." }]
      };
    case "table":
      return {
        type: "table",
        headers: [[{ t: "text", v: "Column 1" }], [{ t: "text", v: "Column 2" }]],
        rows: [[[{ t: "text", v: "Item" }], [{ t: "text", v: "Description" }]]]
      };
    case "callout":
      return {
        type: "callout",
        tone: "info",
        body: [{ t: "text", v: "Important note." }]
      };
    case "answer":
      return {
        type: "answer",
        body: [{ t: "text", v: "Expected answer." }]
      };
  }
}
function blockToDraftBuffer(block) {
  const base = {
    blockId: block.id,
    blockType: block.type,
    baseHash: block.hash,
    dirty: false,
    conflict: false,
    markup: "",
    headerFields: { titel: "", subtitle: "", fach: "", klasse: "", datum: "", name: "" },
    headerShowNameLine: true,
    headingLevel: 1,
    headingNumbered: false,
    sourceTitle: "",
    lineEvery: 0,
    lineStart: 1,
    calloutTone: "info",
    tableHeaders: ["Column 1", "Column 2"],
    tableRows: [["", ""]],
    slot: block.slot ? JSON.parse(JSON.stringify(block.slot)) : { mode: "full" },
    dependsOnIds: (block.dependsOn ?? []).map((d) => d.id)
  };
  switch (block.type) {
    case "header":
      base.headerFields = {
        titel: block.fields?.titel ?? "",
        subtitle: block.fields?.subtitle ?? "",
        fach: block.fields?.fach ?? "",
        klasse: block.fields?.klasse ?? "",
        datum: block.fields?.datum ?? "",
        name: block.fields?.name ?? ""
      };
      base.headerShowNameLine = block.fields?.name !== void 0;
      break;
    case "heading":
      base.headingLevel = block.level ?? 1;
      base.headingNumbered = Boolean(block.numbered);
      base.markup = serializeInlines(block.body);
      break;
    case "source_text":
      base.sourceTitle = block.title ?? "";
      base.lineEvery = block.lineNumbers?.every ?? 0;
      base.lineStart = block.lineNumbers?.start ?? 1;
      base.markup = serializeInlines(block.body);
      break;
    case "callout":
      base.calloutTone = block.tone ?? "info";
      base.markup = serializeInlines(block.body);
      break;
    case "table":
      base.tableHeaders = block.headers && block.headers.length > 0 ? block.headers.map((c) => serializeInlines(c)) : ["Column 1"];
      base.tableRows = block.rows && block.rows.length > 0 ? block.rows.map((r) => r.map((c) => serializeInlines(c))) : [base.tableHeaders.map(() => "")];
      break;
    case "prose":
    case "task":
    case "answer":
      base.markup = serializeInlines(block.body);
      break;
  }
  return base;
}
function reconcileDraftBuffer(current, incoming) {
  if (!incoming) return null;
  if (!current || current.blockId !== incoming.id) {
    return blockToDraftBuffer(incoming);
  }
  if (!current.dirty) {
    return blockToDraftBuffer(incoming);
  }
  if (incoming.hash === current.baseHash) {
    return current.conflict ? { ...current, conflict: false, remoteHash: void 0 } : current;
  }
  return {
    ...current,
    conflict: true,
    remoteHash: incoming.hash
  };
}
function applyCommitOutcome(draft, outcome) {
  if (outcome.ok) {
    return { ...draft, dirty: false, conflict: false, remoteHash: void 0 };
  }
  if (outcome.status === 409) {
    return { ...draft, dirty: true, conflict: true };
  }
  return { ...draft, dirty: true };
}
function draftBufferToPatch(draft) {
  const patch = {};
  if (draft.blockType !== "header" && draft.blockType !== "heading") {
    patch.slot = draft.slot;
  }
  patch.dependsOn = draft.dependsOnIds;
  switch (draft.blockType) {
    case "header": {
      const f = {
        titel: draft.headerFields.titel,
        fach: draft.headerFields.fach,
        klasse: draft.headerFields.klasse,
        datum: draft.headerFields.datum
      };
      if (draft.headerFields.subtitle.trim().length > 0) {
        f.subtitle = draft.headerFields.subtitle;
      }
      if (draft.headerShowNameLine) {
        f.name = draft.headerFields.name;
      }
      patch.fields = f;
      break;
    }
    case "heading":
      patch.level = draft.headingLevel;
      patch.numbered = draft.headingNumbered;
      patch.body = parseInlines(draft.markup);
      break;
    case "source_text":
      patch.title = draft.sourceTitle || void 0;
      patch.lineNumbers = draft.lineEvery > 0 ? { every: Math.max(1, Math.floor(draft.lineEvery)), start: Math.max(1, Math.floor(draft.lineStart || 1)) } : void 0;
      patch.body = parseInlines(draft.markup);
      break;
    case "callout":
      patch.tone = draft.calloutTone;
      patch.body = parseInlines(draft.markup);
      break;
    case "table":
      patch.headers = draft.tableHeaders.map((h) => parseInlines(h));
      patch.rows = draft.tableRows.map((row) => row.map((cell) => parseInlines(cell)));
      break;
    case "prose":
    case "task":
    case "answer":
      patch.body = parseInlines(draft.markup);
      break;
  }
  return patch;
}
function hitBandToPercentRect(band, pageHeightPt) {
  const h = pageHeightPt > 0 ? pageHeightPt : 841.89;
  const rawTop = Math.max(0, Math.min(100, band.yTopPt / h * 100));
  const rawBottom = Math.max(rawTop + 1.2, Math.min(100, band.yBottomPt / h * 100));
  return {
    topPct: Math.round(rawTop * 100) / 100,
    heightPct: Math.round(Math.max(1.2, rawBottom - rawTop) * 100) / 100
  };
}
export {
  POLL_CATCHUP_MS,
  POLL_HIDDEN_MS,
  POLL_IDLE_MS,
  POLL_POST_MUTATION_MS,
  POLL_RETRY_MS,
  WIDE_PANE_MIN_PX,
  applyCommitOutcome,
  blockToDraftBuffer,
  computePaneMode,
  createStarterBlockPayload,
  decodeSvgDataUri,
  draftBufferToPatch,
  flattenBlockPreview,
  formatOverflowBanner,
  hitBandToPercentRect,
  nextPollDelayMs,
  reconcileDraftBuffer,
  shortCwdLabel,
  withCwdQuery
};
//# sourceMappingURL=galley-pane.mjs.map
