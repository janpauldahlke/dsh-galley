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
var TAB_ID = "galley";
var TAB_KIND = "galley";
var TAB_TITLE = "Galley";

// src/client/GalleyBody.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
var base = {
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.5,
  color: "currentColor",
  padding: 12,
  boxSizing: "border-box"
};
function Row({ k, v }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(128,128,128,0.18)" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.7 }, children: k }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: v })
  ] });
}
function GalleyBody() {
  const [state, setState] = (0, import_react.useState)({ status: "loading" });
  const [tick, setTick] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    let alive = true;
    setState({ status: "loading" });
    fetchJson(HEALTH_ROUTE).then((data) => {
      if (alive) setState({ status: data.ok ? "ok" : "error", data });
    }).catch((error) => {
      if (alive) setState({ status: "error", data: { ok: false, error: String(error) } });
    });
    return () => {
      alive = false;
    };
  }, [tick]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: base, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Galley \xB7 Druck und Satz" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          onClick: () => setTick((t) => t + 1),
          style: { color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12 },
          children: "Re-render"
        }
      )
    ] }),
    state.status === "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.7 }, children: "Compiling the sample packet in-process\u2026" }),
    state.status === "error" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { opacity: 0.85 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: "Host proof unavailable" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { style: { fontSize: 12, opacity: 0.8 }, children: state.data?.error ?? "unknown" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 6, fontSize: 12, opacity: 0.7 }, children: [
        "Is a ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "dsh web" }),
        " host with this plugin installed running? The host face must be active for the proof to render."
      ] })
    ] }),
    state.status === "ok" && state.data && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "status", v: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "green" }, children: "\u25CF native arm OK" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "arm / typst", v: `${state.data.arm} \xB7 ${state.data.typst}` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "pages", v: state.data.sample?.pages }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "pdf", v: `${state.data.sample ? (state.data.sample.pdfBytes / 1024).toFixed(1) : "?"} KB` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "svg", v: `${state.data.sample ? (state.data.sample.svgBytes / 1024).toFixed(1) : "?"} KB` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { k: "compile", v: `${state.data.sample?.ms} ms` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 10, fontSize: 12, opacity: 0.7 }, children: [
        "The host compiled the sample ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: ".typ" }),
        " with the native Typst 0.14.2 arm. Full A4 SVG proof + block editing land in M2\u2013M3."
      ] })
    ] })
  ] });
}

// src/client/GalleyIcon.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function GalleyIcon({ size = 16, className, style }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("rect", { x: "3.5", y: "2", width: "9", height: "12", rx: "1", stroke: "currentColor" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M5.2 4.5H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M5.2 6.8H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M5.2 9.1H6", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M7 4.5H11", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M7 6.8H11", stroke: "currentColor", strokeLinecap: "round" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M7 9.1H10", stroke: "currentColor", strokeLinecap: "round" })
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
