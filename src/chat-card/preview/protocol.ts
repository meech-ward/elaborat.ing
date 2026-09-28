/**
 * What the chat card and the component preview's frame say to each other,
 * over postMessage. The card builds the frame's document with the compiled
 * code in it (frameDocument.ts) and then sends it only data: what to show,
 * the drawings the server drew, sample props, the colours and fonts. The
 * frame sends back only its height, that it has drawn, what failed, and a
 * link someone clicked. The card checks every message the frame sends
 * (frameMessages.ts); the frame's code is the note's, so nothing it says is
 * trusted. No schema library here: the frame's bundle imports these types.
 */
import type { CardEmbed } from "../embedText"
import type { FontSource } from "../fontFaces"

/** The component the compiler wraps around each outermost element of a note, so one that throws shows an error in its place. */
export const GUARD_NAME = "PreviewGuard"

/** The colours and fonts the card has now: the host's scheme (none: the device's) and its font variables. */
export type PreviewAppearance = {
  scheme: "light" | "dark" | null
  /** --ui-font, --heading-font and --code-font where the host set them. */
  variables: Record<string, string>
  /** The host's own @font-face or @import rules, if it gave some. */
  hostFonts: string | null
}

/** What to show: a note, or components from one component file with their props. */
export type PreviewPlan =
  | {
      kind: "note"
      /** The compiled modules' paths, in the order their scripts were registered. */
      modules: string[]
      embeds: CardEmbed[]
      svgs: Record<string, string>
    }
  | {
      kind: "components"
      modules: string[]
      /** The component file the items come from. */
      target: string
      items: Array<{ name: string; props: Record<string, unknown> }>
    }

export type CardToFrame =
  | { type: "setup"; plan: PreviewPlan; appearance: PreviewAppearance; fonts: readonly FontSource[] }
  | { type: "appearance"; appearance: PreviewAppearance }

/** A component that threw while it rendered, shown as an error in its place. */
export type ComponentError = { name: string; message: string }

export type FrameToCard =
  /** The frame's scripts ran; it waits for setup. */
  | { type: "ready"; run: number }
  | { type: "size"; run: number; height: number }
  /** The preview has drawn, with the components that threw doing so. */
  | { type: "rendered"; run: number; errors: ComponentError[] }
  /** Nothing could be shown. */
  | { type: "failed"; run: number; message: string }
  /** A link clicked, and where it is: its top and bottom, in pixels from the frame's top. */
  | { type: "link"; run: number; href: string; top?: number; bottom?: number }
