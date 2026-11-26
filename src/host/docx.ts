/**
 * dsh-galley — deterministic, zero-dependency in-process `.docx` OOXML exporter (Spec 03 §8).
 *
 * Uses only `node:zlib` (raw Deflate + CRC-32) so `lib/galley-core.mjs` and
 * `lib/index.js` ship zero transitive npm dependencies (`jszip`/`docx` trees),
 * work inside npm tarballs and Electron `.asar` bundles alike, and produce
 * byte-identical `.docx` SHA-256 hashes for any fixed packet revision.
 */
import { crc32 as nodeCrc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { getGalleyStrings } from '../shared/i18n.ts'
import type {
  AssetMeta,
  Block,
  BlockId,
  GalleyLocale,
  GalleyPacket,
  GalleySheet,
  Inline,
} from '../shared/types.ts'

// ── Constants & unit conversions ────────────────────────────────────────────

const TWIPS_PER_PT = 20
const TWIPS_PER_CM = 566.9291338582677 // 1440 / 2.54
const EMU_PER_CM = 360_000
const EMU_PER_PT = 12_700

/** Paper sizes in twips (1/20 pt). */
const PAPER_TWIPS: Record<'a4' | 'letter', { w: number; h: number }> = {
  a4: { w: 11_906, h: 16_838 }, // 210 × 297 mm
  letter: { w: 12_240, h: 15_840 }, // 8.5 × 11 in
}

const CALLOUT_HEX: Record<'info' | 'hint' | 'warning', { fill: string; accent: string }> = {
  info: { fill: 'E8F0FE', accent: '1A73E8' },
  hint: { fill: 'E6F4EA', accent: '188038' },
  warning: { fill: 'FCE8E6', accent: 'D93025' },
}

// Fixed MS-DOS timestamp (1980-01-01 00:00:00) for byte-deterministic ZIP headers.
const FIXED_DOS_TIME = 0x0000
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1 // 0x0021

// ── XML & image helpers ─────────────────────────────────────────────────────

/** Total XML 1.0 escape: strips illegal control chars and escapes the 5 XML entities. */
export function escapeXml(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function cmToTwips(cm: number): number {
  return Math.max(0, Math.round(cm * TWIPS_PER_CM))
}

function parseIsoTimestamp(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) {
    return raw.endsWith('Z') ? raw : `${raw.replace(/\.\d+$/, '')}Z`
  }
  return '2026-01-01T00:00:00Z'
}

/** Inspect PNG / JPEG / GIF headers for intrinsic pixel dimensions (fallback 400×300). */
export function probeImageDimensions(bytes: Buffer): { widthPx: number; heightPx: number } {
  // PNG: 8-byte signature + IHDR chunk (width @ 16, height @ 20, big-endian uint32)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const widthPx = bytes.readUInt32BE(16)
    const heightPx = bytes.readUInt32BE(20)
    if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx }
  }
  // GIF87a / GIF89a: width @ 6, height @ 8 (little-endian uint16)
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    const widthPx = bytes.readUInt16LE(6)
    const heightPx = bytes.readUInt16LE(8)
    if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx }
  }
  // JPEG: scan SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 markers
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2
    while (off + 8 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++
        continue
      }
      const marker = bytes[off + 1]
      if (marker === 0xff) {
        off++
        continue
      }
      if (marker === 0xd9 || marker === 0xda) break
      const segLen = bytes.readUInt16BE(off + 2)
      if (segLen < 2 || off + 2 + segLen > bytes.length) break
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof && segLen >= 7) {
        const heightPx = bytes.readUInt16BE(off + 5)
        const widthPx = bytes.readUInt16BE(off + 7)
        if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx }
      }
      off += 2 + segLen
    }
  }
  return { widthPx: 400, heightPx: 300 }
}

function extFromAsset(meta: AssetMeta | undefined): { ext: string; mime: string } {
  const mime = (meta?.mimeType ?? '').toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/jpg') return { ext: 'jpg', mime: 'image/jpeg' }
  if (mime === 'image/gif') return { ext: 'gif', mime: 'image/gif' }
  if (mime === 'image/webp') return { ext: 'webp', mime: 'image/webp' }
  if (mime === 'image/svg+xml') return { ext: 'svg', mime: 'image/svg+xml' }
  const p = (meta?.path ?? '').toLowerCase()
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return { ext: 'jpg', mime: 'image/jpeg' }
  if (p.endsWith('.gif')) return { ext: 'gif', mime: 'image/gif' }
  if (p.endsWith('.webp')) return { ext: 'webp', mime: 'image/webp' }
  if (p.endsWith('.svg')) return { ext: 'svg', mime: 'image/svg+xml' }
  return { ext: 'png', mime: 'image/png' }
}

// ── Deterministic ZIP writer & reader (PKZIP 2.0, UTF-8, fixed timestamp) ──

let crcTable: Uint32Array | null = null
function computeCrc32(buf: Buffer): number {
  if (typeof nodeCrc32 === 'function') {
    return nodeCrc32(buf) >>> 0
  }
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  name: string
  data: Buffer
  storeOnly?: boolean
}

export function buildDeterministicZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const crc = computeCrc32(raw)
    const compressed = entry.storeOnly ? raw : deflateRawSync(raw, { level: 9 })
    const useStore = entry.storeOnly || compressed.length >= raw.length
    const payload = useStore ? raw : compressed
    const method = useStore ? 0 : 8 // 0 = STORE, 8 = DEFLATE

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // signature
    lfh.writeUInt16LE(20, 4) // version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6) // flags: bit 11 = UTF-8 filename
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(FIXED_DOS_TIME, 10)
    lfh.writeUInt16LE(FIXED_DOS_DATE, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(payload.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra length

    localParts.push(lfh, nameBuf, payload)

    // Central directory header (46 bytes + filename)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0) // signature
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0x0800, 8) // UTF-8
    cdh.writeUInt16LE(method, 10)
    cdh.writeUInt16LE(FIXED_DOS_TIME, 12)
    cdh.writeUInt16LE(FIXED_DOS_DATE, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(payload.length, 20)
    cdh.writeUInt32LE(raw.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30) // extra length
    cdh.writeUInt16LE(0, 32) // comment length
    cdh.writeUInt16LE(0, 34) // disk number
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(0, 38) // external attrs
    cdh.writeUInt32LE(offset, 42) // relative offset of local header

    centralParts.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + payload.length
  }

  const cdBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, cdBuf, eocd])
}

/** Hermetic `.docx` / ZIP reader for tests & verification (supports STORE + DEFLATE). */
export function unpackDocxEntries(zip: Buffer): Record<string, Buffer> {
  // Locate End of Central Directory (scan backwards from end)
  let eocdOff = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i
      break
    }
  }
  if (eocdOff < 0) throw new Error('invalid zip: EOCD signature not found')
  const count = zip.readUInt16LE(eocdOff + 10)
  let cdOff = zip.readUInt32LE(eocdOff + 16)
  const out: Record<string, Buffer> = {}

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cdOff) !== 0x02014b50) {
      throw new Error(`invalid zip: central directory signature mismatch at ${cdOff}`)
    }
    const method = zip.readUInt16LE(cdOff + 10)
    const compSize = zip.readUInt32LE(cdOff + 20)
    const nameLen = zip.readUInt16LE(cdOff + 28)
    const extraLen = zip.readUInt16LE(cdOff + 30)
    const commentLen = zip.readUInt16LE(cdOff + 32)
    const lfhOff = zip.readUInt32LE(cdOff + 42)
    const name = zip.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('utf8')

    const lfhNameLen = zip.readUInt16LE(lfhOff + 26)
    const lfhExtraLen = zip.readUInt16LE(lfhOff + 28)
    const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen
    const slice = zip.subarray(dataStart, dataStart + compSize)
    out[name] = method === 0 ? Buffer.from(slice) : method === 8 ? inflateRawSync(slice) : Buffer.alloc(0)

    cdOff += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// ── Inline AST → OOXML runs ─────────────────────────────────────────────────

interface RunStyle {
  bold?: boolean
  italic?: boolean
  code?: boolean
  underline?: boolean
  colorHex?: string
  sizeHalfPt?: number
}

function renderRunProps(st: RunStyle): string {
  const tags: string[] = []
  if (st.code) {
    tags.push('<w:rStyle w:val="CodeChar"/>')
    tags.push('<w:rFonts w:ascii="Liberation Mono" w:hAnsi="Liberation Mono" w:cs="Liberation Mono"/>')
  }
  if (st.bold) tags.push('<w:b/><w:bCs/>')
  if (st.italic) tags.push('<w:i/><w:iCs/>')
  if (st.underline) tags.push('<w:u w:val="single"/>')
  if (st.colorHex) tags.push(`<w:color w:val="${st.colorHex}"/>`)
  if (st.sizeHalfPt) tags.push(`<w:sz w:val="${st.sizeHalfPt}"/><w:szCs w:val="${st.sizeHalfPt}"/>`)
  return tags.length > 0 ? `<w:rPr>${tags.join('')}</w:rPr>` : ''
}

function renderTextRun(text: string, st: RunStyle = {}): string {
  const rPr = renderRunProps(st)
  const lines = text.split('\n')
  const inner: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) inner.push('<w:br/>')
    if (lines[i].length > 0) {
      inner.push(`<w:t xml:space="preserve">${escapeXml(lines[i])}</w:t>`)
    }
  }
  if (inner.length === 0) return ''
  return `<w:r>${rPr}${inner.join('')}</w:r>`
}

function inlineToOoxml(inlines: Inline[], inherited: RunStyle = {}): string {
  const out: string[] = []
  for (const node of inlines) {
    switch (node.t) {
      case 'text':
        out.push(renderTextRun(node.v, inherited))
        break
      case 'strong':
        out.push(inlineToOoxml(node.c, { ...inherited, bold: true }))
        break
      case 'emph':
        out.push(inlineToOoxml(node.c, { ...inherited, italic: true }))
        break
      case 'code':
        out.push(renderTextRun(node.v, { ...inherited, code: true, sizeHalfPt: inherited.sizeHalfPt ?? 19 }))
        break
      case 'cloze': {
        // Non-breaking spaces ensure Word renders the underline across the blank gap.
        const width = Math.max(6, (node.hint ?? '').length + 4)
        out.push(renderTextRun('\u00A0'.repeat(width), { ...inherited, underline: true }))
        break
      }
      case 'math': {
        const expr = node.v.trim()
        if (expr.length > 0) {
          out.push(`<m:oMath><m:r><m:t xml:space="preserve">${escapeXml(expr)}</m:t></m:r></m:oMath>`)
        }
        break
      }
      case 'newline':
        out.push(`<w:r>${renderRunProps(inherited)}<w:br/></w:r>`)
        break
      default:
        break
    }
  }
  return out.join('')
}

function inlineCharLen(inlines: Inline[]): number {
  let n = 0
  for (const it of inlines) {
    if (it.t === 'text' || it.t === 'code' || it.t === 'math') n += it.v.length
    else if (it.t === 'strong' || it.t === 'emph') n += inlineCharLen(it.c)
    else if (it.t === 'cloze') n += Math.max(6, (it.hint ?? '').length + 4)
    else if (it.t === 'newline') n += 1
  }
  return n
}

/** Deterministic two-column split at the whitespace boundary nearest 50% length (Spec 03 §5.4). */
export function splitInlinesTwoColumn(inlines: Inline[]): [Inline[], Inline[]] | null {
  const total = inlineCharLen(inlines)
  if (total < 16) return null

  // Flatten top-level text boundaries if single text node, or split across top-level nodes.
  if (inlines.length === 1 && inlines[0].t === 'text') {
    const s = inlines[0].v
    const mid = Math.floor(s.length / 2)
    let best = -1
    let bestDist = Infinity
    for (let i = 8; i <= s.length - 8; i++) {
      if (/\s/.test(s[i])) {
        const d = Math.abs(i - mid)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
    }
    if (best < 0) return null
    return [[{ t: 'text', v: s.slice(0, best).trimEnd() }], [{ t: 'text', v: s.slice(best + 1).trimStart() }]]
  }

  // Multi-node inline array: expand top-level text whitespace tokens so we can split cleanly.
  const tokens: Inline[] = []
  for (const it of inlines) {
    if (it.t === 'text') {
      const parts = it.v.match(/\S+\s*|\s+/g) ?? [it.v]
      for (const p of parts) tokens.push({ t: 'text', v: p })
    } else {
      tokens.push(it)
    }
  }
  const mid = total / 2
  let acc = 0
  let splitIdx = -1
  let bestDist = Infinity
  for (let i = 0; i < tokens.length - 1; i++) {
    acc += inlineCharLen([tokens[i]])
    if (acc >= 8 && total - acc >= 8) {
      const d = Math.abs(acc - mid)
      if (d < bestDist) {
        bestDist = d
        splitIdx = i + 1
      }
    }
  }
  if (splitIdx <= 0) return null
  return [tokens.slice(0, splitIdx), tokens.slice(splitIdx)]
}

/** Split block body into discrete card cell inline arrays (matches `cardCellsFromBlock` in `src/typst/index.ts`). */
function cardInlineCells(block: Block): Inline[][] {
  const body = (block as { body?: Inline[] }).body
  if (!body || body.length === 0) return [[]]
  const hasLineBreaks = body.some((it) => it.t === 'newline' || (it.t === 'text' && it.v.includes('\n')))
  if (hasLineBreaks) {
    const groups: Inline[][] = []
    let cur: Inline[] = []
    for (const it of body) {
      if (it.t === 'newline') {
        groups.push(cur)
        cur = []
      } else if (it.t === 'text' && it.v.includes('\n')) {
        const parts = it.v.split('\n')
        parts.forEach((p, idx) => {
          if (idx > 0) {
            groups.push(cur)
            cur = []
          }
          if (p.length > 0) cur.push({ t: 'text', v: p })
        })
      } else {
        cur.push(it)
      }
    }
    groups.push(cur)
    const nonEmpty = groups.filter((g) => g.length > 0)
    if (nonEmpty.length > 0) return nonEmpty
  }
  if (body.length > 1) return body.map((it) => [it])
  return [body]
}

// ── Table border & column width helpers ─────────────────────────────────────

const BORDERLESS_TBL_PR =
  '<w:tblBorders>' +
  '<w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '</w:tblBorders>'

function singleBordersXml(colorHex: string, szEighthsPt = 4): string {
  return (
    '<w:tblBorders>' +
    `<w:top w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    `<w:left w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    `<w:bottom w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    `<w:right w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    `<w:insideH w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    `<w:insideV w:val="single" w:sz="${szEighthsPt}" w:space="0" w:color="${colorHex}"/>` +
    '</w:tblBorders>'
  )
}

function computeColTwips(
  colCount: number,
  totalTwips: number,
  colWidths?: (string | number)[],
): number[] {
  if (!colWidths || colWidths.length === 0) {
    const base = Math.floor(totalTwips / colCount)
    return Array.from({ length: colCount }, (_, i) =>
      i === colCount - 1 ? totalTwips - base * (colCount - 1) : base,
    )
  }
  const fixed: (number | null)[] = []
  const flexWeights: number[] = []
  let fixedSum = 0
  let flexSum = 0

  for (let i = 0; i < colCount; i++) {
    const spec = colWidths[i]
    if (typeof spec === 'number' && Number.isFinite(spec) && spec > 0) {
      fixed.push(null)
      flexWeights.push(spec)
      flexSum += spec
    } else if (typeof spec === 'string') {
      const s = spec.trim()
      const pct = s.match(/^(\d+(?:\.\d+)?)%$/)
      const fr = s.match(/^(\d+(?:\.\d+)?)fr$/)
      const cm = s.match(/^(\d+(?:\.\d+)?)cm$/)
      const mm = s.match(/^(\d+(?:\.\d+)?)mm$/)
      const pt = s.match(/^(\d+(?:\.\d+)?)pt$/)
      if (pct) {
        const w = Math.round((Number(pct[1]) / 100) * totalTwips)
        fixed.push(w)
        flexWeights.push(0)
        fixedSum += w
      } else if (cm) {
        const w = cmToTwips(Number(cm[1]))
        fixed.push(w)
        flexWeights.push(0)
        fixedSum += w
      } else if (mm) {
        const w = cmToTwips(Number(mm[1]) / 10)
        fixed.push(w)
        flexWeights.push(0)
        fixedSum += w
      } else if (pt) {
        const w = Math.round(Number(pt[1]) * TWIPS_PER_PT)
        fixed.push(w)
        flexWeights.push(0)
        fixedSum += w
      } else if (fr) {
        const val = Math.max(0.1, Number(fr[1]))
        fixed.push(null)
        flexWeights.push(val)
        flexSum += val
      } else {
        fixed.push(null)
        flexWeights.push(1)
        flexSum += 1
      }
    } else {
      fixed.push(null)
      flexWeights.push(1)
      flexSum += 1
    }
  }

  const remaining = Math.max(colCount * 240, totalTwips - fixedSum)
  const out = fixed.map((f, i) => {
    if (f !== null) return Math.max(240, f)
    const share = flexSum > 0 ? flexWeights[i] / flexSum : 1 / colCount
    return Math.max(240, Math.round(remaining * share))
  })
  // Normalize rounding drift so columns sum to totalTwips when within 5%.
  const sum = out.reduce((a, b) => a + b, 0)
  if (sum > 0 && Math.abs(sum - totalTwips) > 0) {
    const scale = totalTwips / sum
    let acc = 0
    for (let i = 0; i < out.length; i++) {
      if (i === out.length - 1) {
        out[i] = Math.max(240, totalTwips - acc)
      } else {
        out[i] = Math.max(240, Math.round(out[i] * scale))
        acc += out[i]
      }
    }
  }
  return out
}

// ── Block & Sheet → OOXML document builder ──────────────────────────────────

interface MediaEmbed {
  relId: string
  zipPath: string
  ext: string
  mime: string
  bytes: Buffer
  docPrId: number
}

interface SheetBuildContext {
  packet: GalleyPacket
  sheet: GalleySheet
  locale: GalleyLocale
  contentWidthTwips: number
  assetBytes: Record<string, Buffer>
  mediaByAssetId: Map<string, MediaEmbed>
  mediaList: MediaEmbed[]
  nextDocPrId: number
  taskIndexByBlockId: Map<BlockId, number>
}

function registerOrGetMedia(ctx: SheetBuildContext, assetId: string): MediaEmbed | null {
  const existing = ctx.mediaByAssetId.get(assetId)
  if (existing) return existing
  const bytes = ctx.assetBytes[assetId]
  if (!bytes || bytes.length === 0) return null
  const meta = ctx.packet.assets?.[assetId]
  const { ext, mime } = extFromAsset(meta)
  const idx = ctx.mediaList.length + 1
  const embed: MediaEmbed = {
    relId: `rIdImg${idx}`,
    zipPath: `word/media/${assetId}.${ext}`,
    ext,
    mime,
    bytes,
    docPrId: ctx.nextDocPrId++,
  }
  ctx.mediaByAssetId.set(assetId, embed)
  ctx.mediaList.push(embed)
  return embed
}

function renderMediaParagraphXml(
  ctx: SheetBuildContext,
  assetId: string,
  alt: string,
  maxWidthTwips: number,
  explicitWidthCm?: number,
): string {
  const embed = registerOrGetMedia(ctx, assetId)
  if (!embed) {
    return `<w:p><w:r>${renderRunProps({ italic: true, colorHex: '666666' })}<w:t xml:space="preserve">${escapeXml(`[Image: ${alt || assetId}]`)}</w:t></w:r></w:p>`
  }
  const { widthPx, heightPx } = probeImageDimensions(embed.bytes)
  const maxWidthEmu = Math.round((maxWidthTwips / TWIPS_PER_PT) * EMU_PER_PT)
  const desiredWidthEmu =
    explicitWidthCm && Number.isFinite(explicitWidthCm) && explicitWidthCm > 0
      ? Math.min(maxWidthEmu, Math.round(explicitWidthCm * EMU_PER_CM))
      : maxWidthEmu
  const cx = Math.max(91_440, desiredWidthEmu)
  const cy = Math.max(91_440, Math.round(cx * (heightPx / Math.max(1, widthPx))))
  const docPrId = ctx.nextDocPrId++
  const safeAlt = escapeXml(alt || assetId)
  const safeName = escapeXml(`${assetId}.${embed.ext}`)

  return (
    '<w:p><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${docPrId}" name="${safeName}" descr="${safeAlt}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr>' +
    `<pic:cNvPr id="${docPrId}" name="${safeName}" descr="${safeAlt}"/>` +
    '<pic:cNvPicPr/>' +
    '</pic:nvPicPr>' +
    '<pic:blipFill>' +
    `<a:blip r:embed="${embed.relId}"/>` +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</pic:blipFill>' +
    '<pic:spPr>' +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing></w:r></w:p>'
  )
}

/** Ensure every `<w:tc>` ends with a `<w:p>` (strict OOXML table cell requirement). */
function wrapTableCell(widthTwips: number, innerXml: string, extraTcPr = ''): string {
  const body = innerXml.trim().endsWith('</w:p>') ? innerXml : `${innerXml}<w:p/>`
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${extraTcPr}</w:tcPr>${body}</w:tc>`
}

function renderBlockCoreXml(ctx: SheetBuildContext, block: Block, availTwips: number): string {
  const isDe = ctx.locale === 'de'
  const pStr = getGalleyStrings(ctx.locale).print

  switch (block.type) {
    case 'header': {
      // Spec 03 §8: 2-column borderless table (4 cm label col), `name` value underlined.
      const f = block.fields ?? { titel: '' }
      const labelColW = Math.min(cmToTwips(4), Math.round(availTwips * 0.4))
      const valColW = Math.max(400, availTwips - labelColW)
      const rowsXml: string[] = []

      const metaRows: Array<{ label: string; value: string; underlineValue?: boolean }> = []
      if (f.fach) metaRows.push({ label: isDe ? 'Fach' : 'Subject', value: f.fach })
      if (f.klasse) {
        const cleanVal = f.klasse.replace(/^(?:Group|Klasse)\s*:\s*/i, '')
        metaRows.push({ label: isDe ? 'Klasse' : 'Group', value: cleanVal })
      }
      if (f.datum) metaRows.push({ label: isDe ? 'Datum' : 'Date', value: f.datum })
      if (f.name !== undefined) {
        const hasVal = f.name.trim().length > 0
        metaRows.push({
          label: 'Name',
          value: hasVal ? f.name : '\u00A0'.repeat(28),
          underlineValue: true,
        })
      }

      for (const row of metaRows) {
        const lblCell = wrapTableCell(
          labelColW,
          `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${renderTextRun(row.label, { bold: true, colorHex: '555555', sizeHalfPt: 18 })}</w:p>`,
        )
        const valCell = wrapTableCell(
          valColW,
          `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${renderTextRun(row.value, { underline: row.underlineValue, sizeHalfPt: 19 })}</w:p>`,
        )
        rowsXml.push(`<w:tr>${lblCell}${valCell}</w:tr>`)
      }

      // Emit title (+ optional subtitle) banner above the borderless 2-col metadata table.
      const parts: string[] = []
      if (f.titel || f.subtitle) {
        const hasSub = Boolean(f.subtitle && f.subtitle.trim().length > 0)
        if (f.titel) {
          const bdrXml = !hasSub
            ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="AAAAAA"/></w:pBdr>'
            : ''
          parts.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="${hasSub ? 20 : 80}"/>${bdrXml}</w:pPr>${renderTextRun(f.titel, { bold: true, sizeHalfPt: 32 })}</w:p>`,
          )
        }
        if (hasSub) {
          parts.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="AAAAAA"/></w:pBdr></w:pPr>${renderTextRun(f.subtitle!, { colorHex: '555555', sizeHalfPt: 21 })}</w:p>`,
          )
        }
      }
      if (rowsXml.length > 0) {
        parts.push(
          '<w:tbl>' +
            `<w:tblPr><w:tblW w:w="${availTwips}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="30" w:type="dxa"/><w:bottom w:w="30" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
            `<w:tblGrid><w:gridCol w:w="${labelColW}"/><w:gridCol w:w="${valColW}"/></w:tblGrid>` +
            rowsXml.join('') +
            '</w:tbl>',
        )
      }
      return parts.join('')
    }

    case 'heading': {
      const level = Math.max(1, Math.min(3, block.level ?? 1))
      return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${inlineToOoxml(block.body)}</w:p>`
    }

    case 'prose':
      return `<w:p>${inlineToOoxml(block.body)}</w:p>`

    case 'source_text': {
      const parts: string[] = []
      if (block.title) {
        parts.push(
          `<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr>${renderTextRun(block.title, { bold: true })}</w:p>`,
        )
      }
      parts.push(`<w:p>${inlineToOoxml(block.body)}</w:p>`)
      return parts.join('')
    }

    case 'task': {
      const firstNode = block.body?.[0]
      const leadingText =
        firstNode?.t === 'text'
          ? firstNode.v
          : firstNode?.t === 'strong' && firstNode.c?.[0]?.t === 'text'
            ? firstNode.c[0].v
            : ''
      const alreadyNumbered = /^\s*(?:Task|Problem|Question|Exercise|Aufgabe)\s+\d+\b/i.test(leadingText)
      if (alreadyNumbered) {
        return `<w:p>${inlineToOoxml(block.body)}</w:p>`
      }
      return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${inlineToOoxml(block.body)}</w:p>`
    }

    case 'table': {
      const cols = Math.max(1, block.headers.length, ...block.rows.map((r) => r.length))
      const colTwips = computeColTwips(cols, availTwips, block.colWidths)
      const gridXml = `<w:tblGrid>${colTwips.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`

      const hdrCells: string[] = []
      for (let ci = 0; ci < cols; ci++) {
        const cellInlines = block.headers[ci] ?? []
        const cellRuns = inlineToOoxml(cellInlines, { bold: true })
        hdrCells.push(
          wrapTableCell(
            colTwips[ci],
            `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${cellRuns}</w:p>`,
            '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>',
          ),
        )
      }
      const headerRowXml = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${hdrCells.join('')}</w:tr>`

      const bodyRowsXml = block.rows.map((row) => {
        const rowCells: string[] = []
        for (let ci = 0; ci < cols; ci++) {
          const cellInlines = row[ci] ?? []
          rowCells.push(
            wrapTableCell(
              colTwips[ci],
              `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${inlineToOoxml(cellInlines)}</w:p>`,
            ),
          )
        }
        return `<w:tr>${rowCells.join('')}</w:tr>`
      })

      return (
        '<w:tbl>' +
        `<w:tblPr><w:tblW w:w="${availTwips}" w:type="dxa"/>${singleBordersXml('B4B4B4', 4)}<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        gridXml +
        headerRowXml +
        bodyRowsXml.join('') +
        '</w:tbl>'
      )
    }

    case 'callout': {
      // Spec 03 §8: paragraph with 3pt left border (`w:sz="24"` eighths of a pt) + light tone shading.
      const tone = block.tone ?? 'info'
      const colors = CALLOUT_HEX[tone]
      const label = pStr.calloutLabels[tone] ?? tone
      return (
        '<w:p>' +
        '<w:pPr>' +
        `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${colors.accent}"/></w:pBdr>` +
        `<w:shd w:val="clear" w:color="auto" w:fill="${colors.fill}"/>` +
        '<w:ind w:left="160" w:right="160"/>' +
        '<w:spacing w:before="100" w:after="100"/>' +
        '</w:pPr>' +
        renderTextRun(label, { bold: true, colorHex: colors.accent, sizeHalfPt: 18 }) +
        '<w:r><w:br/></w:r>' +
        inlineToOoxml(block.body) +
        '</w:p>'
      )
    }

    case 'answer': {
      // Spec 03 §8: prefix with task reference when `dependsOn` is non-empty.
      const firstNode = block.body?.[0]
      const leadingText =
        firstNode?.t === 'text'
          ? firstNode.v
          : firstNode?.t === 'strong' && firstNode.c?.[0]?.t === 'text'
            ? firstNode.c[0].v
            : ''
      const alreadyPrefixed = /^\s*(?:Answer|Solution|Lösung)\b/i.test(leadingText)
      let prefixXml = ''
      if (!alreadyPrefixed && block.dependsOn && block.dependsOn.length > 0) {
        const originId = block.dependsOn[0].id
        const taskNum = ctx.taskIndexByBlockId.get(originId)
        const label = isDe
          ? taskNum
            ? `Lösung (${pStr.taskPrefix} ${taskNum}): `
            : 'Lösung: '
          : taskNum
            ? `Answer (${pStr.taskPrefix} ${taskNum}): `
            : 'Answer: '
        prefixXml = renderTextRun(label, { bold: true })
      }
      return `<w:p>${prefixXml}${inlineToOoxml(block.body)}</w:p>`
    }
  }
}

function renderBlockWithSlotXml(ctx: SheetBuildContext, block: Block): string {
  const slot = block.slot ?? { mode: 'full' }
  const totalW = ctx.contentWidthTwips

  switch (slot.mode) {
    case 'media-right':
    case 'media-left': {
      const gutterTwips = 160
      const mediaW = Math.round((totalW - gutterTwips) * 0.35)
      const textW = totalW - mediaW
      const bodyXml = renderBlockCoreXml(ctx, block, textW - 120)
      const imgXml = slot.asset
        ? renderMediaParagraphXml(ctx, slot.asset.id, slot.asset.alt, mediaW - 120, slot.asset.widthCm)
        : '<w:p/>'
      const leftCell =
        slot.mode === 'media-left' ? wrapTableCell(mediaW, imgXml) : wrapTableCell(textW, bodyXml)
      const rightCell =
        slot.mode === 'media-left' ? wrapTableCell(textW, bodyXml) : wrapTableCell(mediaW, imgXml)
      const col1W = slot.mode === 'media-left' ? mediaW : textW
      const col2W = slot.mode === 'media-left' ? textW : mediaW
      return (
        '<w:tbl>' +
        `<w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        `<w:tblGrid><w:gridCol w:w="${col1W}"/><w:gridCol w:w="${col2W}"/></w:tblGrid>` +
        `<w:tr>${leftCell}${rightCell}</w:tr>` +
        '</w:tbl>'
      )
    }

    case 'two-column': {
      const body = (block as { body?: Inline[] }).body
      const split = body ? splitInlinesTwoColumn(body) : null
      if (!split) {
        return renderBlockCoreXml(ctx, block, totalW)
      }
      const col1W = Math.floor(totalW / 2)
      const col2W = totalW - col1W
      const c1 = wrapTableCell(col1W, `<w:p>${inlineToOoxml(split[0])}</w:p>`)
      const c2 = wrapTableCell(col2W, `<w:p>${inlineToOoxml(split[1])}</w:p>`)
      return (
        '<w:tbl>' +
        `<w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${BORDERLESS_TBL_PR}<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        `<w:tblGrid><w:gridCol w:w="${col1W}"/><w:gridCol w:w="${col2W}"/></w:tblGrid>` +
        `<w:tr>${c1}${c2}</w:tr>` +
        '</w:tbl>'
      )
    }

    case 'card-grid': {
      const cols = slot.columns ?? 3
      const heightTwips = cmToTwips(slot.cardHeightCm ?? 6)
      const colWidths = computeColTwips(cols, totalW)
      const cells = cardInlineCells(block)
      const rowsXml: string[] = []
      for (let r = 0; r < cells.length; r += cols) {
        const rowTcs: string[] = []
        for (let c = 0; c < cols; c++) {
          const item = cells[r + c]
          const pXml = item ? `<w:p>${inlineToOoxml(item)}</w:p>` : '<w:p/>'
          rowTcs.push(
            wrapTableCell(
              colWidths[c],
              pXml,
              '<w:shd w:val="clear" w:color="auto" w:fill="FBFBFB"/>',
            ),
          )
        }
        rowsXml.push(
          `<w:tr><w:trPr><w:trHeight w:val="${heightTwips}" w:hRule="atLeast"/></w:trPr>${rowTcs.join('')}</w:tr>`,
        )
      }
      return (
        '<w:tbl>' +
        `<w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${singleBordersXml('828282', 4)}<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        `<w:tblGrid>${colWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
        rowsXml.join('') +
        '</w:tbl>'
      )
    }

    default:
      return renderBlockCoreXml(ctx, block, totalW)
  }
}

// ── Static & metadata OOXML part generators ─────────────────────────────────

function buildContentTypesXml(mediaExts: Map<string, string>): string {
  const defaults: string[] = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ]
  const sortedExts = [...mediaExts.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [ext, mime] of sortedExts) {
    defaults.push(`<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(mime)}"/>`)
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults.join('') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
    '</Types>'
  )
}

function buildRootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>' +
    '</Relationships>'
  )
}

function buildDocumentRelsXml(mediaList: MediaEmbed[]): string {
  const rels: string[] = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ]
  for (const m of mediaList) {
    const relTarget = m.zipPath.replace(/^word\//, '')
    rels.push(
      `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(relTarget)}"/>`,
    )
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') +
    '</Relationships>'
  )
}

function buildStylesXml(locale: GalleyLocale): string {
  const langTag = locale === 'de' ? 'de-DE' : 'en-US'
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    '<w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans" w:cs="Liberation Sans"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/>' +
    `<w:lang w:val="${langTag}"/>` +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
    '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3">' +
    '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="character" w:styleId="CodeChar">' +
    '<w:name w:val="CodeChar"/>' +
    '<w:rPr><w:rFonts w:ascii="Liberation Mono" w:hAnsi="Liberation Mono" w:cs="Liberation Mono"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>' +
    '</w:style>' +
    '</w:styles>'
  )
}

function buildNumberingXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="1">' +
    '<w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0">' +
    '<w:start w:val="1"/>' +
    '<w:numFmt w:val="decimal"/>' +
    '<w:lvlText w:val="%1."/>' +
    '<w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/></w:rPr>' +
    '</w:lvl>' +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  )
}

function buildCorePropsXml(sheet: GalleySheet, packet: GalleyPacket, agentBlockIds: BlockId[]): string {
  const created = parseIsoTimestamp(packet.createdAt)
  const modified = parseIsoTimestamp(packet.updatedAt)
  const blockList = agentBlockIds.length > 0 ? agentBlockIds.join(', ') : 'none'
  const comments = `Co-authored with DeepSeek Harness (dsh-galley); AI-assisted blocks: ${blockList}`
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties ' +
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(sheet.title)}</dc:title>` +
    '<dc:creator>dsh-galley</dc:creator>' +
    `<dc:description>${escapeXml(comments)}</dc:description>` +
    '<cp:lastModifiedBy>dsh-galley</cp:lastModifiedBy>' +
    `<cp:revision>${Math.max(1, packet.rev)}</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(modified)}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

function buildAppPropsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>DeepSeek Harness (dsh-galley)</Application>' +
    '</Properties>'
  )
}

function buildCustomPropsXml(agentBlockIds: BlockId[], packetId: string): string {
  const fmtid = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'
  const blockList = agentBlockIds.length > 0 ? agentBlockIds.join(', ') : 'none'
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties ' +
    'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<property fmtid="${fmtid}" pid="2" name="AIAssistance"><vt:bool>true</vt:bool></property>` +
    `<property fmtid="${fmtid}" pid="3" name="AIAssistedBlocks"><vt:lpwstr>${escapeXml(blockList)}</vt:lpwstr></property>` +
    `<property fmtid="${fmtid}" pid="4" name="GalleyPacketId"><vt:lpwstr>${escapeXml(packetId)}</vt:lpwstr></property>` +
    '</Properties>'
  )
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Compile one `GalleySheet` into a complete, byte-deterministic `.docx` Buffer.
 */
export function exportSheetDocx(
  sheet: GalleySheet,
  packet: GalleyPacket,
  assetBytes: Record<string, Buffer> = {},
): Buffer {
  const locale: GalleyLocale = packet.locale === 'de' ? 'de' : 'en'
  const geom = sheet.geometry
  const isLandscape = geom.orientation === 'landscape'
  const basePaper = PAPER_TWIPS[geom.paper] ?? PAPER_TWIPS.a4
  const pageW = isLandscape ? basePaper.h : basePaper.w
  const pageH = isLandscape ? basePaper.w : basePaper.h

  const marginTop = cmToTwips(geom.margin.top)
  const marginRight = cmToTwips(geom.margin.right)
  const marginBottom = cmToTwips(geom.margin.bottom)
  const marginLeft = cmToTwips(geom.margin.left)
  const contentWidthTwips = Math.max(2_880, pageW - marginLeft - marginRight)

  // Build cross-sheet task numbering lookup so `answer` blocks with `dependsOn`
  // resolve their exact origin task number (`Answer (Task 2):` / `Lösung (Aufgabe 2):`).
  const taskIndexByBlockId = new Map<BlockId, number>()
  for (const sid of packet.sheetOrder) {
    const sh = packet.sheets[sid]
    if (!sh) continue
    let n = 0
    for (const b of sh.blocks) {
      if (b.type === 'task') {
        n += 1
        taskIndexByBlockId.set(b.id, n)
      }
    }
  }

  const ctx: SheetBuildContext = {
    packet,
    sheet,
    locale,
    contentWidthTwips,
    assetBytes,
    mediaByAssetId: new Map(),
    mediaList: [],
    nextDocPrId: 1,
    taskIndexByBlockId,
  }

  const bodyParts: string[] = []
  const firstBlk = sheet.blocks[0]
  const hasOwnBanner =
    sheet.blocks.some((b) => b.type === 'header') ||
    (firstBlk?.type === 'heading' && (firstBlk.level ?? 1) === 1)
  if (!hasOwnBanner && sheet.title.trim().length > 0) {
    bodyParts.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${renderTextRun(sheet.title)}</w:p>`,
    )
  }

  let sectionLineNumbers: { every: number; start?: number } | undefined
  for (const block of sheet.blocks) {
    if (block.type === 'source_text' && block.lineNumbers && !sectionLineNumbers) {
      sectionLineNumbers = block.lineNumbers
    }
    const xml = renderBlockWithSlotXml(ctx, block)
    if (xml) bodyParts.push(xml)
    // Word requires a paragraph between adjacent top-level tables so they don't merge.
    if (xml.endsWith('</w:tbl>')) {
      bodyParts.push('<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr></w:p>')
    }
  }

  if (bodyParts.length === 0) {
    bodyParts.push('<w:p/>')
  }

  const lnNumXml = sectionLineNumbers
    ? `<w:lnNumType w:countBy="${Math.max(1, sectionLineNumbers.every)}" w:start="${Math.max(1, sectionLineNumbers.start ?? 1)}" w:restart="newPage"/>`
    : ''
  const orientAttr = isLandscape ? ' w:orient="landscape"' : ''
  const sectPrXml =
    '<w:sectPr>' +
    `<w:pgSz w:w="${pageW}" w:h="${pageH}"${orientAttr}/>` +
    `<w:pgMar w:top="${marginTop}" w:right="${marginRight}" w:bottom="${marginBottom}" w:left="${marginLeft}" w:header="708" w:footer="708" w:gutter="0"/>` +
    lnNumXml +
    '</w:sectPr>'

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
    `<w:body>${bodyParts.join('')}${sectPrXml}</w:body>` +
    '</w:document>'

  const agentBlockIds = sheet.blocks.filter((b) => b.origin === 'agent').map((b) => b.id)
  const mediaExts = new Map<string, string>()
  for (const m of ctx.mediaList) mediaExts.set(m.ext, m.mime)

  const zipEntries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(buildContentTypesXml(mediaExts), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(buildRootRelsXml(), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(buildAppPropsXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(buildCorePropsXml(sheet, packet, agentBlockIds), 'utf8') },
    { name: 'docProps/custom.xml', data: Buffer.from(buildCustomPropsXml(agentBlockIds, packet.id), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(buildDocumentRelsXml(ctx.mediaList), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(buildNumberingXml(), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(buildStylesXml(locale), 'utf8') },
    ...ctx.mediaList.map((m) => ({ name: m.zipPath, data: m.bytes, storeOnly: true })),
  ]

  return buildDeterministicZip(zipEntries)
}
