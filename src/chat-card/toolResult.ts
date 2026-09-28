/**
 * The tool results the chat card reads, parsed at the bridge: show_file's
 * view of one file (supabase/functions/mcp-server/tools/fileView.ts),
 * preview_component's view of a component file (componentPreview.ts), and
 * write_file's outcome. The host passes them on from the server, so every
 * field is checked; links count only when they go to elaborat.ing, and a
 * drawing only when it is SVG markup the server drew. Zod Mini, which the
 * card's small script tree-shakes, where full Zod would all come along.
 */
import { z } from "zod/mini"
import type { CardEmbed, FileKind } from "./embedText"

/** The app's origin: the only place the card links to. */
export const APP_ORIGIN = "https://elaborat.ing/"

/**
 * The result `_meta` keys (fileView.ts): the note's HTML, its source, each
 * drawn file's SVG by path, and the component files to preview.
 */
const HTML_KEY = "elaborat.ing/html"
const SOURCE_KEY = "elaborat.ing/source"
const SVG_KEY = "elaborat.ing/svg"
const COMPONENTS_KEY = "elaborat.ing/components"

export type { CardEmbed, EmbedStatus, FileKind } from "./embedText"
export { EMBED_NOTES, FILE_NOTES, KIND_NAMES, svgFor } from "./embedText"

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
  /**
   * The source of each component file (.mdx) the note or component imports,
   * by path, when the card previews its components (preview/compile.ts);
   * null when there is nothing to preview.
   */
  components: Record<string, string> | null
  /** For a component file: which component to show (every one when null) and its sample props. */
  preview: ComponentPreviewRequest | null
  /** The file is in a project shared with the person, not their own: its custom component code runs only when they say so. */
  shared: boolean
  /** Who last changed each file whose code the preview runs, by path ("you" for the person), where the server says. */
  editors: Record<string, string>
}

export type ComponentPreviewRequest = {
  component: string | null
  props: Record<string, unknown> | null
  /** The source is a draft the agent sent, not the saved file. */
  draft: boolean
}

export type ShowOutcome = { ok: true; file: CardFile } | { ok: false; message: string }
export type WriteOutcome = { kind: "saved"; version: number | null } | { kind: "conflict" } | { kind: "failed"; message: string }

const STATUSES = ["drawn", "stale", "not_drawn", "missing", "unreadable", "empty", "too_big", "not_shown", "unsupported"] as const
const kindSchema = z.catch(z.enum(["note", "drawing", "diagram", "file", "component"]), "file")
const appUrl = z.catch(z.nullable(z.string().check(z.startsWith(APP_ORIGIN))), null)

const embedSchema = z.catch(
  z.nullable(z.object({ kind: kindSchema, path: z.string(), url: appUrl, status: z.catch(z.enum(STATUSES), "drawn") })),
  null,
)

const viewSchema = z.object({
  project_id: z.unknown(),
  path: z.string(),
  kind: kindSchema,
  version: z.catch(z.nullable(z.number()), null),
  url: appUrl,
  truncated: z.catch(z.boolean(), false),
  embeds: z.catch(z.array(embedSchema), []),
  component: z.optional(z.catch(z.nullable(z.string()), null)),
  props: z.optional(z.catch(z.nullable(z.record(z.string(), z.unknown())), null)),
  draft: z.optional(z.catch(z.boolean(), false)),
  shared: z.optional(z.catch(z.boolean(), true)),
})

const componentsSchema = z.catch(
  z.nullable(z.object({ modules: z.record(z.string(), z.string()), editors: z.optional(z.catch(z.record(z.string(), z.string()), {})) })),
  null,
)

const metaSchema = z.catch(z.record(z.string(), z.unknown()), {})

const showSchema = z.object({ structuredContent: viewSchema, _meta: z.optional(z.unknown()) })

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
  const component = view.kind === "component"
  const html = meta[HTML_KEY]
  const source = meta[SOURCE_KEY]
  const noteSource = note && !view.truncated && typeof source === "string" ? source : null
  const components = componentsSchema.parse(meta[COMPONENTS_KEY] ?? null)
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
      source: noteSource,
      // A note's components are previewed from its whole source; a component file's from its own.
      components: (noteSource !== null || component) && components ? components.modules : null,
      preview: component ? { component: view.component ?? null, props: view.props ?? null, draft: view.draft ?? false } : null,
      shared: view.shared ?? false,
      editors: components?.editors ?? {},
    },
  }
}

/** Whether a raw result carried its own `_meta` (ChatGPT dropped it from the notification until May 2026). */
export const hasMeta = (raw: unknown) => z.object({ _meta: z.record(z.string(), z.unknown()) }).safeParse(raw).success

const writeSchema = z.object({
  structuredContent: z.object({
    status: z.string(),
    changes: z.catch(z.array(z.catch(z.nullable(z.object({ path: z.string(), version: z.number() })), null)), []),
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
