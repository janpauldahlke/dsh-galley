/**
 * Block Tray (Spec 04 §4–§5) — flat ordered block rows per sheet, structural
 * insert/move/remove actions, stale dependency badges, unified 4-op proposal
 * diff Accept/Revert cards (`insert`, `patch`, `move`, `remove`), and margin
 * annotations (Randnotizen).
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { serializeInlines } from '../shared/inlineMarkup.ts'
import type {
  AssetId,
  AssetMeta,
  Block,
  BlockId,
  BlockType,
  GalleyAnnotation,
  GalleyProposal,
  Inline,
  SheetId,
  StateSheetView,
} from '../shared/types.ts'
import { BlockEditor } from './BlockEditor.tsx'
import {
  createStarterBlockPayload,
  flattenBlockPreview,
  type CommitOutcome,
} from './paneModel.ts'

const ALL_BLOCK_TYPES: { type: BlockType; label: string; icon: string }[] = [
  { type: 'header', label: 'Kopfbogen (header)', icon: '▤' },
  { type: 'heading', label: 'Überschrift (heading)', icon: '§' },
  { type: 'prose', label: 'Fließtext (prose)', icon: '¶' },
  { type: 'source_text', label: 'Quellentext (source_text)', icon: '❝' },
  { type: 'task', label: 'Aufgabe (task)', icon: '☑' },
  { type: 'table', label: 'Tabelle (table)', icon: '⊞' },
  { type: 'callout', label: 'Hinweisbox (callout)', icon: '◈' },
  { type: 'answer', label: 'Lösung (answer)', icon: '✓' },
]

function iconForType(type: BlockType): string {
  return ALL_BLOCK_TYPES.find((x) => x.type === type)?.icon ?? '□'
}

function summarizePatchSide(patch: Record<string, unknown> | undefined): string {
  if (!patch) return '—'
  if (patch.remove === true) return 'Block entfernen'
  if (patch.block && typeof patch.block === 'object') {
    const b = patch.block as Block
    return `[${b.type}] ${flattenBlockPreview(b, 80)}`
  }
  if (Array.isArray(patch.body)) return serializeInlines(patch.body as Inline[])
  if (typeof patch.body === 'string') return patch.body
  return JSON.stringify(patch)
}

export interface BlockTrayProps {
  sheet: StateSheetView
  allBlockIds: BlockId[]
  assets: Record<AssetId, AssetMeta>
  selectedBlockId: BlockId | null
  busy: boolean
  onSelectBlock: (blockId: BlockId | null) => void
  onInsertBlock: (sheetId: SheetId, block: Record<string, unknown>, afterBlockId?: BlockId) => Promise<void>
  onPatchBlock: (blockId: BlockId, patch: Record<string, unknown>, baseHash?: string) => Promise<CommitOutcome>
  onMoveBlock: (sheetId: SheetId, blockId: BlockId, direction: 'up' | 'down') => Promise<void>
  onRemoveBlock: (sheetId: SheetId, blockId: BlockId) => Promise<void>
  onUploadAsset: (args: {
    blockId: BlockId
    slotMode: 'media-right' | 'media-left'
    mimeType: string
    dataBase64: string
    alt?: string
    widthCm?: number
  }) => Promise<void>
  onDecideProposal: (proposalId: string, action: 'accept' | 'revert') => Promise<void>
  onAddAnnotation: (blockId: BlockId, body: string) => Promise<void>
  onResolveAnnotation: (blockId: BlockId, annotationId: string) => Promise<void>
}

const iconBtn: CSSProperties = {
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(128,128,128,0.28)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  cursor: 'pointer',
  lineHeight: 1.35,
}

export function BlockTray(props: BlockTrayProps): ReactNode {
  const {
    sheet,
    allBlockIds,
    assets,
    selectedBlockId,
    busy,
    onSelectBlock,
    onInsertBlock,
    onPatchBlock,
    onMoveBlock,
    onRemoveBlock,
    onUploadAsset,
    onDecideProposal,
    onAddAnnotation,
    onResolveAnnotation,
  } = props

  const [insertAfterTarget, setInsertAfterTarget] = useState<BlockId | '__end__' | null>(null)
  const [noteOpenBlockId, setNoteOpenBlockId] = useState<BlockId | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [proposalOpenId, setProposalOpenId] = useState<string | null>(null)

  const pendingProposalsByBlock = new Map<BlockId, GalleyProposal[]>()
  const pendingInsertProposals: GalleyProposal[] = []
  for (const p of sheet.proposals) {
    if (p.status === 'pending' || p.status === 'conflicted') {
      if (p.op === 'insert') {
        pendingInsertProposals.push(p)
      } else {
        const list = pendingProposalsByBlock.get(p.targetBlockId) ?? []
        list.push(p)
        pendingProposalsByBlock.set(p.targetBlockId, list)
      }
    }
  }

  const openAnnotationsByBlock = new Map<BlockId, GalleyAnnotation[]>()
  for (const a of sheet.annotations) {
    if (!a.resolved) {
      const list = openAnnotationsByBlock.get(a.blockId) ?? []
      list.push(a)
      openAnnotationsByBlock.set(a.blockId, list)
    }
  }

  const renderProposalCard = (prop: GalleyProposal): ReactNode => {
    const opLabel =
      prop.op === 'insert'
        ? 'Neuer Block vorgeschlagen'
        : prop.op === 'remove'
          ? 'Block-Löschung vorgeschlagen'
          : prop.op === 'move'
            ? 'Verschiebung vorgeschlagen'
            : 'Änderungsvorschlag'
    return (
      <div
        key={prop.id}
        data-testid={`galley-proposal-card-${prop.id}`}
        style={{
          marginTop: 6,
          marginBottom: prop.op === 'insert' ? 6 : 0,
          padding: '6px 8px',
          borderRadius: 5,
          border: `1px solid ${prop.status === 'conflicted' ? '#dc2626' : '#d97706'}`,
          background:
            prop.status === 'conflicted' ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.1)',
          fontSize: 11,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ fontWeight: 600 }}>
          Δ Agent: {opLabel} ({prop.id})
          {prop.status === 'conflicted'
            ? ' — Konflikt (Inhalt inzwischen geändert)'
            : ''}
        </div>
        {prop.beforePatch && (
          <div style={{ opacity: 0.78 }}>
            <span style={{ color: '#dc2626', fontWeight: 600 }}>− Vorher: </span>
            {summarizePatchSide(prop.beforePatch)}
          </div>
        )}
        <div>
          <span style={{ color: '#16a34a', fontWeight: 600 }}>+ Vorschlag: </span>
          {summarizePatchSide(prop.proposedPatch)}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {prop.status === 'pending' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { void onDecideProposal(prop.id, 'accept') }}
              style={{ ...iconBtn, borderColor: '#16a34a', color: '#16a34a', fontWeight: 600 }}
            >
              ✓ Annehmen
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => { void onDecideProposal(prop.id, 'revert') }}
            style={iconBtn}
          >
            ✕ Verwerfen
          </button>
        </div>
      </div>
    )
  }

  const renderInsertPicker = (afterId?: BlockId): ReactNode => (
    <div
      data-testid="galley-insert-menu"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: 7,
        borderRadius: 6,
        background: 'rgba(128,128,128,0.1)',
        border: '1px solid rgba(128,128,128,0.26)',
        marginBottom: 6,
      }}
    >
      {ALL_BLOCK_TYPES.map((item) => (
        <button
          key={item.type}
          type="button"
          onClick={() => {
            setInsertAfterTarget(null)
            void onInsertBlock(sheet.id, createStarterBlockPayload(item.type), afterId)
          }}
          style={{ ...iconBtn, padding: '3px 8px' }}
        >
          {item.icon} {item.label}
        </button>
      ))}
    </div>
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Tray toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(128,128,128,0.2)',
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>
          Blöcke · {sheet.title} <span style={{ opacity: 0.65 }}>({sheet.blocks.length})</span>
        </span>
        <button
          type="button"
          data-testid="galley-add-block-btn"
          onClick={() => setInsertAfterTarget((cur) => (cur === '__end__' ? null : '__end__'))}
          style={{ ...iconBtn, padding: '2px 8px', fontWeight: 600 }}
        >
          + Block anfügen
        </button>
      </div>

      {/* Scrollable block rows */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px' }}>
        {insertAfterTarget === '__end__' && sheet.blocks.length === 0 && renderInsertPicker(undefined)}

        {sheet.blocks.length === 0 && pendingInsertProposals.length === 0 && insertAfterTarget !== '__end__' && (
          <div style={{ opacity: 0.7, fontSize: 12, padding: '16px 4px', textAlign: 'center' }}>
            Noch keine Blöcke auf diesem Bogen — über „+ Block anfügen“ starten.
          </div>
        )}

        {sheet.blocks.map((block, index) => {
          const expanded = selectedBlockId === block.id
          const blockProposals = pendingProposalsByBlock.get(block.id) ?? []
          const blockNotes = openAnnotationsByBlock.get(block.id) ?? []
          const preview = flattenBlockPreview(block)

          return (
            <div
              key={block.id}
              data-testid={`galley-block-row-${block.id}`}
              style={{
                marginBottom: 6,
                padding: '6px 8px',
                borderRadius: 6,
                border: expanded
                  ? '1px solid rgba(59,130,246,0.65)'
                  : block.stale
                    ? '1px solid rgba(217,119,6,0.55)'
                    : '1px solid rgba(128,128,128,0.22)',
                background: expanded ? 'rgba(128,128,128,0.06)' : 'transparent',
              }}
            >
              {/* Compact header line */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectBlock(expanded ? null : block.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectBlock(expanded ? null : block.id)
                    }
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{iconForType(block.type)}</span>
                  <code style={{ fontSize: 11, fontWeight: 700 }}>{block.id}</code>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '0 5px',
                      borderRadius: 4,
                      background: 'rgba(128,128,128,0.15)',
                    }}
                  >
                    {block.type}
                  </span>
                  {block.slot.mode !== 'full' && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '0 5px',
                        borderRadius: 4,
                        background: 'rgba(59,130,246,0.14)',
                      }}
                    >
                      {block.slot.mode}
                    </span>
                  )}
                  <span style={{ fontSize: 10, opacity: 0.62 }}>{block.origin}</span>
                  <span
                    style={{
                      opacity: 0.85,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 220,
                    }}
                  >
                    {preview || '—'}
                  </span>

                  {/* Stale badge (Spec 04 §5 S1) */}
                  {block.stale && (
                    <span
                      data-testid={`galley-stale-${block.id}`}
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: '#d97706',
                        background: 'rgba(217,119,6,0.14)',
                        border: '1px solid #d97706',
                        borderRadius: 4,
                        padding: '0 5px',
                      }}
                    >
                      ⚠ stale ← {block.stale.origin}
                    </span>
                  )}

                  {/* Proposal badge (Spec 04 §5 S2) */}
                  {blockProposals.map((prop) => (
                    <button
                      key={prop.id}
                      type="button"
                      data-testid={`galley-proposal-badge-${prop.id}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setProposalOpenId((cur) => (cur === prop.id ? null : prop.id))
                      }}
                      style={{
                        ...iconBtn,
                        fontSize: 10,
                        fontWeight: 600,
                        color: prop.status === 'conflicted' ? '#dc2626' : '#d97706',
                        borderColor: prop.status === 'conflicted' ? '#dc2626' : '#d97706',
                        background: 'rgba(217,119,6,0.14)',
                      }}
                    >
                      Δ {prop.status === 'conflicted' ? 'Konflikt' : 'Vorschlag'}
                    </button>
                  ))}

                  {/* Annotation count */}
                  {blockNotes.length > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '0 5px',
                        borderRadius: 4,
                        background: 'rgba(128,128,128,0.18)',
                      }}
                    >
                      💬 {blockNotes.length}
                    </span>
                  )}
                </div>

                {/* Structural actions: note, +, up, down, remove */}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <button
                    type="button"
                    title="Randnotiz"
                    onClick={() => setNoteOpenBlockId((cur) => (cur === block.id ? null : block.id))}
                    style={iconBtn}
                  >
                    💬
                  </button>
                  <button
                    type="button"
                    title="Block danach einfügen"
                    onClick={() => setInsertAfterTarget((cur) => (cur === block.id ? null : block.id))}
                    style={iconBtn}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    title="Nach oben"
                    disabled={index === 0 || busy}
                    onClick={() => { void onMoveBlock(sheet.id, block.id, 'up') }}
                    style={{ ...iconBtn, opacity: index === 0 ? 0.35 : 1 }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Nach unten"
                    disabled={index === sheet.blocks.length - 1 || busy}
                    onClick={() => { void onMoveBlock(sheet.id, block.id, 'down') }}
                    style={{ ...iconBtn, opacity: index === sheet.blocks.length - 1 ? 0.35 : 1 }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="Block entfernen"
                    disabled={busy}
                    onClick={() => { void onRemoveBlock(sheet.id, block.id) }}
                    style={iconBtn}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Proposal diff overlay (Spec 04 §5 S2) */}
              {blockProposals
                .filter((p) => proposalOpenId === p.id || blockProposals.length === 1)
                .map((prop) => renderProposalCard(prop))}

              {/* Margin notes (Randnotizen, Spec 04 §5 S4) */}
              {(noteOpenBlockId === block.id || blockNotes.length > 0) && (
                <div
                  style={{
                    marginTop: 6,
                    padding: '6px 8px',
                    borderRadius: 5,
                    background: 'rgba(128,128,128,0.08)',
                    fontSize: 11,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {blockNotes.map((ann) => (
                    <div
                      key={ann.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}
                    >
                      <span>
                        <strong>[{ann.author}]</strong> {serializeInlines(ann.body)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { void onResolveAnnotation(block.id, ann.id) }}
                        style={iconBtn}
                      >
                        Erledigt
                      </button>
                    </div>
                  ))}
                  {noteOpenBlockId === block.id && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        aria-label={`Randnotiz für ${block.id}`}
                        placeholder="Randnotiz hinzufügen (max. 800 Zeichen)…"
                        maxLength={800}
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        style={{
                          flex: 1,
                          color: 'inherit',
                          background: 'transparent',
                          border: '1px solid rgba(128,128,128,0.32)',
                          borderRadius: 4,
                          padding: '3px 6px',
                          fontSize: 11,
                        }}
                      />
                      <button
                        type="button"
                        disabled={!noteDraft.trim() || busy}
                        onClick={() => {
                          const text = noteDraft.trim()
                          if (!text) return
                          setNoteDraft('')
                          setNoteOpenBlockId(null)
                          void onAddAnnotation(block.id, text)
                        }}
                        style={iconBtn}
                      >
                        Senden
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Expanded zero-latency structured editor */}
              {expanded && (
                <BlockEditor
                  block={block}
                  allBlockIds={allBlockIds}
                  assets={assets}
                  busy={busy}
                  onCommitPatch={onPatchBlock}
                  onUploadAsset={onUploadAsset}
                />
              )}

              {insertAfterTarget === block.id && (
                <div style={{ marginTop: 6 }}>{renderInsertPicker(block.id)}</div>
              )}
            </div>
          )
        })}

        {/* Staged insert proposals (in Review mode) */}
        {pendingInsertProposals.map((prop) => renderProposalCard(prop))}

        {insertAfterTarget === '__end__' && sheet.blocks.length > 0 && renderInsertPicker(undefined)}
      </div>
    </div>
  )
}
