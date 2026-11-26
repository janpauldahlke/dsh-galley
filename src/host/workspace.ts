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

interface WorkspaceSingletonState {
  lastGalleyCwd: string | null
  storesByRoot: Map<string, GalleyStore>
  sessionActivePackets: Map<string, string>
}

const WORKSPACE_SYM = Symbol.for('dsh-galley.workspace.v1')
const g = globalThis as unknown as Record<symbol, WorkspaceSingletonState | undefined>
if (!g[WORKSPACE_SYM]) {
  g[WORKSPACE_SYM] = {
    lastGalleyCwd: null,
    storesByRoot: new Map<string, GalleyStore>(),
    sessionActivePackets: new Map<string, string>(),
  }
}
const wsState = g[WORKSPACE_SYM]!
const storesByRoot = wsState.storesByRoot
/**
 * Per-(root, sessionId) sticky active packet so human pane browsing never
 * hijacks an in-flight agent session's un-anchored tool calls (M2.7).
 */
const sessionActivePackets = wsState.sessionActivePackets

export function setSessionActivePacket(
  root: string,
  sessionId: string | null | undefined,
  packetId: string,
): void {
  const sid = sessionId?.trim()
  if (sid && packetId) {
    sessionActivePackets.set(`${root}::${sid}`, packetId)
  }
}

export function getSessionActivePacket(
  root: string,
  sessionId: string | null | undefined,
): string | null {
  const sid = sessionId?.trim()
  if (!sid) return null
  return sessionActivePackets.get(`${root}::${sid}`) ?? null
}

export function clearSessionActivePacket(packetId: string): void {
  for (const [k, v] of sessionActivePackets.entries()) {
    if (v === packetId) sessionActivePackets.delete(k)
  }
}

export function noteGalleyCwd(cwd: string | null | undefined): void {
  const trimmed = cwd?.trim()
  if (trimmed) wsState.lastGalleyCwd = trimmed
}

export function getGalleyCwd(): string {
  return wsState.lastGalleyCwd ?? process.cwd()
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
  wsState.lastGalleyCwd = null
  storesByRoot.clear()
  sessionActivePackets.clear()
}
