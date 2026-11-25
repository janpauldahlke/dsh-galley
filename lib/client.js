window.__ModuleLoader__.load({ id: "dsh-galley", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/shared/types.ts
var PLUGIN = "dsh-galley";
var HEALTH_ROUTE = "/api/galley/health";
var STATE_ROUTE = "/api/galley/state";
var EDIT_ROUTE = "/api/galley/edit";
var EXPORT_ROUTE = "/api/galley/export";
var PROPOSAL_ROUTE_PREFIX = "/api/galley/proposal";
var TAB_ID = "galley";
var TAB_KIND = "galley";
var TAB_TITLE = "Galley";

// src/client/GalleyBody.tsx
var import_react4 = require("react");

// src/client/BlockTray.tsx
var import_react2 = require("react");

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

// src/client/BlockEditor.tsx
var import_react = require("react");

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

// src/client/BlockEditor.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  color: "inherit",
  background: "rgba(128,128,128,0.08)",
  border: "1px solid rgba(128,128,128,0.32)",
  borderRadius: 5,
  padding: "4px 7px",
  fontSize: 12,
  fontFamily: "inherit"
};
var smallBtn = {
  color: "inherit",
  background: "transparent",
  border: "1px solid rgba(128,128,128,0.32)",
  borderRadius: 4,
  padding: "2px 7px",
  fontSize: 11,
  cursor: "pointer",
  lineHeight: 1.4
};
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const stripped = result.replace(/^data:[^;]+;base64,/, "");
      resolve({
        mimeType: file.type || "image/png",
        dataBase64: stripped,
        name: file.name || "image.png"
      });
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}
function BlockEditor(props) {
  const { block, allBlockIds, assets, busy, onCommitPatch, onUploadAsset, onDirtyChange } = props;
  const [draft, setDraft] = (0, import_react.useState)(() => blockToDraftBuffer(block));
  const [dropActive, setDropActive] = (0, import_react.useState)(false);
  const [showDeps, setShowDeps] = (0, import_react.useState)(() => (block.dependsOn?.length ?? 0) > 0);
  const textareaRef = (0, import_react.useRef)(null);
  const fileInputRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    setDraft((prev) => reconcileDraftBuffer(prev, block) ?? blockToDraftBuffer(block));
  }, [block]);
  (0, import_react.useEffect)(() => {
    onDirtyChange?.(block.id, draft.dirty);
  }, [block.id, draft.dirty, onDirtyChange]);
  const updateDraft = (updater) => {
    setDraft((prev) => ({ ...updater(prev), dirty: true }));
  };
  const commitNow = async (ignoreBaseHash = false) => {
    if (!draft.dirty && !ignoreBaseHash) return;
    const patch = draftBufferToPatch(draft);
    await onCommitPatch(block.id, patch, ignoreBaseHash ? void 0 : draft.baseHash);
    setDraft((prev) => ({ ...prev, dirty: false, conflict: false }));
  };
  const handleContainerBlur = (e) => {
    const nextTarget = e.relatedTarget;
    if (nextTarget && e.currentTarget.contains(nextTarget)) return;
    if (draft.dirty && !draft.conflict && !busy) {
      void commitNow(false);
    }
  };
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void commitNow(false);
    }
  };
  const wrapSelection = (prefix, suffix, placeholder) => {
    const el = textareaRef.current;
    if (!el) {
      updateDraft((p) => ({ ...p, markup: `${p.markup}${prefix}${placeholder}${suffix}` }));
      return;
    }
    const start = el.selectionStart ?? draft.markup.length;
    const end = el.selectionEnd ?? draft.markup.length;
    const selected = draft.markup.slice(start, end) || placeholder;
    const nextMarkup = draft.markup.slice(0, start) + prefix + selected + suffix + draft.markup.slice(end);
    updateDraft((p) => ({ ...p, markup: nextMarkup }));
    requestAnimationFrame(() => {
      el.focus();
      const cursorStart = start + prefix.length;
      el.setSelectionRange(cursorStart, cursorStart + selected.length);
    });
  };
  const ingestImageFile = async (file) => {
    if (!file.type.startsWith("image/")) return;
    const { mimeType, dataBase64, name: name2 } = await readFileAsBase64(file);
    const mode = draft.slot.mode === "media-left" ? "media-left" : "media-right";
    if (draft.dirty) {
      await commitNow(true);
    }
    await onUploadAsset({
      blockId: block.id,
      slotMode: mode,
      mimeType,
      dataBase64,
      alt: draft.slot.asset?.alt || name2.replace(/\.[^.]+$/, ""),
      widthCm: draft.slot.asset?.widthCm
    });
  };
  const handlePaste = (e) => {
    if (block.type === "header" || block.type === "heading") return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void ingestImageFile(file);
          return;
        }
      }
    }
  };
  const handleDrop = (e) => {
    if (block.type === "header" || block.type === "heading") return;
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      void ingestImageFile(file);
    }
  };
  const supportsRichText = block.type === "heading" || block.type === "prose" || block.type === "source_text" || block.type === "task" || block.type === "callout" || block.type === "answer";
  const supportsSlot = block.type !== "header" && block.type !== "heading";
  const assetList = Object.values(assets);
  const handleSlotModeChange = (nextMode) => {
    updateDraft((prev) => {
      if (nextMode === "full" || nextMode === "two-column") {
        return { ...prev, slot: { mode: nextMode } };
      }
      if (nextMode === "card-grid") {
        return {
          ...prev,
          slot: {
            mode: "card-grid",
            columns: prev.slot.columns ?? 3,
            cardHeightCm: prev.slot.cardHeightCm ?? 6
          }
        };
      }
      const fallbackAsset = prev.slot.asset ? prev.slot.asset : assetList[0] ? { id: assetList[0].id, path: assetList[0].path, alt: assetList[0].id } : void 0;
      return {
        ...prev,
        slot: {
          mode: nextMode,
          asset: fallbackAsset
        }
      };
    });
  };
  const mediaMissingAsset = (draft.slot.mode === "media-right" || draft.slot.mode === "media-left") && !draft.slot.asset;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      "data-testid": `galley-editor-${block.id}`,
      onBlur: handleContainerBlur,
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onDragOver: (e) => {
        if (supportsSlot) {
          e.preventDefault();
          setDropActive(true);
        }
      },
      onDragLeave: () => setDropActive(false),
      onDrop: handleDrop,
      style: {
        marginTop: 6,
        padding: 8,
        borderRadius: 6,
        background: dropActive ? "rgba(59,130,246,0.1)" : "rgba(128,128,128,0.06)",
        border: dropActive ? "1px dashed #3b82f6" : "1px solid rgba(128,128,128,0.22)",
        display: "flex",
        flexDirection: "column",
        gap: 7
      },
      children: [
        draft.conflict && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            "data-testid": "galley-editor-conflict",
            style: {
              padding: "6px 8px",
              borderRadius: 5,
              background: "rgba(220,38,38,0.12)",
              border: "1px solid #dc2626",
              color: "#dc2626",
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              flexWrap: "wrap"
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Block wurde zwischenzeitlich ge\xE4ndert." }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", gap: 4 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      void commitNow(true);
                    },
                    style: { ...smallBtn, borderColor: "#dc2626", color: "#dc2626", fontWeight: 600 },
                    children: "Meine behalten"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => setDraft(blockToDraftBuffer(block)),
                    style: smallBtn,
                    children: "Server \xFCbernehmen"
                  }
                )
              ] })
            ]
          }
        ),
        block.type === "header" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { gridColumn: "1 / -1" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 11, opacity: 0.75 }, children: "Titel" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                "aria-label": "Header Titel",
                style: inputStyle,
                value: draft.headerFields.titel,
                onChange: (e) => updateDraft((p) => ({ ...p, headerFields: { ...p.headerFields, titel: e.target.value } }))
              }
            )
          ] }),
          ["fach", "klasse", "datum", "name"].map((fieldKey) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 11, opacity: 0.75, textTransform: "capitalize" }, children: fieldKey }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                "aria-label": `Header ${fieldKey}`,
                style: inputStyle,
                value: draft.headerFields[fieldKey],
                onChange: (e) => updateDraft((p) => ({
                  ...p,
                  headerFields: { ...p.headerFields, [fieldKey]: e.target.value }
                }))
              }
            )
          ] }, fieldKey))
        ] }),
        block.type === "heading" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Ebene:" }),
          [1, 2, 3].map((lvl) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              type: "button",
              onClick: () => updateDraft((p) => ({ ...p, headingLevel: lvl })),
              style: {
                ...smallBtn,
                background: draft.headingLevel === lvl ? "rgba(128,128,128,0.22)" : "transparent",
                fontWeight: draft.headingLevel === lvl ? 700 : 400
              },
              children: [
                "H",
                lvl
              ]
            },
            lvl
          )),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: draft.headingNumbered,
                onChange: (e) => updateDraft((p) => ({ ...p, headingNumbered: e.target.checked }))
              }
            ),
            "Nummeriert"
          ] })
        ] }),
        block.type === "source_text" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              "aria-label": "Quellentext Titel",
              placeholder: "Quellentitel (optional)",
              style: { ...inputStyle, flex: "1 1 140px" },
              value: draft.sourceTitle,
              onChange: (e) => updateDraft((p) => ({ ...p, sourceTitle: e.target.value }))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Zeilennr. alle" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                "aria-label": "Zeilennummern Intervall",
                type: "number",
                min: 0,
                max: 50,
                style: { ...inputStyle, width: 52 },
                value: draft.lineEvery,
                onChange: (e) => updateDraft((p) => ({ ...p, lineEvery: Math.max(0, Number(e.target.value) || 0) }))
              }
            )
          ] })
        ] }),
        block.type === "callout" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 11 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Ton:" }),
          ["info", "hint", "warning"].map((tone) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              onClick: () => updateDraft((p) => ({ ...p, calloutTone: tone })),
              style: {
                ...smallBtn,
                background: draft.calloutTone === tone ? "rgba(128,128,128,0.22)" : "transparent",
                fontWeight: draft.calloutTone === tone ? 600 : 400
              },
              children: tone
            },
            tone
          ))
        ] }),
        supportsRichText && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: "Fett (**\u2026**)", style: smallBtn, onClick: () => wrapSelection("**", "**", "fett"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "B" }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: "Kursiv (*\u2026*)", style: smallBtn, onClick: () => wrapSelection("*", "*", "kursiv"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "I" }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: "Code (`\u2026`)", style: smallBtn, onClick: () => wrapSelection("`", "`", "code"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "<>" }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: "Typst Math ($\u2026$)", style: smallBtn, onClick: () => wrapSelection("$", "$", "x^2"), children: "\u2211 Math" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                title: "L\xFCckentext ({{Hinweis}})",
                style: smallBtn,
                onClick: () => wrapSelection("{{", "}}", "L\xF6sung"),
                children: "___ L\xFCcke"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              ref: textareaRef,
              "aria-label": `Block ${block.id} Inhalt`,
              rows: block.type === "heading" ? 2 : block.type === "source_text" ? 5 : 3,
              style: { ...inputStyle, resize: "vertical", lineHeight: 1.45 },
              value: draft.markup,
              onChange: (e) => updateDraft((p) => ({ ...p, markup: e.target.value }))
            }
          )
        ] }),
        block.type === "table" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, overflowX: "auto" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: smallBtn,
                onClick: () => updateDraft((p) => ({
                  ...p,
                  tableHeaders: [...p.tableHeaders, `Spalte ${p.tableHeaders.length + 1}`],
                  tableRows: p.tableRows.map((r) => [...r, ""])
                })),
                children: "+ Spalte"
              }
            ),
            draft.tableHeaders.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: smallBtn,
                onClick: () => updateDraft((p) => ({
                  ...p,
                  tableHeaders: p.tableHeaders.slice(0, -1),
                  tableRows: p.tableRows.map((r) => r.slice(0, -1))
                })),
                children: "\u2212 Spalte"
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: smallBtn,
                onClick: () => updateDraft((p) => ({
                  ...p,
                  tableRows: [...p.tableRows, p.tableHeaders.map(() => "")]
                })),
                children: "+ Zeile"
              }
            ),
            draft.tableRows.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: smallBtn,
                onClick: () => updateDraft((p) => ({ ...p, tableRows: p.tableRows.slice(0, -1) })),
                children: "\u2212 Zeile"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: `repeat(${Math.max(1, draft.tableHeaders.length)}, minmax(90px, 1fr))`,
                gap: 4
              },
              children: [
                draft.tableHeaders.map((h, ci) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "input",
                  {
                    "aria-label": `Tabellenkopf ${ci + 1}`,
                    style: { ...inputStyle, fontWeight: 600 },
                    value: h,
                    onChange: (e) => updateDraft((p) => {
                      const nextH = [...p.tableHeaders];
                      nextH[ci] = e.target.value;
                      return { ...p, tableHeaders: nextH };
                    })
                  },
                  `th-${ci}`
                )),
                draft.tableRows.map(
                  (row, ri) => draft.tableHeaders.map((_, ci) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                    "input",
                    {
                      "aria-label": `Zelle ${ri + 1},${ci + 1}`,
                      style: inputStyle,
                      value: row[ci] ?? "",
                      onChange: (e) => updateDraft((p) => {
                        const nextRows = p.tableRows.map((r) => [...r]);
                        while (nextRows[ri].length < p.tableHeaders.length) nextRows[ri].push("");
                        nextRows[ri][ci] = e.target.value;
                        return { ...p, tableRows: nextRows };
                      })
                    },
                    `td-${ri}-${ci}`
                  ))
                )
              ]
            }
          )
        ] }),
        supportsSlot && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 5,
              paddingTop: 5,
              borderTop: "1px solid rgba(128,128,128,0.16)",
              fontSize: 11
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.78 }, children: "Slot:" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                  "select",
                  {
                    "aria-label": `Block ${block.id} Layout-Slot`,
                    value: draft.slot.mode,
                    onChange: (e) => handleSlotModeChange(e.target.value),
                    style: {
                      color: "inherit",
                      background: "transparent",
                      border: "1px solid rgba(128,128,128,0.32)",
                      borderRadius: 4,
                      fontSize: 11,
                      padding: "2px 5px"
                    },
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "full", style: { color: "#111" }, children: "full (100%)" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "two-column", style: { color: "#111" }, children: "two-column (2 Spalten)" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "card-grid", style: { color: "#111" }, children: "card-grid (Ausschneidekarten)" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "media-right", style: { color: "#111" }, children: "media-right (65/35 Bild rechts)" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "media-left", style: { color: "#111" }, children: "media-left (35/65 Bild links)" })
                    ]
                  }
                ),
                draft.slot.mode === "card-grid" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Spalten:" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "select",
                      {
                        "aria-label": "Karten-Spalten",
                        value: String(draft.slot.columns ?? 3),
                        onChange: (e) => updateDraft((p) => ({
                          ...p,
                          slot: { ...p.slot, mode: "card-grid", columns: Number(e.target.value) }
                        })),
                        style: {
                          color: "inherit",
                          background: "transparent",
                          border: "1px solid rgba(128,128,128,0.32)",
                          borderRadius: 4,
                          fontSize: 11,
                          padding: "1px 4px"
                        },
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "2", style: { color: "#111" }, children: "2" }),
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "3", style: { color: "#111" }, children: "3" }),
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "4", style: { color: "#111" }, children: "4" })
                        ]
                      }
                    )
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "H\xF6he (cm):" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      "input",
                      {
                        "aria-label": "Kartenh\xF6he cm",
                        type: "number",
                        min: 2,
                        max: 20,
                        step: 0.5,
                        style: { ...inputStyle, width: 54, padding: "2px 5px" },
                        value: draft.slot.cardHeightCm ?? 6,
                        onChange: (e) => updateDraft((p) => ({
                          ...p,
                          slot: { ...p.slot, mode: "card-grid", cardHeightCm: Number(e.target.value) || 6 }
                        }))
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "input",
                  {
                    ref: fileInputRef,
                    type: "file",
                    accept: "image/*",
                    style: { display: "none" },
                    onChange: (e) => {
                      const file = e.target.files?.[0];
                      if (file) void ingestImageFile(file);
                      e.target.value = "";
                    }
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => fileInputRef.current?.click(),
                    style: smallBtn,
                    title: "Bild hochladen, ablegen oder mit Strg+V einf\xFCgen",
                    children: "\u{1F5BC} Bild hochladen / Drop"
                  }
                )
              ] }),
              (draft.slot.mode === "media-right" || draft.slot.mode === "media-left") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: assetList.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Asset:" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "select",
                  {
                    "aria-label": "Medien-Asset",
                    value: draft.slot.asset?.id ?? "",
                    onChange: (e) => {
                      const meta = assets[e.target.value];
                      if (meta) {
                        updateDraft((p) => ({
                          ...p,
                          slot: {
                            ...p.slot,
                            asset: { id: meta.id, path: meta.path, alt: p.slot.asset?.alt || meta.id }
                          }
                        }));
                      }
                    },
                    style: {
                      color: "inherit",
                      background: "transparent",
                      border: "1px solid rgba(128,128,128,0.32)",
                      borderRadius: 4,
                      fontSize: 11,
                      padding: "1px 5px"
                    },
                    children: assetList.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: a.id, style: { color: "#111" }, children: [
                      a.id,
                      " (",
                      a.path,
                      ")"
                    ] }, a.id))
                  }
                )
              ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#d97706" }, children: "Bild ablegen, einf\xFCgen (Strg+V) oder \u201EBild hochladen\u201C klicken, um den Medien-Slot zu f\xFCllen." }) })
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              flexWrap: "wrap",
              paddingTop: 4,
              borderTop: "1px solid rgba(128,128,128,0.16)",
              fontSize: 11
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "button",
                {
                  type: "button",
                  onClick: () => setShowDeps((v) => !v),
                  style: { ...smallBtn, opacity: 0.85 },
                  children: [
                    "Abh\xE4ngig von (",
                    draft.dependsOnIds.length,
                    ") ",
                    showDeps ? "\u25B4" : "\u25BE"
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [
                draft.dirty && !mediaMissingAsset && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 10, opacity: 0.7 }, children: "Ungespeichert \xB7 Strg+Enter" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    disabled: !draft.dirty || mediaMissingAsset || busy,
                    onClick: () => {
                      void commitNow(false);
                    },
                    style: {
                      ...smallBtn,
                      fontWeight: 600,
                      opacity: !draft.dirty || mediaMissingAsset || busy ? 0.45 : 1,
                      background: draft.dirty && !mediaMissingAsset ? "rgba(22,163,74,0.16)" : "transparent",
                      borderColor: draft.dirty && !mediaMissingAsset ? "#16a34a" : "rgba(128,128,128,0.32)"
                    },
                    children: "\xDCbernehmen"
                  }
                )
              ] })
            ]
          }
        ),
        showDeps && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", fontSize: 11 }, children: allBlockIds.filter((id) => id !== block.id).map((id) => {
          const linked = draft.dependsOnIds.includes(id);
          return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              onClick: () => updateDraft((p) => ({
                ...p,
                dependsOnIds: linked ? p.dependsOnIds.filter((x) => x !== id) : [...p.dependsOnIds, id]
              })),
              style: {
                ...smallBtn,
                padding: "1px 6px",
                background: linked ? "rgba(59,130,246,0.2)" : "transparent",
                borderColor: linked ? "#3b82f6" : "rgba(128,128,128,0.32)"
              },
              children: linked ? `\u2713 ${id}` : `+ ${id}`
            },
            id
          );
        }) })
      ]
    }
  );
}

// src/client/BlockTray.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var ALL_BLOCK_TYPES = [
  { type: "header", label: "Kopfbogen (header)", icon: "\u25A4" },
  { type: "heading", label: "\xDCberschrift (heading)", icon: "\xA7" },
  { type: "prose", label: "Flie\xDFtext (prose)", icon: "\xB6" },
  { type: "source_text", label: "Quellentext (source_text)", icon: "\u275D" },
  { type: "task", label: "Aufgabe (task)", icon: "\u2611" },
  { type: "table", label: "Tabelle (table)", icon: "\u229E" },
  { type: "callout", label: "Hinweisbox (callout)", icon: "\u25C8" },
  { type: "answer", label: "L\xF6sung (answer)", icon: "\u2713" }
];
function iconForType(type) {
  return ALL_BLOCK_TYPES.find((x) => x.type === type)?.icon ?? "\u25A1";
}
function summarizePatchSide(patch) {
  if (!patch) return "\u2014";
  if (Array.isArray(patch.body)) return serializeInlines(patch.body);
  if (typeof patch.body === "string") return patch.body;
  return JSON.stringify(patch);
}
var iconBtn = {
  color: "inherit",
  background: "transparent",
  border: "1px solid rgba(128,128,128,0.28)",
  borderRadius: 4,
  padding: "1px 6px",
  fontSize: 11,
  cursor: "pointer",
  lineHeight: 1.35
};
function BlockTray(props) {
  const {
    sheet,
    allBlockIds,
    assets,
    selectedBlockId,
    busy,
    onSelectBlock,
    onInsertBlock,
    onPatchBlock,
    onMoveBlock,
    onRemoveBlock,
    onUploadAsset,
    onDecideProposal,
    onAddAnnotation,
    onResolveAnnotation
  } = props;
  const [insertAfterTarget, setInsertAfterTarget] = (0, import_react2.useState)(null);
  const [noteOpenBlockId, setNoteOpenBlockId] = (0, import_react2.useState)(null);
  const [noteDraft, setNoteDraft] = (0, import_react2.useState)("");
  const [proposalOpenId, setProposalOpenId] = (0, import_react2.useState)(null);
  const pendingProposalsByBlock = /* @__PURE__ */ new Map();
  for (const p of sheet.proposals) {
    if (p.status === "pending" || p.status === "conflicted") {
      const list = pendingProposalsByBlock.get(p.targetBlockId) ?? [];
      list.push(p);
      pendingProposalsByBlock.set(p.targetBlockId, list);
    }
  }
  const openAnnotationsByBlock = /* @__PURE__ */ new Map();
  for (const a of sheet.annotations) {
    if (!a.resolved) {
      const list = openAnnotationsByBlock.get(a.blockId) ?? [];
      list.push(a);
      openAnnotationsByBlock.set(a.blockId, list);
    }
  }
  const renderInsertPicker = (afterId) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "div",
    {
      "data-testid": "galley-insert-menu",
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: 7,
        borderRadius: 6,
        background: "rgba(128,128,128,0.1)",
        border: "1px solid rgba(128,128,128,0.26)",
        marginBottom: 6
      },
      children: ALL_BLOCK_TYPES.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          onClick: () => {
            setInsertAfterTarget(null);
            void onInsertBlock(sheet.id, createStarterBlockPayload(item.type), afterId);
          },
          style: { ...iconBtn, padding: "3px 8px" },
          children: [
            item.icon,
            " ",
            item.label
          ]
        },
        item.type
      ))
    }
  );
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 10px",
              borderBottom: "1px solid rgba(128,128,128,0.2)",
              fontSize: 12
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { fontWeight: 600 }, children: [
                "Bl\xF6cke \xB7 ",
                sheet.title,
                " ",
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { opacity: 0.65 }, children: [
                  "(",
                  sheet.blocks.length,
                  ")"
                ] })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  type: "button",
                  "data-testid": "galley-add-block-btn",
                  onClick: () => setInsertAfterTarget((cur) => cur === "__end__" ? null : "__end__"),
                  style: { ...iconBtn, padding: "2px 8px", fontWeight: 600 },
                  children: "+ Block anf\xFCgen"
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px" }, children: [
          insertAfterTarget === "__end__" && sheet.blocks.length === 0 && renderInsertPicker(void 0),
          sheet.blocks.length === 0 && insertAfterTarget !== "__end__" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { opacity: 0.7, fontSize: 12, padding: "16px 4px", textAlign: "center" }, children: "Noch keine Bl\xF6cke auf diesem Bogen \u2014 \xFCber \u201E+ Block anf\xFCgen\u201C starten." }),
          sheet.blocks.map((block, index) => {
            const expanded = selectedBlockId === block.id;
            const blockProposals = pendingProposalsByBlock.get(block.id) ?? [];
            const blockNotes = openAnnotationsByBlock.get(block.id) ?? [];
            const preview = flattenBlockPreview(block);
            return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
              "div",
              {
                "data-testid": `galley-block-row-${block.id}`,
                style: {
                  marginBottom: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: expanded ? "1px solid rgba(59,130,246,0.65)" : block.stale ? "1px solid rgba(217,119,6,0.55)" : "1px solid rgba(128,128,128,0.22)",
                  background: expanded ? "rgba(128,128,128,0.06)" : "transparent"
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                      "div",
                      {
                        role: "button",
                        tabIndex: 0,
                        onClick: () => onSelectBlock(expanded ? null : block.id),
                        onKeyDown: (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectBlock(expanded ? null : block.id);
                          }
                        },
                        style: {
                          flex: 1,
                          minWidth: 0,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                          fontSize: 12
                        },
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontFamily: "monospace", fontWeight: 700 }, children: iconForType(block.type) }),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { fontSize: 11, fontWeight: 700 }, children: block.id }),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "span",
                            {
                              style: {
                                fontSize: 10,
                                padding: "0 5px",
                                borderRadius: 4,
                                background: "rgba(128,128,128,0.15)"
                              },
                              children: block.type
                            }
                          ),
                          block.slot.mode !== "full" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "span",
                            {
                              style: {
                                fontSize: 10,
                                padding: "0 5px",
                                borderRadius: 4,
                                background: "rgba(59,130,246,0.14)"
                              },
                              children: block.slot.mode
                            }
                          ),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "span",
                            {
                              style: {
                                fontSize: 10,
                                opacity: 0.62
                              },
                              children: block.origin
                            }
                          ),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "span",
                            {
                              style: {
                                opacity: 0.85,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: 220
                              },
                              children: preview || "\u2014"
                            }
                          ),
                          block.stale && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                            "span",
                            {
                              "data-testid": `galley-stale-${block.id}`,
                              style: {
                                fontSize: 10,
                                fontWeight: 600,
                                color: "#d97706",
                                background: "rgba(217,119,6,0.14)",
                                border: "1px solid #d97706",
                                borderRadius: 4,
                                padding: "0 5px"
                              },
                              children: [
                                "\u26A0 stale \u2190 ",
                                block.stale.origin
                              ]
                            }
                          ),
                          blockProposals.map((prop) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                            "button",
                            {
                              type: "button",
                              "data-testid": `galley-proposal-badge-${prop.id}`,
                              onClick: (e) => {
                                e.stopPropagation();
                                setProposalOpenId((cur) => cur === prop.id ? null : prop.id);
                              },
                              style: {
                                ...iconBtn,
                                fontSize: 10,
                                fontWeight: 600,
                                color: prop.status === "conflicted" ? "#dc2626" : "#d97706",
                                borderColor: prop.status === "conflicted" ? "#dc2626" : "#d97706",
                                background: "rgba(217,119,6,0.14)"
                              },
                              children: [
                                "\u0394 ",
                                prop.status === "conflicted" ? "Konflikt" : "Vorschlag"
                              ]
                            },
                            prop.id
                          )),
                          blockNotes.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                            "span",
                            {
                              style: {
                                fontSize: 10,
                                padding: "0 5px",
                                borderRadius: 4,
                                background: "rgba(128,128,128,0.18)"
                              },
                              children: [
                                "\u{1F4AC} ",
                                blockNotes.length
                              ]
                            }
                          )
                        ]
                      }
                    ),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }, children: [
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          type: "button",
                          title: "Randnotiz",
                          onClick: () => setNoteOpenBlockId((cur) => cur === block.id ? null : block.id),
                          style: iconBtn,
                          children: "\u{1F4AC}"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          type: "button",
                          title: "Block danach einf\xFCgen",
                          onClick: () => setInsertAfterTarget((cur) => cur === block.id ? null : block.id),
                          style: iconBtn,
                          children: "+"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          type: "button",
                          title: "Nach oben",
                          disabled: index === 0 || busy,
                          onClick: () => {
                            void onMoveBlock(sheet.id, block.id, "up");
                          },
                          style: { ...iconBtn, opacity: index === 0 ? 0.35 : 1 },
                          children: "\u2191"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          type: "button",
                          title: "Nach unten",
                          disabled: index === sheet.blocks.length - 1 || busy,
                          onClick: () => {
                            void onMoveBlock(sheet.id, block.id, "down");
                          },
                          style: { ...iconBtn, opacity: index === sheet.blocks.length - 1 ? 0.35 : 1 },
                          children: "\u2193"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          type: "button",
                          title: "Block entfernen",
                          disabled: busy,
                          onClick: () => {
                            void onRemoveBlock(sheet.id, block.id);
                          },
                          style: iconBtn,
                          children: "\u2715"
                        }
                      )
                    ] })
                  ] }),
                  blockProposals.filter((p) => proposalOpenId === p.id || blockProposals.length === 1).map((prop) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                    "div",
                    {
                      "data-testid": `galley-proposal-card-${prop.id}`,
                      style: {
                        marginTop: 6,
                        padding: "6px 8px",
                        borderRadius: 5,
                        border: `1px solid ${prop.status === "conflicted" ? "#dc2626" : "#d97706"}`,
                        background: prop.status === "conflicted" ? "rgba(220,38,38,0.1)" : "rgba(217,119,6,0.1)",
                        fontSize: 11,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { fontWeight: 600 }, children: [
                          "Agent-\xC4nderungsvorschlag (",
                          prop.id,
                          ")",
                          prop.status === "conflicted" ? " \u2014 Inhalt inzwischen ge\xE4ndert (bitte verwerfen oder neu anfordern)" : ""
                        ] }),
                        prop.beforePatch && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { opacity: 0.78 }, children: [
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#dc2626", fontWeight: 600 }, children: "\u2212 Vorher: " }),
                          summarizePatchSide(prop.beforePatch)
                        ] }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#16a34a", fontWeight: 600 }, children: "+ Vorschlag: " }),
                          summarizePatchSide(prop.proposedPatch)
                        ] }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 2 }, children: [
                          prop.status === "pending" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "button",
                            {
                              type: "button",
                              disabled: busy,
                              onClick: () => {
                                void onDecideProposal(prop.id, "accept");
                              },
                              style: { ...iconBtn, borderColor: "#16a34a", color: "#16a34a", fontWeight: 600 },
                              children: "\u2713 Annehmen"
                            }
                          ),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "button",
                            {
                              type: "button",
                              disabled: busy,
                              onClick: () => {
                                void onDecideProposal(prop.id, "revert");
                              },
                              style: iconBtn,
                              children: "\u2715 Verwerfen"
                            }
                          )
                        ] })
                      ]
                    },
                    prop.id
                  )),
                  (noteOpenBlockId === block.id || blockNotes.length > 0) && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                    "div",
                    {
                      style: {
                        marginTop: 6,
                        padding: "6px 8px",
                        borderRadius: 5,
                        background: "rgba(128,128,128,0.08)",
                        fontSize: 11,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4
                      },
                      children: [
                        blockNotes.map((ann) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                          "div",
                          {
                            style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 },
                            children: [
                              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
                                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("strong", { children: [
                                  "[",
                                  ann.author,
                                  "]"
                                ] }),
                                " ",
                                serializeInlines(ann.body)
                              ] }),
                              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                                "button",
                                {
                                  type: "button",
                                  onClick: () => {
                                    void onResolveAnnotation(block.id, ann.id);
                                  },
                                  style: iconBtn,
                                  children: "Erledigt"
                                }
                              )
                            ]
                          },
                          ann.id
                        )),
                        noteOpenBlockId === block.id && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 4 }, children: [
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "input",
                            {
                              "aria-label": `Randnotiz f\xFCr ${block.id}`,
                              placeholder: "Randnotiz hinzuf\xFCgen (max. 800 Zeichen)\u2026",
                              maxLength: 800,
                              value: noteDraft,
                              onChange: (e) => setNoteDraft(e.target.value),
                              style: {
                                flex: 1,
                                color: "inherit",
                                background: "transparent",
                                border: "1px solid rgba(128,128,128,0.32)",
                                borderRadius: 4,
                                padding: "3px 6px",
                                fontSize: 11
                              }
                            }
                          ),
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                            "button",
                            {
                              type: "button",
                              disabled: !noteDraft.trim() || busy,
                              onClick: () => {
                                const text = noteDraft.trim();
                                if (!text) return;
                                setNoteDraft("");
                                setNoteOpenBlockId(null);
                                void onAddAnnotation(block.id, text);
                              },
                              style: iconBtn,
                              children: "Senden"
                            }
                          )
                        ] })
                      ]
                    }
                  ),
                  expanded && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    BlockEditor,
                    {
                      block,
                      allBlockIds,
                      assets,
                      busy,
                      onCommitPatch: onPatchBlock,
                      onUploadAsset
                    }
                  ),
                  insertAfterTarget === block.id && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { marginTop: 6 }, children: renderInsertPicker(block.id) })
                ]
              },
              block.id
            );
          }),
          insertAfterTarget === "__end__" && sheet.blocks.length > 0 && renderInsertPicker(void 0)
        ] })
      ]
    }
  );
}

// src/client/ProofView.tsx
var import_react3 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var toolbarStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  flexWrap: "wrap",
  padding: "6px 10px",
  borderBottom: "1px solid rgba(128,128,128,0.2)",
  fontSize: 12
};
var pillBtn = (active) => ({
  color: "inherit",
  background: active ? "rgba(128,128,128,0.22)" : "transparent",
  border: "1px solid rgba(128,128,128,0.32)",
  borderRadius: 5,
  padding: "2px 7px",
  fontSize: 11,
  fontWeight: active ? 600 : 400,
  cursor: "pointer",
  lineHeight: 1.4
});
function ProofView(props) {
  const {
    sheets,
    proofs,
    selectedSheetId,
    selectedBlockId,
    onSelectSheet,
    onSelectBlock,
    onUpdateTargetPages
  } = props;
  const [zoom, setZoom] = (0, import_react3.useState)("fit");
  const activeSheet = sheets.find((s) => s.id === selectedSheetId) ?? sheets[0];
  const activeProof = proofs.find((p) => p.sheetId === activeSheet?.id);
  const decodedPages = (0, import_react3.useMemo)(() => {
    if (!activeProof?.svgPages) return [];
    return activeProof.svgPages.map((uri) => decodeSvgDataUri(uri));
  }, [activeProof]);
  const blocksByPage = (0, import_react3.useMemo)(() => {
    const map = /* @__PURE__ */ new Map();
    if (!activeProof?.blockToPage) return map;
    for (const [bid, pIdx] of Object.entries(activeProof.blockToPage)) {
      const list = map.get(pIdx) ?? [];
      list.push(bid);
      map.set(pIdx, list);
    }
    return map;
  }, [activeProof]);
  const selectedBlockPage = selectedBlockId && activeProof?.blockToPage && selectedBlockId in activeProof.blockToPage ? activeProof.blockToPage[selectedBlockId] : null;
  const targetPages = activeSheet?.geometry?.targetPages;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: toolbarStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }, children: sheets.map((sh) => {
        const pr = proofs.find((p) => p.sheetId === sh.id);
        const hasOverflow = (pr?.overflowLinesOnLastPage ?? 0) > 0;
        const active = sh.id === activeSheet?.id;
        return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
          "button",
          {
            type: "button",
            onClick: () => onSelectSheet(sh.id),
            style: {
              ...pillBtn(active),
              borderColor: hasOverflow ? "#d97706" : "rgba(128,128,128,0.32)"
            },
            children: [
              sh.title,
              " ",
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { style: { opacity: 0.68 }, children: [
                "(",
                pr?.pages ?? 0,
                "p)"
              ] }),
              hasOverflow ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { color: "#d97706", marginLeft: 4 }, children: "\u26A0" }) : null
            ]
          },
          sh.id
        );
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
        activeSheet && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
          "label",
          {
            style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.85 },
            title: "Zielseitenzahl (targetPages) f\xFCr \xDCberlauf-Pr\xFCfung",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "Ziel:" }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                "select",
                {
                  "aria-label": "Zielseiten",
                  value: targetPages === void 0 ? "" : String(targetPages),
                  onChange: (e) => {
                    const v = e.target.value;
                    onUpdateTargetPages(activeSheet.id, v === "" ? null : Number(v));
                  },
                  style: {
                    color: "inherit",
                    background: "transparent",
                    border: "1px solid rgba(128,128,128,0.32)",
                    borderRadius: 4,
                    fontSize: 11,
                    padding: "1px 4px"
                  },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", style: { color: "#111" }, children: "\u221E frei" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "1", style: { color: "#111" }, children: "1 Seite" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "2", style: { color: "#111" }, children: "2 Seiten" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "3", style: { color: "#111" }, children: "3 Seiten" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "4", style: { color: "#111" }, children: "4 Seiten" })
                  ]
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { display: "inline-flex", gap: 2 }, children: ["fit", 75, 100, 125].map((z) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "button",
          {
            type: "button",
            onClick: () => setZoom(z),
            style: pillBtn(zoom === z),
            children: z === "fit" ? "Fit" : `${z}%`
          },
          String(z)
        )) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
      "div",
      {
        style: {
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "auto",
          padding: 12,
          background: "rgba(128,128,128,0.08)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14
        },
        children: [
          activeProof?.compileError && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "div",
            {
              "data-testid": "galley-compile-error",
              style: {
                width: "100%",
                maxWidth: 560,
                boxSizing: "border-box",
                padding: "10px 12px",
                borderRadius: 6,
                border: "1px solid #dc2626",
                background: "rgba(220, 38, 38, 0.1)",
                fontSize: 12
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { fontWeight: 700, color: "#dc2626", marginBottom: 4 }, children: [
                  "Typst-Satzfehler auf Bogen ",
                  activeSheet?.title ?? selectedSheetId
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("code", { style: { display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11 }, children: activeProof.compileError.message }),
                activeProof.compileError.blockId && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                  "button",
                  {
                    type: "button",
                    onClick: () => onSelectBlock(activeProof.compileError.blockId),
                    style: { ...pillBtn(false), marginTop: 6, borderColor: "#dc2626", color: "#dc2626" },
                    children: [
                      "Zu Block ",
                      activeProof.compileError.blockId,
                      " springen"
                    ]
                  }
                )
              ]
            }
          ),
          !activeProof?.compileError && decodedPages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { opacity: 0.65, fontSize: 12, padding: 24 }, children: "Kein Fahnenabzug verf\xFCgbar." }),
          decodedPages.map((svgMarkup, idx) => {
            const total = activeProof?.pages ?? decodedPages.length;
            const dims = activeProof?.perPage?.[idx] ?? { wPt: 595, hPt: 842 };
            const isLastPage = idx === total - 1;
            const overflowText = isLastPage ? formatOverflowBanner(activeProof?.overflowLinesOnLastPage ?? 0, targetPages) : null;
            const isFocusedPage = selectedBlockPage === idx;
            const pageBlocks = blocksByPage.get(idx) ?? [];
            const widthStyle = zoom === "fit" ? { width: "100%", maxWidth: 560 } : { width: `${Math.round(560 * zoom / 100)}px`, maxWidth: "none" };
            return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
              "div",
              {
                "data-testid": `galley-proof-page-${idx + 1}`,
                style: {
                  ...widthStyle,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                    "div",
                    {
                      style: {
                        background: "#ffffff",
                        color: "#000000",
                        borderRadius: 3,
                        overflow: "hidden",
                        boxShadow: isFocusedPage ? "0 0 0 2px rgba(59,130,246,0.75), 0 3px 12px rgba(0,0,0,0.18)" : "0 2px 10px rgba(0,0,0,0.16)",
                        border: overflowText ? "1.5px solid #d97706" : "1px solid rgba(128,128,128,0.25)"
                      },
                      dangerouslySetInnerHTML: { __html: svgMarkup }
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                    "div",
                    {
                      style: {
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                        flexWrap: "wrap",
                        fontSize: 11,
                        opacity: 0.78,
                        padding: "0 2px"
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
                          "Seite ",
                          idx + 1,
                          " von ",
                          total,
                          " \xB7 ",
                          Math.round(dims.wPt),
                          "\xD7",
                          Math.round(dims.hPt),
                          " pt"
                        ] }),
                        pageBlocks.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { display: "inline-flex", gap: 3, flexWrap: "wrap" }, children: pageBlocks.map((bid) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                          "button",
                          {
                            type: "button",
                            onClick: () => onSelectBlock(bid),
                            style: {
                              ...pillBtn(bid === selectedBlockId),
                              padding: "0 5px",
                              fontSize: 10
                            },
                            children: bid
                          },
                          bid
                        )) })
                      ]
                    }
                  ),
                  overflowText && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                    "div",
                    {
                      "data-testid": "galley-overflow-strip",
                      style: {
                        padding: "5px 9px",
                        borderRadius: 5,
                        background: "rgba(217, 119, 6, 0.16)",
                        border: "1px solid #d97706",
                        color: "#d97706",
                        fontSize: 12,
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
                          "\u26A0 ",
                          overflowText
                        ] }),
                        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { fontSize: 11, fontWeight: 400, opacity: 0.9 }, children: "Text k\xFCrzen oder Zielseiten erh\xF6hen" })
                      ]
                    }
                  )
                ]
              },
              `${activeSheet?.id ?? "s"}-p${idx}`
            );
          })
        ]
      }
    )
  ] });
}

// src/client/GalleyBody.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function useNoopSessions(selector) {
  return selector({ byId: {} });
}
var STORAGE_MODE_KEY = "dsh-galley:layout-override";
function readStoredOverride() {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_MODE_KEY);
    if (v === "wide" || v === "narrow" || v === "auto") return v;
  } catch {
  }
  return "auto";
}
var headerBtn = {
  color: "inherit",
  background: "transparent",
  border: "1px solid rgba(128,128,128,0.32)",
  borderRadius: 5,
  padding: "2px 7px",
  fontSize: 11,
  cursor: "pointer",
  lineHeight: 1.4
};
function GalleyBody(props = {}) {
  const { sessionId, useSessions = useNoopSessions } = props;
  const sessionCwd = useSessions((sessions) => {
    if (!sessionId) return null;
    const cwd = sessions.byId[sessionId]?.cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
  });
  const rootRef = (0, import_react4.useRef)(null);
  const [paneWidth, setPaneWidth] = (0, import_react4.useState)(520);
  const [layoutOverride, setLayoutOverride] = (0, import_react4.useState)(() => readStoredOverride());
  const [narrowTab, setNarrowTab] = (0, import_react4.useState)("proof");
  const [health, setHealth] = (0, import_react4.useState)(null);
  const [payload, setPayload] = (0, import_react4.useState)(null);
  const [reconnecting, setReconnecting] = (0, import_react4.useState)(false);
  const [actionError, setActionError] = (0, import_react4.useState)(null);
  const [busy, setBusy] = (0, import_react4.useState)(false);
  const [selectedSheetId, setSelectedSheetId] = (0, import_react4.useState)("s1");
  const [selectedBlockId, setSelectedBlockId] = (0, import_react4.useState)(null);
  const [showNewMenu, setShowNewMenu] = (0, import_react4.useState)(false);
  const [newTitleDraft, setNewTitleDraft] = (0, import_react4.useState)("");
  const [showExportMenu, setShowExportMenu] = (0, import_react4.useState)(false);
  const [exportedFiles, setExportedFiles] = (0, import_react4.useState)(null);
  const localRevRef = (0, import_react4.useRef)(null);
  const postMutationFlagRef = (0, import_react4.useRef)(false);
  const pollTimerRef = (0, import_react4.useRef)(null);
  const healthOkRef = (0, import_react4.useRef)(false);
  (0, import_react4.useEffect)(() => {
    localRevRef.current = null;
  }, [sessionCwd]);
  (0, import_react4.useEffect)(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setPaneWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pollOnce = (0, import_react4.useCallback)(async (forceFull = false) => {
    try {
      let url = withCwdQuery(STATE_ROUTE, sessionCwd);
      const knownRev = forceFull ? null : localRevRef.current;
      if (knownRev !== null && knownRev > 0) {
        url += `${url.includes("?") ? "&" : "?"}rev=${knownRev}`;
      }
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 304) {
        setReconnecting(false);
        return { hadError: false, revAdvanced: false };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const prevRev = localRevRef.current;
      localRevRef.current = data.activePacket ? data.rev : 0;
      setPayload(data);
      setReconnecting(false);
      if (data.activePacket) {
        setSelectedSheetId((cur) => data.sheetOrder.includes(cur) ? cur : data.activeSheetId);
      }
      return {
        hadError: false,
        revAdvanced: prevRev !== null && data.activePacket && data.rev > prevRev
      };
    } catch {
      setReconnecting(true);
      return { hadError: true, revAdvanced: false };
    }
  }, [sessionCwd]);
  (0, import_react4.useEffect)(() => {
    let disposed = false;
    const probeHealth = async () => {
      try {
        const res = await fetch(HEALTH_ROUTE, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const h = await res.json();
        healthOkRef.current = Boolean(h.ok);
        if (!disposed) setHealth(h);
      } catch (err) {
        healthOkRef.current = false;
        if (!disposed) setHealth({ ok: false, error: String(err) });
      }
    };
    void probeHealth();
    const scheduleNext = (delayMs) => {
      if (disposed) return;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = window.setTimeout(runTick, delayMs);
    };
    const runTick = async () => {
      if (disposed) return;
      const hidden = typeof document !== "undefined" ? document.hidden : false;
      if (hidden) {
        scheduleNext(nextPollDelayMs({ hidden: true, hadError: false, postMutation: false, revAdvanced: false }));
        return;
      }
      const wasPostMutation = postMutationFlagRef.current;
      postMutationFlagRef.current = false;
      const { hadError, revAdvanced } = await pollOnce(false);
      if (hadError) {
        healthOkRef.current = false;
        if (!disposed) setHealth({ ok: false, error: "offline" });
      } else if (!healthOkRef.current) {
        void probeHealth();
      }
      const delay = nextPollDelayMs({
        hidden: false,
        hadError,
        postMutation: wasPostMutation,
        revAdvanced
      });
      scheduleNext(delay);
    };
    void runTick();
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void runTick();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      disposed = true;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [pollOnce]);
  const postJson = (0, import_react4.useCallback)(
    async (path, body, refreshFull = false) => {
      setBusy(true);
      setActionError(null);
      try {
        const payloadWithCwd = sessionCwd ? { ...body, cwd: sessionCwd } : body;
        const res = await fetch(withCwdQuery(path, sessionCwd), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payloadWithCwd)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          const msg = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
          setActionError(`${data.code ?? "ERROR"}: ${msg}`);
          if (res.status === 409) {
            await pollOnce(true);
          }
          return null;
        }
        postMutationFlagRef.current = true;
        await pollOnce(refreshFull);
        return data;
      } catch (err) {
        setReconnecting(true);
        setActionError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [pollOnce, sessionCwd]
  );
  const handleOpenTemplate = async (template, customTitle) => {
    setShowNewMenu(false);
    const defaultTitle = template === "arbeitsblatt" ? "Arbeitsblatt" : template === "rfc" ? "Engineering RFC" : "Dokument";
    const res = await postJson(
      EDIT_ROUTE,
      {
        op: "open",
        template,
        title: customTitle?.trim() || defaultTitle
      },
      true
    );
    if (res) setNewTitleDraft("");
  };
  const handleSwitchPacket = async (packetId) => {
    localRevRef.current = null;
    await postJson(EDIT_ROUTE, { op: "open", id: packetId }, true);
  };
  const activeData = payload && payload.activePacket ? payload : null;
  const activeSheet = (0, import_react4.useMemo)(() => {
    if (!activeData) return null;
    return activeData.sheets.find((s) => s.id === selectedSheetId) ?? activeData.sheets[0] ?? null;
  }, [activeData, selectedSheetId]);
  const allBlockIds = (0, import_react4.useMemo)(() => {
    if (!activeData) return [];
    const ids = [];
    for (const s of activeData.sheets) {
      for (const b of s.blocks) ids.push(b.id);
    }
    return ids;
  }, [activeData]);
  const paneMode = computePaneMode(paneWidth, layoutOverride);
  const setOverridePersisted = (next) => {
    setLayoutOverride(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_MODE_KEY, next);
    } catch {
    }
  };
  const handleMoveBlock = async (sheetId, blockId, direction) => {
    if (!activeData) return;
    const sh = activeData.sheets.find((s) => s.id === sheetId);
    if (!sh) return;
    const idx = sh.blocks.findIndex((b) => b.id === blockId);
    if (idx < 0) return;
    if (direction === "up" && idx > 0) {
      await postJson(EDIT_ROUTE, { op: "move", sheetId, blockId, toBeforeId: sh.blocks[idx - 1].id });
    } else if (direction === "down" && idx < sh.blocks.length - 1) {
      await postJson(EDIT_ROUTE, { op: "move", sheetId, blockId, toAfterId: sh.blocks[idx + 1].id });
    }
  };
  const handleExport = async (format) => {
    setShowExportMenu(false);
    const res = await postJson(EXPORT_ROUTE, { format });
    if (res && Array.isArray(res.files)) {
      setExportedFiles(res.files);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
    "div",
    {
      ref: rootRef,
      "data-testid": "galley-pane-root",
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        width: "100%",
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: 1.45,
        color: "currentColor",
        boxSizing: "border-box"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              flexWrap: "wrap",
              padding: "6px 10px",
              borderBottom: "1px solid rgba(128,128,128,0.22)",
              fontSize: 12
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("strong", { children: "Galley" }),
                activeData ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
                  activeData.packets.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                    "select",
                    {
                      "aria-label": "Aktive Mappe",
                      value: activeData.packetId,
                      onChange: (e) => {
                        void handleSwitchPacket(e.target.value);
                      },
                      style: {
                        color: "inherit",
                        background: "transparent",
                        border: "1px solid rgba(128,128,128,0.32)",
                        borderRadius: 4,
                        fontSize: 12,
                        padding: "1px 5px",
                        maxWidth: 150
                      },
                      children: activeData.packets.map((p) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("option", { value: p.id, style: { color: "#111" }, children: [
                        p.title,
                        " (r",
                        p.rev,
                        ")"
                      ] }, p.id))
                    }
                  ) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { style: { fontWeight: 600, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: activeData.title }),
                  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("code", { style: { fontSize: 11, opacity: 0.72 }, children: [
                    "rev ",
                    activeData.rev
                  ] })
                ] }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
                  "span",
                  {
                    title: payload?.cwd ? `Store: ${payload.cwd}` : void 0,
                    style: { fontSize: 11, opacity: 0.8 },
                    children: [
                      health?.ok ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { style: { color: "#16a34a" }, children: [
                        "\u25CF ",
                        health.arm ?? "native"
                      ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { style: { color: "#d97706" }, children: "\u25CF offline" }),
                      payload?.cwd ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { style: { opacity: 0.65, marginLeft: 5 }, children: shortCwdLabel(payload.cwd) }) : null
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }, children: [
                activeData && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                    "button",
                    {
                      type: "button",
                      title: "R\xFCckg\xE4ngig (Undo)",
                      disabled: activeData.undoDepth === 0 || busy,
                      onClick: () => {
                        void postJson(EDIT_ROUTE, { op: "undo" });
                      },
                      style: { ...headerBtn, opacity: activeData.undoDepth === 0 ? 0.35 : 1 },
                      children: "\u21B6"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                    "button",
                    {
                      type: "button",
                      title: "Wiederholen (Redo)",
                      disabled: activeData.redoDepth === 0 || busy,
                      onClick: () => {
                        void postJson(EDIT_ROUTE, { op: "redo" });
                      },
                      style: { ...headerBtn, opacity: activeData.redoDepth === 0 ? 0.35 : 1 },
                      children: "\u21B7"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => setShowNewMenu((v) => !v),
                    style: headerBtn,
                    children: "+ Mappe"
                  }
                ),
                activeData && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    "data-testid": "galley-export-btn",
                    onClick: () => setShowExportMenu((v) => !v),
                    style: headerBtn,
                    children: "Export \u25BE"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    title: "Ansichtsmodus wechseln (Auto / Split / Tabs)",
                    onClick: () => setOverridePersisted(
                      layoutOverride === "auto" ? "wide" : layoutOverride === "wide" ? "narrow" : "auto"
                    ),
                    style: { ...headerBtn, opacity: 0.8 },
                    children: layoutOverride === "auto" ? `Auto (${paneMode === "wide" ? "Split" : "Tabs"})` : layoutOverride === "wide" ? "Split" : "Tabs"
                  }
                )
              ] })
            ]
          }
        ),
        reconnecting && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "div",
          {
            "data-testid": "galley-reconnecting-strip",
            style: {
              padding: "4px 10px",
              background: "rgba(217, 119, 6, 0.16)",
              borderBottom: "1px solid #d97706",
              color: "#d97706",
              fontSize: 11,
              fontWeight: 600
            },
            children: "\u27F3 Verbinde erneut mit Host\u2026 (lokale Eingaben bleiben erhalten)"
          }
        ),
        actionError && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            "data-testid": "galley-error-strip",
            style: {
              padding: "5px 10px",
              background: "rgba(220, 38, 38, 0.12)",
              borderBottom: "1px solid #dc2626",
              color: "#dc2626",
              fontSize: 11,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: actionError }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", onClick: () => setActionError(null), style: headerBtn, children: "\u2715" })
            ]
          }
        ),
        showNewMenu && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            style: {
              padding: "8px 10px",
              borderBottom: "1px solid rgba(128,128,128,0.22)",
              background: "rgba(128,128,128,0.06)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 12
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "input",
                {
                  "aria-label": "Titel der neuen Mappe",
                  placeholder: "Titel der Mappe (optional)\u2026",
                  value: newTitleDraft,
                  onChange: (e) => setNewTitleDraft(e.target.value),
                  style: {
                    color: "inherit",
                    background: "transparent",
                    border: "1px solid rgba(128,128,128,0.32)",
                    borderRadius: 5,
                    padding: "4px 7px",
                    fontSize: 12
                  }
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", style: headerBtn, onClick: () => {
                  void handleOpenTemplate("arbeitsblatt", newTitleDraft);
                }, children: "Arbeitsblatt + Erwartungshorizont" }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", style: headerBtn, onClick: () => {
                  void handleOpenTemplate("rfc", newTitleDraft);
                }, children: "Engineering RFC" }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", style: headerBtn, onClick: () => {
                  void handleOpenTemplate("generic", newTitleDraft);
                }, children: "Leeres Dokument" })
              ] })
            ]
          }
        ),
        showExportMenu && activeData && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            style: {
              padding: "6px 10px",
              borderBottom: "1px solid rgba(128,128,128,0.22)",
              background: "rgba(128,128,128,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              fontSize: 11
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: "Format exportieren:" }),
              ["pdf", "typ", "md", "tex"].map((fmt) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("button", { type: "button", style: headerBtn, onClick: () => {
                void handleExport(fmt);
              }, children: [
                ".",
                fmt.toUpperCase()
              ] }, fmt))
            ]
          }
        ),
        exportedFiles && exportedFiles.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            "data-testid": "galley-export-receipt",
            style: {
              padding: "6px 10px",
              borderBottom: "1px solid rgba(22,163,74,0.45)",
              background: "rgba(22,163,74,0.1)",
              fontSize: 11,
              display: "flex",
              flexDirection: "column",
              gap: 3
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("strong", { style: { color: "#16a34a" }, children: "\u2713 Export erstellt" }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", onClick: () => setExportedFiles(null), style: headerBtn, children: "\u2715" })
              ] }),
              exportedFiles.map((f) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("code", { children: [
                  f.path,
                  " (",
                  (f.sizeBytes / 1024).toFixed(1),
                  " KB)"
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      void navigator.clipboard?.writeText(f.path);
                    },
                    style: headerBtn,
                    children: "Pfad kopieren"
                  }
                )
              ] }, f.path))
            ]
          }
        ),
        !payload && !reconnecting && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { padding: 24, opacity: 0.7, fontSize: 12 }, children: "Lade Galley-Status\u2026" }),
        !payload && reconnecting && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { padding: 24, opacity: 0.85, fontSize: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: "Galley-Host derzeit nicht erreichbar" }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { opacity: 0.75 }, children: "Automatischer Neuverbindungsversuch alle 2 Sekunden\u2026" })
        ] }),
        payload && !payload.activePacket && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            "data-testid": "galley-empty-state",
            style: {
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
              gap: 12,
              textAlign: "center"
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { fontWeight: 700, fontSize: 15 }, children: "Mappe \xF6ffnen \xB7 Druck und Satz" }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { fontSize: 12, opacity: 0.76, maxWidth: 340 }, children: "W\xE4hle eine Vorlage f\xFCr den gemeinsamen Satz mit sofortigem Typst-A4-Fahnenabzug:" }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "input",
                {
                  "aria-label": "Mappentitel",
                  placeholder: "Titel (z. B. Br\xFCche: Addieren)\u2026",
                  value: newTitleDraft,
                  onChange: (e) => setNewTitleDraft(e.target.value),
                  style: {
                    width: "100%",
                    maxWidth: 300,
                    boxSizing: "border-box",
                    color: "inherit",
                    background: "transparent",
                    border: "1px solid rgba(128,128,128,0.34)",
                    borderRadius: 6,
                    padding: "6px 9px",
                    fontSize: 12
                  }
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 300 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    "data-testid": "galley-open-arbeitsblatt",
                    onClick: () => {
                      void handleOpenTemplate("arbeitsblatt", newTitleDraft);
                    },
                    style: { ...headerBtn, padding: "8px 12px", fontWeight: 600 },
                    children: "\u25A4 Arbeitsblatt + Erwartungshorizont (A4, Ziel 1 S.)"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    "data-testid": "galley-open-rfc",
                    onClick: () => {
                      void handleOpenTemplate("rfc", newTitleDraft);
                    },
                    style: { ...headerBtn, padding: "7px 12px" },
                    children: "\xA7 Engineering RFC"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    "data-testid": "galley-open-generic",
                    onClick: () => {
                      void handleOpenTemplate("generic", newTitleDraft);
                    },
                    style: { ...headerBtn, padding: "7px 12px" },
                    children: "\u25A1 Leeres Dokument (Generic)"
                  }
                )
              ] }),
              payload.packets.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { marginTop: 8, width: "100%", maxWidth: 300, textAlign: "left", fontSize: 12 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { opacity: 0.7, marginBottom: 4 }, children: "Vorhandene Mappen im Projekt:" }),
                payload.packets.map((p) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      void handleSwitchPacket(p.id);
                    },
                    style: { ...headerBtn, width: "100%", textAlign: "left", marginBottom: 4, padding: "5px 8px" },
                    children: [
                      p.title,
                      " ",
                      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { style: { opacity: 0.65 }, children: [
                        "(",
                        p.id,
                        " \xB7 rev ",
                        p.rev,
                        ")"
                      ] })
                    ]
                  },
                  p.id
                ))
              ] })
            ]
          }
        ),
        activeData && activeSheet && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
          paneMode === "narrow" && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
            "div",
            {
              "data-testid": "galley-narrow-tabs",
              style: {
                display: "flex",
                gap: 4,
                padding: "5px 10px",
                borderBottom: "1px solid rgba(128,128,128,0.2)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "button",
                  {
                    type: "button",
                    onClick: () => setNarrowTab("proof"),
                    style: {
                      ...headerBtn,
                      flex: 1,
                      fontWeight: narrowTab === "proof" ? 700 : 400,
                      background: narrowTab === "proof" ? "rgba(128,128,128,0.2)" : "transparent"
                    },
                    children: "Fahnenabzug (Proof)"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
                  "button",
                  {
                    type: "button",
                    onClick: () => setNarrowTab("blocks"),
                    style: {
                      ...headerBtn,
                      flex: 1,
                      fontWeight: narrowTab === "blocks" ? 700 : 400,
                      background: narrowTab === "blocks" ? "rgba(128,128,128,0.2)" : "transparent"
                    },
                    children: [
                      "Bl\xF6cke (",
                      activeSheet.blocks.length,
                      ")"
                    ]
                  }
                )
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }, children: [
            (paneMode === "wide" || narrowTab === "proof") && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "div",
              {
                style: {
                  flex: paneMode === "wide" ? "0 0 55%" : "1 1 auto",
                  minHeight: 0,
                  borderBottom: paneMode === "wide" ? "1px solid rgba(128,128,128,0.24)" : void 0
                },
                children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  ProofView,
                  {
                    sheets: activeData.sheets,
                    proofs: activeData.proofs,
                    selectedSheetId: activeSheet.id,
                    selectedBlockId,
                    onSelectSheet: (sid) => setSelectedSheetId(sid),
                    onSelectBlock: (bid) => {
                      setSelectedBlockId(bid);
                      if (paneMode === "narrow") setNarrowTab("blocks");
                    },
                    onUpdateTargetPages: (sid, tp) => {
                      void postJson(EDIT_ROUTE, { op: "update-geometry", sheetId: sid, targetPages: tp });
                    }
                  }
                )
              }
            ),
            (paneMode === "wide" || narrowTab === "blocks") && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { flex: paneMode === "wide" ? "1 1 45%" : "1 1 auto", minHeight: 0 }, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              BlockTray,
              {
                sheet: activeSheet,
                allBlockIds,
                assets: activeData.assets,
                selectedBlockId,
                busy,
                onSelectBlock: (bid) => setSelectedBlockId(bid),
                onInsertBlock: async (sid, block, afterBlockId) => {
                  const res = await postJson(EDIT_ROUTE, {
                    op: "insert",
                    sheetId: sid,
                    block,
                    afterBlockId
                  });
                  const created = res?.block;
                  if (created?.id) setSelectedBlockId(created.id);
                },
                onPatchBlock: async (blockId, patch, baseHash) => {
                  await postJson(EDIT_ROUTE, {
                    op: "patch",
                    sheetId: activeSheet.id,
                    blockId,
                    patch,
                    baseHash
                  });
                },
                onMoveBlock: handleMoveBlock,
                onRemoveBlock: async (sid, blockId) => {
                  if (selectedBlockId === blockId) setSelectedBlockId(null);
                  await postJson(EDIT_ROUTE, { op: "remove", sheetId: sid, blockId });
                },
                onUploadAsset: async (uploadArgs) => {
                  await postJson(EDIT_ROUTE, {
                    op: "insert-asset",
                    ...uploadArgs
                  });
                },
                onDecideProposal: async (proposalId, action) => {
                  await postJson(`${PROPOSAL_ROUTE_PREFIX}/${encodeURIComponent(proposalId)}/decide`, { action });
                },
                onAddAnnotation: async (blockId, body) => {
                  await postJson(EDIT_ROUTE, { op: "annotate-add", blockId, body });
                },
                onResolveAnnotation: async (blockId, annotationId) => {
                  await postJson(EDIT_ROUTE, { op: "annotate-resolve", blockId, annotationId });
                }
              }
            ) })
          ] })
        ] })
      ]
    }
  );
}

// src/client/GalleyIcon.tsx
var import_jsx_runtime5 = require("react/jsx-runtime");
function GalleyIcon({ size = 16, className, style }) {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true",
      className,
      style,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("rect", { x: "3.5", y: "2", width: "9", height: "12", rx: "1", stroke: "currentColor" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M5.2 4.5H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M5.2 6.8H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M5.2 9.1H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M7 4.5H11", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M7 6.8H11", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M7 9.1H10", stroke: "currentColor", strokeLinecap: "round" })
      ]
    }
  );
}

// src/client/index.tsx
var name = PLUGIN;
var inject = ["slots", "sidebarRightTabs"];
function apply(ctx) {
  const definition = {
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => TAB_TITLE,
    guide: [
      {
        id: "galley",
        order: 285,
        title: () => TAB_TITLE,
        description: () => "Document co-authoring & Typst A4 proof (Druck und Satz): block packets, instant native render, deterministic PDF/DOCX",
        icon: GalleyIcon
      }
    ]
  };
  const disposeType = ctx.sidebarRightTabs.register(definition);
  const disposeBody = ctx.slots.inject(
    "sidebar.right.pane.tab",
    () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, GalleyBody)
  );
  ctx.effect(() => () => {
    disposeBody();
    disposeType();
  }, "galley: rightbar tab type");
}
return module.exports; } });
//# sourceMappingURL=client.js.map
