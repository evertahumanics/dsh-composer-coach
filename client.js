/**
 * Composer Coach — browser half.
 *
 * Registers a floating suggestion card that appears over the changed word in
 * the composer, anchored by measuring the editor's text range for the edit.
 * If the editor cannot be measured safely (chips present, editor not found,
 * recent re-render), the same panel falls back to an inline strip so the
 * feature never silently disappears.
 *
 * Model calls and diffing happen on the host at /composer-coach/api.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-coach',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo } = React

    let createPortal = null
    try {
      const reactDom = require('react-dom')
      createPortal = typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
    } catch {
      createPortal = null
    }

    const API = '/composer-coach/api'
    const DEFAULTS = {
      enabled: true,
      delayMs: 1000,
      minWords: 2,
      minChars: 1,
      maxChars: 6000,
      language: 'auto',
      polishTone: 'concise',
      polishContext: true,
      sendPreview: true,
      liveChecks: true,
    }

    /** Module-level config channel so settings changes reach the composer panel live. */
    const bus = {
      cfg: null,
      model: null,
      listeners: new Set(),
      publish(next) {
        bus.cfg = next
        for (const listener of bus.listeners) listener(next)
      },
      subscribe(listener) {
        bus.listeners.add(listener)
        return () => bus.listeners.delete(listener)
      },
    }

    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
      return data
    }

    async function getConfig() {
      const response = await fetch(API + '/config', { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
      return { ...DEFAULTS, ...(data.config ?? {}) }
    }

    function shiftEdits(edits, applied) {
      const delta = applied.replacement.length - (applied.end - applied.start)
      const next = []
      for (const edit of edits) {
        if (edit === applied) continue
        if (edit.end <= applied.start) next.push(edit)
        else if (edit.start >= applied.end) next.push({ ...edit, start: edit.start + delta, end: edit.end + delta })
        // overlapping edits are dropped: the draft moved under them
      }
      return next
    }

    function applyLocally(text, edit) {
      if (edit.start < 0 || edit.end > text.length || text.slice(edit.start, edit.end) !== edit.original) return null
      return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
    }

    /**
     * The composer's editor, found by walking up from our own docked node and
     * taking the nearest ancestor that contains exactly one contenteditable.
     * This avoids colliding with other editors on the page (such as a sidebar
     * code editor) and stops at the first ambiguous ancestor.
     */
    function editorRootFrom(node) {
      let element = node
      for (let depth = 0; depth < 10 && element !== null; depth += 1) {
        element = element.parentElement
        if (element === null) break
        const editors = element.querySelectorAll('[contenteditable="true"]')
        if (editors.length === 1) return editors[0] instanceof HTMLElement ? editors[0] : null
        if (editors.length > 1) return null
      }
      return null
    }

    /** Last resort: the page's single contenteditable, when there is exactly one. */
    function editorRootGlobal() {
      const editors = document.querySelectorAll('[contenteditable="true"]')
      if (editors.length !== 1) return null
      return editors[0] instanceof HTMLElement ? editors[0] : null
    }

    /** Client rect for a character range inside the editor, or null. */
    function rectForRange(root, start, end) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      let consumed = 0
      let startNode = null
      let startOffset = 0
      let endNode = null
      let endOffset = 0
      let node = walker.nextNode()
      while (node !== null) {
        const length = node.data.length
        if (startNode === null && start >= consumed && start <= consumed + length) {
          startNode = node
          startOffset = start - consumed
        }
        if (startNode !== null && end <= consumed + length) {
          endNode = node
          endOffset = end - consumed
          break
        }
        consumed += length
        node = walker.nextNode()
      }
      if (startNode === null || endNode === null) return null
      const range = document.createRange()
      try {
        range.setStart(startNode, startOffset)
        range.setEnd(endNode, endOffset)
      } catch {
        return null
      }
      const rects = range.getClientRects()
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) return null
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }

    /**
     * Measure one edit's span. Returns null whenever the safe preconditions do
     * not hold, which sends the panel to its inline fallback.
     */
    function measureEdit(draft, edit, anchorNode) {
      const root = (anchorNode !== null ? editorRootFrom(anchorNode) : null) ?? editorRootGlobal()
      if (root === null) return null
      // The clipboard projection only equals the DOM text while the draft holds
      // no reference chips; otherwise offsets would drift.
      if ((root.textContent ?? '') !== draft) return null
      let start = Math.max(0, Math.min(edit.start, draft.length))
      let end = Math.max(start, Math.min(edit.end, draft.length))
      if (end === start) {
        // Pure insertion: anchor the card on the neighbouring character.
        if (start > 0) start -= 1
        else if (end < draft.length) end += 1
        else return null
      }
      return rectForRange(root, start, end)
    }

    /** The editor's own box, used to place the floating polish control. */
    function measureEditorBox(anchorNode) {
      const root = (anchorNode !== null ? editorRootFrom(anchorNode) : null) ?? editorRootGlobal()
      if (root === null) return null
      const box = root.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) return null
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    const CARD_WIDTH = 340
    const STYLE_ID = 'dsh-composer-coach-styles'

    const STYLES = `
      .gc-card { animation: gc-fade 120ms ease-out; }
      @keyframes gc-fade { from { opacity: 0 } to { opacity: 1 } }
      .gc-btn { font: inherit; font-size: 12px; line-height: 1; padding: 6px 11px; border-radius: 7px;
        cursor: pointer; color: inherit; background: transparent;
        border: 1px solid color-mix(in oklab, currentColor 26%, transparent);
        transition: background 90ms ease, border-color 90ms ease, transform 60ms ease; }
      .gc-btn:hover:not(:disabled) { background: color-mix(in oklab, currentColor 12%, transparent); }
      .gc-btn:active:not(:disabled) { transform: translateY(1px); }
      .gc-btn:focus-visible { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; }
      .gc-btn:disabled { opacity: .55; cursor: progress; }
      .gc-btn-primary { background: color-mix(in oklab, currentColor 14%, transparent); font-weight: 600; }
      .gc-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
        padding: 0; border: 0; border-radius: 6px; cursor: pointer; color: inherit; background: transparent;
        font: inherit; font-size: 13px; transition: background 90ms ease; }
      .gc-icon-btn:hover:not(:disabled) { background: color-mix(in oklab, currentColor 12%, transparent); }
      .gc-icon-btn:focus-visible { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; }
      .gc-pill { position: fixed; z-index: 60; display: inline-flex; align-items: center; gap: 6px;
        height: 28px; padding: 0 11px 0 9px; border-radius: 14px; cursor: pointer;
        font: inherit; font-size: 12px; font-weight: 500; color: CanvasText; background: Canvas;
        border: 1px solid color-mix(in oklab, currentColor 26%, transparent);
        box-shadow: 0 2px 10px rgba(0,0,0,0.16);
        transition: background 90ms ease, box-shadow 90ms ease, transform 60ms ease; }
      .gc-pill:hover:not(:disabled) { background: color-mix(in oklab, currentColor 10%, transparent); box-shadow: 0 4px 14px rgba(0,0,0,0.2); }
      .gc-pill:active:not(:disabled) { transform: translateY(1px); }
      .gc-pill:focus-visible { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 2px; }
      .gc-pill:disabled { opacity: .6; cursor: progress; }
      .gc-pill-error { border-color: var(--dsh-color-danger, #c0392b); color: var(--dsh-color-danger, #c0392b); }
      .gc-spinner { width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid color-mix(in oklab, currentColor 30%, transparent); border-top-color: currentColor;
        animation: gc-spin 700ms linear infinite; }
      @keyframes gc-spin { to { transform: rotate(360deg) } }
      @media (prefers-reduced-motion: reduce) {
        .gc-card, .gc-spinner { animation: none; }
        .gc-btn, .gc-pill { transition: none; }
      }
    `

    /** Inject the stylesheet once per page; returns its disposer. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = STYLES
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    function cardStyle(left, top, placeBelow) {
      return {
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        width: `${CARD_WIDTH}px`,
        transform: placeBelow ? 'none' : 'translateY(-100%)',
        zIndex: 60,
        boxSizing: 'border-box',
        padding: '12px 14px',
        borderRadius: '12px',
        border: '1px solid color-mix(in oklab, currentColor 22%, transparent)',
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 12px 28px rgba(0,0,0,0.22)',
        font: 'inherit',
        fontSize: '12.5px',
        lineHeight: '1.5',
      }
    }

    function highlightStyle(rect) {
      return {
        position: 'fixed',
        left: `${rect.left - 2}px`,
        top: `${rect.top - 1}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 2}px`,
        borderBottom: '2px solid color-mix(in oklab, currentColor 55%, transparent)',
        background: 'color-mix(in oklab, currentColor 10%, transparent)',
        borderRadius: '3px',
        pointerEvents: 'none',
        zIndex: 59,
      }
    }

    const panelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px 12px',
      margin: '0 auto 8px',
      width: '100%',
      maxWidth: '880px',
      boxSizing: 'border-box',
      border: '1px solid color-mix(in oklab, currentColor 18%, transparent)',
      borderRadius: '12px',
      background: 'color-mix(in oklab, currentColor 4%, transparent)',
      color: 'inherit',
      fontSize: '12.5px',
      lineHeight: '1.5',
    }

    const headerStyle = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

    function mutedStyle(extra) {
      return { opacity: 0.65, ...extra }
    }

    function describe(edit) {
      const from = edit.original === '' ? '(add)' : edit.original
      const to = edit.replacement === '' ? '(remove)' : edit.replacement
      return { from, to }
    }

    /** One word-level change: struck original, emphasised replacement. */
    function DiffLine(props) {
      const { from, to } = describe(props.edit)
      return h('span', { style: { overflowWrap: 'anywhere' } },
        h('span', { style: { textDecoration: 'line-through', opacity: 0.6 } }, from),
        h('span', { style: { opacity: 0.45, margin: '0 6px' } }, '→'),
        h('strong', { style: { color: 'var(--dsh-color-success, #2e7d32)' } }, to),
      )
    }

    function EditActions(props) {
      const { edit, onAccept, onSkip } = props
      const { from, to } = describe(edit)
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, h(DiffLine, { edit })),
        h('button', {
          type: 'button', className: 'gc-btn gc-btn-primary', onClick: onAccept,
          'aria-label': `Accept change ${from} to ${to}`,
        }, 'Accept'),
        h('button', {
          type: 'button', className: 'gc-btn', onClick: onSkip,
          'aria-label': `Skip change ${from}`,
        }, 'Skip'),
      )
    }

    function GrammarDock(props) {
      const useDraft = typeof props.useInput === 'function' ? props.useInput : (() => undefined)
      const actions = props.inputActions
      const draft = useDraft(state => state.draft)
      const phase = useDraft(state => state.phase)
      const revision = useDraft(state => state.draftRev)

      const [cfg, setCfg] = useState(bus.cfg ?? DEFAULTS)
      const [edits, setEdits] = useState([])
      const [status, setStatus] = useState('idle')
      const [error, setError] = useState(null)
      const [polish, setPolish] = useState(null)
      const [polishing, setPolishing] = useState(false)
      const [active, setActive] = useState(0)
      const [tick, setTick] = useState(0)
      const [slowCheck, setSlowCheck] = useState(false)
      const [modelLabel, setModelLabel] = useState(null)
      const [good, setGood] = useState(false)
      const [sendCard, setSendCard] = useState(null)

      const draftRef = useRef(draft)
      draftRef.current = draft
      const lastChecked = useRef('')
      const abortRef = useRef(null)
      // In-flow node used only to locate the composer editor.
      const anchorRef = useRef(null)

      useEffect(() => bus.subscribe(setCfg), [])
      useEffect(() => {
        if (bus.cfg === null) getConfig().then(next => bus.publish(next)).catch(() => {})
      }, [])

      // Re-measure after layout changes so the floating UI follows the text.
      useEffect(() => {
        let frame = 0
        const bump = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            setTick(value => value + 1)
          })
        }
        window.addEventListener('resize', bump)
        window.addEventListener('scroll', bump, true)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          window.removeEventListener('resize', bump)
          window.removeEventListener('scroll', bump, true)
        }
      }, [])

      const canEdit = typeof actions?.setDraft === 'function'
      const sessionId = props.session?.sessionId
      // An edit is only valid while the draft still matches its recorded span.
      // Deleting or inserting text therefore drops suggestions instead of
      // hovering a word that no longer exists.
      const liveEdits = typeof draft === 'string'
        ? edits.filter(edit => draft.slice(edit.start, edit.end) === edit.original)
        : []
      const activeIndex = liveEdits.length === 0 ? -1 : clamp(active, 0, liveEdits.length - 1)

      /**
       * What floats over the text, and where. Priority: polished-prompt preview,
       * word suggestion, checking indicator, then the polish pill.
       */
      const overlay = useMemo(() => {
        if (typeof draft !== 'string' || draft.trim() === '') return null
        if (createPortal === null) return null

        if (polish !== null) {
          const box = measureEditorBox(anchorRef.current)
          if (box === null) return null
          const left = clamp(box.right - CARD_WIDTH, 8, Math.max(8, window.innerWidth - CARD_WIDTH - 8))
          const placeBelow = box.top < 240
          const top = placeBelow ? box.bottom + 8 : box.top - 8
          return { kind: 'polish', left, top, placeBelow }
        }

        if (liveEdits.length > 0) {
          const edit = liveEdits[activeIndex]
          if (edit === undefined) return null
          const rect = measureEdit(draft, edit, anchorRef.current)
          if (rect === null) return null
          const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - CARD_WIDTH - 8))
          const placeBelow = rect.top < 190
          const top = placeBelow ? rect.bottom + 8 : rect.top - 8
          return { kind: 'edit', rect, left, top, placeBelow, edit }
        }

        const box = measureEditorBox(anchorRef.current)
        if (box === null) return null
        if (good) {
          const size = 108
          const left = clamp(box.right - size - 6, 8, Math.max(8, window.innerWidth - size - 8))
          const placeBelow = box.top < 64
          const top = placeBelow ? box.bottom + 6 : box.top - 6
          return { kind: 'good', left, top, width: size, placeBelow }
        }
        const width = slowCheck ? 106 : 92
        const left = clamp(box.right - width - 6, 8, Math.max(8, window.innerWidth - width - 8))
        const placeBelow = box.top < 64
        const top = placeBelow ? box.bottom + 6 : box.top - 6
        return { kind: slowCheck ? 'checking' : 'button', left, top, width, placeBelow }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [draft, edits, activeIndex, polish, tick, slowCheck, good])

      // Escape dismisses the floating UI without touching the draft.
      const overlayOpen = overlay !== null || sendCard !== null
      useEffect(() => {
        if (!overlayOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (sendCard !== null) setSendCard(null)
          setEdits([])
          setPolish(null)
          lastChecked.current = draftRef.current ?? ''
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [overlayOpen, sendCard])

      async function runCheck(text) {
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        // Hard ceiling: the floating UI can never sit on "Checking…" forever.
        const ceiling = setTimeout(() => controller.abort(), 25000)
        setStatus('checking')
        setError(null)
        const slow = setTimeout(() => setSlowCheck(true), 400)
        try {
          const response = await fetch(API + '/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, language: cfg.language }),
            signal: controller.signal,
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error || `Check failed (${response.status})`)
          if (draftRef.current !== text) {
            // Superseded by newer typing: settle instead of hanging on "checking".
            setStatus('idle')
            return
          }
          lastChecked.current = text
          const next = Array.isArray(data.edits) ? data.edits : []
          setEdits(next)
          setActive(0)
          setModelLabel(data.model)
          bus.model = data.model
          setStatus('done')
          if (next.length === 0) {
            setGood(true)
            setTimeout(() => setGood(false), 2600)
          }
        } catch (failure) {
          if (failure && failure.name === 'AbortError') {
            setStatus('idle')
            return
          }
          setStatus('error')
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          clearTimeout(slow)
          clearTimeout(ceiling)
          setSlowCheck(false)
        }
      }

      async function prepareSend(text) {
        setSendCard({ loading: true, original: text })
        setError(null)
        try {
          const data = await postJson('/prepare', {
            text,
            language: cfg.language,
            tone: cfg.polishTone,
            sessionId,
          })
          setSendCard({
            loading: false,
            original: text,
            corrected: typeof data.corrected === 'string' ? data.corrected : text,
            polished: typeof data.polished === 'string' ? data.polished : text,
            model: data.model,
          })
        } catch (failure) {
          setSendCard({
            loading: false,
            original: text,
            error: failure instanceof Error ? failure.message : String(failure),
          })
        }
      }

      function sendNow(text) {
        setSendCard(null)
        setEdits([])
        setPolish(null)
        const next = typeof text === 'string' && text !== '' ? text : draftRef.current
        if (next !== draftRef.current && canEdit) {
          actions.setDraft(next)
          lastChecked.current = next
          setTimeout(() => { actions.submit?.() }, 40)
          return
        }
        actions.submit?.()
      }

      // Send-time preview: hold Enter, show both rewrites, then send the choice.
      useEffect(() => {
        if (!cfg.sendPreview) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
          if (event.isComposing || event.defaultPrevented) return
          if (sendCard !== null) return
          if (phase !== undefined && phase !== 'plain') return
          const root = (anchorRef.current !== null ? editorRootFrom(anchorRef.current) : null) ?? editorRootGlobal()
          if (root === null) return
          const target = event.target
          if (!(target instanceof Node) || !root.contains(target)) return
          const text = draftRef.current
          if (typeof text !== 'string' || text.trim() === '') return
          event.preventDefault()
          event.stopPropagation()
          void prepareSend(text)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cfg.sendPreview, sendCard, phase])

      // Debounced trigger: every keystroke resets the timer.
      useEffect(() => {
        if (!cfg.enabled || !cfg.liveChecks || polish !== null) return undefined
        if (phase !== undefined && phase !== 'plain') return undefined
        if (typeof draft !== 'string' || draft.trim() === '') return undefined
        const wordCount = draft.trim().split(/\s+/).filter(Boolean).length
        if (wordCount < Number(cfg.minWords ?? 2)) return undefined
        if (draft.length < Number(cfg.minChars ?? 1) || draft.length > Number(cfg.maxChars)) return undefined
        if (draft === lastChecked.current) return undefined
        const rawDelay = Number(cfg.delayMs)
        const delay = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 1000
        const timer = setTimeout(() => { runCheck(draft) }, delay)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [draft, revision, phase, cfg.enabled, cfg.liveChecks, cfg.delayMs, cfg.minWords, cfg.minChars, cfg.maxChars, polish])

      function acceptOne(edit) {
        const current = draftRef.current
        const next = applyLocally(current, edit)
        if (next === null || !canEdit) {
          setEdits(list => list.filter(item => item !== edit))
          lastChecked.current = ''
          return
        }
        actions.setDraft(next)
        lastChecked.current = next
        setEdits(list => shiftEdits(list, edit))
        setActive(0)
      }

      function acceptAll() {
        const current = draftRef.current
        let next = current
        const ordered = liveEdits.slice().sort((left, right) => right.start - left.start)
        for (const edit of ordered) {
          const applied = applyLocally(next, edit)
          if (applied !== null) next = applied
        }
        if (next !== current && canEdit) actions.setDraft(next)
        lastChecked.current = next
        setEdits([])
      }

      function dismiss() {
        lastChecked.current = draftRef.current ?? ''
        setEdits([])
        setError(null)
      }

      async function runPolish() {
        const text = draftRef.current
        if (typeof text !== 'string' || text.trim() === '') return
        setPolishing(true)
        setError(null)
        try {
          const data = await postJson('/polish', { text, tone: cfg.polishTone, sessionId })
          if (typeof data.polished === 'string' && data.polished !== '') setPolish({ text: data.polished })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setPolishing(false)
        }
      }

      function acceptPolish() {
        if (polish === null) return
        if (canEdit) actions.setDraft(polish.text)
        lastChecked.current = polish.text
        setPolish(null)
        setEdits([])
      }

      if (typeof draft !== 'string' || draft.trim() === '') return null

      // In-flow anchor used only to locate the composer editor.
      const anchor = h('div', { ref: anchorRef, style: { display: 'none' }, 'aria-hidden': true })

      // 0. Send-time preview: both rewrites, choose what to send.
      if (sendCard !== null) {
        const box = measureEditorBox(anchorRef.current)
        const width = 400
        const left = box !== null
          ? clamp(box.left, 8, Math.max(8, window.innerWidth - width - 8))
          : clamp((window.innerWidth - width) / 2, 8, Math.max(8, window.innerWidth - width - 8))
        const placeBelow = box !== null ? box.top < 320 : false
        const top = box === null ? 80 : (placeBelow ? box.bottom + 8 : box.top - 8)
        const textBlock = (label, value) => h('div', { style: { marginTop: '8px' } },
          h('div', { style: mutedStyle({ fontSize: '11px', marginBottom: '3px' }) }, label),
          h('div', {
            style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '96px', overflowY: 'auto', fontSize: '12.5px' },
          }, value),
        )
        const body = sendCard.loading
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' } },
            h('span', { className: 'gc-spinner', 'aria-hidden': true }),
            h('span', null, 'Preparing grammar and polish…'),
          )
          : sendCard.error !== undefined
            ? h('div', { style: { marginTop: '10px', color: 'var(--dsh-color-danger, #c0392b)' } }, sendCard.error)
            : h(React.Fragment, null,
              textBlock('Grammar', sendCard.corrected),
              textBlock('Polished', sendCard.polished),
            )
        const card = h('div', {
          className: 'gc-card',
          style: { ...cardStyle(left, top, placeBelow), width: `${width}px` },
          role: 'dialog',
          'aria-label': 'Send preview',
        },
          h('div', { style: headerStyle },
            h('strong', { style: { fontSize: '12px' } }, 'Send preview'),
            h('span', { style: mutedStyle({ fontSize: '11px' }) }, 'Enter held'),
            h('span', { style: { marginLeft: 'auto' } },
              h('button', {
                type: 'button', className: 'gc-icon-btn', 'aria-label': 'Cancel sending',
                onClick: () => setSendCard(null),
              }, '✕'),
            ),
          ),
          body,
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' } },
            sendCard.loading
              ? h('button', { type: 'button', className: 'gc-btn gc-btn-primary', onClick: () => sendNow(sendCard.original) }, 'Send as-is')
              : h(React.Fragment, null,
                sendCard.error === undefined
                  ? h('button', {
                    type: 'button', className: 'gc-btn gc-btn-primary',
                    onClick: () => sendNow(sendCard.polished),
                  }, 'Send polished')
                  : null,
                sendCard.error === undefined
                  ? h('button', { type: 'button', className: 'gc-btn', onClick: () => sendNow(sendCard.corrected) }, 'Send grammar')
                  : null,
                h('button', { type: 'button', className: 'gc-btn', onClick: () => sendNow(sendCard.original) }, 'Send original'),
              ),
          ),
        )
        return h(React.Fragment, null, anchor, createPortal(card, document.body))
      }

      // Live checks off: nothing appears in the composer. The send card above
      // still runs, so results arrive only at send time.
      if (!cfg.liveChecks) return anchor

      // 1. Polished-prompt preview over the text.
      if (overlay !== null && overlay.kind === 'polish') {
        const card = h('div', {
          className: 'gc-card',
          style: cardStyle(overlay.left, overlay.top, overlay.placeBelow),
          role: 'dialog',
          'aria-label': 'Polished prompt',
        },
          h('div', { style: headerStyle },
            h(PolishIcon, { size: 14 }),
            h('strong', { style: { fontSize: '12px' } }, 'Polished prompt'),
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
              h('button', { type: 'button', className: 'gc-btn gc-btn-primary', onClick: acceptPolish }, 'Use it'),
              h('button', { type: 'button', className: 'gc-btn', onClick: () => setPolish(null) }, 'Discard'),
            ),
          ),
          h('div', {
            style: {
              marginTop: '8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              maxHeight: '180px', overflowY: 'auto', opacity: 0.95,
            },
          }, polish !== null ? polish.text : ''),
          error !== null ? h('div', { style: { marginTop: '8px', color: 'var(--dsh-color-danger, #c0392b)' } }, error) : null,
        )
        return h(React.Fragment, null, anchor, createPortal(card, document.body))
      }

      // 2. Polish pill, the checking indicator, or a visible failure.
      if (overlay !== null && overlay.kind === 'good') {
        const pill = h('div', {
          className: 'gc-pill',
          role: 'status',
          'aria-live': 'polite',
          style: {
            left: `${overlay.left}px`,
            top: `${overlay.top}px`,
            transform: overlay.placeBelow ? 'none' : 'translateY(-100%)',
            cursor: 'default',
          },
        },
          h('span', { 'aria-hidden': true, style: { color: 'var(--dsh-color-success, #2e7d32)', fontWeight: 700 } }, '✓'),
          h('span', null, 'Looks good'),
        )
        return h(React.Fragment, null, anchor, createPortal(pill, document.body))
      }

      if (overlay !== null && (overlay.kind === 'button' || overlay.kind === 'checking')) {
        const checking = overlay.kind === 'checking'
        const failed = !checking && status === 'error' && error !== null
        const pill = h('button', {
          type: 'button',
          className: failed ? 'gc-pill gc-pill-error' : 'gc-pill',
          onClick: failed ? () => runCheck(draft) : runPolish,
          disabled: checking || polishing,
          title: failed
            ? error
            : (checking ? 'Checking the draft…' : 'Rewrite this draft into a stronger prompt'),
          'aria-label': failed ? 'Grammar check failed, retry' : (checking ? 'Checking the draft' : 'Polish prompt'),
          style: {
            left: `${overlay.left}px`,
            top: `${overlay.top}px`,
            transform: overlay.placeBelow ? 'none' : 'translateY(-100%)',
          },
        },
          checking
            ? h('span', { className: 'gc-spinner', 'aria-hidden': true })
            : failed
              ? h('span', { 'aria-hidden': true, style: { fontWeight: 700 } }, '!')
              : h(PolishIcon, { size: 14 }),
          h('span', null,
            checking ? 'Checking…' : failed ? 'Retry check' : (polishing ? 'Polishing…' : 'Polish')),
        )
        return h(React.Fragment, null, anchor, createPortal(pill, document.body))
      }

      // 3. Word suggestion card anchored to the changed word.
      if (overlay !== null && overlay.kind === 'edit') {
        const card = h('div', {
          className: 'gc-card',
          style: cardStyle(overlay.left, overlay.top, overlay.placeBelow),
          role: 'dialog',
          'aria-label': 'Grammar suggestion',
        },
          h('div', { style: headerStyle },
            h('strong', { style: { fontSize: '12px' } },
              liveEdits.length === 1 ? 'Suggestion' : `${activeIndex + 1} of ${liveEdits.length}`),
            h('span', { style: mutedStyle({ fontSize: '11px' }) }, 'grammar'),
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '2px' } },
              liveEdits.length > 1 ? h('button', {
                type: 'button', className: 'gc-icon-btn', 'aria-label': 'Previous suggestion',
                onClick: () => setActive(index => (index <= 0 ? liveEdits.length - 1 : index - 1)),
              }, '↑') : null,
              liveEdits.length > 1 ? h('button', {
                type: 'button', className: 'gc-icon-btn', 'aria-label': 'Next suggestion',
                onClick: () => setActive(index => (index + 1) % liveEdits.length),
              }, '↓') : null,
              h('button', {
                type: 'button', className: 'gc-icon-btn', onClick: dismiss,
                'aria-label': 'Dismiss suggestions',
              }, '✕'),
            ),
          ),
          h('div', { style: { margin: '8px 0 10px', fontSize: '13px' } },
            h(DiffLine, { edit: overlay.edit }),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('button', {
              type: 'button', className: 'gc-btn gc-btn-primary',
              onClick: () => acceptOne(overlay.edit),
            }, 'Accept'),
            h('button', {
              type: 'button', className: 'gc-btn',
              onClick: () => setEdits(list => list.filter(item => item.start !== overlay.edit.start)),
            }, 'Skip'),
            liveEdits.length > 1 ? h('button', { type: 'button', className: 'gc-btn', onClick: acceptAll }, 'Accept all') : null,
            h('button', {
              type: 'button', className: 'gc-btn', style: { marginLeft: 'auto' },
              onClick: runPolish, disabled: polishing,
            }, polishing ? 'Polishing…' : 'Polish'),
          ),
          error !== null ? h('div', { style: { marginTop: '8px', color: 'var(--dsh-color-danger, #c0392b)' } }, error) : null,
        )
        return h(React.Fragment, null,
          anchor,
          createPortal(h(React.Fragment, null,
            h('div', { style: highlightStyle(overlay.rect), 'aria-hidden': true }),
            card,
          ), document.body),
        )
      }

      // 4. Inline fallback: the same suggestions, docked above the composer.
      const children = []
      if (liveEdits.length > 0) {
        children.push(h('div', { key: 'head', style: headerStyle },
          h('strong', null, liveEdits.length === 1 ? '1 suggestion' : `${liveEdits.length} suggestions`),
          h('span', { style: mutedStyle({ fontSize: '11px' }) }, 'grammar'),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            h('button', { type: 'button', className: 'gc-btn gc-btn-primary', onClick: acceptAll }, 'Accept all'),
            h('button', { type: 'button', className: 'gc-btn', onClick: dismiss }, 'Dismiss'),
          ),
        ))
        for (const edit of liveEdits) {
          children.push(h('div', { key: `e${edit.start}:${edit.original}` },
            h(EditActions, {
              edit,
              onAccept: () => acceptOne(edit),
              onSkip: () => setEdits(list => list.filter(item => item !== edit)),
            }),
          ))
        }
      } else if (polish !== null) {
        children.push(h('div', { key: 'phead', style: headerStyle },
          h(PolishIcon, { size: 14 }),
          h('strong', null, 'Polished prompt'),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            h('button', { type: 'button', className: 'gc-btn gc-btn-primary', onClick: acceptPolish }, 'Use it'),
            h('button', { type: 'button', className: 'gc-btn', onClick: () => setPolish(null) }, 'Discard'),
          ),
        ))
        children.push(h('div', {
          key: 'pbody',
          style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', opacity: 0.95 },
        }, polish.text))
      } else {
        children.push(h('div', { key: 'idle', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: mutedStyle({ display: 'inline-flex', alignItems: 'center', gap: '6px' }) },
            status === 'checking'
              ? h('span', { className: 'gc-spinner', 'aria-hidden': true })
              : h(PolishIcon, { size: 13 }),
            status === 'checking' ? 'Checking…' : 'Composer coach',
          ),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            h('button', {
              type: 'button', className: 'gc-btn', onClick: runPolish, disabled: polishing,
              title: 'Rewrite this draft into a stronger prompt',
            }, polishing ? 'Polishing…' : 'Polish prompt'),
          ),
        ))
      }

      if (error !== null) {
        children.push(h('div', { key: 'error', style: { color: 'var(--dsh-color-danger, #c0392b)' } }, error))
      }

      return h('div', {
        ref: anchorRef,
        style: panelStyle,
        role: 'region',
        'aria-label': 'Composer coach',
      }, children)
    }

    /** Settings section: trigger delay in seconds plus limits and model choice. */
    function GrammarSettings() {
      const [form, setForm] = useState(bus.cfg ?? DEFAULTS)
      const [seconds, setSeconds] = useState(String(((bus.cfg ?? DEFAULTS).delayMs / 1000).toFixed(1)))
      const [routes, setRoutes] = useState([])
      const [note, setNote] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [ready, setReady] = useState(bus.cfg !== null)
      const lastModel = bus.model ?? null

      useEffect(() => {
        let alive = true
        getConfig()
          .then((next) => {
            if (!alive) return
            bus.publish(next)
            setForm(next)
            setSeconds(String((next.delayMs / 1000).toFixed(1)))
            setReady(true)
          })
          .catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        let alive = true
        fetch(API + '/models')
          .then(response => response.json())
          .then((data) => { if (alive) setRoutes(Array.isArray(data.providers) ? data.providers : []) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      function update(key, value) {
        setForm(current => ({ ...current, [key]: value }))
      }

      async function save() {
        setBusy(true)
        setNote(null)
        setError(null)
        try {
          const delayMs = Math.round(Number(seconds) * 1000)
          const payload = {
            enabled: Boolean(form.enabled),
            delayMs: Number.isFinite(delayMs) ? delayMs : 1000,
            minWords: Number(form.minWords) || 2,
            minChars: Number(form.minChars) || 0,
            maxChars: Number(form.maxChars) || 6000,
            language: String(form.language || 'auto'),
            provider: String(form.provider || ''),
            model: String(form.model || ''),
            polishTone: String(form.polishTone || 'concise'),
            polishContext: Boolean(form.polishContext),
            sendPreview: Boolean(form.sendPreview),
            liveChecks: Boolean(form.liveChecks),
          }
          const saved = await postJson('/config', payload)
          if (saved.config) {
            bus.publish(saved.config)
            setForm(saved.config)
            setSeconds(String((saved.config.delayMs / 1000).toFixed(1)))
          }
          setNote('Settings saved')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      async function testCheck() {
        setBusy(true)
        setNote(null)
        setError(null)
        try {
          const data = await postJson('/check', { text: 'i has a apple and it are good', language: form.language })
          const count = Array.isArray(data.edits) ? data.edits.length : 0
          const via = data.model ? `${data.model.provider} · ${data.model.model}` : 'the model'
          setNote(count === 0
            ? `Reached ${via}, but it found nothing to change.`
            : `Reached ${via}: ${count} change${count === 1 ? '' : 's'} on the sample.`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const inputStyle = {
        font: 'inherit', fontSize: '12.5px', padding: '6px 9px', borderRadius: '7px',
        border: '1px solid color-mix(in oklab, currentColor 25%, transparent)',
        background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box',
      }
      const rowStyle = { display: 'flex', gap: '16px', alignItems: 'flex-start', padding: '10px 0',
        borderTop: '1px solid color-mix(in oklab, currentColor 10%, transparent)' }
      const labelCell = { flex: '0 0 180px', paddingTop: '4px', fontSize: '12.5px', fontWeight: 600 }
      const fieldCell = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }
      const hint = { fontSize: '11px', opacity: 0.62, lineHeight: '1.4' }
      const sectionTitle = { margin: '18px 0 2px', fontSize: '12px', textTransform: 'uppercase',
        letterSpacing: '0.05em', opacity: 0.6 }

      function row(label, control, hintText) {
        return h('div', { key: label, style: rowStyle },
          h('div', { style: labelCell }, label),
          h('div', { style: fieldCell }, control, hintText ? h('div', { style: hint }, hintText) : null),
        )
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '620px' } },
        h('h3', { style: { margin: '0 0 4px' } }, 'Composer coach'),
        h('p', { style: { ...hint, margin: '0 0 6px', fontSize: '12px' } },
          'Checks the composer once you have typed a couple of words and paused, and shows a card over the changed word.'),

        h('div', { style: sectionTitle }, 'Behaviour'),
        row('Enabled',
          h('input', {
            type: 'checkbox', checked: Boolean(form.enabled),
            onChange: event => update('enabled', event.target.checked),
          }),
          'Turn off to stop all checks and model calls.'),
        row('Live checks in the composer',
          h('input', {
            type: 'checkbox', checked: Boolean(form.liveChecks),
            onChange: event => update('liveChecks', event.target.checked),
          }),
          'On: suggestions and the Polish pill appear while you type. Off: the composer stays silent and results show only in the send preview.'),
        row('Pause before checking',
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('input', {
              type: 'number', min: '0', max: '10', step: '0.1', value: seconds,
              onChange: event => setSeconds(event.target.value),
              style: { ...inputStyle, width: '90px' },
              'aria-label': 'Delay in seconds before a grammar check',
            }),
            h('span', { style: hint }, 'seconds'),
          ),
          '0 checks as you type. 0.4–0.6 s is usually the best balance.'),
        row('Start after',
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('input', {
              type: 'number', min: '1', max: '50', value: form.minWords,
              onChange: event => update('minWords', event.target.value),
              style: { ...inputStyle, width: '90px' },
              'aria-label': 'Minimum words before a check runs',
            }),
            h('span', { style: hint }, 'words'),
          ),
          'Shorter drafts are left alone.'),
        row('Maximum length',
          h('input', {
            type: 'number', min: '100', max: '20000', value: form.maxChars,
            onChange: event => update('maxChars', event.target.value),
            style: { ...inputStyle, width: '120px' },
          }),
          'Longer drafts are refused rather than sent.'),
        row('Language',
          h('input', {
            type: 'text', value: form.language, placeholder: 'auto or en',
            onChange: event => update('language', event.target.value),
            style: { ...inputStyle, maxWidth: '200px' },
          }),
          'Auto keeps whatever language the draft is in.'),

        h('div', { style: sectionTitle }, 'Model'),
        row('Provider',
          h('input', {
            type: 'text', value: form.provider, placeholder: 'profile default',
            onChange: event => update('provider', event.target.value),
            list: 'gc-providers', style: { ...inputStyle, maxWidth: '260px' },
          }),
          null),
        row('Model',
          h('input', {
            type: 'text', value: form.model, placeholder: 'profile default',
            onChange: event => update('model', event.target.value),
            list: 'gc-models', style: { ...inputStyle, maxWidth: '260px' },
          }),
          lastModel !== null
            ? `Last answer came from ${lastModel.provider} · ${lastModel.model}.`
            : (routes.length === 0
              ? 'No models listed for this provider; type an id such as deepseek-v4-flash.'
              : 'Leave both empty to use the profile default.')),
        h('datalist', { id: 'gc-providers' },
          routes.map(route => h('option', { key: route.provider, value: route.provider }))),
        h('datalist', { id: 'gc-models' },
          routes.flatMap(route => (route.models || []).map(model => h('option', {
            key: `${route.provider}|${model}`, value: model, label: `${route.provider} · ${model}`,
          })))),

        h('div', { style: sectionTitle }, 'Polish'),
        row('Style',
          h('select', {
            value: form.polishTone,
            onChange: event => update('polishTone', event.target.value),
            style: { ...inputStyle, maxWidth: '200px' },
          },
            h('option', { value: 'concise' }, 'Concise'),
            h('option', { value: 'detailed' }, 'Detailed'),
            h('option', { value: 'technical' }, 'Technical'),
          ),
          null),
        row('Preview before sending',
          h('input', {
            type: 'checkbox', checked: Boolean(form.sendPreview),
            onChange: event => update('sendPreview', event.target.checked),
          }),
          'Enter opens a card with the grammar-corrected and polished text, and you choose which one to send.'),
        row('Use conversation context',
          h('input', {
            type: 'checkbox', checked: Boolean(form.polishContext),
            onChange: event => update('polishContext', event.target.checked),
          }),
          'Sends the last turns of this session with the draft, so the rewrite fits what you are doing. Off sends only the draft.'),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '18px 0 6px' } },
          h('button', { type: 'button', className: 'gc-btn gc-btn-primary', onClick: save, disabled: busy || !ready },
            busy ? 'Working…' : 'Save'),
          h('button', { type: 'button', className: 'gc-btn', onClick: testCheck, disabled: busy || !ready },
            'Run a test check'),
        ),
        note !== null ? h('div', { style: { color: 'var(--dsh-color-success, #2e7d32)', fontSize: '12px' } }, note) : null,
        error !== null ? h('div', { style: { color: 'var(--dsh-color-danger, #c0392b)', fontSize: '12px' } }, error) : null,
      )
    }

    /** Sparkle mark used by the floating polish control. */
    function PolishIcon(props) {
      const size = props?.size ?? 14
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M12 3.5l1.5 4.2 4.2 1.5-4.2 1.5L12 15l-1.5-4.3L6.3 9.2l4.2-1.5z' }),
        h('path', { d: 'M18.4 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }),
      )
    }

    function SettingsIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M4 6h16' }),
        h('path', { d: 'M4 12h10' }),
        h('path', { d: 'M4 18h7' }),
        h('path', { d: 'M17.5 15.5l2.5 2.5 3-3' }),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ensureStyles(), 'composer-coach: styles')

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'composer-coach',
        order: 40,
      }, GrammarDock))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'composer-coach',
        order: 120,
        label: () => 'Composer coach',
      }, GrammarSettings))

      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'composer-coach',
        order: 120,
        label: () => 'Composer coach',
      }, SettingsIcon))
    }

    return { inject: ['slots'], apply }
  },
})
