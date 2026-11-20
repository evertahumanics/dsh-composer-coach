/**
 * Prompt builders for Composer Coach.
 *
 * Both prompts ask for plain replacement text only: the host diffs the reply
 * against the draft itself, so model-supplied offsets can never corrupt the
 * editor.
 */

function languageLine(language) {
  if (typeof language !== 'string' || language === '' || language === 'auto') {
    return 'Keep the text in the language it is already written in.'
  }
  return `Keep the text in this language: ${language}.`
}

/** Prompt that returns the draft with spelling, grammar, and punctuation fixed. */
export function buildGrammarPrompt({ text, language }) {
  return [
    'You are a careful copy editor for text a user is typing into a chat composer.',
    'Correct spelling, grammar, agreement, punctuation, and capitalisation.',
    languageLine(language),
    'Preserve meaning, tone, wording choices, markdown, line breaks, URLs, quoted material, and code fences or inline code exactly.',
    'Do not rewrite, shorten, expand, or add commentary.',
    'Return only the corrected text, with no preamble, no explanation, and no surrounding quotes or code fences.',
    'If nothing needs changing, return the text exactly as given.',
    '',
    'TEXT:',
    text,
  ].join('\n')
}

/** Prompt that rewrites the draft into a clearer, more effective instruction. */
export function buildPolishPrompt({ text, tone, context }) {
  const toneLine = tone === 'detailed'
    ? 'Make it thorough: state the goal, relevant context, and what a good result looks like.'
    : tone === 'technical'
      ? 'Make it precise and technical: name the exact files, tools, constraints, and acceptance criteria where the text allows.'
      : 'Make it concise: one tight, well-specified instruction without filler.'
  return [
    'You rewrite a user\'s message into a stronger prompt for an AI coding agent.',
    'Keep the original intent and every concrete detail: names, paths, versions, numbers, and constraints.',
    'Do not invent requirements the user did not imply, and do not answer the request.',
    toneLine,
    'Return only the rewritten prompt, with no preamble, no explanation, and no surrounding quotes or code fences.',
    ...(typeof context === 'string' && context.trim() !== ''
      ? [
        '',
        'EARLIER IN THIS CONVERSATION (context only, do not answer it):',
        context,
      ]
      : []),
    '',
    'MESSAGE:',
    text,
  ].join('\n')
}

/** Strip wrappers a model sometimes adds around returned text. */
export function stripWrap(raw) {
  let text = String(raw ?? '').trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/
  const fenced = fence.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"') && !text.slice(1, -1).includes('"')) {
    text = text.slice(1, -1).trim()
  }
  return text
}
