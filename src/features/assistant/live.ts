import type { LiveHandle, LiveKind } from "@/chat-card/live/mount"
import { kindForPath } from "@/features/workbench/session"
import { moduleLoader } from "@/lib/moduleLoader"
import type { LiveDriver } from "./chat"

// The chat card's live view (src/chat-card/live/mount.ts), reused as it is:
// a note renders, a drawing sketches in, a diagram's code writes in. Its
// renderers are a chunk of their own, loaded when a write starts.
const mountModule = moduleLoader(() => import("@/chat-card/live/mount"))

/** The rendered note's type, as NoteProse sets it, for a note being written. */
const NOTE_CLASSES =
  "mx-auto flex max-w-[680px] flex-col gap-3.5 px-10 py-[30px] text-foreground max-sm:px-5 [&_h1]:m-0 [&_h1]:text-[32px] [&_h1]:leading-[1.15] [&_h1]:font-bold [&_h2]:mt-1.5 [&_h2]:mb-0 [&_h2]:text-[21px] [&_h2]:leading-[1.3] [&_h2]:font-semibold [&_li]:text-[15.5px] [&_li]:leading-[1.6] [&_li]:text-body [&_p]:m-0 [&_p]:text-[15.5px] [&_p]:leading-[1.6] [&_p]:text-body [&_ol]:list-decimal [&_ol]:pl-[22px] [&_ul]:list-disc [&_ul]:pl-[22px] [&_pre]:overflow-auto [&_pre]:rounded-tile [&_pre]:bg-seg [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px]"

type View = { overlay: HTMLElement; handle: LiveHandle | null; latest: string; ready: Promise<void> }

/**
 * Covers the editor area (`container`) with the live view of each file the
 * assistant writes, from its first line until its content lands.
 */
export function liveDriver(container: () => HTMLElement | null): LiveDriver {
  const views = new Map<string, View>()
  return {
    start(id, path) {
      const area = container()
      if (!area || views.has(id)) return
      const kind: LiveKind = kindForPath(path) === "drawing" ? "drawing" : kindForPath(path) === "note" ? "note" : "diagram"
      const overlay = document.createElement("section")
      overlay.dataset.assistantLive = path
      overlay.setAttribute("aria-label", `Assistant writing ${path}`)
      // On a phone it starts below the file's floating buttons.
      overlay.className = "absolute inset-0 z-20 flex flex-col overflow-hidden bg-background [[data-compact=true]_&]:pt-16"
      const label = document.createElement("p")
      label.className = "m-0 flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-xs text-muted-foreground"
      label.textContent = `Writing ${path}`
      const target = document.createElement("div")
      // A drawing in dark mode goes through Excalidraw's dark filter, as on the canvas; a label's backing is drawn light so the filter turns it dark.
      target.className =
        kind === "drawing"
          ? "relative min-h-0 flex-1 p-6 dark:[&_svg]:[filter:invert(93%)_hue-rotate(180deg)] dark:[&_.label-bg]:fill-[#fefefe]"
          : "relative flex min-h-0 flex-1 flex-col"
      if (kind !== "drawing") {
        const viewport = document.createElement("div")
        viewport.dataset.liveViewport = ""
        viewport.className = "min-h-0 flex-1 overflow-auto"
        if (kind === "note") {
          const content = document.createElement("div")
          content.dataset.liveContent = ""
          content.className = NOTE_CLASSES
          viewport.append(content)
        }
        target.append(viewport)
      }
      overlay.append(label, target)
      area.append(overlay)
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const view: View = { overlay, handle: null, latest: "", ready: Promise.resolve() }
      view.ready = mountModule.load().then(
        ({ mountLive }) => {
          if (views.get(id) !== view) return
          view.handle = mountLive(target, { kind, path, reducedMotion })
          view.handle.update(view.latest)
        },
        () => {
          // The renderers did not load: the overlay says what is being written until the content lands.
        },
      )
      views.set(id, view)
    },
    update(id, content) {
      const view = views.get(id)
      if (!view) return
      view.latest = content
      view.handle?.update(content)
    },
    async finish(id) {
      const view = views.get(id)
      if (!view) return
      await view.ready
      view.handle?.update(view.latest, true)
      await view.handle?.finish()
    },
    destroy(id) {
      const view = views.get(id)
      if (!view) return
      views.delete(id)
      view.handle?.destroy()
      view.overlay.remove()
    },
  }
}
