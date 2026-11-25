/**
 * Ambient type declarations for the DSH host packages (`@deepseek-ai/*`).
 *
 * The host provides these at runtime: build.mjs marks `@deepseek-ai/*` as
 * externals (resolved by the DeepSeek Harness when the plugin is installed),
 * so they are not declared as npm dependencies and are absent in a standalone
 * checkout. We declare here the small slice of the host surface that
 * dsh-galley actually uses, so `tsc --noEmit` stays clean without shipping a
 * behavioural stub. The real host defines the authoritative shapes; if a
 * member is ever used in a way not covered below, add it here — do not widen
 * it to `any`, which would mask real type errors in the plugin.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** Host tool registry (accessed via a structural cast in registerGalleyTools). */
    tools?: { register(def: Record<string, unknown>): () => void }
    /** Web-server route registration (present under `dsh web`). */
    webServer: { register(def: Record<string, unknown>): () => void }
    /** Rightbar tab-type registry (client face). */
    sidebarRightTabs: { register(definition: unknown): () => void }
    /** Slot injection / registration (client face). `inject` returns a disposer. */
    slots: {
      inject(key: string, factory: () => unknown): () => void
      register(def: Record<string, unknown>, component: unknown): void
    }
    /**
     * Register a disposer. The callback's RETURN VALUE is the disposer — return
     * the dispose function, do not call it.
     */
    effect(disposer: () => unknown, label?: string): void
    /** Run `fn` once the named capabilities are present (deferred bootstrap). */
    inject(names: string[], fn: (ctx: Context) => void): void
    /** Per-plugin logger (may be absent in headless profiles — call via `?.`). */
    logger?: (plugin: string) => {
      debug?(...args: unknown[]): void
      info?(...args: unknown[]): void
      warn?(...args: unknown[]): void
      error?(...args: unknown[]): void
    }
    // The host Context carries many more capabilities; allow unknown access
    // without weakening the declared members above.
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  // Side-effect type import only; dsh-galley takes no named exports from it.
  export {}
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  export interface SidebarRightTabDefinition {
    id: string
    kind: string
    title: () => string
    guide?: Array<{
      id: string
      order?: number
      title: () => string
      description: () => string
      icon?: unknown
    }>
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  // Side-effect type import only; dsh-galley takes no named exports from it.
  export {}
}
