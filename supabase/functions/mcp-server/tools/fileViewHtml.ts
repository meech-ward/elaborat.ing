import { CARD_EDITOR_SCRIPT } from './cardEditorScript.ts'

// The HTML an MCP Apps host (Claude, ChatGPT) renders for show_file, in a
// sandboxed frame. It is self-contained: inline CSS and script, system fonts,
// and no network requests, so it runs under the spec's default policy with no
// `_meta.ui.csp`. It talks to the host over the MCP Apps postMessage bridge:
// ui/initialize, then the tool-input and tool-result notifications, theme
// changes, size changes and ui/open-link. Drawings arrive as SVG the server
// drew, in the result's `_meta` (which the host passes to the view and keeps
// from the model); in dark mode they go through Excalidraw's own dark filter.
//
// A note can be edited in place where the host lets views call tools: Edit
// opens the app's rendered editor on the note's source (sent in `_meta` too),
// built into CARD_EDITOR_SCRIPT, and Save calls write_file through the bridge
// with the version the card showed, so a note changed since then is a
// conflict, never overwritten. After a save the card reloads itself with
// show_file and tells the model with ui/update-model-context.
// https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

/** The spec version this view speaks. */
const PROTOCOL_VERSION = '2026-01-26'

/** The app's Supabase Green palette (src/features/appearance/palettes.ts). */
const LIGHT = {
  bg: '#F6F8F7',
  panel: '#FFFFFF',
  'panel-border': '#E2E6E4',
  text: '#121413',
  muted: '#555C58',
  accent: '#097C4F',
  'accent-text': '#FFFFFF',
  'accent-soft': '#DCF5E8',
  'accent-soft-text': '#065C3A',
  seg: '#EDF0EE',
  'warn-bg': '#FFF4D6',
  'warn-text': '#6B4700',
  'code-head': '#6B3FD0',
  'code-key': '#2A5BC9',
  'code-str': '#A8560A',
  'code-kw': '#B42A76',
}

const DARK: typeof LIGHT = {
  bg: '#131413',
  panel: '#1C1D1C',
  'panel-border': '#2E302F',
  text: '#EDEFEE',
  muted: '#B2B5B3',
  accent: '#3ECF8E',
  'accent-text': '#07231A',
  'accent-soft': '#0F3323',
  'accent-soft-text': '#85E0BA',
  seg: '#242624',
  'warn-bg': '#3A2C0E',
  'warn-text': '#F5D27A',
  'code-head': '#C49BFF',
  'code-key': '#72A6FF',
  'code-str': '#F5A55A',
  'code-kw': '#F28AC0',
}

const tokens = (colors: typeof LIGHT, scheme: string) =>
  Object.entries(colors).map(([name, value]) => `--${name}:${value};`).join('') + `color-scheme:${scheme};`

const STYLE = `
:root{${tokens(LIGHT, 'light')}
  --ui-font:"Space Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --code-font:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:root[data-theme="dark"]{${tokens(DARK, 'dark')}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${tokens(DARK, 'dark')}}}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:14px/1.6 var(--ui-font);color:var(--text);-webkit-font-smoothing:antialiased}
.card{display:flex;flex-direction:column;gap:12px;padding:14px 16px 16px;border:1px solid var(--panel-border);border-radius:14px;background:var(--panel)}
.head{display:flex;align-items:center;gap:10px;min-width:0}
.kind{flex:none;padding:2px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent-soft-text);font:600 11px/18px var(--ui-font);letter-spacing:.02em}
.names{min-width:0}
.name{overflow:hidden;font-weight:600;white-space:nowrap;text-overflow:ellipsis}
.path{overflow:hidden;color:var(--muted);font:12px/1.5 var(--code-font);white-space:nowrap;text-overflow:ellipsis}
.skel{display:grid;gap:8px}
.skel span{height:10px;border-radius:5px;background:var(--bg)}
.skel span:nth-child(2){width:80%}.skel span:nth-child(3){width:55%}
.doc{position:relative;overflow-wrap:anywhere}
.doc>:first-child{margin-top:0}.doc>:last-child{margin-bottom:0}
.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{margin:1em 0 .4em;font-weight:600;line-height:1.3}
.doc h1{font-size:20px}.doc h2{font-size:17px}.doc h3{font-size:15px}.doc h4,.doc h5,.doc h6{font-size:14px}
.doc p,.doc ul,.doc ol,.doc blockquote,.doc pre,.doc table{margin:.6em 0}
.doc ul,.doc ol{padding-left:1.4em}
.doc li::marker{color:var(--muted)}
.doc a{color:var(--accent-soft-text);text-decoration:underline;text-underline-offset:2px}
.doc code{padding:0 4px;border:1px solid var(--panel-border);border-radius:5px;background:var(--bg);color:var(--code-str);font:.9em/1.5 var(--code-font)}
.doc pre{overflow-x:auto;padding:10px 12px;border:1px solid var(--panel-border);border-radius:10px;background:var(--bg)}
.doc pre code{padding:0;border:0;background:none;color:var(--text);font-size:12.5px;line-height:1.6}
.doc blockquote{padding-left:12px;border-left:3px solid var(--accent);color:var(--muted)}
.doc hr{height:0;margin:1em 0;border:0;border-top:1px solid var(--panel-border)}
.doc table{display:block;overflow-x:auto;border-collapse:collapse}
.doc th,.doc td{padding:4px 10px;border:1px solid var(--panel-border);text-align:left}
.doc th{background:var(--bg);font-weight:600}
.doc input[type=checkbox]{accent-color:var(--accent);margin:0 6px 0 0}
.doc li:has(>input[type=checkbox]){list-style:none}
.note{margin:0;color:var(--muted);font-size:13px}
.art{overflow:hidden}
.art svg{display:block;max-width:100%;height:auto;max-height:420px;margin:0 auto}
.art .label-bg{fill:var(--panel)}
:root[data-theme="dark"] .art svg{filter:invert(93%) hue-rotate(180deg)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .art svg{filter:invert(93%) hue-rotate(180deg)}}
/* The dark panel colour, before the dark filter turns it back into itself. */
:root[data-theme="dark"] .art .label-bg{fill:#f3f2f3}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .art .label-bg{fill:#f3f2f3}}
.doc figure.embed{display:grid;gap:8px;margin:.8em 0;padding:10px 12px;border:1px solid var(--panel-border);border-radius:10px}
.doc figure.embed .art svg{max-height:300px}
.doc figcaption{display:flex;align-items:center;gap:8px;min-width:0;font:12px/1.5 var(--code-font)}
.doc figcaption a{overflow:hidden;color:var(--muted);white-space:nowrap;text-overflow:ellipsis}
.foot{display:flex;align-items:center;justify-content:space-between;gap:12px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.btn{display:inline-flex;align-items:center;min-height:32px;margin:0;padding:0 14px;border:1px solid transparent;border-radius:9px;background:var(--accent);color:var(--accent-text);font:600 13px/1 var(--ui-font);text-decoration:none;cursor:pointer}
.btn.quiet{border-color:var(--panel-border);background:var(--seg);color:var(--text)}
.btn:disabled{opacity:.55;cursor:default}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.version{color:var(--muted);font:12px var(--code-font)}
.status{margin:0;color:var(--muted);font-size:13px}
.status.warn{padding:8px 10px;border-radius:9px;background:var(--warn-bg);color:var(--warn-text)}
@media (pointer:coarse){.btn{min-height:44px}}
.editor{padding:10px 12px;border:1px solid var(--accent);border-radius:10px}
.editor .ProseMirror{min-height:3em;outline:none;white-space:pre-wrap;word-wrap:break-word;font-variant-ligatures:none;caret-color:var(--accent)}
.editor .ProseMirror>:first-child{margin-top:0}.editor .ProseMirror>:last-child{margin-bottom:0}
.editor .ProseMirror li{position:relative}
.editor .ProseMirror-hideselection *::selection{background:transparent}
.editor .ProseMirror-selectednode{outline:2px solid var(--accent)}
.editor [data-fluid-object]{cursor:default;user-select:none}
.editor div[data-fluid-object]{margin:.6em 0}
.editor [data-fluid-object] figure.embed{margin:0}
.editor .island-source{margin:0;color:var(--muted);font:12.5px/1.6 var(--code-font);white-space:pre-wrap}
.editor code.island-source{white-space:normal}
[hidden]{display:none!important}
`

// Plain script: it reads only the tool result, and puts HTML into the page
// only from `html`, which the server rendered and sanitized, and from the
// SVG the server drew, which escapes every value it takes from the file.
// The note editor builds its own DOM from the note's source, as text.
const SCRIPT = `
(() => {
  const root = document.documentElement
  const $ = (id) => document.getElementById(id)
  const KINDS = { note: 'Note', drawing: 'Drawing', diagram: 'Diagram', file: 'File' }
  const CARD_NOTES = {
    drawing: 'Drawings open in elaborat.ing.',
    diagram: 'Diagrams open in elaborat.ing.',
    file: 'Open this file in elaborat.ing.',
  }
  const EMBED_NOTES = {
    drawn: 'Open it in elaborat.ing to see it.',
    stale: 'Its source changed after this was drawn. Open it in elaborat.ing to redraw it.',
    not_drawn: 'Open it in elaborat.ing to draw it.',
    missing: 'No file at this path.',
    unreadable: 'This drawing could not be read.',
    empty: 'This drawing is empty.',
    too_big: 'Too big to show here. Open it in elaborat.ing.',
    not_shown: 'Open the note in elaborat.ing to see it.',
    unsupported: 'Only drawings and diagrams are shown here.',
  }
  const SVG_KEY = 'elaborat.ing/svg'
  const SOURCE_KEY = 'elaborat.ing/source'
  const HTML_KEY = 'elaborat.ing/html'
  const APP = 'https://elaborat.ing/'
  const pending = new Map()
  let nextId = 1
  let hostCapabilities = {}
  let fileUrl = APP
  let lastResult = null
  // The note on show: its tool result fields, its source and drawings, for editing.
  let shown = null
  let editor = null
  let busy = false

  const post = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*')
  const notify = (method, params) => post({ method, params: params || {} })
  const request = (method, params) => {
    const id = nextId++
    post({ id, method, params })
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  // Calls one of this server's tools through the host. ChatGPT also offers window.openai.callTool.
  const canCallTools = () => !!hostCapabilities.serverTools || !!(window.openai && typeof window.openai.callTool === 'function')
  function callTool(name, args) {
    if (hostCapabilities.serverTools || !(window.openai && window.openai.callTool)) return request('tools/call', { name, arguments: args })
    return window.openai.callTool(name, args)
  }

  function applyContext(context) {
    if (!context) return
    if (context.theme === 'light' || context.theme === 'dark') root.dataset.theme = context.theme
    const insets = context.safeAreaInsets
    if (insets) {
      document.body.style.padding = [insets.top, insets.right, insets.bottom, insets.left]
        .map((value) => (Number(value) || 0) + 'px').join(' ')
    }
  }

  function setHeader(kind, path) {
    $('kind').textContent = KINDS[kind] || KINDS.file
    $('kind').hidden = false
    $('name').textContent = path.split('/').pop() || path
    $('path').textContent = path
  }

  function setStatus(message, warn) {
    $('status').textContent = message || ''
    $('status').className = warn ? 'status warn' : 'status'
    $('status').hidden = !message
  }

  function showProblem(message) {
    $('card').removeAttribute('aria-busy')
    $('skel').hidden = true
    $('kind').hidden = true
    $('name').textContent = 'This file could not be shown'
    $('path').textContent = ''
    $('note').textContent = message
    $('note').hidden = false
  }

  // ChatGPT also hands the result's _meta to window.openai.
  function metaOf(result) {
    const meta = result._meta || (window.openai && window.openai.toolResponseMetadata) || {}
    return meta && typeof meta === 'object' ? meta : {}
  }
  function svgsOf(result) {
    const svgs = metaOf(result)[SVG_KEY]
    return svgs && typeof svgs === 'object' ? svgs : {}
  }

  // The embed's drawing, or null when it has none to show.
  function artFor(embed, svgs) {
    const svg = embed.status === 'drawn' || embed.status === 'stale' ? svgs[embed.path] : null
    if (typeof svg !== 'string' || !svg.startsWith('<svg')) return null
    const art = document.createElement('div')
    art.className = 'art'
    art.setAttribute('role', 'img')
    art.setAttribute('aria-label', (KINDS[embed.kind] || KINDS.file) + ' ' + embed.path)
    art.innerHTML = svg
    return art
  }

  const noteFor = (embed) => EMBED_NOTES[embed.status] || EMBED_NOTES.drawn

  // The drawing (or a note about it) and a caption linking to its file.
  function figureParts(embed, svgs) {
    let art = artFor(embed, svgs)
    if (!art) {
      art = document.createElement('p')
      art.className = 'note'
      art.textContent = noteFor(embed)
    }
    const parts = [art]
    if (embed.status === 'stale' && art.className === 'art') {
      const stale = document.createElement('p')
      stale.className = 'note'
      stale.textContent = noteFor(embed)
      parts.push(stale)
    }
    const caption = document.createElement('figcaption')
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = KINDS[embed.kind] || KINDS.file
    const link = document.createElement('a')
    link.textContent = embed.path
    if (typeof embed.url === 'string' && embed.url.startsWith(APP)) link.href = embed.url
    caption.append(kind, link)
    return [...parts, caption]
  }

  function fillFigures(doc, embeds, svgs) {
    for (const figure of doc.querySelectorAll('figure[data-embed]')) {
      const embed = embeds[Number(figure.dataset.embed)]
      if (!embed || typeof embed.path !== 'string') { figure.remove(); continue }
      figure.replaceChildren(...figureParts(embed, svgs))
    }
  }

  function showInput(args) {
    if (args && typeof args.path === 'string') setHeader('file', args.path)
  }

  function showResult(result) {
    const view = result && result.structuredContent
    if (!result || result.isError || !view || typeof view.path !== 'string') {
      const first = result && Array.isArray(result.content) ? result.content[0] : null
      showProblem(first && typeof first.text === 'string' ? first.text : 'Something went wrong.')
      return
    }
    lastResult = result
    closeEditor()
    $('card').removeAttribute('aria-busy')
    $('skel').hidden = true
    setHeader(view.kind, view.path)
    const embeds = Array.isArray(view.embeds) ? view.embeds : []
    const svgs = svgsOf(result)
    const source = metaOf(result)[SOURCE_KEY]
    shown = {
      view,
      embeds,
      svgs,
      source: view.kind === 'note' && !view.truncated && typeof source === 'string' ? source : null,
    }
    if (typeof view.url === 'string' && view.url.startsWith(APP)) {
      fileUrl = view.url
      $('open').href = view.url
      $('foot').hidden = false
    }
    $('version').textContent = typeof view.version === 'number' ? 'v' + view.version : ''
    const doc = $('doc')
    $('art').hidden = true
    const html = metaOf(result)[HTML_KEY]
    if (view.kind === 'note' && typeof html === 'string') {
      doc.innerHTML = html
      fillFigures(doc, embeds, svgs)
      doc.hidden = false
      // The whole note shows; only a note longer than the server's limit is cut.
      $('note').textContent = 'Open in elaborat.ing to read the rest.'
      $('note').hidden = !view.truncated
    } else if ((view.kind === 'drawing' || view.kind === 'diagram') && embeds[0]) {
      doc.hidden = true
      const art = artFor(embeds[0], svgs)
      $('art').replaceChildren(...(art ? [art] : []))
      $('art').hidden = !art
      const stale = !!art && embeds[0].status === 'stale'
      $('note').textContent = art && !stale ? '' : noteFor(embeds[0])
      $('note').hidden = !!art && !stale
    } else {
      doc.hidden = true
      $('note').textContent = CARD_NOTES[view.kind] || CARD_NOTES.file
      $('note').hidden = false
    }
    setMode('read')
  }

  // Which buttons show: read (Open, Edit), edit (Save, Cancel), conflict (Load latest, Cancel).
  function setMode(mode) {
    const editable = !!(shown && shown.source !== null && canCallTools() && window.elaboratingCardEditor)
    $('open').hidden = mode !== 'read'
    $('edit').hidden = mode !== 'read' || !editable
    $('save').hidden = mode !== 'edit'
    $('cancel').hidden = mode === 'read'
    $('reload').hidden = mode !== 'conflict'
    for (const id of ['edit', 'save', 'cancel', 'reload']) $(id).disabled = busy
  }

  function closeEditor() {
    if (editor) editor.destroy()
    editor = null
    $('editor').replaceChildren()
    $('editor').hidden = true
    setStatus('')
  }

  function cancelEdit() {
    closeEditor()
    $('doc').hidden = false
    setMode('read')
  }

  // A drawn embed for the editor, from what the server drew for this note.
  function embedFor(ref) {
    const embed = shown && shown.embeds.find((entry) => entry && entry.path === ref.path)
    if (!embed) return null
    const figure = document.createElement('figure')
    figure.className = 'embed'
    figure.replaceChildren(...figureParts(embed, shown.svgs))
    return figure
  }

  async function startEdit() {
    if (!shown || shown.source === null || editor || busy) return
    busy = true
    setMode('read')
    const mount = $('editor')
    try {
      const format = shown.view.path.toLowerCase().endsWith('.mdx') ? 'mdx' : 'md'
      mount.hidden = false
      $('doc').hidden = true
      editor = await window.elaboratingCardEditor.start({
        mount,
        text: shown.source,
        format,
        embed: embedFor,
        notice: (message) => setStatus(message, true),
        change: (dirty) => { $('save').disabled = busy || !dirty },
      })
      busy = false
      setMode('edit')
      $('save').disabled = true
      setStatus('Editing. Embeds and other MDX stay as they are.')
      const prose = mount.querySelector('.ProseMirror')
      if (prose) prose.focus()
    } catch (error) {
      console.error('The note editor could not start.', error)
      busy = false
      closeEditor()
      $('doc').hidden = false
      setMode('read')
      setStatus('This note cannot be edited here. Open it in elaborat.ing to change it.', true)
    }
  }

  const newId = () => (window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : undefined)
  // One id per attempt at saving one text, so a retried save is never applied twice.
  let attempt = null

  async function save() {
    if (!editor || busy || !shown) return
    busy = true
    setMode('edit')
    setStatus('Saving')
    const { view } = shown
    try {
      const content = await editor.source()
      if (content === shown.source) {
        busy = false
        cancelEdit()
        return
      }
      if (!attempt || attempt.content !== content) attempt = { content, id: newId() }
      const args = { project_id: view.project_id, path: view.path, content, base_version: view.version }
      if (attempt.id) args.mutation_id = attempt.id
      const result = await callTool('write_file', args)
      const saved = result && result.structuredContent
      if (!result || result.isError || !saved) {
        const first = result && Array.isArray(result.content) ? result.content[0] : null
        throw new Error(first && typeof first.text === 'string' ? first.text : 'Saving failed.')
      }
      if (saved.status === 'conflict') {
        busy = false
        setMode('conflict')
        setStatus('This note changed since it was loaded, so your edit was not saved. Load the latest version to edit it again.', true)
        return
      }
      attempt = null
      const change = Array.isArray(saved.changes) ? saved.changes.find((entry) => entry && entry.path === view.path) : null
      const version = change && typeof change.version === 'number' ? change.version : null
      tellModel(view.path, version)
      await reload(version)
    } catch (error) {
      busy = false
      setMode('edit')
      $('save').disabled = false
      const message = error && typeof error.message === 'string' ? error.message : ''
      setStatus(message ? 'Not saved: ' + message : 'Not saved. Try again.', true)
    }
  }

  // The model learns about the edit on its next turn; the chat is not interrupted.
  function tellModel(path, version) {
    const text = 'The user edited ' + path + ' in the elaborat.ing card and saved it' +
      (version ? ' as version ' + version : '') + '. Read it again before changing it.'
    request('ui/update-model-context', { content: [{ type: 'text', text }] }).catch(() => {})
  }

  // Shows the note as saved now, from the server.
  async function reload(savedVersion) {
    const view = shown && shown.view
    if (!view) return
    busy = true
    setMode($('reload').hidden ? 'edit' : 'conflict')
    try {
      const result = await callTool('show_file', { project_id: view.project_id, path: view.path })
      busy = false
      if (!result || result.isError || !result.structuredContent) throw new Error('reload')
      showResult(result)
      if (savedVersion) setStatus('Saved as v' + savedVersion + '.')
    } catch {
      busy = false
      if (savedVersion) {
        // Saved, but the card could not load it: keep editing from the saved text.
        shown.source = await editor.source()
        shown.view = { ...view, version: savedVersion }
        $('version').textContent = 'v' + savedVersion
        setMode('edit')
        $('save').disabled = true
        setStatus('Saved as v' + savedVersion + '.')
      } else {
        setMode('conflict')
        setStatus('The latest version could not be loaded. Open it in elaborat.ing.', true)
      }
    }
  }

  $('edit').addEventListener('click', startEdit)
  $('save').addEventListener('click', save)
  $('cancel').addEventListener('click', cancelEdit)
  $('reload').addEventListener('click', () => reload(null))
  document.addEventListener('keydown', (event) => {
    if (editor && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!$('save').hidden && !$('save').disabled) save()
    }
  })

  function openLink(href) {
    let url
    try { url = new URL(href, fileUrl) } catch { return }
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return
    const fallback = () => window.open(url.href, '_blank', 'noopener')
    if (hostCapabilities.openLinks) request('ui/open-link', { url: url.href }).catch(fallback)
    else fallback()
  }

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link) return
    event.preventDefault()
    // A link being edited is text to place the caret in, not a way out.
    if (link.closest('.ProseMirror') && !link.closest('[data-fluid-object]')) return
    openLink(link.getAttribute('href'))
  })

  function watchSize() {
    let last = ''
    let scheduled = false
    const send = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        const before = root.style.height
        root.style.height = 'max-content'
        const height = Math.ceil(root.getBoundingClientRect().height)
        root.style.height = before
        const width = Math.ceil(window.innerWidth)
        if (width + 'x' + height === last) return
        last = width + 'x' + height
        notify('ui/notifications/size-changed', { width, height })
      })
    }
    send()
    const observer = new ResizeObserver(send)
    observer.observe(root)
    observer.observe(document.body)
  }

  // If ChatGPT sets its globals after the result arrived without _meta, draw again.
  window.addEventListener('openai:set_globals', () => {
    if (lastResult && !lastResult._meta && !editor) showResult(lastResult)
  })

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || message.jsonrpc !== '2.0') return
    if (message.method === undefined) {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      if (message.error) waiting.reject(message.error)
      else waiting.resolve(message.result)
      return
    }
    switch (message.method) {
      case 'ui/notifications/tool-input': return editor ? undefined : showInput(message.params && message.params.arguments)
      case 'ui/notifications/tool-result': return editor ? undefined : showResult(message.params)
      case 'ui/notifications/tool-cancelled': return editor ? undefined : showProblem('The tool call was cancelled.')
      case 'ui/notifications/host-context-changed': return applyContext(message.params)
    }
    if (message.id === undefined) return
    if (message.method === 'ping' || message.method === 'ui/resource-teardown') post({ id: message.id, result: {} })
    else post({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  })

  request('ui/initialize', {
    appInfo: { name: 'elaborat.ing file view', version: '1.1.0' },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: '${PROTOCOL_VERSION}',
  }).then((result) => {
    hostCapabilities = (result && result.hostCapabilities) || {}
    applyContext(result && result.hostContext)
    notify('ui/notifications/initialized')
    watchSize()
    if (shown) setMode('read')
  }, () => {})
})()
`

export const FILE_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>elaborat.ing file</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card" id="card" aria-busy="true">
  <header class="head">
    <span class="kind" id="kind" hidden></span>
    <div class="names">
      <div class="name" id="name">Loading file</div>
      <div class="path" id="path"></div>
    </div>
  </header>
  <div class="skel" id="skel" aria-hidden="true"><span></span><span></span><span></span></div>
  <div class="doc" id="doc" hidden></div>
  <div class="doc editor" id="editor" hidden></div>
  <div id="art" hidden></div>
  <p class="note" id="note" hidden></p>
  <p class="status" id="status" role="status" hidden></p>
  <footer class="foot" id="foot" hidden>
    <div class="actions">
      <a class="btn" id="open" target="_blank" rel="noopener noreferrer">Open in elaborat.ing</a>
      <button class="btn quiet" id="edit" type="button" hidden>Edit</button>
      <button class="btn" id="save" type="button" hidden>Save</button>
      <button class="btn" id="reload" type="button" hidden>Load latest</button>
      <button class="btn quiet" id="cancel" type="button" hidden>Cancel</button>
    </div>
    <span class="version" id="version"></span>
  </footer>
</main>
<script>${CARD_EDITOR_SCRIPT}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
