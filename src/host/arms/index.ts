/**
 * Arm factory (spec 03 §2 + runtime decision). Primary = native; on native
 * load failure, fall back to WASM. Env `GALLEY_TYPST_ARM=native|wasm|cli`
 * overrides primary selection.
 */
import type { Arm, ArmName } from './types.ts'
import { ArmError } from './types.ts'
import { NativeArm } from './native.ts'
import { WasmArm } from './wasm.ts'
import { CliArm } from './cli.ts'

export type { Arm, ArmName, ArmError, CompiledTyp } from './types.ts'
export { BaseArm } from './base.ts'
export { NativeArm } from './native.ts'
export { WasmArm, inferPagesFromSvg } from './wasm.ts'
export { CliArm } from './cli.ts'
export { BUNDLED_FONT_FILES, loadBundledFontBlobs, resolveBundledFontsDir } from './fonts.ts'

export async function createArm(name: ArmName = 'native'): Promise<Arm> {
  const a = name === 'native' ? new NativeArm() : name === 'wasm' ? new WasmArm() : new CliArm()
  await a.init()
  return a
}

/** Primary render arm with env override + native → WASM fallback (spec 03 §1/§2). */
export async function createPrimaryArm(): Promise<{ arm: Arm; available: ArmName[]; note?: string }> {
  const override = process.env.GALLEY_TYPST_ARM?.trim().toLowerCase()
  if (override === 'wasm' || override === 'cli' || override === 'native') {
    const arm = await createArm(override)
    return { arm, available: [override] }
  }
  try {
    const arm = new NativeArm()
    await arm.init()
    return { arm, available: ['native'] }
  } catch (e) {
    const arm = new WasmArm()
    await arm.init()
    return {
      arm,
      available: ['wasm'],
      note: `native unavailable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
