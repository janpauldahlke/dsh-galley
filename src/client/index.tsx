/**
 * dsh-galley — browser half (M0: the Galley rightbar tab).
 *
 * Registers the "Galley" rightbar tab type at the TOP LEVEL of apply (not
 * only inside a React effect — a missing top-level registration can stall
 * boot) with a guide capsule, and the keyed pane body under
 * `sidebar.right.pane.tab`.
 *
 * Inline styles only. Bundle is load-once, dispose-clean; runtime imports are
 * the platform baseline (react + the dsh-client-* UI packages).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PLUGIN, TAB_ID, TAB_KIND, TAB_TITLE } from '../shared/types.ts'
import { GalleyBody } from './GalleyBody.tsx'
import { GalleyIcon } from './GalleyIcon.tsx'

export const name = PLUGIN
export const inject = ['slots', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  const definition: SidebarRightTabDefinition = {
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => TAB_TITLE,
    guide: [
      {
        id: 'galley',
        order: 285,
        title: () => TAB_TITLE,
        description: () => 'Document co-authoring & Typst A4 proof (Druck und Satz): block packets, instant native render, deterministic PDF/DOCX',
        icon: GalleyIcon,
      },
    ],
  }
  const disposeType = ctx.sidebarRightTabs.register(definition)
  const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, GalleyBody),
  )
  ctx.effect(() => () => {
    disposeBody()
    disposeType()
  }, 'galley: rightbar tab type')
}
