/**
 * Offline bundled font loader for Native, WASM, and CLI Typst arms (M4.2).
 *
 * Reads the SIL-OFL-1.1 font files from `<pkgRoot>/fonts/` via `node:fs`
 * (`readFileSync`), which works identically in development, `npm pack`
 * tarball installs, and Electron `app.asar` archives without any runtime
 * CDN/network fetches.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLED_FONT_FILES = [
  'LiberationSans-Regular.ttf',
  'LiberationSans-Bold.ttf',
  'LiberationSans-Italic.ttf',
  'LiberationSerif-Regular.ttf',
  'LiberationMono-Regular.ttf',
  'NotoSansMath-Regular.ttf',
] as const

let cachedFontsDir: string | null | undefined
let cachedFontBlobs: Buffer[] | null = null

/** Locate the package `fonts/` directory whether running from `lib/` or `src/host/arms/`. */
export function resolveBundledFontsDir(): string | null {
  if (cachedFontsDir !== undefined) return cachedFontsDir
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDir, '..', 'fonts'),       // built `lib/index.js` → `../fonts`
    resolve(moduleDir, '..', '..', '..', 'fonts'), // unbundled `src/host/arms/fonts.ts` → `../../../fonts`
    resolve(process.cwd(), 'fonts'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, BUNDLED_FONT_FILES[0]))) {
      cachedFontsDir = dir
      return dir
    }
  }
  cachedFontsDir = null
  return null
}

/** Read and memoize all bundled `.ttf` / `.otf` font files as Node `Buffer`s. */
export function loadBundledFontBlobs(): Buffer[] {
  if (cachedFontBlobs) return cachedFontBlobs
  const dir = resolveBundledFontsDir()
  if (!dir) {
    cachedFontBlobs = []
    return cachedFontBlobs
  }
  const files = readdirSync(dir)
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .sort()
  cachedFontBlobs = files.map((f) => readFileSync(join(dir, f)))
  return cachedFontBlobs
}
