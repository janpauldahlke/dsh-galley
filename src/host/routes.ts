/**
 * Cordis `webServer` route bindings for `/api/galley/*` (spec 02 §5).
 *
 * Thin registration layer over `createGalleyHttpDispatcher` — each route
 * returns its unregister function from a dedicated `ctx.effect(...)` call so
 * plugin reload/unload cleans up cleanly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  DOWNLOAD_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  PLUGIN,
  PROPOSAL_ROUTE_PREFIX,
  STATE_ROUTE,
} from '../shared/types.ts'
import { createGalleyHttpDispatcher, type GalleyHttpDispatcherDeps } from './httpDispatch.ts'

function safeWrap(
  ctx: Context,
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    dispatch(req, res).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      ctx.logger?.(PLUGIN)?.error?.('galley route handler error: %s', msg)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, code: 'GALLEY_EXPORT_FAILED', message: msg, fields: {} }))
        }
      } catch {
        /* connection closed */
      }
    })
  }
}

export function registerGalleyRoutes(ctx: Context, deps: GalleyHttpDispatcherDeps): void {
  const dispatch = createGalleyHttpDispatcher(deps)
  const handler = safeWrap(ctx, dispatch)

  const unregisterState = ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler,
  })
  ctx.effect(() => unregisterState, 'galley: /api/galley/state route')

  const unregisterEdit = ctx.webServer.register({
    kind: 'exact',
    path: EDIT_ROUTE,
    handler,
  })
  ctx.effect(() => unregisterEdit, 'galley: /api/galley/edit route')

  const unregisterExport = ctx.webServer.register({
    kind: 'exact',
    path: EXPORT_ROUTE,
    handler,
  })
  ctx.effect(() => unregisterExport, 'galley: /api/galley/export route')

  const unregisterDownload = ctx.webServer.register({
    kind: 'exact',
    path: DOWNLOAD_ROUTE,
    handler,
  })
  ctx.effect(() => unregisterDownload, 'galley: /api/galley/download route')

  const unregisterProposal = ctx.webServer.register({
    kind: 'prefix',
    path: PROPOSAL_ROUTE_PREFIX,
    handler,
  })
  ctx.effect(() => unregisterProposal, 'galley: /api/galley/proposal prefix route')
}
