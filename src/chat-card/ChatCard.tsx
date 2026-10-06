/**
 * The chat card running in the host: it shows what the host passes it
 * (show_file's input and result) and, where the host lets it call tools,
 * edits the note in place. Save calls write_file with the version the card
 * showed, so a note changed since then is a conflict, never overwritten.
 * After a save the card reloads itself with show_file and tells the model
 * with ui/update-model-context.
 *
 * A note with components, and a component file from preview_component, are
 * previewed in a sandboxed frame of their own (preview/ComponentPreview.tsx)
 * that cannot reach the bridge; a note shows the server's HTML until its
 * preview has drawn, and again if the preview fails.
 *
 * The editor and the previews load from elaborat.ing when they are first
 * needed (modules.ts). Where the host does not allow that, the card stays
 * read-only with the server's HTML, and says why.
 *
 * Edit asks the host to show the card full screen, where it can, and the
 * card asks to go back inline when editing ends.
 *
 * create_and_show's card is live while the agent writes the new file: the
 * host's partial input draws in (the live module, loaded then), and the
 * saved card takes its place when the result comes. A host that sends no
 * partial input gets the same drawing in, quickly, from the input, while the
 * tool is still running.
 */
import { useEffect, useEffectEvent, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { createPortal } from "react-dom"
import { z } from "zod/mini"
import { DottedPage } from "@/components/panel"
import { NoteProse } from "@/features/design-system/ui/NoteProse"
import type { HostBridge } from "./bridge"
import type { CardEditor, EmbedRef } from "./cardEditor"
import { CARD_NOTE_CLASS } from "./cardNote"
import { cardReducer, CARD_TEXT, INITIAL_CARD_STATE, type LiveKind } from "./cardState"
import { CardView, EditorFrame, EmbedFigure, LoadingLines, type CardPreview } from "./CardView"
import { addCardFonts } from "./fonts"
import type { LiveHandle } from "./live/mount"
import { blockModules, loadModule, ModuleNotLoaded, modulesAllowed } from "./modules"
import { ComponentPreview, type LinkSpot, type PreviewOutcome } from "./preview/ComponentPreview"
import { APP_ORIGIN, hasMeta, parseShowResult, parseWriteResult, type CardEmbed, type CardFile } from "./toolResult"

const inputSchema = z.object({ path: z.string() })

const newId = () => (typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : undefined)

const modelNote = (path: string, version: number | null) =>
  `The user edited ${path} in the elaborat.ing card and saved it${version ? ` as version ${version}` : ""}. Read it again before changing it.`

/** A link from the preview as the host would open it: http(s) or mailto, made absolute; else null. */
function linkUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** What the model hears about a component preview that did not go cleanly, for its next turn; nothing when it did. */
function previewNote(path: string, outcome: PreviewOutcome): string | null {
  if (outcome.status === "failed") return `The preview of ${path} in the elaborat.ing card failed: ${outcome.message}`
  if (outcome.status === "asking" || outcome.errors.length === 0) return null
  const errors = outcome.errors.map((error) => `${error.name}: ${error.message}`).join(" ")
  return `The preview of ${path} in the elaborat.ing card showed errors from its components. ${errors}`
}

/** A new file create_and_show is writing, from its input: what it is and its content so far; null for any other input. */
function liveDraft(args: unknown): { path: string; kind: LiveKind; content: string } | null {
  const { path, content } = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>
  if (typeof path !== "string" || typeof content !== "string") return null
  const kind: LiveKind | null = /\.excalidraw(\.md)?$/i.test(path) ? "drawing" : /\.d2$/i.test(path) ? "diagram" : /\.mdx?$/i.test(path) ? "note" : null
  return kind && { path, kind, content }
}

/**
 * Carries a live file's content to its view, which may not have loaded yet:
 * the latest content waits for it. `final`: the whole input is in.
 */
type LiveFeed = {
  content: string | null
  final: boolean
  view: LiveHandle | null
  push(content: string, final: boolean): void
  attach(view: LiveHandle | null): void
}

function liveFeed(): LiveFeed {
  const feed: LiveFeed = {
    content: null,
    final: false,
    view: null,
    push(content, final) {
      feed.content = content
      feed.final ||= final
      feed.view?.update(content, final)
    },
    attach(view) {
      feed.view = view
      if (view && feed.content !== null) view.update(feed.content, feed.final)
    },
  }
  return feed
}

/** How long input that came with no partial input waits for the result: a result that comes with it shows the saved card at once. */
const LIVE_GRACE_MS = 100

export function ChatCard({ host }: { host: HostBridge }) {
  const [state, dispatch] = useReducer(cardReducer, INITIAL_CARD_STATE)
  const [feed] = useState(liveFeed)
  // The host said it does not allow the modules: a live card would only show its skeleton.
  const modulesBlocked = useRef(false)
  // The input came with no partial input before it: the card goes live if the result does not come at once.
  const graceTimer = useRef(0)
  const [canCallTools, setCanCallTools] = useState(false)
  // The editor could not load from elaborat.ing, or the host said it would not allow it.
  const [editorBlocked, setEditorBlocked] = useState(false)
  const editor = useRef<CardEditor | null>(null)
  // The last result the host sent, drawn again if ChatGPT's globals bring its _meta late.
  const lastResult = useRef<unknown>(null)
  // One id per attempt at saving one text, so a retried save is never applied twice.
  const attempt = useRef<{ content: string; id: string | undefined } | null>(null)
  // How the components' preview of the file shown went; it starts again for each file, and after an edit.
  const [previewed, setPreviewed] = useState<{ file: CardFile; outcome: PreviewOutcome } | null>(null)
  // A link clicked in the preview, waiting for the person to open it.
  const [asked, setAsked] = useState<{ file: CardFile; url: string; spot: LinkSpot | null } | null>(null)
  // The shared file whose custom component code the person chose to run; each file shown asks again.
  const [ran, setRan] = useState<CardFile | null>(null)
  // Edit asked the host for full screen, so the card goes back inline when editing ends.
  const expanded = useRef(false)

  useEffect(
    () =>
      host.subscribe((event) => {
        switch (event.type) {
          case "tool-input-partial": {
            const draft = modulesBlocked.current ? null : liveDraft(event.args)
            if (!draft) return
            feed.push(draft.content, false)
            return dispatch({ type: "live", path: draft.path, kind: draft.kind })
          }
          case "tool-input": {
            const input = inputSchema.safeParse(event.args)
            if (input.success) dispatch({ type: "input", path: input.data.path })
            const draft = modulesBlocked.current ? null : liveDraft(event.args)
            if (!draft) return
            if (feed.content !== null) return feed.push(draft.content, true)
            // No partial input: the input draws in quickly, unless the result comes with it (a conversation opened again).
            window.clearTimeout(graceTimer.current)
            graceTimer.current = window.setTimeout(() => {
              feed.push(draft.content, true)
              dispatch({ type: "live", path: draft.path, kind: draft.kind })
            }, LIVE_GRACE_MS)
            return
          }
          case "tool-result": {
            window.clearTimeout(graceTimer.current)
            lastResult.current = event.result
            const shown = parseShowResult(event.result, host.openaiMeta())
            if (!shown.ok) return dispatch({ type: "problem", message: shown.message, tone: "danger" })
            // A live view that has drawn finishes drawing quickly first, then the saved card takes its place.
            const view = feed.view
            if (!view) return dispatch({ type: "result", file: shown.file })
            void view.finish().then(() => dispatch({ type: "result", file: shown.file }))
            return
          }
          case "tool-cancelled":
            window.clearTimeout(graceTimer.current)
            return dispatch({ type: "problem", message: "The tool call was cancelled.", tone: "info" })
          case "ready":
            // The fonts and modules come from the origin the view declares, unless the host said it does not allow it.
            if (modulesAllowed(event.resourceDomains) === false) {
              modulesBlocked.current = true
              blockModules()
              setEditorBlocked(true)
            } else {
              addCardFonts(event.hostFonts)
            }
            return setCanCallTools(event.canCallTools)
          case "globals": {
            if (lastResult.current === null || hasMeta(lastResult.current)) return
            const shown = parseShowResult(lastResult.current, host.openaiMeta())
            if (shown.ok) dispatch({ type: "result", file: shown.file })
            return
          }
        }
      }),
    [host, feed],
  )

  const shown = state.phase === "shown" ? state : null
  const editing = shown !== null && shown.mode !== "read"
  useEffect(() => {
    if (editing || !expanded.current) return
    expanded.current = false
    host.requestDisplayMode("inline")
  }, [editing, host])
  const previewFile = shown && shown.mode === "read" && shown.file.components !== null ? shown.file : null
  const outcome = previewFile && previewed?.file === previewFile ? previewed.outcome : null
  // Custom component code from a project shared with the person runs only when they say so.
  const held = previewFile !== null && previewFile.shared && ran !== previewFile
  const preview: CardPreview | null = previewFile
    ? {
        frame: (
          <ComponentPreview
            file={previewFile}
            held={held}
            onOutcome={(next) => {
              setPreviewed({ file: previewFile, outcome: next })
              const note = previewFile.kind === "component" ? previewNote(previewFile.path, next) : null
              if (note) host.tellModel(note)
            }}
            onLink={(href, spot) => {
              const url = linkUrl(href, previewFile.url ?? APP_ORIGIN)
              if (url) setAsked({ file: previewFile, url, spot })
            }}
          />
        ),
        status: outcome?.status ?? "loading",
        message: outcome?.status === "failed" ? outcome.message : null,
        files: outcome?.status === "asking" ? outcome.files : undefined,
        onRun: () => {
          setRan(previewFile)
          setPreviewed(null)
        },
        link:
          asked?.file === previewFile
            ? {
                url: asked.url,
                spot: asked.spot,
                onOpen: () => {
                  setAsked(null)
                  host.openLink(asked.url, APP_ORIGIN)
                },
                onDismiss: () => setAsked(null),
              }
            : null,
      }
    : null

  /** Shows the note as saved now, from the server. */
  async function reload(file: CardFile, savedVersion: number | null) {
    dispatch({ type: "reloading" })
    try {
      const raw = await host.callTool("show_file", { project_id: file.projectId, path: file.path })
      const reloaded = parseShowResult(raw, host.openaiMeta())
      if (!reloaded.ok) throw new Error("reload")
      lastResult.current = raw
      dispatch({ type: "reloaded", file: reloaded.file, version: savedVersion })
    } catch {
      const current = editor.current
      if (savedVersion !== null && current) dispatch({ type: "saved-not-reloaded", source: await current.source(), version: savedVersion })
      else dispatch({ type: "reload-failed" })
    }
  }

  async function save() {
    const current = editor.current
    if (!shown || shown.mode !== "edit" || shown.busy || !current) return
    const { file } = shown
    dispatch({ type: "saving" })
    try {
      const content = await current.source()
      if (content === file.source) return dispatch({ type: "cancel" })
      if (attempt.current?.content !== content) attempt.current = { content, id: newId() }
      const args: Record<string, unknown> = { project_id: file.projectId, path: file.path, content, base_version: file.version }
      if (attempt.current.id) args.mutation_id = attempt.current.id
      const outcome = parseWriteResult(await host.callTool("write_file", args), file.path)
      if (outcome.kind === "failed") throw new Error(outcome.message)
      if (outcome.kind === "conflict") return dispatch({ type: "conflict" })
      attempt.current = null
      host.tellModel(modelNote(file.path, outcome.version))
      await reload(file, outcome.version)
    } catch (error) {
      dispatch({ type: "save-failed", message: error instanceof Error ? error.message : "" })
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!shown || shown.mode === "read" || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "s") return
    event.preventDefault()
    if (shown.mode === "edit" && !shown.busy && shown.dirty) void save()
  }

  // Every link opens through the host; a link being edited is text to place the caret in.
  function onClick(event: MouseEvent) {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (!link) return
    event.preventDefault()
    if (link.closest(".ProseMirror") && !link.closest("[data-fluid-object]")) return
    host.openLink(link.getAttribute("href") ?? "", shown?.file.url ?? APP_ORIGIN)
  }

  return (
    // The page's one landmark; it handles Save's shortcut and every link in the card.
    <main onKeyDown={onKeyDown} onClick={onClick}>
      <CardView
        state={state}
        canEdit={canCallTools && !editorBlocked}
        editNote={canCallTools && editorBlocked ? CARD_TEXT.editorNotLoaded : null}
        live={state.phase === "live" ? <LiveView kind={state.kind} path={state.path} feed={feed} /> : undefined}
        editor={
          shown && shown.mode !== "read" && shown.file.source !== null ? (
            <NoteEditor
              file={shown.file}
              onReady={(started) => {
                editor.current = started
                dispatch({ type: "editor-ready" })
              }}
              onFail={(error) => {
                if (error instanceof ModuleNotLoaded) {
                  setEditorBlocked(true)
                  return dispatch({ type: "cancel" })
                }
                console.error("The note editor could not start.", error)
                dispatch({ type: "editor-failed" })
              }}
              onNotice={(text) => dispatch({ type: "notice", text })}
              onChange={(dirty) => dispatch({ type: "dirty", dirty })}
              onClose={() => {
                editor.current = null
              }}
            />
          ) : undefined
        }
        preview={preview}
        onEdit={() => {
          setPreviewed(null)
          if (host.canFullscreen()) {
            expanded.current = true
            host.requestDisplayMode("fullscreen")
          }
          dispatch({ type: "start-edit" })
        }}
        onSave={() => void save()}
        onCancel={() => dispatch({ type: "cancel" })}
        onReload={() => shown && void reload(shown.file, null)}
      />
    </main>
  )
}

/**
 * A new file as it is written: the live module (loaded the first time)
 * draws into the card's own frame for it, at a fixed height so the card does
 * not resize as it grows: a drawing on the dotted canvas, a note in the
 * note's type, a diagram's source as the module sets it. Where the module does not
 * load, the card shows its skeleton.
 */
function LiveView({ kind, path, feed }: { kind: LiveKind; path: string; feed: LiveFeed }) {
  const box = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const start = useEffectEvent((element: HTMLElement) =>
    loadModule("live").then(({ mountLive }) =>
      mountLive(element, { kind, path, reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches }),
    ),
  )
  useEffect(() => {
    const element = box.current
    if (!element) return
    let stopped = false
    let running: LiveHandle | null = null
    start(element).then(
      (view) => {
        if (stopped) return view.destroy()
        running = view
        feed.attach(view)
      },
      () => {
        if (!stopped) setFailed(true)
      },
    )
    return () => {
      stopped = true
      feed.attach(null)
      running?.destroy()
    }
  }, [feed])

  if (failed) return <LoadingLines />
  if (kind === "drawing") {
    return (
      <DottedPage className="min-h-0 p-4 max-[500px]:p-3">
        <div ref={box} className="card-art relative h-[340px] max-[500px]:h-[280px]" />
      </DottedPage>
    )
  }
  return (
    <div ref={box} className="relative">
      <div data-live-viewport className="h-[340px] overflow-hidden max-[500px]:h-[280px]">
        {kind === "note" && (
          <NoteProse className={CARD_NOTE_CLASS}>
            <div data-live-content className="contents" />
          </NoteProse>
        )}
      </div>
    </div>
  )
}

type Island = { id: number; host: HTMLElement; embed: CardEmbed }

/**
 * The app's rendered editor on the note's source (cardEditor.ts, loaded the
 * first time), for as long as it is on screen. Its embeds show the drawings
 * the server drew, in the library's embed box.
 */
function NoteEditor({
  file,
  onReady,
  onFail,
  onNotice,
  onChange,
  onClose,
}: {
  file: CardFile
  onReady: (editor: CardEditor) => void
  onFail: (error: unknown) => void
  onNotice: (text: string | null) => void
  onChange: (dirty: boolean) => void
  onClose: () => void
}) {
  const mount = useRef<HTMLDivElement>(null)
  const [islands, setIslands] = useState<Island[]>([])

  // The editor starts once, from the note as it was when editing began.
  const start = useEffectEvent((element: HTMLElement) => {
    let next = 0
    const embed = (ref: EmbedRef) => {
      const found = file.embeds.find((entry) => entry?.path === ref.path)
      if (!found) return null
      const host = document.createElement("div")
      const id = next++
      setIslands((list) => [...list.filter((island) => island.host.isConnected), { id, host, embed: found }])
      return host
    }
    return loadModule("editor").then(({ startCardEditor }) =>
      startCardEditor({
        mount: element,
        text: file.source ?? "",
        format: file.path.toLowerCase().endsWith(".mdx") ? "mdx" : "md",
        embed,
        notice: (text) => onNotice(text),
        change: (dirty) => onChange(dirty),
      }),
    )
  })
  const ready = useEffectEvent((editor: CardEditor) => {
    onReady(editor)
    mount.current?.querySelector<HTMLElement>(".ProseMirror")?.focus()
  })
  const fail = useEffectEvent((error: unknown) => onFail(error))
  const close = useEffectEvent(() => onClose())

  useEffect(() => {
    const element = mount.current
    if (!element) return
    let stopped = false
    let running: CardEditor | null = null
    start(element).then(
      (editor) => {
        if (stopped) return editor.destroy()
        running = editor
        ready(editor)
      },
      (error) => {
        if (!stopped) fail(error)
      },
    )
    return () => {
      stopped = true
      running?.destroy()
      element.replaceChildren()
      close()
    }
  }, [])

  return (
    <EditorFrame>
      <div ref={mount} />
      {islands.map((island) => createPortal(<EmbedFigure embed={island.embed} svgs={file.svgs} />, island.host, String(island.id)))}
    </EditorFrame>
  )
}
