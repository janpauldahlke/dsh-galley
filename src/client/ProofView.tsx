/**
 * Fahnenabzug (Proof View) — renders host-compiled Typst SVGs inline per page
 * with page geometry footers, block-to-page jump chips, target-page budget
 * controls, and the Spec 04 §3 amber overflow strip. Zero client Typst imports.
 */
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  BlockId,
  SheetId,
  StateProofView,
  StateSheetView,
} from '../shared/types.ts'
import { decodeSvgDataUri, formatOverflowBanner } from './paneModel.ts'

export interface ProofViewProps {
  sheets: StateSheetView[]
  proofs: StateProofView[]
  selectedSheetId: SheetId
  selectedBlockId: BlockId | null
  onSelectSheet: (sheetId: SheetId) => void
  onSelectBlock: (blockId: BlockId) => void
  onUpdateTargetPages: (sheetId: SheetId, targetPages: number | null) => void
}

type ZoomLevel = 'fit' | 75 | 100 | 125

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  flexWrap: 'wrap',
  padding: '6px 10px',
  borderBottom: '1px solid rgba(128,128,128,0.2)',
  fontSize: 12,
}

const pillBtn = (active: boolean): CSSProperties => ({
  color: 'inherit',
  background: active ? 'rgba(128,128,128,0.22)' : 'transparent',
  border: '1px solid rgba(128,128,128,0.32)',
  borderRadius: 5,
  padding: '2px 7px',
  fontSize: 11,
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  lineHeight: 1.4,
})

export function ProofView(props: ProofViewProps): ReactNode {
  const {
    sheets,
    proofs,
    selectedSheetId,
    selectedBlockId,
    onSelectSheet,
    onSelectBlock,
    onUpdateTargetPages,
  } = props

  const [zoom, setZoom] = useState<ZoomLevel>('fit')

  const activeSheet = sheets.find((s) => s.id === selectedSheetId) ?? sheets[0]
  const activeProof = proofs.find((p) => p.sheetId === activeSheet?.id)

  const decodedPages = useMemo(() => {
    if (!activeProof?.svgPages) return []
    return activeProof.svgPages.map((uri) => decodeSvgDataUri(uri))
  }, [activeProof])

  const blocksByPage = useMemo(() => {
    const map = new Map<number, BlockId[]>()
    if (!activeProof?.blockToPage) return map
    for (const [bid, pIdx] of Object.entries(activeProof.blockToPage)) {
      const list = map.get(pIdx) ?? []
      list.push(bid)
      map.set(pIdx, list)
    }
    return map
  }, [activeProof])

  const selectedBlockPage =
    selectedBlockId && activeProof?.blockToPage && selectedBlockId in activeProof.blockToPage
      ? activeProof.blockToPage[selectedBlockId]
      : null

  const targetPages = activeSheet?.geometry?.targetPages

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Sheet switcher + Target pages + Zoom */}
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {sheets.map((sh) => {
            const pr = proofs.find((p) => p.sheetId === sh.id)
            const hasOverflow = (pr?.overflowLinesOnLastPage ?? 0) > 0
            const active = sh.id === activeSheet?.id
            return (
              <button
                key={sh.id}
                type="button"
                onClick={() => onSelectSheet(sh.id)}
                style={{
                  ...pillBtn(active),
                  borderColor: hasOverflow ? '#d97706' : 'rgba(128,128,128,0.32)',
                }}
              >
                {sh.title} <span style={{ opacity: 0.68 }}>({pr?.pages ?? 0}p)</span>
                {hasOverflow ? <span style={{ color: '#d97706', marginLeft: 4 }}>⚠</span> : null}
              </button>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {activeSheet && (
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, opacity: 0.85 }}
              title="Zielseitenzahl (targetPages) für Überlauf-Prüfung"
            >
              <span>Ziel:</span>
              <select
                aria-label="Zielseiten"
                value={targetPages === undefined ? '' : String(targetPages)}
                onChange={(e) => {
                  const v = e.target.value
                  onUpdateTargetPages(activeSheet.id, v === '' ? null : Number(v))
                }}
                style={{
                  color: 'inherit',
                  background: 'transparent',
                  border: '1px solid rgba(128,128,128,0.32)',
                  borderRadius: 4,
                  fontSize: 11,
                  padding: '1px 4px',
                }}
              >
                <option value="" style={{ color: '#111' }}>∞ frei</option>
                <option value="1" style={{ color: '#111' }}>1 Seite</option>
                <option value="2" style={{ color: '#111' }}>2 Seiten</option>
                <option value="3" style={{ color: '#111' }}>3 Seiten</option>
                <option value="4" style={{ color: '#111' }}>4 Seiten</option>
              </select>
            </label>
          )}

          <div style={{ display: 'inline-flex', gap: 2 }}>
            {(['fit', 75, 100, 125] as ZoomLevel[]).map((z) => (
              <button
                key={String(z)}
                type="button"
                onClick={() => setZoom(z)}
                style={pillBtn(zoom === z)}
              >
                {z === 'fit' ? 'Fit' : `${z}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scrollable proof canvas */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'auto',
          padding: 12,
          background: 'rgba(128,128,128,0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
        }}
      >
        {activeProof?.compileError && (
          <div
            data-testid="galley-compile-error"
            style={{
              width: '100%',
              maxWidth: 560,
              boxSizing: 'border-box',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #dc2626',
              background: 'rgba(220, 38, 38, 0.1)',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 4 }}>
              Typst-Satzfehler auf Bogen {activeSheet?.title ?? selectedSheetId}
            </div>
            <code style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11 }}>
              {activeProof.compileError.message}
            </code>
            {activeProof.compileError.blockId && (
              <button
                type="button"
                onClick={() => onSelectBlock(activeProof.compileError!.blockId!)}
                style={{ ...pillBtn(false), marginTop: 6, borderColor: '#dc2626', color: '#dc2626' }}
              >
                Zu Block {activeProof.compileError.blockId} springen
              </button>
            )}
          </div>
        )}

        {!activeProof?.compileError && decodedPages.length === 0 && (
          <div style={{ opacity: 0.65, fontSize: 12, padding: 24 }}>
            Kein Fahnenabzug verfügbar.
          </div>
        )}

        {decodedPages.map((svgMarkup, idx) => {
          const total = activeProof?.pages ?? decodedPages.length
          const dims = activeProof?.perPage?.[idx] ?? { wPt: 595, hPt: 842 }
          const isLastPage = idx === total - 1
          const overflowText = isLastPage
            ? formatOverflowBanner(activeProof?.overflowLinesOnLastPage ?? 0, targetPages)
            : null
          const isFocusedPage = selectedBlockPage === idx
          const pageBlocks = blocksByPage.get(idx) ?? []

          const widthStyle: CSSProperties =
            zoom === 'fit'
              ? { width: '100%', maxWidth: 560 }
              : { width: `${Math.round((560 * zoom) / 100)}px`, maxWidth: 'none' }

          return (
            <div
              key={`${activeSheet?.id ?? 's'}-p${idx}`}
              data-testid={`galley-proof-page-${idx + 1}`}
              style={{
                ...widthStyle,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  background: '#ffffff',
                  color: '#000000',
                  borderRadius: 3,
                  overflow: 'hidden',
                  boxShadow: isFocusedPage
                    ? '0 0 0 2px rgba(59,130,246,0.75), 0 3px 12px rgba(0,0,0,0.18)'
                    : '0 2px 10px rgba(0,0,0,0.16)',
                  border: overflowText ? '1.5px solid #d97706' : '1px solid rgba(128,128,128,0.25)',
                }}
                dangerouslySetInnerHTML={{ __html: svgMarkup }}
              />

              {/* Page footer */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  flexWrap: 'wrap',
                  fontSize: 11,
                  opacity: 0.78,
                  padding: '0 2px',
                }}
              >
                <span>
                  Seite {idx + 1} von {total} · {Math.round(dims.wPt)}×{Math.round(dims.hPt)} pt
                </span>
                {pageBlocks.length > 0 && (
                  <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
                    {pageBlocks.map((bid) => (
                      <button
                        key={bid}
                        type="button"
                        onClick={() => onSelectBlock(bid)}
                        style={{
                          ...pillBtn(bid === selectedBlockId),
                          padding: '0 5px',
                          fontSize: 10,
                        }}
                      >
                        {bid}
                      </button>
                    ))}
                  </span>
                )}
              </div>

              {/* Spec 04 §3: Amber overflow strip on last page */}
              {overflowText && (
                <div
                  data-testid="galley-overflow-strip"
                  style={{
                    padding: '5px 9px',
                    borderRadius: 5,
                    background: 'rgba(217, 119, 6, 0.16)',
                    border: '1px solid #d97706',
                    color: '#d97706',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span>⚠ {overflowText}</span>
                  <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.9 }}>
                    Text kürzen oder Zielseiten erhöhen
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
