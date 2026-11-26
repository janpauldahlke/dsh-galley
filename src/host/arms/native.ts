/**
 * Native N-API arm (primary): @myriaddreamin/typst-ts-node-compiler@0.7.0.
 * Warm renders are sub-millisecond (M0: ~0.02 ms). Synchronous under the hood;
 * wrapped in async to match the Arm port.
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BaseArm } from './base.ts'
import { loadBundledFontBlobs } from './fonts.ts'
import { ArmError } from './types.ts'
import type { CompiledTyp, ShadowFile } from './types.ts'

// The N-API module is a heavy native binding — lazy-load so a load failure
// (e.g. missing .node for the platform) falls through to the WASM arm.
type NodeCompiler = {
  compile(input: { mainFileContent: string }): any
  pdf(doc: any): any
  svg(doc: any): any
  /** Map a virtual file (absolute path) to bytes; resolvable by `#image` etc. */
  mapShadow(path: string, content: Buffer): void
  /** Forget all mapped shadow files. */
  resetShadow(): void
}
type NodeCompilerModule = {
  NodeCompiler: {
    create(args?: { workspace?: string; fontArgs?: Array<{ fontBlobs: Buffer[] }> }): NodeCompiler
  }
}

export class NativeArm extends BaseArm {
  readonly name = 'native' as const
  private compiler: NodeCompiler | null = null
  /** Stable virtual root the arm compiles against (need not exist on disk). */
  private readonly workspace = join(tmpdir(), 'dsh-galley-native-ws')

  async init(): Promise<void> {
    if (this.compiler) return
    const mod = (await import('@myriaddreamin/typst-ts-node-compiler')) as unknown as NodeCompilerModule
    const fontBlobs = loadBundledFontBlobs()
    this.compiler = mod.NodeCompiler.create({
      workspace: this.workspace,
      ...(fontBlobs.length > 0 ? { fontArgs: [{ fontBlobs }] } : {}),
    })
  }

  protected compileTyp(typ: string, shadows?: ShadowFile[]): CompiledTyp {
    const c = this.compiler
    if (!c) throw new ArmError('native arm not initialized')
    // Map asset bytes as virtual files so media slots resolve offline. The
    // native arm is synchronous under the hood (no await between map and
    // compile), so this is safe against concurrent renders.
    if (shadows && shadows.length) {
      for (const s of shadows) c.mapShadow(join(this.workspace, s.path), s.bytes)
    }
    try {
      const r = c.compile({ mainFileContent: typ })
      if (r.hasError()) {
        // The native arm reports no source range (range is always null); attribution
        // is the CLI arm's job. Surface a best-effort message.
        let msg = 'native compile error'
        try {
          const d = r.takeDiagnostics()
          if (d && typeof d === 'object') {
            const shorts = (d as { shortDiagnostics?: Array<{ message?: string }> }).shortDiagnostics
            if (Array.isArray(shorts) && shorts.length > 0) {
              msg = shorts.map((s) => s.message ?? '').filter(Boolean).join(' | ') || msg
            } else if ('message' in d && d.message) {
              msg = String(d.message)
            }
          }
        } catch {
          /* ignore */
        }
        throw new ArmError(`native compile failed: ${msg}`)
      }
      const doc = r.result
      const pages: number = doc.numOfPages ?? 0
      const pdf = Buffer.from(c.pdf(doc))
      const svg = String(c.svg(doc))
      return { pdf, svg, pages, diags: [] }
    } finally {
      if (shadows && shadows.length) c.resetShadow()
    }
  }
}
