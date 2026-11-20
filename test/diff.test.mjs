import assert from 'node:assert/strict'
import test from 'node:test'
import { applyEdits, diffWords, staleEdits } from '../host/diff.js'
import { stripWrap } from '../host/prompt.js'

test('diff finds word-level changes', () => {
  const original = 'i has a apple'
  const corrected = 'I have an apple'
  const edits = diffWords(original, corrected)
  assert.ok(edits.length >= 1, 'expected at least one edit')
  const whole = applyEdits(original, edits)
  assert.equal(whole.text, corrected)
})

test('accepting one edit leaves the rest of the draft alone', () => {
  const original = 'i has a apple'
  const corrected = 'I have an apple'
  const edits = diffWords(original, corrected)
  // Word-granular: "i has a apple" -> "I have an apple" is three separate fixes,
  // not one sentence-wide replacement.
  assert.ok(edits.length >= 2, `expected word-level edits, got ${edits.length}`)
  const first = edits[0]
  const partial = applyEdits(original, [first])
  assert.equal(partial.applied.length, 1)
  assert.notEqual(partial.text, corrected)
  assert.equal(partial.text.slice(0, first.start), original.slice(0, first.start))
})

test('a stale edit is refused', () => {
  const original = 'i has a apple'
  const edits = diffWords(original, 'I have an apple')
  const typed = 'i has a apple and a pear'
  const stale = staleEdits(typed, edits)
  // Edits before the typing stay valid; none should apply to changed text.
  assert.ok(Array.isArray(stale))
  const shifted = edits.map(edit => ({ ...edit, original: 'zzz' }))
  assert.equal(applyEdits(original, shifted).stale.length, edits.length)
})

test('inline code is never rewritten', () => {
  const original = 'run `npm i` now'
  const corrected = 'Run `npm i` now.'
  const edits = diffWords(original, corrected)
  const inside = edits.filter(edit => edit.start < 10 && edit.end > 3)
  assert.equal(inside.length, 0, 'no edit may touch the code span')
})

test('fenced code is never rewritten', () => {
  const original = 'fix this:\n```\nvar x = 1\n```\nthanks'
  const corrected = 'Fix this:\n```\nvar x = 2\n```\nThanks.'
  const edits = diffWords(original, corrected)
  const codeStart = original.indexOf('```')
  const codeEnd = original.lastIndexOf('```') + 3
  const inside = edits.filter(edit => edit.start < codeEnd && edit.end > codeStart)
  assert.equal(inside.length, 0, 'no edit may touch a fenced block')
  assert.ok(edits.length >= 1)
})

test('identical text yields no edits', () => {
  assert.deepEqual(diffWords('same text', 'same text'), [])
})

test('applyEdits applies several edits without shifting offsets', () => {
  const original = 'i has a apple'
  const corrected = 'I have an apple'
  const edits = diffWords(original, corrected)
  const result = applyEdits(original, edits)
  assert.equal(result.text, corrected)
  assert.equal(result.stale.length, 0)
})

test('stripWrap removes fences and quotes', () => {
  assert.equal(stripWrap('```\nhello\n```'), 'hello')
  assert.equal(stripWrap('"hello"'), 'hello')
  assert.equal(stripWrap('  hello  '), 'hello')
})
