/**
 * Composer Coach — host half.
 *
 * Owns configuration, the HTTP surface the browser bundle calls, and the model
 * calls. No suggestion logic lives here beyond diffing the model's corrected
 * text: the client decides what to accept.
 */

import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffWords } from './host/diff.js'
import { buildGrammarPrompt, buildPolishPrompt, stripWrap } from './host/prompt.js'

/** Services this plugin needs mounted before it activates. */
export const inject = ['llm', 'webServer']

const API_PREFIX = '/composer-coach/api'
const MAX_BODY_BYTES = 64 * 1024
const MODEL_TIMEOUT_MS = 20_000

/**
 * A locally installed bundle is symlinked into the profile, so a bare import
 * would resolve against the workspace instead of the profile's node_modules.
 * Resolve the schema builder from the profile explicitly, and fall back to
 * plain configuration when it is unavailable.
 */
function loadSchema() {
  const bases = []
  if (process.env.DSH_PROFILE_DIR) bases.push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  if (process.env.DSH_PROFILE) bases.push(path.join(home, 'profiles', process.env.DSH_PROFILE))
  // The host process does not always expose the profile anchors; fall back to
  // the profile directories that exist on this machine.
  try {
    const profilesDir = path.join(home, 'profiles')
    for (const name of require$readdir(profilesDir)) bases.push(path.join(profilesDir, name))
  } catch {
    // no profiles directory: plain configuration is still usable
  }
  for (const base of bases) {
    try {
      const anchor = createRequire(path.join(base, 'resolve-anchor.js'))
      return anchor('@deepseek-ai/schemastery')
    } catch {
      // try the next candidate
    }
  }
  return null
}

function require$readdir(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

const Schema = loadSchema()

function delayField() {
  // A volatile field updates in place instead of restarting the plugin, so the
  // trigger delay changes the moment the settings page saves it. Zero is a
  // supported value: check as soon as the draft changes.
  let field = Schema.number().default(1000).min(0).max(10000)
  if (typeof field.volatile === 'function') field = field.volatile()
  return field
}

/** Row schema; validated when the plugin activates, when the builder resolved. */
export const Config = Schema === null
  ? undefined
  : Schema.object({
    enabled: Schema.boolean().default(true),
    liveChecks: Schema.boolean().default(true),
    delayMs: delayField(),
    minWords: Schema.number().default(2).min(1).max(50),
    minChars: Schema.number().default(1).min(0).max(2000),
    maxChars: Schema.number().default(6000).min(100).max(20000),
    language: Schema.string().default('auto'),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    polishTone: Schema.string().default('concise'),
    polishContext: Schema.boolean().default(true),
    sendPreview: Schema.boolean().default(true),
  })

/** Read a config value from either a plain value or a volatile getter. */
function readValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    const current = value.get()
    return current === undefined ? fallback : current
  }
  return value
}

function readSettings(config) {
  return {
    enabled: Boolean(readValue(config.enabled, true)),
    liveChecks: Boolean(readValue(config.liveChecks, true)),
    delayMs: Number(readValue(config.delayMs, 1000)),
    minWords: Number(readValue(config.minWords, 2)),
    minChars: Number(readValue(config.minChars, 1)),
    maxChars: Number(readValue(config.maxChars, 6000)),
    language: String(readValue(config.language, 'auto')),
    provider: String(readValue(config.provider, '')),
    model: String(readValue(config.model, '')),
    polishTone: String(readValue(config.polishTone, 'concise')),
    polishContext: Boolean(readValue(config.polishContext, true)),
    sendPreview: Boolean(readValue(config.sendPreview, true)),
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('Request body is not valid JSON')
  }
}

function providerId(info) {
  return info?.id ?? info?.name ?? info?.provider ?? info?.type
}

function modelId(info) {
  return info?.id ?? info?.name ?? info?.model
}

/** The profile's default model selection, when that service is mounted. */
function defaultSelection(ctx) {
  try {
    const service = ctx.get('agentDefaultModel')
    const current = service?.currentSelection?.()
    if (current !== undefined && current.provider && current.model) {
      return { provider: String(current.provider), model: String(current.model) }
    }
  } catch {
    // the service is optional
  }
  return null
}

/** Resolve the provider/model pair from config, else the profile default, else the first route. */
async function resolveTarget(ctx, settings) {
  if (settings.provider !== '' && settings.model !== '') {
    return { provider: settings.provider, model: settings.model }
  }

  const fallback = defaultSelection(ctx)
  if (settings.provider === '' && settings.model === '' && fallback !== null) return fallback

  let provider = settings.provider
  if (provider === '') provider = fallback?.provider ?? ''
  if (provider === '') {
    const providers = ctx.llm.listProviders()
    const first = Array.isArray(providers) ? providers[0] : undefined
    provider = providerId(first) ?? ''
  }
  if (provider === '') throw new Error('No model provider is configured')

  if (settings.model !== '') return { provider, model: settings.model }
  if (fallback !== null && fallback.provider === provider) return fallback

  const models = await ctx.llm.listModels(provider)
  const first = Array.isArray(models) ? models[0] : undefined
  const model = modelId(first) ?? ''
  if (model === '') {
    throw new Error(`No model is available for provider "${provider}". Set a provider and model in Settings → Composer coach.`)
  }
  return { provider, model }
}

/** One non-streaming-in-effect model call; returns the full text. */
async function complete(ctx, settings, prompt) {
  const { provider, model } = await resolveTarget(ctx, settings)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
  let text = ''
  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      signal: controller.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          const detail = chunk.reason?.message ?? chunk.reason?.failure?.message
          throw new Error(detail !== undefined ? String(detail) : 'The model call did not finish')
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const cleaned = stripWrap(text)
  if (cleaned === '') throw new Error('The model returned no text')
  return cleaned
}

const CONTEXT_MAX_CHARS = 3000
const CONTEXT_MAX_MESSAGES = 8

function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/**
 * Recent turns of one live session, as plain text. Returns '' when the session
 * is not readable, so polish simply proceeds without context.
 */
function conversationContext(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { text: '', reason: 'no-id' }
  let sessions = null
  try {
    sessions = ctx.get('sessions') ?? ctx.sessions ?? null
  } catch {
    sessions = null
  }
  if (sessions === null || typeof sessions.get !== 'function') return { text: '', reason: 'no-service' }
  let session = null
  try {
    session = sessions.get(sessionId) ?? null
  } catch {
    return { text: '', reason: 'no-session' }
  }
  if (session === null) return { text: '', reason: 'no-session' }
  let messages = []
  try {
    messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    return { text: '', reason: 'no-messages' }
  }
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', reason: 'no-messages' }
  const rows = []
  for (const message of messages.slice(-CONTEXT_MAX_MESSAGES * 2)) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(message)
    if (text === '') continue
    rows.push(`${role}: ${text}`)
  }
  if (rows.length === 0) return { text: '', reason: 'no-text' }
  let joined = rows.join('\n')
  if (joined.length > CONTEXT_MAX_CHARS) joined = joined.slice(-CONTEXT_MAX_CHARS)
  return { text: joined, reason: 'ok' }
}

/** Validate the incoming draft against the configured bounds. */
function requireText(settings, body) {
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim() === '') throw new Error('The draft is empty')
  if (text.length > settings.maxChars) {
    throw new Error(`The draft is longer than the ${settings.maxChars}-character limit`)
  }
  return text
}

async function saveConfig(ctx, patch) {
  const entry = ctx.fiber.entry
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    throw new Error('Configuration cannot be saved in this profile')
  }
  const allowed = ['enabled', 'liveChecks', 'delayMs', 'minWords', 'minChars', 'maxChars', 'language', 'provider', 'model', 'polishTone', 'polishContext', 'sendPreview']
  const clean = {}
  for (const key of allowed) {
    if (patch[key] !== undefined) clean[key] = patch[key]
  }
  if (clean.delayMs !== undefined) {
    const seconds = Number(clean.delayMs)
    if (!Number.isFinite(seconds)) throw new Error('delayMs must be a number')
    clean.delayMs = Math.round(Math.min(10000, Math.max(0, seconds)))
  }
  await editor.edit(entry, current => ({ ...current, ...clean }))
}

async function handleRequest(ctx, config, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
  const settings = readSettings(config)
  const method = req.method ?? 'GET'

  if (route === '/config' && method === 'GET') {
    sendJson(res, 200, { config: settings })
    return
  }

  if (route === '/config' && method === 'POST') {
    const body = await readJson(req)
    await saveConfig(ctx, body)
    // Re-read after the edit: volatile fields (the delay) are live, so the
    // response must describe what was actually stored.
    sendJson(res, 200, { config: readSettings(config), saved: true })
    return
  }

  if (route === '/models' && method === 'GET') {
    const providers = []
    let list = []
    try {
      list = ctx.llm.listProviders() ?? []
    } catch {
      list = []
    }
    for (const info of list) {
      const id = providerId(info)
      if (id === undefined) continue
      let models = []
      try {
        const found = await ctx.llm.listModels(id)
        models = (Array.isArray(found) ? found : []).map(modelId).filter(Boolean)
      } catch {
        models = []
      }
      providers.push({ provider: id, models })
    }
    sendJson(res, 200, { providers, effective: defaultSelection(ctx) })
    return
  }

  if (route === '/check' && method === 'POST') {
    const body = await readJson(req)
    const text = requireText(settings, body)
    const language = typeof body.language === 'string' ? body.language : settings.language
    const target = await resolveTarget(ctx, settings)
    const corrected = await complete(ctx, settings, buildGrammarPrompt({ text, language }))
    const edits = diffWords(text, corrected)
    sendJson(res, 200, { checkedText: text, corrected, edits, model: target })
    return
  }

  if (route === '/prepare' && method === 'POST') {
    const body = await readJson(req)
    const text = requireText(settings, body)
    const language = typeof body.language === 'string' ? body.language : settings.language
    const tone = typeof body.tone === 'string' ? body.tone : settings.polishTone
    const gathered = settings.polishContext
      ? conversationContext(ctx, body.sessionId)
      : { text: '', reason: 'disabled' }
    const target = await resolveTarget(ctx, settings)
    const [corrected, polished] = await Promise.all([
      complete(ctx, settings, buildGrammarPrompt({ text, language })),
      complete(ctx, settings, buildPolishPrompt({ text, tone, context: gathered.text })),
    ])
    sendJson(res, 200, {
      original: text,
      corrected,
      polished,
      model: target,
      contextChars: gathered.text.length,
      contextReason: gathered.reason,
    })
    return
  }

  if (route === '/polish' && method === 'POST') {
    const body = await readJson(req)
    const text = requireText(settings, body)
    const tone = typeof body.tone === 'string' ? body.tone : settings.polishTone
    const target = await resolveTarget(ctx, settings)
    const gathered = settings.polishContext
      ? conversationContext(ctx, body.sessionId)
      : { text: '', reason: 'disabled' }
    const polished = await complete(ctx, settings, buildPolishPrompt({ text, tone, context: gathered.text }))
    sendJson(res, 200, { polished, model: target, contextChars: gathered.text.length, contextReason: gathered.reason })
    return
  }

  sendJson(res, 404, { error: `Unknown route: ${route}` })
}

/** Mount the HTTP surface. */
export function apply(ctx, config) {
  const handler = async (req, res) => {
    try {
      await handleRequest(ctx, config, req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { error: message })
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'composer-coach: api routes',
  )
}
