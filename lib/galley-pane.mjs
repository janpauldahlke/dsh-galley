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
function withCwdQuery(path, cwd) {
  const trimmed = cwd?.trim();
  if (!trimmed) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}cwd=${encodeURIComponent(trimmed)}`;
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
function formatOverflowBanner(overflowLines, targetPages) {
  if (!overflowLines || overflowLines <= 0) return null;
  if (targetPages && targetPages > 0) {
    const unit = targetPages === 1 ? "Seite" : "Seiten";
    return `+${overflowLines} Zeilen \xFCber ${targetPages} ${unit}`;
  }
  return `+${overflowLines} Zeilen \xDCberlauf`;
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
    const joined = [f.titel, f.fach, f.klasse, f.datum].filter(Boolean).join(" \xB7 ");
    return (joined || "Kopfbogen").slice(0, maxChars);
  }
  if (block.type === "table") {
    const head = (block.headers ?? []).map((c) => plainInlineText(c)).join(" | ");
    return (head || `${block.rows?.length ?? 0} Zeilen`).slice(0, maxChars);
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
        fields: { titel: "Arbeitsblatt", fach: "", klasse: "", datum: "", name: "" }
      };
    case "heading":
      return {
        type: "heading",
        level: 2,
        numbered: false,
        body: [{ t: "text", v: "Abschnitt" }]
      };
    case "prose":
      return {
        type: "prose",
        body: [{ t: "text", v: "Neuer Absatz." }]
      };
    case "source_text":
      return {
        type: "source_text",
        title: "Quellentext",
        lineNumbers: { every: 5, start: 1 },
        body: [{ t: "text", v: "Erste Zeile des Quellentextes.\nZweite Zeile." }]
      };
    case "task":
      return {
        type: "task",
        body: [{ t: "text", v: "Bearbeiten Sie die folgende Aufgabe." }]
      };
    case "table":
      return {
        type: "table",
        headers: [[{ t: "text", v: "Begriff" }], [{ t: "text", v: "Bedeutung" }]],
        rows: [[[{ t: "text", v: "Beispiel" }], [{ t: "text", v: "Erkl\xE4rung" }]]]
      };
    case "callout":
      return {
        type: "callout",
        tone: "info",
        body: [{ t: "text", v: "Hinweis f\xFCr die Bearbeitung." }]
      };
    case "answer":
      return {
        type: "answer",
        body: [{ t: "text", v: "Erwartete L\xF6sung." }]
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
    headerFields: { titel: "", fach: "", klasse: "", datum: "", name: "" },
    headingLevel: 1,
    headingNumbered: false,
    sourceTitle: "",
    lineEvery: 0,
    lineStart: 1,
    calloutTone: "info",
    tableHeaders: ["Spalte 1", "Spalte 2"],
    tableRows: [["", ""]],
    slot: block.slot ? JSON.parse(JSON.stringify(block.slot)) : { mode: "full" },
    dependsOnIds: (block.dependsOn ?? []).map((d) => d.id)
  };
  switch (block.type) {
    case "header":
      base.headerFields = {
        titel: block.fields?.titel ?? "",
        fach: block.fields?.fach ?? "",
        klasse: block.fields?.klasse ?? "",
        datum: block.fields?.datum ?? "",
        name: block.fields?.name ?? ""
      };
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
      base.tableHeaders = block.headers && block.headers.length > 0 ? block.headers.map((c) => serializeInlines(c)) : ["Spalte 1"];
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
    case "header":
      patch.fields = { ...draft.headerFields };
      break;
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
  nextPollDelayMs,
  reconcileDraftBuffer,
  shortCwdLabel,
  withCwdQuery
};
//# sourceMappingURL=galley-pane.mjs.map
