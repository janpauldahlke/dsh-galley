/**
 * dsh-galley — pane body (M0: the dual-face proof).
 *
 * On mount it pings `GET /api/galley/health` — which forces the host's native
 * Typst arm to compile the sample packet in-process — and renders the receipt
 * (arm, typst version, pages, byte sizes, ms). A successful render is the
 * end-to-end "host compiled, pane shows" proof for the M0 gate.
 *
 * Inline styles only (no CSS pipeline). `currentColor`-friendly so light/dark
 * chrome both work. Runtime imports: react (the platform baseline).
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { HEALTH_ROUTE } from '../shared/types.ts'

type Receipt = {
  ok: boolean
  name?: string
  version?: string
  arm?: string
  typst?: string
  sample?: { pages: number; pdfBytes: number; svgBytes: number; ms: number }
  time?: string
  error?: string
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const base: CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'currentColor',
  padding: 12,
  boxSizing: 'border-box',
}

function Row({ k, v }: { k: string; v: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.18)' }}>
      <span style={{ opacity: 0.7 }}>{k}</span>
      <span style={{ fontWeight: 600 }}>{v}</span>
    </div>
  )
}

export function GalleyBody(): ReactNode {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; data?: Receipt }>({ status: 'loading' })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetchJson(HEALTH_ROUTE)
      .then((data) => {
        if (alive) setState({ status: (data as Receipt).ok ? 'ok' : 'error', data: data as Receipt })
      })
      .catch((error) => {
        if (alive) setState({ status: 'error', data: { ok: false, error: String(error) } })
      })
    return () => {
      alive = false
    }
  }, [tick])

  return (
    <div style={base}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Galley · Druck und Satz</strong>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          style={{ color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6, padding: '2px 10px', cursor: 'pointer', fontSize: 12 }}
        >
          Re-render
        </button>
      </div>

      {state.status === 'loading' && <div style={{ opacity: 0.7 }}>Compiling the sample packet in-process…</div>}

      {state.status === 'error' && (
        <div style={{ opacity: 0.85 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Host proof unavailable</div>
          <code style={{ fontSize: 12, opacity: 0.8 }}>{state.data?.error ?? 'unknown'}</code>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            Is a <code>dsh web</code> host with this plugin installed running? The host face must be active for the proof to render.
          </div>
        </div>
      )}

      {state.status === 'ok' && state.data && (
        <div>
          <Row k="status" v={<span style={{ color: 'green' }}>● native arm OK</span>} />
          <Row k="arm / typst" v={`${state.data.arm} · ${state.data.typst}`} />
          <Row k="pages" v={state.data.sample?.pages} />
          <Row k="pdf" v={`${state.data.sample ? (state.data.sample.pdfBytes / 1024).toFixed(1) : '?'} KB`} />
          <Row k="svg" v={`${state.data.sample ? (state.data.sample.svgBytes / 1024).toFixed(1) : '?'} KB`} />
          <Row k="compile" v={`${state.data.sample?.ms} ms`} />
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            The host compiled the sample <code>.typ</code> with the native Typst 0.14.2 arm. Full A4 SVG proof + block editing land in M2–M3.
          </div>
        </div>
      )}
    </div>
  )
}
