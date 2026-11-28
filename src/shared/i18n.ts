/**
 * Lightweight, dependency-free localization dictionary for `dsh-galley`.
 *
 * Architectural Decision (M3.2):
 * - `dsh-galley` is an English-first, domain-neutral typesetting & co-authoring
 *   workbench (`DEFAULT_LOCALE = 'en'`).
 * - All workbench UI chrome, preflight messages, and default print labels use
 *   English (`en`).
 * - German (`de`) is stubbed alongside `en` so companion leaf bundles (e.g.
 *   `dsh-galley-didaktik` setting `locale: 'de'` on German templates) can emit
 *   authentic German print labels (`Aufgabe 1`, `Tipp`, `Achtung`, `Klasse:`)
 *   and future host/user locale selection can switch UI strings without any
 *   refactor.
 */

export type GalleyLocale = 'en' | 'de'

export const DEFAULT_LOCALE: GalleyLocale = 'en'

export interface GalleyPrintStrings {
  typstLang: string
  headerEyebrow: string
  groupPrefix: string
  namePrefix: string
  taskPrefix: string
  calloutLabels: {
    info: string
    hint: string
    warning: string
  }
}

export interface GalleyPreflightStrings {
  staleMissingOrigin: (blockId: string, originId: string) => string
  staleChangedOrigin: (blockId: string, originId: string) => string
  unansweredTask: (blockId: string) => string
  pageOverflow: (sheetTitle: string, target: number | string, overflow: number) => string
  sourceLineWrap: (blockId: string, lineNum: number, charLen: number) => string
  unknownHeaderFields: (blockId: string, keys: string[]) => string
  emptyHeaderTitle: (blockId: string) => string
  preflightInternal: (checkId: string, errorMessage: string) => string
}

export interface GalleyUiStrings {
  packet: string
  packets: string
  sheet: string
  sheets: string
  addSheet: string
  proof: string
  blocks: string
  addBlock: string
  noBlocksYet: string
  template: string
  saveAsTemplate: string
  overflowOverTarget: (lines: number, targetPages: number) => string
  overflowGeneric: (lines: number) => string
  overflowHint: string
}

export interface GalleyLocaleBundle {
  print: GalleyPrintStrings
  preflight: GalleyPreflightStrings
  ui: GalleyUiStrings
}

export const GALLEY_I18N: Record<GalleyLocale, GalleyLocaleBundle> = {
  en: {
    print: {
      typstLang: 'en',
      headerEyebrow: 'DOCUMENT',
      groupPrefix: 'Group: ',
      namePrefix: 'Name: ',
      taskPrefix: 'Task',
      calloutLabels: {
        info: 'Info',
        hint: 'Hint',
        warning: 'Warning',
      },
    },
    preflight: {
      staleMissingOrigin: (id, origin) => `Block ${id} references removed block ${origin}`,
      staleChangedOrigin: (id, origin) => `Block ${id} is stale (origin ${origin} changed)`,
      unansweredTask: (id) => `Task ${id} has no linked answer (dependsOn) on a follow-up sheet`,
      pageOverflow: (title, target, overflow) =>
        `Sheet "${title}" exceeds target (${target}p) by +${overflow} lines`,
      sourceLineWrap: (id, line, len) =>
        `Source text ${id}: line ${line} (${len} chars) may soft-wrap and shift marginal line numbers`,
      unknownHeaderFields: (id, keys) =>
        `Header ${id} ignored unsupported field(s): ${keys.join(', ')} (supported: title, subtitle, subject/fach, meta/klasse, date/datum, name)`,
      emptyHeaderTitle: (id) => `Header ${id} has an empty title (set fields.title)`,
      preflightInternal: (checkId, err) => `Preflight check "${checkId}" failed internally: ${err}`,
    },
    ui: {
      packet: 'Packet',
      packets: 'Packets',
      sheet: 'Sheet',
      sheets: 'Sheets',
      addSheet: '+ Sheet',
      proof: 'Galley Proof',
      blocks: 'Blocks',
      addBlock: '+ Add Block',
      noBlocksYet: 'No blocks on this sheet yet — click "+ Add Block" to start.',
      template: 'Template',
      saveAsTemplate: '★ Save as Template',
      overflowOverTarget: (lines, tp) => `+${lines} lines over ${tp} ${tp === 1 ? 'page' : 'pages'}`,
      overflowGeneric: (lines) => `+${lines} lines overflow`,
      overflowHint: 'Trim text or raise target pages',
    },
  },
  // Stubbed German bundle (used for `locale: 'de'` print labels on German domain templates;
  // UI strings reserved until host/user locale wiring is finalized).
  de: {
    print: {
      typstLang: 'de',
      headerEyebrow: 'TITEL',
      groupPrefix: 'Klasse: ',
      namePrefix: 'Name: ',
      taskPrefix: 'Aufgabe',
      calloutLabels: {
        info: 'Info',
        hint: 'Tipp',
        warning: 'Achtung',
      },
    },
    preflight: {
      staleMissingOrigin: (id, origin) => `Block ${id} verweist auf entfernten Block ${origin}`,
      staleChangedOrigin: (id, origin) => `Block ${id} ist veraltet (Ursprung ${origin} wurde geändert)`,
      unansweredTask: (id) => `Aufgabe ${id} hat noch keine verknüpfte Lösung (dependsOn) auf einem Folgebogen`,
      pageOverflow: (title, target, overflow) =>
        `Bogen "${title}" überschreitet Ziel (${target} S.) um +${overflow} Zeilen`,
      sourceLineWrap: (id, line, len) =>
        `Quellentext ${id}: Zeile ${line} (${len} Zeichen) bricht ggf. um und verschiebt nachfolgende Randzeilennummern`,
      unknownHeaderFields: (id, keys) =>
        `Kopfbereich ${id} ignoriert unbekannte Felder: ${keys.join(', ')} (unterstützt: title/titel, subtitle/untertitel, subject/fach, meta/klasse, date/datum, name)`,
      emptyHeaderTitle: (id) => `Kopfbereich ${id} hat keinen Titel (fields.title / fields.titel setzen)`,
      preflightInternal: (checkId, err) => `Vorabprüfung "${checkId}" intern fehlgeschlagen: ${err}`,
    },
    ui: {
      packet: 'Mappe',
      packets: 'Mappen',
      sheet: 'Bogen',
      sheets: 'Bögen',
      addSheet: '+ Bogen',
      proof: 'Fahnenabzug',
      blocks: 'Blöcke',
      addBlock: '+ Block anfügen',
      noBlocksYet: 'Noch keine Blöcke auf diesem Bogen — über „+ Block anfügen“ starten.',
      template: 'Vorlage',
      saveAsTemplate: '★ Als Vorlage speichern',
      overflowOverTarget: (lines, tp) => `+${lines} Zeilen über ${tp} ${tp === 1 ? 'Seite' : 'Seiten'}`,
      overflowGeneric: (lines) => `+${lines} Zeilen Überlauf`,
      overflowHint: 'Text kürzen oder Zielseiten erhöhen',
    },
  },
}

export function getGalleyStrings(locale?: GalleyLocale | string | null): GalleyLocaleBundle {
  if (locale === 'de') return GALLEY_I18N.de
  return GALLEY_I18N.en
}
