/**
 * Pane <-> tools workspace cwd & session-packet bridge (M2.7 + M4.2b).
 *
 * Tools resolve the galley store root from an explicit `cwd` arg or the agent
 * session header (`exec.agent.session.header.cwd`), recording the active cwd.
 * HTTP pane routes adopt `?cwd=` / `body.cwd` and `?sessionId=` / `body.sessionId`
 * from the active chat session, persisting `(root, sessionId) -> packetId`
 * atomically in `<root>/sessions.json` so concurrent sessions in one workspace
 * never clobber each other across edits, polls, or host restarts.
 */
import { join } from 'node:path'
import { GalleyStore } from './store.ts'

interface WorkspaceSingletonState {
  lastGalleyCwd: string | null
  storesByRoot: Map<string, GalleyStore>
}

const WORKSPACE_SYM = Symbol.for('dsh-galley.workspace.v1')
const g = globalThis as unknown as Record<symbol, WorkspaceSingletonState | undefined>
if (!g[WORKSPACE_SYM]) {
  g[WORKSPACE_SYM] = {
    lastGalleyCwd: null,
    storesByRoot: new Map<string, GalleyStore>(),
  }
}
const wsState = g[WORKSPACE_SYM]!
const storesByRoot = wsState.storesByRoot

function getOrCreateStoreByRoot(root: string): GalleyStore {
  let store = storesByRoot.get(root)
  if (!store) {
    store = new GalleyStore(root)
    storesByRoot.set(root, store)
  }
  return store
}

export function setSessionActivePacket(
  root: string,
  sessionId: string | null | undefined,
  packetId: string,
): void {
  const sid = sessionId?.trim()
  const pid = packetId?.trim()
  if (sid && pid && root) {
    getOrCreateStoreByRoot(root).setSessionPacket(sid, pid)
  }
}

export function getSessionActivePacket(
  root: string,
  sessionId: string | null | undefined,
): string | null {
  const sid = sessionId?.trim()
  if (!sid || !root) return null
  return getOrCreateStoreByRoot(root).getSessionPacket(sid)
}

export function clearSessionActivePacket(packetId: string, root?: string): void {
  if (root) {
    getOrCreateStoreByRoot(root).pruneSessionPackets(packetId)
  }
  for (const store of storesByRoot.values()) {
    store.pruneSessionPackets(packetId)
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
  const store = getOrCreateStoreByRoot(root)
  return { store, root, cwd: resolvedCwd }
}

export function _resetGalleyWorkspaceForTests(): void {
  wsState.lastGalleyCwd = null
  storesByRoot.clear()
}
