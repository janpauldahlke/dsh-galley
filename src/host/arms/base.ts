/**
 * Shared render pipeline (spec 03 §4 + §7): sheet → deterministic `.typ`
 * (compileSheet) → CompiledTyp (arm-specific) → deriveReceipt (pure SVG math)
 * → SheetRender. Each arm only supplies `compileTyp`.
 */
import type { GalleySheet, GalleyPacket, SheetRender, RenderDiagnostic, AssetMeta } from '../../shared/types.ts'
import { compileSheet, deriveReceipt, mapDiagnosticsToBlocks, splitSvgPages } from '../../typst/index.ts'
import type { Arm, CompiledTyp, ShadowFile } from './types.ts'
import { ArmError } from './types.ts'

/** Map a packet's asset metadata + supplied bytes to shadow files (M1.5 H2.2). */
export function buildShadows(packet: GalleyPacket, assetBytes?: Record<string, Buffer>): ShadowFile[] {
  if (!assetBytes) return []
  const out: ShadowFile[] = []
  for (const [id, bytes] of Object.entries(assetBytes)) {
    const meta = packet.assets?.[id] as AssetMeta | undefined
    if (meta) out.push({ path: meta.path, bytes })
  }
  return out
}

export abstract class BaseArm implements Arm {
  abstract readonly name: Arm['name']
  private _timeMs = 0
  private _warm = false
  get timeMs(): number {
    return this._timeMs
  }
  get warm(): boolean {
    return this._warm
  }
  abstract init(): Promise<void>
  protected abstract compileTyp(typ: string, shadows?: ShadowFile[]): CompiledTyp | Promise<CompiledTyp>

  async render(sheet: GalleySheet, packet: GalleyPacket, assetBytes?: Record<string, Buffer>): Promise<SheetRender> {
    const cs = compileSheet(sheet, packet.assets)
    const shadows = buildShadows(packet, assetBytes)
    const t0 = process.hrtime.bigint()
    let out: CompiledTyp
    try {
      out = await this.compileTyp(cs.typ, shadows)
    } catch (e) {
      if (e instanceof ArmError) throw e
      throw new ArmError(`render failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this._timeMs = Number(process.hrtime.bigint() - t0) / 1e6
    this._warm = true

    if (!out.svg || out.pages <= 0) {
      throw new ArmError('compile produced no pages')
    }
    const receipt = deriveReceipt(out.svg, out.pages, cs.pageHeightPt, cs.targetPages, cs.anchors)
    const diagnostics: RenderDiagnostic[] = mapDiagnosticsToBlocks(cs.typ, out.diags ?? [])
    const perPage = Array.from({ length: out.pages }, () => ({ wPt: cs.pageWidthPt, hPt: cs.pageHeightPt }))
    const pageSvgs = splitSvgPages(out.svg, out.pages, perPage, `${packet.id}_${sheet.id}_r${packet.rev}`)
    return {
      sheetId: sheet.id,
      pdf: out.pdf,
      svgPages: pageSvgs.map((s) => Buffer.from(s, 'utf8')),
      svg: out.svg,
      pages: out.pages,
      perPage,
      lastPageLineCount: receipt.lastPageLineCount,
      overflowLinesOnLastPage: receipt.overflowLinesOnLastPage,
      blockToPage: receipt.blockToPage,
      diagnostics,
      compiledAtRev: packet.rev,
    }
  }
}
