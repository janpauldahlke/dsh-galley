/**
 * dsh-galley — render-arm port (spec 03 §2).
 *
 * One interface, three adapters: `native` (N-API, primary, warm sub-ms),
 * `wasm` (portable fallback on native load failure), `cli` (vendored binary,
 * used for error attribution via `file:line:col` + export). The port is async
 * (renderer I/O); the native adapter does its work synchronously inside an
 * async function so a single call site awaits every arm uniformly.
 *
 * No `@deepseek-ai/*` here (guardrail 6): the arms only import `node:` builtins
 * and the arm package.
 */
import type {
  GalleySheet,
  GalleyPacket,
  SheetRender,
  RenderDiagnostic,
} from '../../shared/types.ts'

export type ArmName = 'native' | 'wasm' | 'cli'

/**
 * A virtual file the arm maps into the compiler before a render (M1.5 H2.2).
 * `path` is packet-relative (e.g. `assets/a1.png`); `bytes` is the raw asset
 * content. The native arm `mapShadow`s each one; WASM/CLI arms may ignore it.
 */
export interface ShadowFile {
  path: string
  bytes: Buffer
}

export interface Arm {
  readonly name: ArmName
  /** Load the engine + fonts (async). Idempotent. */
  init(): Promise<void>
  /**
   * Compile + render one sheet; throws ArmError on a failed compile.
   * `assetBytes` (optional) maps asset id → raw bytes so media slots resolve
   * offline; the arm maps them as shadow files keyed by the asset's path.
   */
  render(sheet: GalleySheet, packet: GalleyPacket, assetBytes?: Record<string, Buffer>): Promise<SheetRender>
  /** Elapsed ms of the last render (0 before the first). */
  readonly timeMs: number
  /** True once a render has completed (warm). */
  readonly warm: boolean
}

/** A compile failure with (best-effort) per-block attribution. */
export class ArmError extends Error {
  readonly code = 'compile_failed'
  readonly diagnostics: RenderDiagnostic[]
  constructor(message: string, diagnostics: RenderDiagnostic[] = []) {
    super(message)
    this.diagnostics = diagnostics
  }
}

/** Raw output of compiling a `.typ` document on any arm. */
export interface CompiledTyp {
  pdf: Buffer
  svg: string
  pages: number
  /** diagnostics with source line numbers where the arm provides them. */
  diags: { message: string; line?: number }[]
}
