/**
 * Arm factory (spec 03 §2 + runtime decision). Primary = native; on native
 * load failure, fall back to WASM. The CLI arm is created on demand for error
 * attribution + export of record.
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

export async function createArm(name: ArmName = 'native'): Promise<Arm> {
  const a = name === 'native' ? new NativeArm() : name === 'wasm' ? new WasmArm() : new CliArm()
  await a.init()
  return a
}

/** Primary render arm with the native → WASM fallback (spec 03 §2). */
export async function createPrimaryArm(): Promise<{ arm: Arm; available: ArmName[] }> {
  try {
    const arm = new NativeArm()
    await arm.init()
    return { arm, available: ['native'] }
  } catch (e) {
    const arm = new WasmArm()
    await arm.init()
    return { arm, available: ['wasm'], note: `native unavailable: ${e instanceof Error ? e.message : String(e)}` } as {
      arm: Arm
      available: ArmName[]
      note?: string
    }
  }
}
