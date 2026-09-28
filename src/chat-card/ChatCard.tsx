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
 */
import { useEffect, useEffectEvent, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { createPortal } from "react-dom"
import { z } from "zod"
import type { HostBridge } from "./bridge"
import { startCardEditor, type CardEditor, type EmbedRef } from "./cardEditor"
import { cardReducer, INITIAL_CARD_STATE } from "./cardState"
import { CardView, EditorFrame, EmbedFigure, type CardPreview } from "./CardView"
import { ComponentPreview, type PreviewOutcome } from "./preview/ComponentPreview"
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
  if (outcome.errors.length === 0) return null
  const errors = outcome.errors.map((error) => `${error.name}: ${error.message}`).join(" ")
  return `The preview of ${path} in the elaborat.ing card showed errors from its components. ${errors}`
}

export function ChatCard({ host }: { host: HostBridge }) {
  const [state, dispatch] = useReducer(cardReducer, INITIAL_CARD_STATE)
  const [canCallTools, setCanCallTools] = useState(false)
  const editor = useRef<CardEditor | null>(null)
  // The last result the host sent, drawn again if ChatGPT's globals bring its _meta late.
  const lastResult = useRef<unknown>(null)
  // One id per attempt at saving one text, so a retried save is never applied twice.
  const attempt = useRef<{ content: string; id: string | undefined } | null>(null)
  // How the components' preview of the file shown went; it starts again for each file, and after an edit.
  const [previewed, setPreviewed] = useState<{ file: CardFile; outcome: PreviewOutcome } | null>(null)
  // A link clicked in the preview, waiting for the person to open it.
  const [asked, setAsked] = useState<{ file: CardFile; url: string } | null>(null)

  useEffect(
    () =>
      host.subscribe((event) => {
        switch (event.type) {
          case "tool-input": {
            const input = inputSchema.safeParse(event.args)
            if (input.success) dispatch({ type: "input", path: input.data.path })
            return
          }
          case "tool-result": {
            lastResult.current = event.result
            const shown = parseShowResult(event.result, host.openaiMeta())
            dispatch(shown.ok ? { type: "result", file: shown.file } : { type: "problem", message: shown.message, tone: "danger" })
            return
          }
          case "tool-cancelled":
            return dispatch({ type: "problem", message: "The tool call was cancelled.", tone: "info" })
          case "ready":
            return setCanCallTools(event.canCallTools)
          case "globals": {
            if (lastResult.current === null || hasMeta(lastResult.current)) return
            const shown = parseShowResult(lastResult.current, host.openaiMeta())
            if (shown.ok) dispatch({ type: "result", file: shown.file })
            return
          }
        }
      }),
    [host],
  )

  const shown = state.phase === "shown" ? state : null
  const previewFile = shown && shown.mode === "read" && shown.file.components !== null ? shown.file : null
  const outcome = previewFile && previewed?.file === previewFile ? previewed.outcome : null
  const preview: CardPreview | null = previewFile
    ? {
        frame: (
          <ComponentPreview
            file={previewFile}
            onOutcome={(next) => {
              setPreviewed({ file: previewFile, outcome: next })
              const note = previewFile.kind === "component" ? previewNote(previewFile.path, next) : null
              if (note) host.tellModel(note)
            }}
            onLink={(href) => {
              const url = linkUrl(href, previewFile.url ?? APP_ORIGIN)
              if (url) setAsked({ file: previewFile, url })
            }}
          />
        ),
        status: outcome?.status ?? "loading",
        message: outcome?.status === "failed" ? outcome.message : null,
        link:
          asked?.file === previewFile
            ? {
                url: asked.url,
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
        canEdit={canCallTools}
        editor={
          shown && shown.mode !== "read" && shown.file.source !== null ? (
            <NoteEditor
              file={shown.file}
              onReady={(started) => {
                editor.current = started
                dispatch({ type: "editor-ready" })
              }}
              onFail={(error) => {
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
          dispatch({ type: "start-edit" })
        }}
        onSave={() => void save()}
        onCancel={() => dispatch({ type: "cancel" })}
        onReload={() => shown && void reload(shown.file, null)}
      />
    </main>
  )
}

type Island = { id: number; host: HTMLElement; embed: CardEmbed }

/**
 * The app's rendered editor on the note's source (cardEditor.ts), for as long
 * as it is on screen. Its embeds show the drawings the server drew, in the
 * library's embed box.
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
    return startCardEditor({
      mount: element,
      text: file.source ?? "",
      format: file.path.toLowerCase().endsWith(".mdx") ? "mdx" : "md",
      embed,
      notice: (text) => onNotice(text),
      change: (dirty) => onChange(dirty),
    })
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
