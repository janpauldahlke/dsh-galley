# dsh-galley

> **Status:** `0.0.1` — Exploration Phase / local Model

Shared volatile **document workbench & typesetter** (*Druck und Satz*) for
human + agent co-authoring in the **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (`dsh`) web and desktop UI.

npm package (planned) and GitHub repo share the name `dsh-galley`
([`janpauldahlke/dsh-galley`](https://github.com/janpauldahlke/dsh-galley)).
First foundational plugin of **The Ivory Tower** document & knowledge studio suite.

---

## Why `dsh-galley`?

![Traditional letterpress galley tray (Setzschiff) holding composed movable type and an illustration block](./media/galley.jpg)

In traditional letterpress printing (*Druck und Satz*), a **galley**
(*Setzschiff* / *Fahnenabzug*) is the volatile composing tray where movable
blocks of text and illustrations are arranged, proofed at actual page dimensions,
annotated in the margins, and revised before locking up for final print.

Today in DeepSeek Harness:

- `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` is strictly **read-only**
and **model-blind** (what the user views never enters model context, and
nothing can be edited in place).
- `@deepseek-ai/dsh-skill-office` requires shell execution (`bash` + Python) and
full-file regeneration via LibreOffice conversion on every single wording tweak.

`dsh-galley` fills that gap without touching or forking `dsh` core: **human and
agent share a live, block-addressed document tray in the rightbar**, backed by
instant local **Typst** page typesetting and deterministic exporters.

---

## Core Design Principles

1. **The workbench needs zero AI to edit or typeset.**

   Direct human typing, block reordering, layout switching (full-width, text
    beside media, two-column, card grids), marginal line numbers, and multi-step
    undo run locally in 0 ms with zero LLM calls.
2. **Host-owned Block AST — diffs in, surgical patches out.**

   A galley packet (*Mappe*, e.g. `[Worksheet] + [Answer Key]` or
    `[RFC] + [Appendix]`) is stored in Host memory as keyed, content-hashed
    blocks (`b1`, `b2`, …) with optional `dependsOn` links (`answer-2` →
    `task-2`). When the human edits `task-2`, the Host marks `answer-2` stale
    deterministically (`0` tokens) and injects only compact block summaries +
    deltas on the next agent turn — never re-sending whole documents.
3. **Instant *Fahnenabzug* (Galley Proof) via Typst.**

   The Host compiles the Block AST through clean `.typ` templates into live
    A4/Letter SVG pages in milliseconds. Every mutating agent tool receives a
    deterministic typesetting receipt (`pages`, `overflow`, `staleDependents`) so
    the model knows immediately if content spilled 3 lines onto Page 2 — no
    vision model required.
4. **Propose & annotate, never trample.**

   Agent edits to existing blocks land as calm **inline diff proposals**
    (`[Accept] / [Revert]`) with bounded undo history. Via `galley_annotate`, the
    agent can also act purely as a *Lektor* — attaching margin notes
    (*Randnotizen*) grounded in reference material without overwriting user text.
5. **Write once, export cleanly.**

   Finalizing compiles the same intermediate Block AST deterministically to:
   - `.pdf` (print-ready via Typst)
   - `.docx` (house-style editable Word output; side-by-side media rendered
   via clean borderless OOXML tables rather than fragile floating anchors)
   - `.typ` **/** `.tex` **/** `.md` (for researchers, engineers, and TeX workflows)

---

## Planned Agent Tool Catalog (v0 draft)

| Tool | Role |
| --- | --- |
| `galley_open` | Initialize or switch active galley packet (*Mappe*), template, and page geometry |
| `galley_status` | Compact outline: sheets, block IDs, types, hashes, page count, overflow, stale links |
| `galley_read_block` | Read verbatim content of specific block ID(s) on demand |
| `galley_insert_block` | Insert a typed block (`header`, `prose`, `source_text`, `task`, `table`, `callout`, `answer`) with optional media slot & `dependsOn` |
| `galley_patch_block` | Surgical update to one block (renders as inline diff proposal when touching existing content; returns Typst page/overflow receipt) |
| `galley_move_block` / `galley_remove_block` | Reorder or remove keyed blocks |
| `galley_annotate` | Attach or resolve non-destructive margin notes (*Randnotizen*) on a block |
| `galley_export` | Compile finalized packet to `.pdf`, `.docx`, `.typ`, `.tex`, or `.md` |

---

## Packaging & Sibling Suite

Built with [`dsh-build-tools`](https://github.com/janpauldahlke/dsh-build-tools)
as a standard dual-face `dsh` bundle (`lib/index.js` ESM Host + `lib/client.js`
CJS `__ModuleLoader__` Client + standalone testable `.mjs` modules for
`node --test`).

| Plugin                                                                              | Role                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`dsh-build-tools`](https://github.com/janpauldahlke/dsh-build-tools)               | Dual-face ESM/CJS bundler + byte-diff verifier        |
| [`dsh-web-missions`](https://github.com/janpauldahlke/dsh-web-missions)             | Budgeted, receipted local web research                |
| [`dsh-web-discovery`](https://github.com/janpauldahlke/dsh-web-discovery)           | Local search URL supplier (browser39 / SearXNG)       |
| [`dsh-memento`](https://github.com/janpauldahlke/dsh-memento)                       | Human-curated bounded session memory                  |
| [`dsh-local-long-horizon`](https://github.com/janpauldahlke/dsh-local-long-horizon) | Host-owned multi-step task status board               |
| `dsh-galley`                                                                        | Shared volatile document workbench & Typst typesetter |

---

## License

MIT — see [`LICENSE`](./LICENSE).
