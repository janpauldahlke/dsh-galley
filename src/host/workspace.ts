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
  storesByRoot: Map<string, GalleyStore>
}

const WORKSPACE_SYM = Symbol.for('dsh-galley.workspace.v1')
const g = globalThis as unknown as Record<symbol, WorkspaceSingletonState | undefined>
if (!g[WORKSPACE_SYM]) {
  g[WORKSPACE_SYM] = {
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

/**
 * Deprecated no-op retained for public export compatibility.
 * Process-global "last used cwd" was removed in 0.2.3 so concurrent sessions
 * never leak cwd across workspaces.
 */
export function noteGalleyCwd(_cwd: string | null | undefined): void {
  // Intentionally pure no-op (0.2.3 cross-session cwd confinement).
}

export function getGalleyCwd(): string {
  return process.cwd()
}

export function resolveGalleyCwd(explicitCwd?: string | null, sessionCwd?: string | null): string {
  // When bound to an agent session (`session.header.cwd`), confine strictly to
  // that session workspace and ignore arbitrary out-of-workspace `args.cwd`.
  const fromSession = sessionCwd?.trim()
  if (fromSession) {
    return fromSession
  }
  const fromExplicit = explicitCwd?.trim()
  if (fromExplicit) {
    return fromExplicit
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
  storesByRoot.clear()
}
