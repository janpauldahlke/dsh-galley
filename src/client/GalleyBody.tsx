/**
 * dsh-galley — Rightbar Pane Body (Spec 04 + M2.5 Workbench CRUD & Review Lock).
 *
 * - Workspace `cwd` bound to active chat via seat props (`sessionId` + `useSessions`).
 * - Rev-tagged HTTP polling (`GET /api/galley/state?rev=N`, 304 no-op, 2 s idle,
 *   1 s post-mutation, 10 s hidden, 2 s retry with amber reconnecting banner).
 * - Header `🔓 Auto` / `🔒 Review` agent-mutation lock + `Accept All` proposals.
 * - Low-friction Mappen & Templates drawer (Open, Rename, Duplicate, Delete, Save-as-Template).
 * - Sheet CRUD + Portrait/Landscape toggle + 1-click Browser Download + Preflight strip.
 * - Inline styles only; zero client-side Typst compiler imports.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  DOWNLOAD_ROUTE,
  EDIT_ROUTE,
  EXPORT_ROUTE,
  HEALTH_ROUTE,
  PROPOSAL_ROUTE_PREFIX,
  STATE_ROUTE,
  type BlockId,
  type ExportFileReceipt,
  type GalleyTemplateBlueprint,
  type SheetId,
  type StateActivePayload,
  type StateResponsePayload,
} from '../shared/types.ts'
import { BlockTray } from './BlockTray.tsx'
import { ProofView } from './ProofView.tsx'
import {
  computePaneMode,
  nextPollDelayMs,
  shortCwdLabel,
  withCwdQuery,
  type CommitOutcome,
  type NarrowTab,
  type PaneLayoutOverride,
} from './paneModel.ts'

type UseSessions = <T>(selector: (state: {
  byId: Record<string, { cwd?: string | null } | undefined>
}) => T) => T

function useNoopSessions<T>(selector: (state: { byId: Record<string, never> }) => T): T {
  return selector({ byId: {} })
}

type HealthReceipt = {
  ok: boolean
  arm?: string
  typst?: string
  error?: string
}

const STORAGE_MODE_KEY = 'dsh-galley:layout-override'

function readStoredOverride(): PaneLayoutOverride {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_MODE_KEY)
    if (v === 'wide' || v === 'narrow' || v === 'auto') return v
  } catch {
    /* ignore storage errors */
  }
  return 'auto'
}

const headerBtn: CSSProperties = {
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(128,128,128,0.32)',
  borderRadius: 5,
  padding: '2px 7px',
  fontSize: 11,
  cursor: 'pointer',
  lineHeight: 1.4,
}

export function GalleyBody(props: {
  sessionId?: string
  useSessions?: UseSessions
} = {}): ReactNode {
  const { sessionId, useSessions = useNoopSessions } = props
  const sessionCwd = useSessions((sessions) => {
    if (!sessionId) return null
    const cwd = sessions.byId[sessionId]?.cwd
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
  })

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [paneWidth, setPaneWidth] = useState<number>(520)
  const [layoutOverride, setLayoutOverride] = useState<PaneLayoutOverride>(() => readStoredOverride())
  const [narrowTab, setNarrowTab] = useState<NarrowTab>('proof')

  const [health, setHealth] = useState<HealthReceipt | null>(null)
  const [payload, setPayload] = useState<StateResponsePayload | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [statusToast, setStatusToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [selectedSheetId, setSelectedSheetId] = useState<SheetId>('s1')
  const [selectedBlockId, setSelectedBlockId] = useState<BlockId | null>(null)
  const [showMappenDrawer, setShowMappenDrawer] = useState(false)
  const [renamingPacket, setRenamingPacket] = useState(false)
  const [packetTitleDraft, setPacketTitleDraft] = useState('')
  const [newTitleDraft, setNewTitleDraft] = useState('')
  const [templateSaveDraft, setTemplateSaveDraft] = useState('')
  const [showTemplateSaveInput, setShowTemplateSaveInput] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [exportedFiles, setExportedFiles] = useState<ExportFileReceipt[] | null>(null)
  const [showPreflightDetails, setShowPreflightDetails] = useState(false)

  const localRevRef = useRef<number | null>(null)
  const localPacketIdRef = useRef<string | null>(null)
  const postMutationFlagRef = useRef(false)
  const pollTimerRef = useRef<number | null>(null)
  const healthOkRef = useRef(false)

  useEffect(() => {
    localRevRef.current = null
    localPacketIdRef.current = null
  }, [sessionCwd])

  // Track container width for auto wide/narrow split (480 px threshold, Spec 04 §3)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setPaneWidth(w)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pollOnce = useCallback(async (forceFull = false): Promise<{ hadError: boolean; revAdvanced: boolean }> => {
    try {
      let url = withCwdQuery(STATE_ROUTE, sessionCwd)
      const knownRev = forceFull ? null : localRevRef.current
      const knownPid = forceFull ? null : localPacketIdRef.current
      if (knownRev !== null && knownRev > 0) {
        url += `${url.includes('?') ? '&' : '?'}rev=${knownRev}`
        if (knownPid) url += `&knownPacket=${encodeURIComponent(knownPid)}`
      }
      const res = await fetch(url, { cache: 'no-store' })
      if (res.status === 304) {
        setReconnecting(false)
        return { hadError: false, revAdvanced: false }
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as StateResponsePayload
      const prevRev = localRevRef.current
      localRevRef.current = data.activePacket ? data.rev : 0
      localPacketIdRef.current = data.activePacket ? data.packetId : null
      setPayload(data)
      setReconnecting(false)
      if (data.activePacket) {
        setSelectedSheetId((cur) => (data.sheetOrder.includes(cur) ? cur : data.activeSheetId))
      }
      return {
        hadError: false,
        revAdvanced: prevRev !== null && data.activePacket && data.rev > prevRev,
      }
    } catch {
      setReconnecting(true)
      return { hadError: true, revAdvanced: false }
    }
  }, [sessionCwd])

  // Initial health check + resilient polling loop (Spec 04 §2)
  useEffect(() => {
    let disposed = false

    const probeHealth = async () => {
      try {
        const res = await fetch(HEALTH_ROUTE, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const h = (await res.json()) as HealthReceipt
        healthOkRef.current = Boolean(h.ok)
        if (!disposed) setHealth(h)
      } catch (err) {
        healthOkRef.current = false
        if (!disposed) setHealth({ ok: false, error: String(err) })
      }
    }
    void probeHealth()

    const scheduleNext = (delayMs: number) => {
      if (disposed) return
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = window.setTimeout(runTick, delayMs)
    }

    const runTick = async () => {
      if (disposed) return
      const hidden = typeof document !== 'undefined' ? document.hidden : false
      if (hidden) {
        scheduleNext(nextPollDelayMs({ hidden: true, hadError: false, postMutation: false, revAdvanced: false }))
        return
      }
      const wasPostMutation = postMutationFlagRef.current
      postMutationFlagRef.current = false
      const { hadError, revAdvanced } = await pollOnce(false)
      if (hadError) {
        healthOkRef.current = false
        if (!disposed) setHealth({ ok: false, error: 'offline' })
      } else if (!healthOkRef.current) {
        void probeHealth()
      }
      const delay = nextPollDelayMs({
        hidden: false,
        hadError,
        postMutation: wasPostMutation,
        revAdvanced,
      })
      scheduleNext(delay)
    }

    void runTick()

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void runTick()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }

    return () => {
      disposed = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [pollOnce])

  const postJsonDetailed = useCallback(
    async (
      path: string,
      body: Record<string, unknown>,
      refreshFull = false,
    ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> => {
      setBusy(true)
      setActionError(null)
      try {
        const payloadWithCwd = sessionCwd ? { ...body, cwd: sessionCwd } : body
        const res = await fetch(withCwdQuery(path, sessionCwd), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadWithCwd),
        })
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
        if (!res.ok || data.ok === false) {
          const msg = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`
          setActionError(`${data.code ?? 'ERROR'}: ${msg}`)
          if (res.status === 409) {
            await pollOnce(true)
          }
          return { ok: false, status: res.status, data }
        }
        postMutationFlagRef.current = true
        await pollOnce(refreshFull)
        return { ok: true, status: res.status, data }
      } catch (err) {
        setReconnecting(true)
        setActionError(err instanceof Error ? err.message : String(err))
        return { ok: false, status: 0, data: null }
      } finally {
        setBusy(false)
      }
    },
    [pollOnce, sessionCwd],
  )

  const postJson = useCallback(
    async (path: string, body: Record<string, unknown>, refreshFull = false): Promise<Record<string, unknown> | null> => {
      const out = await postJsonDetailed(path, body, refreshFull)
      return out.ok ? out.data : null
    },
    [postJsonDetailed],
  )

  const handleOpenTemplate = async (bp: GalleyTemplateBlueprint | string, customTitle?: string) => {
    setShowMappenDrawer(false)
    const templateId = typeof bp === 'string' ? bp : bp.id
    const defaultTitle =
      typeof bp !== 'string'
        ? bp.title
        : templateId === 'arbeitsblatt'
          ? 'Arbeitsblatt'
          : templateId === 'rfc'
            ? 'Engineering RFC'
            : 'Dokument'
    localRevRef.current = null
    const res = await postJson(
      EDIT_ROUTE,
      {
        op: 'open',
        template: templateId,
        title: customTitle?.trim() || defaultTitle,
      },
      true,
    )
    if (res) setNewTitleDraft('')
  }

  const handleSwitchPacket = async (packetId: string) => {
    setShowMappenDrawer(false)
    localRevRef.current = null
    await postJson(EDIT_ROUTE, { op: 'open', id: packetId }, true)
  }

  const handleDeletePacket = async (packetId: string) => {
    localRevRef.current = null
    await postJson(EDIT_ROUTE, { op: 'packet-delete', packetId }, true)
  }

  const activeData: StateActivePayload | null = payload && payload.activePacket ? payload : null

  const activeSheet = useMemo(() => {
    if (!activeData) return null
    return activeData.sheets.find((s) => s.id === selectedSheetId) ?? activeData.sheets[0] ?? null
  }, [activeData, selectedSheetId])

  const allBlockIds = useMemo(() => {
    if (!activeData) return []
    const ids: BlockId[] = []
    for (const s of activeData.sheets) {
      for (const b of s.blocks) ids.push(b.id)
    }
    return ids
  }, [activeData])

  const pendingProposalCount = useMemo(() => {
    if (!activeData) return 0
    let n = 0
    for (const s of activeData.sheets) {
      for (const p of s.proposals) {
        if (p.status === 'pending') n += 1
      }
    }
    return n
  }, [activeData])

  const paneMode = computePaneMode(paneWidth, layoutOverride)

  const setOverridePersisted = (next: PaneLayoutOverride) => {
    setLayoutOverride(next)
    try {
      globalThis.localStorage?.setItem(STORAGE_MODE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const handleMoveBlock = async (sheetId: SheetId, blockId: BlockId, direction: 'up' | 'down') => {
    if (!activeData) return
    const sh = activeData.sheets.find((s) => s.id === sheetId)
    if (!sh) return
    const idx = sh.blocks.findIndex((b) => b.id === blockId)
    if (idx < 0) return
    if (direction === 'up' && idx > 0) {
      await postJson(EDIT_ROUTE, { op: 'move', sheetId, blockId, toBeforeId: sh.blocks[idx - 1].id })
    } else if (direction === 'down' && idx < sh.blocks.length - 1) {
      await postJson(EDIT_ROUTE, { op: 'move', sheetId, blockId, toAfterId: sh.blocks[idx + 1].id })
    }
  }

  const handleExport = async (format: 'pdf' | 'typ' | 'md' | 'tex' | 'docx') => {
    setShowExportMenu(false)
    const res = await postJson(EXPORT_ROUTE, { format })
    if (res && Array.isArray(res.files)) {
      setExportedFiles(res.files as ExportFileReceipt[])
    }
  }

  const buildDownloadHref = (relPath: string): string => {
    const q = withCwdQuery(`${DOWNLOAD_ROUTE}?path=${encodeURIComponent(relPath)}`, sessionCwd)
    return q
  }

  const availableTemplates = payload?.templates ?? []

  return (
    <div
      ref={rootRef}
      data-testid="galley-pane-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        width: '100%',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.45,
        color: 'currentColor',
        boxSizing: 'border-box',
      }}
    >
      {/* 1. Compact Header Row (Spec 04 §3 + M2.5 Review Lock) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          flexWrap: 'wrap',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(128,128,128,0.22)',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
          <strong>Galley</strong>
          {activeData && !renamingPacket && (
            <>
              <span
                title="Klicken zum Umbenennen"
                onClick={() => {
                  setPacketTitleDraft(activeData.title)
                  setRenamingPacket(true)
                }}
                style={{
                  fontWeight: 600,
                  maxWidth: 150,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }}
              >
                {activeData.title}
              </span>
              <code style={{ fontSize: 11, opacity: 0.72 }}>rev {activeData.rev}</code>
              <code style={{ fontSize: 10, opacity: 0.55 }} title="Aktive Mappe-ID">
                {activeData.packetId}
              </code>
            </>
          )}

          {activeData && renamingPacket && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <input
                aria-label="Mappe umbenennen"
                value={packetTitleDraft}
                onChange={(e) => setPacketTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && packetTitleDraft.trim()) {
                    setRenamingPacket(false)
                    void postJson(EDIT_ROUTE, { op: 'packet-rename', title: packetTitleDraft.trim() })
                  } else if (e.key === 'Escape') {
                    setRenamingPacket(false)
                  }
                }}
                style={{
                  color: 'inherit',
                  background: 'transparent',
                  border: '1px solid rgba(128,128,128,0.4)',
                  borderRadius: 4,
                  padding: '1px 5px',
                  fontSize: 11,
                  width: 130,
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (packetTitleDraft.trim()) {
                    setRenamingPacket(false)
                    void postJson(EDIT_ROUTE, { op: 'packet-rename', title: packetTitleDraft.trim() })
                  }
                }}
                style={headerBtn}
              >
                ✓
              </button>
            </span>
          )}

          {/* Arm health badge */}
          <span
            title={payload?.cwd ? `Store: ${payload.cwd}` : undefined}
            style={{ fontSize: 11, opacity: 0.8 }}
          >
            {health?.ok ? (
              <span style={{ color: '#16a34a' }}>● {health.arm ?? 'native'}</span>
            ) : (
              <span style={{ color: '#d97706' }}>● offline</span>
            )}
            {payload?.cwd ? <span style={{ opacity: 0.65, marginLeft: 5 }}>{shortCwdLabel(payload.cwd)}</span> : null}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {activeData && (
            <>
              {/* Unified Review Gate Lock (Spec 01 §7 M2.5) */}
              <button
                type="button"
                data-testid="galley-review-mode-btn"
                title={
                  activeData.reviewMode === 'review'
                    ? 'Review-Modus aktiv: Jede Agent-Änderung wird als Vorschlag vorgelegt'
                    : 'Auto-Modus aktiv: Agent darf eigene/neue Blöcke direkt setzen (menschliche Blöcke bleiben geschützt)'
                }
                disabled={busy}
                onClick={() => {
                  const nextMode = activeData.reviewMode === 'review' ? 'auto' : 'review'
                  void postJson(EDIT_ROUTE, { op: 'packet-set-review-mode', reviewMode: nextMode })
                }}
                style={{
                  ...headerBtn,
                  borderColor: activeData.reviewMode === 'review' ? '#d97706' : 'rgba(128,128,128,0.32)',
                  color: activeData.reviewMode === 'review' ? '#d97706' : 'inherit',
                  fontWeight: activeData.reviewMode === 'review' ? 600 : 400,
                }}
              >
                {activeData.reviewMode === 'review' ? '🔒 Review' : '🔓 Auto'}
              </button>

              {pendingProposalCount > 0 && (
                <button
                  type="button"
                  data-testid="galley-accept-all-btn"
                  disabled={busy}
                  onClick={() => {
                    void postJson(`${PROPOSAL_ROUTE_PREFIX}/_all/decide`, { action: 'accept-all' })
                  }}
                  style={{
                    ...headerBtn,
                    borderColor: '#16a34a',
                    color: '#16a34a',
                    fontWeight: 600,
                  }}
                >
                  ✓ Alle ({pendingProposalCount})
                </button>
              )}

              <button
                type="button"
                title="Rückgängig (Undo)"
                disabled={activeData.undoDepth === 0 || busy}
                onClick={() => { void postJson(EDIT_ROUTE, { op: 'undo' }) }}
                style={{ ...headerBtn, opacity: activeData.undoDepth === 0 ? 0.35 : 1 }}
              >
                ↶
              </button>
              <button
                type="button"
                title="Wiederholen (Redo)"
                disabled={activeData.redoDepth === 0 || busy}
                onClick={() => { void postJson(EDIT_ROUTE, { op: 'redo' }) }}
                style={{ ...headerBtn, opacity: activeData.redoDepth === 0 ? 0.35 : 1 }}
              >
                ↷
              </button>
            </>
          )}

          <button
            type="button"
            data-testid="galley-mappen-btn"
            onClick={() => setShowMappenDrawer((v) => !v)}
            style={headerBtn}
          >
            Mappen ({payload?.packets?.length ?? 0}) ▾
          </button>

          {activeData && (
            <button
              type="button"
              data-testid="galley-export-btn"
              onClick={() => setShowExportMenu((v) => !v)}
              style={headerBtn}
            >
              Export ▾
            </button>
          )}

          <button
            type="button"
            title="Ansichtsmodus wechseln (Auto / Split / Tabs)"
            onClick={() =>
              setOverridePersisted(
                layoutOverride === 'auto' ? 'wide' : layoutOverride === 'wide' ? 'narrow' : 'auto',
              )
            }
            style={{ ...headerBtn, opacity: 0.8 }}
          >
            {layoutOverride === 'auto'
              ? `Auto (${paneMode === 'wide' ? 'Split' : 'Tabs'})`
              : layoutOverride === 'wide'
                ? 'Split'
                : 'Tabs'}
          </button>
        </div>
      </div>

      {/* 2. Reconnecting / Error / Toast / Preflight / Export Banners */}
      {reconnecting && (
        <div
          data-testid="galley-reconnecting-strip"
          style={{
            padding: '4px 10px',
            background: 'rgba(217, 119, 6, 0.16)',
            borderBottom: '1px solid #d97706',
            color: '#d97706',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          ⟳ Verbinde erneut mit Host… (lokale Eingaben bleiben erhalten)
        </div>
      )}

      {actionError && (
        <div
          data-testid="galley-error-strip"
          style={{
            padding: '5px 10px',
            background: 'rgba(220, 38, 38, 0.12)',
            borderBottom: '1px solid #dc2626',
            color: '#dc2626',
            fontSize: 11,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} style={headerBtn}>
            ✕
          </button>
        </div>
      )}

      {statusToast && (
        <div
          style={{
            padding: '4px 10px',
            background: 'rgba(22, 163, 74, 0.12)',
            borderBottom: '1px solid #16a34a',
            color: '#16a34a',
            fontSize: 11,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{statusToast}</span>
          <button type="button" onClick={() => setStatusToast(null)} style={headerBtn}>
            ✕
          </button>
        </div>
      )}

      {/* Structural & Companion Preflight Strip */}
      {activeData && activeData.preflight.length > 0 && (
        <div
          data-testid="galley-preflight-strip"
          style={{
            padding: '4px 10px',
            borderBottom: '1px solid rgba(217, 119, 6, 0.35)',
            background: 'rgba(217, 119, 6, 0.08)',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: '#d97706' }}>
              ⚑ Preflight-Hinweise ({activeData.preflight.length})
            </span>
            <button
              type="button"
              onClick={() => setShowPreflightDetails((v) => !v)}
              style={{ ...headerBtn, padding: '0 6px', fontSize: 10 }}
            >
              {showPreflightDetails ? 'Ausblenden ▴' : 'Details ▾'}
            </button>
          </div>
          {showPreflightDetails &&
            activeData.preflight.map((w, idx) => (
              <div
                key={`${w.code}-${w.blockId ?? idx}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}
              >
                <span>
                  {w.severity === 'warn' || w.severity === 'error' ? '⚠ ' : 'ℹ '}
                  {w.message}
                </span>
                {(w.blockId || w.sheetId) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (w.sheetId) setSelectedSheetId(w.sheetId)
                      if (w.blockId) setSelectedBlockId(w.blockId)
                    }}
                    style={{ ...headerBtn, padding: '0 5px', fontSize: 10 }}
                  >
                    Springen
                  </button>
                )}
              </div>
            ))}
        </div>
      )}

      {/* Low-friction Mappen CRUD & Template Blueprints Drawer */}
      {showMappenDrawer && payload && (
        <div
          data-testid="galley-mappen-drawer"
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid rgba(128,128,128,0.25)',
            background: 'rgba(128,128,128,0.07)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 12,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {/* Current Mappe actions */}
          {activeData && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 11, opacity: 0.8 }}>Aktive Mappe: {activeData.title}</span>
              <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="galley-packet-rename-btn"
                  onClick={() => {
                    setPacketTitleDraft(activeData.title)
                    setRenamingPacket(true)
                    setShowMappenDrawer(false)
                  }}
                  style={headerBtn}
                >
                  ✎ Umbenennen
                </button>
                <button
                  type="button"
                  data-testid="galley-packet-duplicate-btn"
                  disabled={busy}
                  onClick={() => {
                    localRevRef.current = null
                    void postJson(EDIT_ROUTE, { op: 'packet-duplicate' }, true)
                  }}
                  style={headerBtn}
                >
                  ⧉ Duplizieren
                </button>
                <button
                  type="button"
                  data-testid="galley-save-template-toggle"
                  onClick={() => {
                    setTemplateSaveDraft(`${activeData.title} Vorlage`)
                    setShowTemplateSaveInput((v) => !v)
                  }}
                  style={headerBtn}
                >
                  ★ Als Vorlage speichern
                </button>
                <button
                  type="button"
                  data-testid="galley-packet-delete-active-btn"
                  disabled={busy}
                  onClick={() => { void handleDeletePacket(activeData.packetId) }}
                  style={{ ...headerBtn, color: '#dc2626', borderColor: 'rgba(220,38,38,0.45)' }}
                >
                  🗑 Löschen
                </button>
              </div>
            </div>
          )}

          {showTemplateSaveInput && activeData && (
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                aria-label="Vorlagenname"
                placeholder="Name der wiederverwendbaren Vorlage…"
                value={templateSaveDraft}
                onChange={(e) => setTemplateSaveDraft(e.target.value)}
                style={{
                  flex: 1,
                  color: 'inherit',
                  background: 'transparent',
                  border: '1px solid rgba(128,128,128,0.35)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontSize: 11,
                }}
              />
              <button
                type="button"
                data-testid="galley-save-template-confirm"
                disabled={!templateSaveDraft.trim() || busy}
                onClick={async () => {
                  const res = await postJson(
                    EDIT_ROUTE,
                    { op: 'template-save', title: templateSaveDraft.trim() },
                    true,
                  )
                  if (res) {
                    setShowTemplateSaveInput(false)
                    setStatusToast(`Vorlage „${templateSaveDraft.trim()}“ gespeichert`)
                  }
                }}
                style={{ ...headerBtn, fontWeight: 600 }}
              >
                Speichern
              </button>
            </div>
          )}

          {/* Existing packets in workspace */}
          {payload.packets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 11, opacity: 0.72 }}>Mappen im Arbeitsverzeichnis ({payload.packets.length}):</div>
              {payload.packets.map((p) => {
                const isCurrent = activeData?.packetId === p.id
                return (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      padding: '3px 6px',
                      borderRadius: 4,
                      background: isCurrent ? 'rgba(59,130,246,0.12)' : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { void handleSwitchPacket(p.id) }}
                      style={{
                        color: 'inherit',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 12,
                        fontWeight: isCurrent ? 700 : 400,
                        flex: 1,
                      }}
                    >
                      {isCurrent ? '● ' : '○ '}
                      {p.title}{' '}
                      <span style={{ opacity: 0.6, fontSize: 11 }}>
                        ({p.id} · rev {p.rev})
                      </span>
                    </button>
                    <button
                      type="button"
                      title={`Mappe ${p.title} löschen`}
                      disabled={busy}
                      onClick={() => { void handleDeletePacket(p.id) }}
                      style={{ ...headerBtn, padding: '0 5px', fontSize: 10 }}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Create new Mappe from Builtin / Plugin / Workspace Templates */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 4, borderTop: '1px solid rgba(128,128,128,0.18)' }}>
            <div style={{ fontSize: 11, opacity: 0.72 }}>Neue Mappe aus Vorlage anlegen:</div>
            <input
              aria-label="Titel der neuen Mappe"
              placeholder="Titel der neuen Mappe (optional)…"
              value={newTitleDraft}
              onChange={(e) => setNewTitleDraft(e.target.value)}
              style={{
                color: 'inherit',
                background: 'transparent',
                border: '1px solid rgba(128,128,128,0.32)',
                borderRadius: 5,
                padding: '4px 7px',
                fontSize: 12,
              }}
            />
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {availableTemplates.map((tpl) => (
                <span key={tpl.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <button
                    type="button"
                    data-testid={`galley-drawer-tpl-${tpl.id}`}
                    onClick={() => { void handleOpenTemplate(tpl, newTitleDraft) }}
                    style={headerBtn}
                  >
                    {tpl.source === 'workspace' ? '★ ' : tpl.source === 'plugin' ? '◆ ' : ''}
                    {tpl.title}
                  </button>
                  {tpl.source === 'workspace' && (
                    <button
                      type="button"
                      title="Gespeicherte Vorlage entfernen"
                      onClick={() => {
                        void postJson(EDIT_ROUTE, { op: 'template-delete', templateId: tpl.id }, true)
                      }}
                      style={{ ...headerBtn, padding: '2px 5px', opacity: 0.7 }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {showExportMenu && activeData && (
        <div
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid rgba(128,128,128,0.22)',
            background: 'rgba(128,128,128,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            fontSize: 11,
          }}
        >
          <span>Format exportieren:</span>
          {(['pdf', 'typ', 'md', 'tex'] as const).map((fmt) => (
            <button key={fmt} type="button" style={headerBtn} onClick={() => { void handleExport(fmt) }}>
              .{fmt.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {exportedFiles && exportedFiles.length > 0 && (
        <div
          data-testid="galley-export-receipt"
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid rgba(22,163,74,0.45)',
            background: 'rgba(22,163,74,0.1)',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ color: '#16a34a' }}>✓ Export bereitgestellt</strong>
            <button type="button" onClick={() => setExportedFiles(null)} style={headerBtn}>
              ✕
            </button>
          </div>
          {exportedFiles.map((f, idx) => (
            <div key={f.path} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <code>{f.path} ({(f.sizeBytes / 1024).toFixed(1)} KB)</code>
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <a
                  data-testid={`galley-download-link-${idx}`}
                  href={buildDownloadHref(f.path)}
                  download
                  style={{
                    ...headerBtn,
                    textDecoration: 'none',
                    fontWeight: 600,
                    borderColor: '#16a34a',
                    color: '#16a34a',
                  }}
                >
                  ⬇ Download
                </a>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard?.writeText(f.path) }}
                  style={headerBtn}
                >
                  Pfad kopieren
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 3. Initial loading / Host offline / Empty Mappe states (Spec 04 §8) */}
      {!payload && !reconnecting && (
        <div style={{ padding: 24, opacity: 0.7, fontSize: 12 }}>Lade Galley-Status…</div>
      )}

      {!payload && reconnecting && (
        <div style={{ padding: 24, opacity: 0.85, fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Galley-Host derzeit nicht erreichbar</div>
          <div style={{ opacity: 0.75 }}>Automatischer Neuverbindungsversuch alle 2 Sekunden…</div>
        </div>
      )}

      {payload && !payload.activePacket && (
        <div
          data-testid="galley-empty-state"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            gap: 12,
            textAlign: 'center',
            overflowY: 'auto',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15 }}>Mappe öffnen · Druck und Satz</div>
          <div style={{ fontSize: 12, opacity: 0.76, maxWidth: 340 }}>
            Wähle eine Vorlage für den gemeinsamen Satz mit sofortigem Typst-A4-Fahnenabzug:
          </div>

          <input
            aria-label="Mappentitel"
            placeholder="Titel (z. B. Brüche: Addieren)…"
            value={newTitleDraft}
            onChange={(e) => setNewTitleDraft(e.target.value)}
            style={{
              width: '100%',
              maxWidth: 320,
              boxSizing: 'border-box',
              color: 'inherit',
              background: 'transparent',
              border: '1px solid rgba(128,128,128,0.34)',
              borderRadius: 6,
              padding: '6px 9px',
              fontSize: 12,
            }}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 320 }}>
            {availableTemplates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                data-testid={`galley-open-${tpl.id}`}
                onClick={() => { void handleOpenTemplate(tpl, newTitleDraft) }}
                style={{
                  ...headerBtn,
                  padding: '8px 12px',
                  fontWeight: tpl.id === 'arbeitsblatt' ? 600 : 400,
                }}
              >
                {tpl.source === 'workspace' ? '★ ' : tpl.source === 'plugin' ? '◆ ' : ''}
                {tpl.title}
              </button>
            ))}
          </div>

          {payload.packets.length > 0 && (
            <div style={{ marginTop: 8, width: '100%', maxWidth: 320, textAlign: 'left', fontSize: 12 }}>
              <div style={{ opacity: 0.7, marginBottom: 4 }}>Vorhandene Mappen im Projekt:</div>
              {payload.packets.map((p) => (
                <div key={p.id} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <button
                    type="button"
                    onClick={() => { void handleSwitchPacket(p.id) }}
                    style={{ ...headerBtn, flex: 1, textAlign: 'left', padding: '5px 8px' }}
                  >
                    {p.title} <span style={{ opacity: 0.65 }}>({p.id} · rev {p.rev})</span>
                  </button>
                  <button
                    type="button"
                    title="Mappe löschen"
                    onClick={() => { void handleDeletePacket(p.id) }}
                    style={{ ...headerBtn, padding: '5px 8px' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4. Active Packet Workspace: Narrow segmented tabs OR Wide 55/45 vertical split */}
      {activeData && activeSheet && (
        <>
          {paneMode === 'narrow' && (
            <div
              data-testid="galley-narrow-tabs"
              style={{
                display: 'flex',
                gap: 4,
                padding: '5px 10px',
                borderBottom: '1px solid rgba(128,128,128,0.2)',
              }}
            >
              <button
                type="button"
                onClick={() => setNarrowTab('proof')}
                style={{
                  ...headerBtn,
                  flex: 1,
                  fontWeight: narrowTab === 'proof' ? 700 : 400,
                  background: narrowTab === 'proof' ? 'rgba(128,128,128,0.2)' : 'transparent',
                }}
              >
                Fahnenabzug (Proof)
              </button>
              <button
                type="button"
                onClick={() => setNarrowTab('blocks')}
                style={{
                  ...headerBtn,
                  flex: 1,
                  fontWeight: narrowTab === 'blocks' ? 700 : 400,
                  background: narrowTab === 'blocks' ? 'rgba(128,128,128,0.2)' : 'transparent',
                }}
              >
                Blöcke ({activeSheet.blocks.length})
              </button>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {(paneMode === 'wide' || narrowTab === 'proof') && (
              <div
                style={{
                  flex: paneMode === 'wide' ? '0 0 55%' : '1 1 auto',
                  minHeight: 0,
                  borderBottom: paneMode === 'wide' ? '1px solid rgba(128,128,128,0.24)' : undefined,
                }}
              >
                <ProofView
                  sheets={activeData.sheets}
                  proofs={activeData.proofs}
                  selectedSheetId={activeSheet.id}
                  selectedBlockId={selectedBlockId}
                  busy={busy}
                  onSelectSheet={(sid) => setSelectedSheetId(sid)}
                  onSelectBlock={(bid) => {
                    setSelectedBlockId(bid)
                    if (paneMode === 'narrow') setNarrowTab('blocks')
                  }}
                  onUpdateTargetPages={(sid, tp) => {
                    void postJson(EDIT_ROUTE, { op: 'update-geometry', sheetId: sid, targetPages: tp })
                  }}
                  onUpdateOrientation={(sid, orientation) => {
                    void postJson(EDIT_ROUTE, { op: 'update-geometry', sheetId: sid, orientation })
                  }}
                  onAddSheet={(title) => {
                    void (async () => {
                      const res = await postJson(EDIT_ROUTE, { op: 'sheet-add', title })
                      if (res && typeof res.sheetId === 'string') setSelectedSheetId(res.sheetId)
                    })()
                  }}
                  onRenameSheet={(sid, title) => {
                    void postJson(EDIT_ROUTE, { op: 'sheet-rename', sheetId: sid, title })
                  }}
                  onRemoveSheet={(sid) => {
                    void postJson(EDIT_ROUTE, { op: 'sheet-remove', sheetId: sid })
                  }}
                />
              </div>
            )}

            {(paneMode === 'wide' || narrowTab === 'blocks') && (
              <div style={{ flex: paneMode === 'wide' ? '1 1 45%' : '1 1 auto', minHeight: 0 }}>
                <BlockTray
                  sheet={activeSheet}
                  allBlockIds={allBlockIds}
                  assets={activeData.assets}
                  selectedBlockId={selectedBlockId}
                  busy={busy}
                  onSelectBlock={(bid) => setSelectedBlockId(bid)}
                  onInsertBlock={async (sid, block, afterBlockId) => {
                    const res = await postJson(EDIT_ROUTE, {
                      op: 'insert',
                      sheetId: sid,
                      block,
                      afterBlockId,
                    })
                    const created = res?.block as { id?: string } | undefined
                    if (created?.id) setSelectedBlockId(created.id)
                  }}
                  onPatchBlock={async (blockId, patch, baseHash): Promise<CommitOutcome> => {
                    const out = await postJsonDetailed(EDIT_ROUTE, {
                      op: 'patch',
                      sheetId: activeSheet.id,
                      blockId,
                      patch,
                      baseHash,
                    })
                    return { ok: out.ok, status: out.status }
                  }}
                  onMoveBlock={handleMoveBlock}
                  onRemoveBlock={async (sid, blockId) => {
                    if (selectedBlockId === blockId) setSelectedBlockId(null)
                    await postJson(EDIT_ROUTE, { op: 'remove', sheetId: sid, blockId })
                  }}
                  onUploadAsset={async (uploadArgs) => {
                    await postJson(EDIT_ROUTE, {
                      op: 'insert-asset',
                      ...uploadArgs,
                    })
                  }}
                  onDecideProposal={async (proposalId, action) => {
                    await postJson(`${PROPOSAL_ROUTE_PREFIX}/${encodeURIComponent(proposalId)}/decide`, { action })
                  }}
                  onAddAnnotation={async (blockId, body) => {
                    await postJson(EDIT_ROUTE, { op: 'annotate-add', blockId, body })
                  }}
                  onResolveAnnotation={async (blockId, annotationId) => {
                    await postJson(EDIT_ROUTE, { op: 'annotate-resolve', blockId, annotationId })
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
