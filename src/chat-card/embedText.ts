/**
 * What the chat card says about files and drawings, with no schema library,
 * so the component preview's frame (preview/runtime.tsx) can use it too.
 * toolResult.ts parses the results these describe.
 */

export type FileKind = "note" | "drawing" | "diagram" | "file" | "component"

/** How a drawing or diagram came out (fileView.ts EmbedStatus); anything else reads as drawn. */
export type EmbedStatus =
  | "drawn"
  | "stale"
  | "not_drawn"
  | "missing"
  | "unreadable"
  | "empty"
  | "too_big"
  | "not_shown"
  | "unsupported"

export type CardEmbed = { kind: FileKind; path: string; url: string | null; status: EmbedStatus }

/** The drawing to show for an embed: SVG markup when it was drawn (or drawn from older source), else null. */
export function svgFor(embed: CardEmbed, svgs: Record<string, string>): string | null {
  return embed.status === "drawn" || embed.status === "stale" ? (svgs[embed.path] ?? null) : null
}

export const KIND_NAMES: Record<FileKind, string> = { note: "Note", drawing: "Drawing", diagram: "Diagram", file: "File", component: "Component" }

/** What the card says about an embed it cannot draw, or about one drawn from older source. */
export const EMBED_NOTES: Record<EmbedStatus, string> = {
  drawn: "Open it in elaborat.ing to see it.",
  stale: "Its source changed after this was drawn. Open it in elaborat.ing to redraw it.",
  not_drawn: "Open it in elaborat.ing to draw it.",
  missing: "No file at this path.",
  unreadable: "This drawing could not be read.",
  empty: "This drawing is empty.",
  too_big: "Too big to show here. Open it in elaborat.ing.",
  not_shown: "Open the note in elaborat.ing to see it.",
  unsupported: "Only drawings and diagrams are shown here.",
}

/** What the card says for a file it does not show. */
export const FILE_NOTES: Record<Exclude<FileKind, "note">, string> = {
  drawing: "Drawings open in elaborat.ing.",
  diagram: "Diagrams open in elaborat.ing.",
  file: "Open this file in elaborat.ing.",
  component: "Open this file in elaborat.ing.",
}
