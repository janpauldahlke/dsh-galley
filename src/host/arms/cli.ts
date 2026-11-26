/**
 * CLI arm (reference): spawns the vendored `typst` binary (0.15.1). The only
 * arm that prints source positions (`file:line:col`), so it owns error
 * attribution (spec 03 §4.2) and is the export path of record. ~100 ms per
 * render (spawn + compile); used on demand, not on the hot path.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { BaseArm } from './base.ts'
import { resolveBundledFontsDir } from './fonts.ts'
import { ArmError } from './types.ts'
import type { CompiledTyp, ShadowFile } from './types.ts'
import { parseCliDiagnostics } from '../../typst/index.ts'
import { inferPagesFromSvg } from './wasm.ts'

const DEFAULT_BIN = resolve('vendor', 'typst', 'typst-x86_64-unknown-linux-musl', 'typst')

export class CliArm extends BaseArm {
  readonly name = 'cli' as const
  private readonly bin: string
  private dir: string | null = null

  constructor(bin: string = DEFAULT_BIN) {
    super()
    this.bin = bin
  }

  async init(): Promise<void> {
    if (!existsSync(this.bin)) throw new ArmError(`cli binary not found: ${this.bin}`)
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'galley-cli-'))
  }

  protected compileTyp(typ: string, shadows?: ShadowFile[]): CompiledTyp {
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'galley-cli-'))
    const src = join(this.dir, 'in.typ')
    const pdfOut = join(this.dir, 'out.pdf')
    const svgOut = join(this.dir, 'out.svg')
    // Materialize shadow files (asset bytes) so `#image("assets/…")` resolves.
    for (const s of shadows ?? []) {
      const p = join(this.dir, s.path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, s.bytes)
    }
    writeFileSync(src, typ, 'utf8')

    const diags: { message: string; line?: number }[] = []
    const fontsDir = resolveBundledFontsDir()
    const fontFlags = fontsDir ? ['--font-path', fontsDir] : []
    try {
      execFileSync(this.bin, ['compile', ...fontFlags, src, pdfOut], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
      execFileSync(this.bin, ['compile', ...fontFlags, src, svgOut], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      const anyErr = e as { stderr?: string | Buffer; message?: string }
      const errText = (typeof anyErr.stderr === 'string' ? anyErr.stderr : Buffer.from(anyErr.stderr ?? '').toString('utf8')) ||
        (anyErr.message ?? String(e))
      const parsed = parseCliDiagnostics(errText)
      throw new ArmError(
        `cli compile failed: ${errText.split('\n').find((l) => l.trim()) ?? 'unknown error'}`,
        parsed.map((d) => ({ message: d.message ?? 'compile error', blockId: null, line: d.line, col: d.col })),
      )
    }

    const pdf = readFileSync(pdfOut)
    const svg = readFileSync(svgOut, 'utf8')
    return { pdf, svg, pages: inferPagesFromSvg(svg), diags }
  }

  /** Clean up the temp dir (call on arm teardown). */
  dispose(): void {
    if (this.dir && existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true })
    this.dir = null
  }
}
