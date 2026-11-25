/**
 * WASM arm (portable fallback): @myriaddreamin/typst.ts@0.7.0. Used when the
 * native binding fails to load. Pure WASM + local fonts (offline-deterministic).
 * Init ~565 ms; warm render ~2–7 ms (M0). Compiles twice per render (pdf + svg).
 */
import { BaseArm } from './base.ts'
import { ArmError } from './types.ts'
import type { CompiledTyp, ShadowFile } from './types.ts'

interface WasmModule {
  createTypstCompiler(): any
  MemoryAccessModel: new () => any
  initOptions: { withAccessModel(m: any): any }
  loadFonts(files: unknown[], opts: { assets: string[] }): any
}

/** Pages inferred from the stacked SVG viewBox (A4 vs letter by width). */
export function inferPagesFromSvg(svg: string): number {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (!m) return 1
  const w = Number(m[1])
  const h = Number(m[2])
  const pageH = Math.abs(w - 595.28) < 6 ? 841.89 : 792 // A4 or letter
  return Math.max(1, Math.round(h / pageH))
}

export class WasmArm extends BaseArm {
  readonly name = 'wasm' as const
  private compiler: any = null
  private model: any = null
  private counter = 0

  async init(): Promise<void> {
    if (this.compiler) return
    const mod = (await import('@myriaddreamin/typst.ts')) as unknown as WasmModule
    this.model = new mod.MemoryAccessModel()
    this.compiler = mod.createTypstCompiler()
    await this.compiler.init({
      beforeBuild: [mod.initOptions.withAccessModel(this.model), mod.loadFonts([], { assets: ['text'] })],
    })
  }

  protected async compileTyp(typ: string, shadows?: ShadowFile[]): Promise<CompiledTyp> {
    const c = this.compiler
    const model = this.model
    if (!c || !model) throw new ArmError('wasm arm not initialized')
    const path = `/@memory/galley-${this.counter++}.typ`
    // Map asset bytes into the virtual FS (relative to the main file's dir).
    for (const s of shadows ?? []) {
      try {
        model.insertFile(`/@memory/${s.path}`, s.bytes, new Date())
      } catch {
        /* best-effort; a missing asset degrades to an empty image slot */
      }
    }
    model.insertFile(path, new TextEncoder().encode(typ), new Date())
    let pdfResult: any
    let svgResult: any
    try {
      pdfResult = await c.compile({ format: 'pdf', mainFilePath: path, diagnostics: 'none' })
      svgResult = await c.compile({ format: 'svg', mainFilePath: path, diagnostics: 'none' })
    } catch (e) {
      throw new ArmError(`wasm compile failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    const pdf = Buffer.from(pdfResult.result)
    const svg = typeof svgResult.result === 'string' ? svgResult.result : Buffer.from(svgResult.result).toString('utf8')
    return { pdf, svg, pages: inferPagesFromSvg(svg), diags: [] }
  }
}
