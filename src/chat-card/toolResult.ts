/**
 * The tool results the chat card reads, parsed at the bridge: show_file's
 * view of one file (supabase/functions/mcp-server/tools/fileView.ts) and
 * write_file's outcome. The host passes them on from the server, so every
 * field is checked; links count only when they go to elaborat.ing, and a
 * drawing only when it is SVG markup the server drew.
 */
import { z } from "zod"

/** The app's origin: the only place the card links to. */
export const APP_ORIGIN = "https://elaborat.ing/"

/** The result `_meta` keys (fileView.ts): the note's HTML, its source, and each drawn file's SVG by path. */
const HTML_KEY = "elaborat.ing/html"
const SOURCE_KEY = "elaborat.ing/source"
const SVG_KEY = "elaborat.ing/svg"

export type FileKind = "note" | "drawing" | "diagram" | "file"

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

/** One file as the card shows it. */
export type CardFile = {
  /** Passed back as it came, to save and reload the file. */
  projectId: unknown
  path: string
  kind: FileKind
  version: number | null
  /** The file's page in the app. */
  url: string | null
  /** Only the start of a long note is shown. */
  truncated: boolean
  /** The note's embeds in the order of its figures' data-embed; null where one is unreadable. */
  embeds: Array<CardEmbed | null>
  /** SVG markup by path, for the embeds that were drawn. */
  svgs: Record<string, string>
  /** A note's sanitized HTML, rendered by the server. */
  html: string | null
  /** The whole note's source, when it can be edited here. */
  source: string | null
}

export type ShowOutcome = { ok: true; file: CardFile } | { ok: false; message: string }
export type WriteOutcome = { kind: "saved"; version: number | null } | { kind: "conflict" } | { kind: "failed"; message: string }

const STATUSES = ["drawn", "stale", "not_drawn", "missing", "unreadable", "empty", "too_big", "not_shown", "unsupported"] as const
const kindSchema = z.enum(["note", "drawing", "diagram", "file"]).catch("file")
const appUrl = z.string().startsWith(APP_ORIGIN).nullable().catch(null)

const embedSchema = z
  .object({ kind: kindSchema, path: z.string(), url: appUrl, status: z.enum(STATUSES).catch("drawn") })
  .nullable()
  .catch(null)

const viewSchema = z.object({
  project_id: z.unknown(),
  path: z.string(),
  kind: kindSchema,
  version: z.number().nullable().catch(null),
  url: appUrl,
  truncated: z.boolean().catch(false),
  embeds: z.array(embedSchema).catch([]),
})

const metaSchema = z.record(z.string(), z.unknown()).catch({})

const showSchema = z.object({ structuredContent: viewSchema, _meta: z.unknown().optional() })

const firstTextSchema = z.object({ content: z.tuple([z.object({ text: z.string() })], z.unknown()) })

/** The message a failed result gives, if it gives one. */
function firstText(raw: unknown): string | null {
  const parsed = firstTextSchema.safeParse(raw)
  return parsed.success ? parsed.data.content[0].text : null
}

const isError = (raw: unknown) => z.object({ isError: z.literal(true) }).safeParse(raw).success

/**
 * show_file's result as the card shows it. `fallbackMeta` is what ChatGPT
 * hands the card on window.openai, used when the result came without `_meta`.
 */
export function parseShowResult(raw: unknown, fallbackMeta?: unknown): ShowOutcome {
  const parsed = isError(raw) ? null : showSchema.safeParse(raw)
  if (!parsed?.success) return { ok: false, message: firstText(raw) ?? "Something went wrong." }
  const view = parsed.data.structuredContent
  const meta = metaSchema.parse(parsed.data._meta ?? fallbackMeta ?? {})
  const svgs = Object.fromEntries(
    Object.entries(metaSchema.parse(meta[SVG_KEY] ?? {})).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith("<svg"),
    ),
  )
  const note = view.kind === "note"
  const html = meta[HTML_KEY]
  const source = meta[SOURCE_KEY]
  return {
    ok: true,
    file: {
      projectId: view.project_id,
      path: view.path,
      kind: view.kind,
      version: view.version,
      url: view.url,
      truncated: view.truncated,
      embeds: view.embeds,
      svgs,
      html: note && typeof html === "string" ? html : null,
      source: note && !view.truncated && typeof source === "string" ? source : null,
    },
  }
}

/** Whether a raw result carried its own `_meta` (ChatGPT dropped it from the notification until May 2026). */
export const hasMeta = (raw: unknown) => z.object({ _meta: z.record(z.string(), z.unknown()) }).safeParse(raw).success

const writeSchema = z.object({
  structuredContent: z.object({
    status: z.string(),
    changes: z.array(z.object({ path: z.string(), version: z.number() }).nullable().catch(null)).catch([]),
  }),
})

/** write_file's outcome for the note at `path`. */
export function parseWriteResult(raw: unknown, path: string): WriteOutcome {
  const parsed = isError(raw) ? null : writeSchema.safeParse(raw)
  if (!parsed?.success) return { kind: "failed", message: firstText(raw) ?? "Saving failed." }
  const { status, changes } = parsed.data.structuredContent
  if (status === "conflict") return { kind: "conflict" }
  const change = changes.find((entry) => entry?.path === path)
  return { kind: "saved", version: change?.version ?? null }
}

/** The drawing to show for an embed: SVG markup when it was drawn (or drawn from older source), else null. */
export function svgFor(embed: CardEmbed, svgs: Record<string, string>): string | null {
  return embed.status === "drawn" || embed.status === "stale" ? (svgs[embed.path] ?? null) : null
}

export const KIND_NAMES: Record<FileKind, string> = { note: "Note", drawing: "Drawing", diagram: "Diagram", file: "File" }

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
}
