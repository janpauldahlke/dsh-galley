/**
 * Pane <-> tools workspace cwd bridge (proven sibling pattern from dsh-web-missions).
 *
 * Tools resolve the galley store root from an explicit `cwd` arg or the agent
 * session header (`exec.agent.session.header.cwd`), recording the active cwd.
 * HTTP pane routes adopt `?cwd=` or `body.cwd` from the active chat session,
 * falling back to the last noted cwd or `process.cwd()`.
 *
 * When `process.env.GALLEY_ROOT` is set, it overrides directory resolution so
 * isolated tests and custom store locations work deterministically.
 */
import { join } from 'node:path'
import { GalleyStore } from './store.ts'

let lastGalleyCwd: string | null = null
const storesByRoot = new Map<string, GalleyStore>()

export function noteGalleyCwd(cwd: string | null | undefined): void {
  const trimmed = cwd?.trim()
  if (trimmed) lastGalleyCwd = trimmed
}

export function getGalleyCwd(): string {
  return lastGalleyCwd ?? process.cwd()
}

export function resolveGalleyCwd(explicitCwd?: string | null, sessionCwd?: string | null): string {
  const fromExplicit = explicitCwd?.trim()
  if (fromExplicit) {
    noteGalleyCwd(fromExplicit)
    return fromExplicit
  }
  const fromSession = sessionCwd?.trim()
  if (fromSession) {
    noteGalleyCwd(fromSession)
    return fromSession
  }
  return getGalleyCwd()
}

export function resolveGalleyRoot(cwd?: string | null): string {
  if (process.env.GALLEY_ROOT) return process.env.GALLEY_ROOT
  const resolved = resolveGalleyCwd(cwd)
  return join(resolved, '.dsh', 'galley')
}

export function getStoreForCwd(cwd?: string | null): { store: GalleyStore; root: string; cwd: string } {
  const resolvedCwd = resolveGalleyCwd(cwd)
  const root = process.env.GALLEY_ROOT ?? join(resolvedCwd, '.dsh', 'galley')
  let store = storesByRoot.get(root)
  if (!store) {
    store = new GalleyStore(root)
    storesByRoot.set(root, store)
  }
  return { store, root, cwd: resolvedCwd }
}

export function _resetGalleyWorkspaceForTests(): void {
  lastGalleyCwd = null
  storesByRoot.clear()
}
