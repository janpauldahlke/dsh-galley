/**
 * WASM arm (portable offline fallback): @myriaddreamin/typst.ts@0.7.0 +
 * @myriaddreamin/typst-ts-renderer@0.7.0.
 *
 * Used when the native N-API binding fails to load or when `GALLEY_TYPST_ARM=wasm`.
 * Loads bundled SIL-OFL-1.1 font blobs from `fonts/` with `assets: false` and a
 * hard offline fetcher guard — zero CDN/network requests at runtime or install.
 */
import { BaseArm } from './base.ts'
import { loadBundledFontBlobs } from './fonts.ts'
import { ArmError } from './types.ts'
import type { CompiledTyp, ShadowFile } from './types.ts'

interface WasmModule {
  createTypstCompiler(): any
  createTypstRenderer(): any
  MemoryAccessModel: new () => any
  initOptions: { withAccessModel(m: any): any }
  loadFonts(files: Uint8Array[], opts: { assets: false; fetcher?: (input: unknown) => Promise<never> }): any
}

/** Numeric `CompileFormatEnum` values inside `@myriaddreamin/typst.ts` (`compiler.mjs`). */
const WASM_FORMAT_VECTOR = 0
const WASM_FORMAT_PDF = 1

const offlineFetcher = async (url: unknown): Promise<never> => {
  throw new Error(`offline font policy: remote fetch blocked (${String(url)})`)
}

/** Pages inferred from the stacked SVG viewBox (A4 vs letter, portrait or landscape). */
export function inferPagesFromSvg(svg: string): number {
  const pageMatches = svg.match(/<g class="typst-page"/g)
  if (pageMatches && pageMatches.length > 0) return pageMatches.length
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (!m) return 1
  const w = Number(m[1])
  const h = Number(m[2])
  let pageH = 841.89
  if (Math.abs(w - 595.28) < 6) pageH = 841.89
  else if (Math.abs(w - 841.89) < 6) pageH = 595.28
  else if (Math.abs(w - 612) < 6) pageH = 792
  else if (Math.abs(w - 792) < 6) pageH = 612
  return Math.max(1, Math.round(h / pageH))
}

export class WasmArm extends BaseArm {
  readonly name = 'wasm' as const
  private compiler: any = null
  private renderer: any = null
  private model: any = null
  private counter = 0

  async init(): Promise<void> {
    if (this.compiler && this.renderer) return
    const mod = (await import('@myriaddreamin/typst.ts')) as unknown as WasmModule
    const fontBuffers = loadBundledFontBlobs()
    if (fontBuffers.length === 0) {
      throw new ArmError('wasm arm cannot initialize: bundled fonts/ directory not found')
    }
    const fontArrays = fontBuffers.map((b) => new Uint8Array(b))
    this.model = new mod.MemoryAccessModel()
    this.compiler = mod.createTypstCompiler()
    await this.compiler.init({
      beforeBuild: [
        mod.initOptions.withAccessModel(this.model),
        mod.loadFonts(fontArrays, { assets: false, fetcher: offlineFetcher }),
      ],
    })
    this.renderer = mod.createTypstRenderer()
    await this.renderer.init()
  }

  protected async compileTyp(typ: string, shadows?: ShadowFile[]): Promise<CompiledTyp> {
    const c = this.compiler
    const r = this.renderer
    const model = this.model
    if (!c || !r || !model) throw new ArmError('wasm arm not initialized')
    const path = `/@memory/galley-${this.counter++}.typ`

    for (const s of shadows ?? []) {
      try {
        model.insertFile(`/@memory/${s.path}`, new Uint8Array(s.bytes), new Date())
      } catch {
        /* best-effort; missing asset checked upstream */
      }
    }
    model.insertFile(path, new TextEncoder().encode(typ), new Date())

    let pdf: Buffer
    let vecBytes: Uint8Array
    try {
      const pdfResult = await c.compile({ format: WASM_FORMAT_PDF, mainFilePath: path, diagnostics: 'full' })
      if (!pdfResult?.result) {
        const errs = Array.isArray(pdfResult?.diagnostics)
          ? pdfResult.diagnostics.map((d: { message?: string }) => d.message ?? '').filter(Boolean).join(' | ')
          : 'compile produced no PDF artifact'
        throw new Error(errs || 'compile produced no PDF artifact')
      }
      // Copy immediately out of WASM linear memory before the next WASM call reuses heap pages!
      pdf = Buffer.from(pdfResult.result)

      const vecResult = await c.compile({ format: WASM_FORMAT_VECTOR, mainFilePath: path, diagnostics: 'none' })
      if (!vecResult?.result) {
        throw new Error('compile produced no vector artifact')
      }
      vecBytes = new Uint8Array(vecResult.result)
    } catch (e) {
      throw new ArmError(`wasm compile failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    let svg = ''
    let pages = 1
    try {
      const rendered = await r.runWithSession(
        { format: 'vector', artifactContent: vecBytes },
        async (session: any) => {
          const info = typeof session.retrievePagesInfo === 'function' ? session.retrievePagesInfo() : []
          const svgStr: string = await r.renderSvg({ renderSession: session })
          return { svg: svgStr, pages: Array.isArray(info) && info.length > 0 ? info.length : inferPagesFromSvg(svgStr) }
        },
      )
      svg = rendered.svg
      pages = Math.max(1, rendered.pages)
    } catch (e) {
      throw new ArmError(`wasm svg render failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    return { pdf, svg, pages, diags: [] }
  }
}
