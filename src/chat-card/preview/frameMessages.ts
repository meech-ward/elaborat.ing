/**
 * The card's check of what the component preview's frame sends it
 * (protocol.ts). The frame runs the note's own code, so a message is read
 * only when it has exactly this shape, and its text is cut short.
 */
import { z } from "zod/mini"
import type { FrameToCard } from "./protocol"

/** The most characters of a message the card keeps. */
export const MAX_MESSAGE = 300

const text = z.pipe(
  z.string(),
  z.transform((value: string) => (value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE - 3)}...` : value)),
)
const run = z.int()
const place = z.optional(z.number())

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), run }),
  z.object({ type: z.literal("size"), run, height: z.number().check(z.gte(0)) }),
  z.object({ type: z.literal("rendered"), run, errors: z.array(z.object({ name: z.string().check(z.maxLength(200)), message: text })).check(z.maxLength(20)) }),
  z.object({ type: z.literal("failed"), run, message: text }),
  z.object({ type: z.literal("link"), run, href: z.string().check(z.maxLength(4096)), top: place, bottom: place }),
])

/** The frame's message, or null when it is anything else. */
export function readFrameMessage(data: unknown): FrameToCard | null {
  const parsed = schema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** The most room the card's "Open this link?" prompt takes, beside the link. */
export const LINK_PROMPT_ROOM = 96

/**
 * Where the card asks about a link clicked in a preview `height` tall: just
 * below it, else just above it, where there is room for the prompt. Null
 * when the frame did not say where the link is, or there is room on neither
 * side: the prompt then follows the preview. The place is the frame's
 * word, so it is kept inside the frame.
 */
export function linkSpot(link: { top?: number; bottom?: number }, height: number): { y: number; side: "below" | "above" } | null {
  if (link.top === undefined || link.bottom === undefined) return null
  const top = Math.min(Math.max(link.top, 0), height)
  const bottom = Math.min(Math.max(link.bottom, top), height)
  if (bottom + LINK_PROMPT_ROOM <= height) return { y: bottom, side: "below" }
  if (top >= LINK_PROMPT_ROOM) return { y: top, side: "above" }
  return null
}
