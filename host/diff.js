/**
 * Pure word-level diff helpers for Composer Coach.
 *
 * The model returns only corrected prose; these helpers turn the difference
 * between the draft and that prose into word-granular edits, and apply an
 * accepted subset back onto a draft with stale detection.
 */

const TOKEN_RE = /[A-Za-z0-9_'\u2019]+|\s+|[^\sA-Za-z0-9_'\u2019]+/g
const CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g

/** Ranges of fenced and inline code in `text`, as [start, end) pairs. */
export function codeRanges(text) {
  const ranges = []
  CODE_RE.lastIndex = 0
  let match
  while ((match = CODE_RE.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

function overlaps(ranges, start, end) {
  return ranges.some(([from, to]) => start < to && end > from)
}

/** Split text into word, whitespace, and punctuation tokens with offsets. */
export function tokenize(text) {
  const tokens = []
  TOKEN_RE.lastIndex = 0
  let match
  while ((match = TOKEN_RE.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

function longestCommonTokens(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  // Bound the table; past this size fall back to common prefix/suffix only.
  if ((n + 1) * (m + 1) > 4_000_000) {
    const pairs = []
    let head = 0
    while (head < n && head < m && a[head].text === b[head].text) {
      pairs.push([head, head])
      head += 1
    }
    let tailA = n - 1
    let tailB = m - 1
    const tail = []
    while (tailA > head && tailB > head && a[tailA].text === b[tailB].text) {
      tail.unshift([tailA, tailB])
      tailA -= 1
      tailB -= 1
    }
    return pairs.concat(tail)
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i].text === b[j].text
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

function classify(original, replacement) {
  if (original.trim() === '' && replacement.trim() === '') return 'spacing'
  if (/^[A-Za-z0-9_'\u2019]+$/.test(original) || original === '') {
    if (/^[A-Za-z0-9_'\u2019]+$/.test(replacement) || replacement === '') return 'wording'
  }
  return 'phrase'
}

/**
 * Word-granular edits turning `original` into `corrected`.
 * Edits never overlap code fences or inline code, and are ordered by position.
 */
export function diffWords(original, corrected) {
  if (original === corrected) return []
  const code = codeRanges(original)
  const a = tokenize(original)
  const b = tokenize(corrected)
  const matches = longestCommonTokens(a, b)

  const hunks = []
  let ai = 0
  let bi = 0
  for (const [pa, pb] of matches.concat([[a.length, b.length]])) {
    if (pa > ai || pb > bi) hunks.push({ aStart: ai, aEnd: pa, bStart: bi, bEnd: pb })
    ai = pa + 1
    bi = pb + 1
  }

  // One edit per changed run: word-by-word granularity is the point, so runs are
  // never merged across intervening matched words.
  const edits = []
  for (const hunk of hunks) {
    const start = hunk.aStart < a.length ? a[hunk.aStart].start : original.length
    const end = hunk.aEnd > hunk.aStart ? a[hunk.aEnd - 1].end : start
    const bStartPos = hunk.bStart < b.length ? b[hunk.bStart].start : corrected.length
    const bEndPos = hunk.bEnd > hunk.bStart ? b[hunk.bEnd - 1].end : bStartPos
    const originalText = original.slice(start, end)
    const replacement = corrected.slice(bStartPos, bEndPos)
    if (originalText === replacement) continue
    if (overlaps(code, start, end)) continue
    edits.push({
      start,
      end,
      original: originalText,
      replacement,
      kind: classify(originalText, replacement),
    })
  }
  return edits
}

/** Edits whose recorded original no longer matches `text` at that range. */
export function staleEdits(text, edits) {
  return edits.filter(edit => (
    edit.start < 0
    || edit.end > text.length
    || edit.start > edit.end
    || text.slice(edit.start, edit.end) !== edit.original
  ))
}

/**
 * Apply the given edits to `text`.
 * @returns applied, rejected-because-stale, and the resulting text.
 */
export function applyEdits(text, edits) {
  const applied = []
  const stale = []
  for (const edit of edits) {
    if (staleEdits(text, [edit]).length > 0) stale.push(edit)
    else applied.push(edit)
  }
  const ordered = applied.slice().sort((left, right) => right.start - left.start)
  let out = text
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }
  return { text: out, applied, stale }
}
