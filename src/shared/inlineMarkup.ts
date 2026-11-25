/**
 * Lossless round-trip serializer & total parser between `Inline[]` (spec 01 §2)
 * and lightweight human-editable mini-markup for the rightbar block editor:
 *
 *   **strong**    <-> { t: 'strong', c: [...] }
 *   *emph*        <-> { t: 'emph',   c: [...] }
 *   `code`        <-> { t: 'code',   v: '...' }
 *   $math$        <-> { t: 'math',   v: '...' }
 *   {{hint}}      <-> { t: 'cloze',  hint: 'hint' }  ({{}} when hint omitted)
 *   \n            <-> { t: 'newline' }
 *   \* \` \$ \{ \\ <-> literal characters inside { t: 'text', v }
 *
 * Total parser: unmatched markers never throw — they remain literal text, and
 * nesting caps at depth 3 (spec 01 §2 MAX_INLINE_DEPTH).
 */
import type { Inline } from './types.ts'

const MAX_DEPTH = 3

function escapeText(v: string): string {
  return v.replace(/([\\*`${])/g, '\\$1')
}

export function serializeInlines(inlines: Inline[] | undefined): string {
  if (!inlines || inlines.length === 0) return ''
  return inlines
    .map((node) => {
      switch (node.t) {
        case 'text':
          return escapeText(node.v)
        case 'strong':
          return `**${serializeInlines(node.c)}**`
        case 'emph':
          return `*${serializeInlines(node.c)}*`
        case 'code':
          return '`' + node.v.replace(/`/g, '\\`') + '`'
        case 'math':
          return '$' + node.v.replace(/\$/g, '\\$') + '$'
        case 'cloze':
          return `{{${(node.hint ?? '').replace(/\}/g, '\\}')}}}`
        case 'newline':
          return '\n'
        default:
          return ''
      }
    })
    .join('')
}

function pushText(out: Inline[], text: string): void {
  if (!text) return
  const prev = out[out.length - 1]
  if (prev && prev.t === 'text') {
    prev.v += text
  } else {
    out.push({ t: 'text', v: text })
  }
}

/** Find the unescaped closing marker on the same line (does not cross `\n`). */
function findClosing(src: string, from: number, marker: string): number {
  let i = from
  while (i <= src.length - marker.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length) {
      i += 2
      continue
    }
    if (ch === '\n') return -1
    // Inside `**…**`, skip a nested `*…*` span so `**bold *emph***` closes `*emph*` first, then `**`.
    if (marker === '**' && ch === '*' && !src.startsWith('**', i)) {
      const innerEmph = findClosing(src, i + 1, '*')
      if (innerEmph >= 0) {
        i = innerEmph + 1
        continue
      }
    }
    if (src.startsWith(marker, i)) {
      // Single `*` must not match the first `*` of `**`
      if (marker === '*' && src.startsWith('**', i)) {
        const inner = findClosing(src, i + 2, '**')
        if (inner >= 0) {
          i = inner + 2
          continue
        }
      }
      return i
    }
    i += 1
  }
  return -1
}

function parseSegment(src: string, depth: number): Inline[] {
  const out: Inline[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (ch === '\r') {
      i += 1
      continue
    }

    if (ch === '\n') {
      out.push({ t: 'newline' })
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < src.length && src[i + 1] !== '\n' && src[i + 1] !== '\r') {
      pushText(out, src[i + 1])
      i += 2
      continue
    }

    // {{cloze}}
    if (src.startsWith('{{', i)) {
      const end = findClosing(src, i + 2, '}}')
      if (end >= 0) {
        const raw = src.slice(i + 2, end).replace(/\\\}/g, '}')
        out.push(raw ? { t: 'cloze', hint: raw } : { t: 'cloze' })
        i = end + 2
        continue
      }
    }

    // `code`
    if (ch === '`') {
      const end = findClosing(src, i + 1, '`')
      if (end > i + 1) {
        const raw = src.slice(i + 1, end).replace(/\\`/g, '`')
        out.push({ t: 'code', v: raw })
        i = end + 1
        continue
      }
    }

    // $math$
    if (ch === '$') {
      const end = findClosing(src, i + 1, '$')
      if (end > i + 1) {
        const raw = src.slice(i + 1, end).replace(/\\\$/g, '$')
        out.push({ t: 'math', v: raw })
        i = end + 1
        continue
      }
    }

    // **strong**
    if (depth < MAX_DEPTH && src.startsWith('**', i)) {
      const end = findClosing(src, i + 2, '**')
      if (end > i + 2) {
        out.push({ t: 'strong', c: parseSegment(src.slice(i + 2, end), depth + 1) })
        i = end + 2
        continue
      }
    }

    // *emph*
    if (depth < MAX_DEPTH && ch === '*' && !src.startsWith('**', i)) {
      const end = findClosing(src, i + 1, '*')
      if (end > i + 1) {
        out.push({ t: 'emph', c: parseSegment(src.slice(i + 1, end), depth + 1) })
        i = end + 1
        continue
      }
    }

    pushText(out, ch)
    i += 1
  }
  return out
}

export function parseInlines(input: string): Inline[] {
  if (!input) return [{ t: 'text', v: '' }]
  const parsed = parseSegment(input, 1)
  return parsed.length > 0 ? parsed : [{ t: 'text', v: '' }]
}
