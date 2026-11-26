/**
 * Per-block zero-latency structured editor (Spec 04 §4).
 *
 * Keystrokes mutate only the local `BlockDraftBuffer` (0 ms network traffic).
 * Commits fire on editor container blur, Ctrl/Cmd+Enter, or the Apply button.
 * Supports all 8 block types, all 5 layout slots, drag-drop / clipboard paste /
 * file upload for media assets, dependency edge linking, and base-hash conflicts.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  ClipboardEvent,
  DragEvent,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from 'react'
import type {
  AssetId,
  AssetMeta,
  Block,
  BlockId,
  LayoutSlot,
} from '../shared/types.ts'
import {
  applyCommitOutcome,
  blockToDraftBuffer,
  draftBufferToPatch,
  reconcileDraftBuffer,
  type BlockDraftBuffer,
  type CommitOutcome,
} from './paneModel.ts'

export interface BlockEditorProps {
  block: Block
  allBlockIds: BlockId[]
  assets: Record<AssetId, AssetMeta>
  busy: boolean
  onCommitPatch: (blockId: BlockId, patch: Record<string, unknown>, baseHash?: string) => Promise<CommitOutcome>
  onUploadAsset: (args: {
    blockId: BlockId
    slotMode: 'media-right' | 'media-left'
    mimeType: string
    dataBase64: string
    alt?: string
    widthCm?: number
  }) => Promise<void>
  onDirtyChange?: (blockId: BlockId, dirty: boolean) => void
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  color: 'inherit',
  background: 'rgba(128,128,128,0.08)',
  border: '1px solid rgba(128,128,128,0.32)',
  borderRadius: 5,
  padding: '4px 7px',
  fontSize: 12,
  fontFamily: 'inherit',
}

const smallBtn: CSSProperties = {
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(128,128,128,0.32)',
  borderRadius: 4,
  padding: '2px 7px',
  fontSize: 11,
  cursor: 'pointer',
  lineHeight: 1.4,
}

function readFileAsBase64(file: File): Promise<{ mimeType: string; dataBase64: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const stripped = result.replace(/^data:[^;]+;base64,/, '')
      resolve({
        mimeType: file.type || 'image/png',
        dataBase64: stripped,
        name: file.name || 'image.png',
      })
    }
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

export function BlockEditor(props: BlockEditorProps): ReactNode {
  const { block, allBlockIds, assets, busy, onCommitPatch, onUploadAsset, onDirtyChange } = props

  const [draft, setDraft] = useState<BlockDraftBuffer>(() => blockToDraftBuffer(block))
  const [dropActive, setDropActive] = useState(false)
  const [showDeps, setShowDeps] = useState(() => (block.dependsOn?.length ?? 0) > 0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Reconcile server updates without overwriting dirty human keystrokes
  useEffect(() => {
    setDraft((prev) => reconcileDraftBuffer(prev, block) ?? blockToDraftBuffer(block))
  }, [block])

  useEffect(() => {
    onDirtyChange?.(block.id, draft.dirty)
  }, [block.id, draft.dirty, onDirtyChange])

  const updateDraft = (updater: (prev: BlockDraftBuffer) => BlockDraftBuffer): void => {
    setDraft((prev) => ({ ...updater(prev), dirty: true }))
  }

  const commitNow = async (ignoreBaseHash = false): Promise<void> => {
    if (!draft.dirty && !ignoreBaseHash) return
    const patch = draftBufferToPatch(draft)
    const outcome = await onCommitPatch(block.id, patch, ignoreBaseHash ? undefined : draft.baseHash)
    setDraft((prev) => applyCommitOutcome(prev, outcome))
  }

  const handleContainerBlur = (e: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = e.relatedTarget as Node | null
    if (nextTarget && e.currentTarget.contains(nextTarget)) return
    if (draft.dirty && !draft.conflict && !busy) {
      void commitNow(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void commitNow(false)
    }
  }

  const wrapSelection = (prefix: string, suffix: string, placeholder: string): void => {
    const el = textareaRef.current
    if (!el) {
      updateDraft((p) => ({ ...p, markup: `${p.markup}${prefix}${placeholder}${suffix}` }))
      return
    }
    const start = el.selectionStart ?? draft.markup.length
    const end = el.selectionEnd ?? draft.markup.length
    const selected = draft.markup.slice(start, end) || placeholder
    const nextMarkup = draft.markup.slice(0, start) + prefix + selected + suffix + draft.markup.slice(end)
    updateDraft((p) => ({ ...p, markup: nextMarkup }))
    requestAnimationFrame(() => {
      el.focus()
      const cursorStart = start + prefix.length
      el.setSelectionRange(cursorStart, cursorStart + selected.length)
    })
  }

  const ingestImageFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) return
    const { mimeType, dataBase64, name } = await readFileAsBase64(file)
    const mode: 'media-right' | 'media-left' =
      draft.slot.mode === 'media-left' ? 'media-left' : 'media-right'
    if (draft.dirty) {
      await commitNow(true)
    }
    await onUploadAsset({
      blockId: block.id,
      slotMode: mode,
      mimeType,
      dataBase64,
      alt: draft.slot.asset?.alt || name.replace(/\.[^.]+$/, ''),
      widthCm: draft.slot.asset?.widthCm,
    })
  }

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    if (block.type === 'header' || block.type === 'heading') return
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          void ingestImageFile(file)
          return
        }
      }
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (block.type === 'header' || block.type === 'heading') return
    e.preventDefault()
    setDropActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (file && file.type.startsWith('image/')) {
      void ingestImageFile(file)
    }
  }

  const supportsRichText =
    block.type === 'heading' ||
    block.type === 'prose' ||
    block.type === 'source_text' ||
    block.type === 'task' ||
    block.type === 'callout' ||
    block.type === 'answer'

  const supportsSlot = block.type !== 'header' && block.type !== 'heading'
  const assetList = Object.values(assets)

  const handleSlotModeChange = (nextMode: LayoutSlot['mode']): void => {
    updateDraft((prev) => {
      if (nextMode === 'full' || nextMode === 'two-column') {
        return { ...prev, slot: { mode: nextMode } }
      }
      if (nextMode === 'card-grid') {
        return {
          ...prev,
          slot: {
            mode: 'card-grid',
            columns: prev.slot.columns ?? 3,
            cardHeightCm: prev.slot.cardHeightCm ?? 6,
          },
        }
      }
      // media-right / media-left: bind existing asset if one exists in packet
      const fallbackAsset = prev.slot.asset
        ? prev.slot.asset
        : assetList[0]
          ? { id: assetList[0].id, path: assetList[0].path, alt: assetList[0].id }
          : undefined
      return {
        ...prev,
        slot: {
          mode: nextMode,
          asset: fallbackAsset,
        },
      }
    })
  }

  const mediaMissingAsset =
    (draft.slot.mode === 'media-right' || draft.slot.mode === 'media-left') && !draft.slot.asset

  return (
    <div
      data-testid={`galley-editor-${block.id}`}
      onBlur={handleContainerBlur}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragOver={(e) => {
        if (supportsSlot) {
          e.preventDefault()
          setDropActive(true)
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
      style={{
        marginTop: 6,
        padding: 8,
        borderRadius: 6,
        background: dropActive ? 'rgba(59,130,246,0.1)' : 'rgba(128,128,128,0.06)',
        border: dropActive ? '1px dashed #3b82f6' : '1px solid rgba(128,128,128,0.22)',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      {/* Base-hash conflict banner (Spec 04 §4.4) */}
      {draft.conflict && (
        <div
          data-testid="galley-editor-conflict"
          style={{
            padding: '6px 8px',
            borderRadius: 5,
            background: 'rgba(220,38,38,0.12)',
            border: '1px solid #dc2626',
            color: '#dc2626',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span>Block wurde zwischenzeitlich geändert.</span>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              onClick={() => { void commitNow(true) }}
              style={{ ...smallBtn, borderColor: '#dc2626', color: '#dc2626', fontWeight: 600 }}
            >
              Meine behalten
            </button>
            <button
              type="button"
              onClick={() => setDraft(blockToDraftBuffer(block))}
              style={smallBtn}
            >
              Server übernehmen
            </button>
          </span>
        </div>
      )}

      {/* 1. HEADER structured fields */}
      {block.type === 'header' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: 11, opacity: 0.75 }}>Titel</label>
            <input
              aria-label="Header Titel"
              style={inputStyle}
              value={draft.headerFields.titel}
              onChange={(e) =>
                updateDraft((p) => ({ ...p, headerFields: { ...p.headerFields, titel: e.target.value } }))
              }
            />
          </div>
          {(['fach', 'klasse', 'datum', 'name'] as const).map((fieldKey) => (
            <div key={fieldKey}>
              <label style={{ fontSize: 11, opacity: 0.75, textTransform: 'capitalize' }}>{fieldKey}</label>
              <input
                aria-label={`Header ${fieldKey}`}
                style={inputStyle}
                value={draft.headerFields[fieldKey]}
                onChange={(e) =>
                  updateDraft((p) => ({
                    ...p,
                    headerFields: { ...p.headerFields, [fieldKey]: e.target.value },
                  }))
                }
              />
            </div>
          ))}
        </div>
      )}

      {/* 2. HEADING controls */}
      {block.type === 'heading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
          <span>Ebene:</span>
          {([1, 2, 3] as const).map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => updateDraft((p) => ({ ...p, headingLevel: lvl }))}
              style={{
                ...smallBtn,
                background: draft.headingLevel === lvl ? 'rgba(128,128,128,0.22)' : 'transparent',
                fontWeight: draft.headingLevel === lvl ? 700 : 400,
              }}
            >
              H{lvl}
            </button>
          ))}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.headingNumbered}
              onChange={(e) => updateDraft((p) => ({ ...p, headingNumbered: e.target.checked }))}
            />
            Nummeriert
          </label>
        </div>
      )}

      {/* 3. SOURCE_TEXT metadata + marginal line numbers */}
      {block.type === 'source_text' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input
            aria-label="Quellentext Titel"
            placeholder="Quellentitel (optional)"
            style={{ ...inputStyle, flex: '1 1 140px' }}
            value={draft.sourceTitle}
            onChange={(e) => updateDraft((p) => ({ ...p, sourceTitle: e.target.value }))}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <span>Zeilennr. alle</span>
            <input
              aria-label="Zeilennummern Intervall"
              type="number"
              min={0}
              max={50}
              style={{ ...inputStyle, width: 52 }}
              value={draft.lineEvery}
              onChange={(e) => updateDraft((p) => ({ ...p, lineEvery: Math.max(0, Number(e.target.value) || 0) }))}
            />
          </label>
        </div>
      )}

      {/* 4. CALLOUT tone selector */}
      {block.type === 'callout' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          <span>Ton:</span>
          {(['info', 'hint', 'warning'] as const).map((tone) => (
            <button
              key={tone}
              type="button"
              onClick={() => updateDraft((p) => ({ ...p, calloutTone: tone }))}
              style={{
                ...smallBtn,
                background: draft.calloutTone === tone ? 'rgba(128,128,128,0.22)' : 'transparent',
                fontWeight: draft.calloutTone === tone ? 600 : 400,
              }}
            >
              {tone}
            </button>
          ))}
        </div>
      )}

      {/* 5. Rich inline toolbar + markup textarea */}
      {supportsRichText && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button type="button" title="Fett (**…**)" style={smallBtn} onClick={() => wrapSelection('**', '**', 'fett')}>
              <strong>B</strong>
            </button>
            <button type="button" title="Kursiv (*…*)" style={smallBtn} onClick={() => wrapSelection('*', '*', 'kursiv')}>
              <em>I</em>
            </button>
            <button type="button" title="Code (`…`)" style={smallBtn} onClick={() => wrapSelection('`', '`', 'code')}>
              <code>{'<>'}</code>
            </button>
            <button type="button" title="Typst Math ($…$)" style={smallBtn} onClick={() => wrapSelection('$', '$', 'x^2')}>
              ∑ Math
            </button>
            <button
              type="button"
              title="Lückentext ({{Hinweis}})"
              style={smallBtn}
              onClick={() => wrapSelection('{{', '}}', 'Lösung')}
            >
              ___ Lücke
            </button>
          </div>
          <textarea
            ref={textareaRef}
            aria-label={`Block ${block.id} Inhalt`}
            rows={block.type === 'heading' ? 2 : block.type === 'source_text' ? 5 : 3}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.45 }}
            value={draft.markup}
            onChange={(e) => updateDraft((p) => ({ ...p, markup: e.target.value }))}
          />
        </div>
      )}

      {/* 6. TABLE structured grid editor */}
      {block.type === 'table' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowX: 'auto' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={smallBtn}
              onClick={() =>
                updateDraft((p) => ({
                  ...p,
                  tableHeaders: [...p.tableHeaders, `Spalte ${p.tableHeaders.length + 1}`],
                  tableRows: p.tableRows.map((r) => [...r, '']),
                }))
              }
            >
              + Spalte
            </button>
            {draft.tableHeaders.length > 1 && (
              <button
                type="button"
                style={smallBtn}
                onClick={() =>
                  updateDraft((p) => ({
                    ...p,
                    tableHeaders: p.tableHeaders.slice(0, -1),
                    tableRows: p.tableRows.map((r) => r.slice(0, -1)),
                  }))
                }
              >
                − Spalte
              </button>
            )}
            <button
              type="button"
              style={smallBtn}
              onClick={() =>
                updateDraft((p) => ({
                  ...p,
                  tableRows: [...p.tableRows, p.tableHeaders.map(() => '')],
                }))
              }
            >
              + Zeile
            </button>
            {draft.tableRows.length > 1 && (
              <button
                type="button"
                style={smallBtn}
                onClick={() => updateDraft((p) => ({ ...p, tableRows: p.tableRows.slice(0, -1) }))}
              >
                − Zeile
              </button>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.max(1, draft.tableHeaders.length)}, minmax(90px, 1fr))`,
              gap: 4,
            }}
          >
            {draft.tableHeaders.map((h, ci) => (
              <input
                key={`th-${ci}`}
                aria-label={`Tabellenkopf ${ci + 1}`}
                style={{ ...inputStyle, fontWeight: 600 }}
                value={h}
                onChange={(e) =>
                  updateDraft((p) => {
                    const nextH = [...p.tableHeaders]
                    nextH[ci] = e.target.value
                    return { ...p, tableHeaders: nextH }
                  })
                }
              />
            ))}
            {draft.tableRows.map((row, ri) =>
              draft.tableHeaders.map((_, ci) => (
                <input
                  key={`td-${ri}-${ci}`}
                  aria-label={`Zelle ${ri + 1},${ci + 1}`}
                  style={inputStyle}
                  value={row[ci] ?? ''}
                  onChange={(e) =>
                    updateDraft((p) => {
                      const nextRows = p.tableRows.map((r) => [...r])
                      while (nextRows[ri].length < p.tableHeaders.length) nextRows[ri].push('')
                      nextRows[ri][ci] = e.target.value
                      return { ...p, tableRows: nextRows }
                    })
                  }
                />
              )),
            )}
          </div>
        </div>
      )}

      {/* 7. Layout Slot & Media Asset controls (Spec 04 §4.6–4.7) */}
      {supportsSlot && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            paddingTop: 5,
            borderTop: '1px solid rgba(128,128,128,0.16)',
            fontSize: 11,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ opacity: 0.78 }}>Slot:</span>
            <select
              aria-label={`Block ${block.id} Layout-Slot`}
              value={draft.slot.mode}
              onChange={(e) => handleSlotModeChange(e.target.value as LayoutSlot['mode'])}
              style={{
                color: 'inherit',
                background: 'transparent',
                border: '1px solid rgba(128,128,128,0.32)',
                borderRadius: 4,
                fontSize: 11,
                padding: '2px 5px',
              }}
            >
              <option value="full" style={{ color: '#111' }}>full (100%)</option>
              <option value="two-column" style={{ color: '#111' }}>two-column (2 Spalten)</option>
              <option value="card-grid" style={{ color: '#111' }}>card-grid (Ausschneidekarten)</option>
              <option value="media-right" style={{ color: '#111' }}>media-right (65/35 Bild rechts)</option>
              <option value="media-left" style={{ color: '#111' }}>media-left (35/65 Bild links)</option>
            </select>

            {draft.slot.mode === 'card-grid' && (
              <>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Spalten:</span>
                  <select
                    aria-label="Karten-Spalten"
                    value={String(draft.slot.columns ?? 3)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        slot: { ...p.slot, mode: 'card-grid', columns: Number(e.target.value) as 2 | 3 | 4 },
                      }))
                    }
                    style={{
                      color: 'inherit',
                      background: 'transparent',
                      border: '1px solid rgba(128,128,128,0.32)',
                      borderRadius: 4,
                      fontSize: 11,
                      padding: '1px 4px',
                    }}
                  >
                    <option value="2" style={{ color: '#111' }}>2</option>
                    <option value="3" style={{ color: '#111' }}>3</option>
                    <option value="4" style={{ color: '#111' }}>4</option>
                  </select>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>Höhe (cm):</span>
                  <input
                    aria-label="Kartenhöhe cm"
                    type="number"
                    min={2}
                    max={20}
                    step={0.5}
                    style={{ ...inputStyle, width: 54, padding: '2px 5px' }}
                    value={draft.slot.cardHeightCm ?? 6}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        slot: { ...p.slot, mode: 'card-grid', cardHeightCm: Number(e.target.value) || 6 },
                      }))
                    }
                  />
                </label>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void ingestImageFile(file)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={smallBtn}
              title="Bild hochladen, ablegen oder mit Strg+V einfügen"
            >
              🖼 Bild hochladen / Drop
            </button>
          </div>

          {(draft.slot.mode === 'media-right' || draft.slot.mode === 'media-left') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {assetList.length > 0 ? (
                <>
                  <span>Asset:</span>
                  <select
                    aria-label="Medien-Asset"
                    value={draft.slot.asset?.id ?? ''}
                    onChange={(e) => {
                      const meta = assets[e.target.value]
                      if (meta) {
                        updateDraft((p) => ({
                          ...p,
                          slot: {
                            ...p.slot,
                            asset: { id: meta.id, path: meta.path, alt: p.slot.asset?.alt || meta.id },
                          },
                        }))
                      }
                    }}
                    style={{
                      color: 'inherit',
                      background: 'transparent',
                      border: '1px solid rgba(128,128,128,0.32)',
                      borderRadius: 4,
                      fontSize: 11,
                      padding: '1px 5px',
                    }}
                  >
                    {assetList.map((a) => (
                      <option key={a.id} value={a.id} style={{ color: '#111' }}>
                        {a.id} ({a.path})
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <span style={{ color: '#d97706' }}>
                  Bild ablegen, einfügen (Strg+V) oder „Bild hochladen“ klicken, um den Medien-Slot zu füllen.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 8. Dependency edges + explicit Apply bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          flexWrap: 'wrap',
          paddingTop: 4,
          borderTop: '1px solid rgba(128,128,128,0.16)',
          fontSize: 11,
        }}
      >
        <button
          type="button"
          onClick={() => setShowDeps((v) => !v)}
          style={{ ...smallBtn, opacity: 0.85 }}
        >
          Abhängig von ({draft.dependsOnIds.length}) {showDeps ? '▴' : '▾'}
        </button>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {draft.dirty && !mediaMissingAsset && (
            <span style={{ fontSize: 10, opacity: 0.7 }}>Ungespeichert · Strg+Enter</span>
          )}
          <button
            type="button"
            disabled={!draft.dirty || mediaMissingAsset || busy}
            onClick={() => { void commitNow(false) }}
            style={{
              ...smallBtn,
              fontWeight: 600,
              opacity: !draft.dirty || mediaMissingAsset || busy ? 0.45 : 1,
              background: draft.dirty && !mediaMissingAsset ? 'rgba(22,163,74,0.16)' : 'transparent',
              borderColor: draft.dirty && !mediaMissingAsset ? '#16a34a' : 'rgba(128,128,128,0.32)',
            }}
          >
            Übernehmen
          </button>
        </div>
      </div>

      {showDeps && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 11 }}>
          {allBlockIds
            .filter((id) => id !== block.id)
            .map((id) => {
              const linked = draft.dependsOnIds.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    updateDraft((p) => ({
                      ...p,
                      dependsOnIds: linked
                        ? p.dependsOnIds.filter((x) => x !== id)
                        : [...p.dependsOnIds, id],
                    }))
                  }
                  style={{
                    ...smallBtn,
                    padding: '1px 6px',
                    background: linked ? 'rgba(59,130,246,0.2)' : 'transparent',
                    borderColor: linked ? '#3b82f6' : 'rgba(128,128,128,0.32)',
                  }}
                >
                  {linked ? `✓ ${id}` : `+ ${id}`}
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}
