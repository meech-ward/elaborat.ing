/**
 * The card's check of what the component preview's frame sends it
 * (protocol.ts). The frame runs the note's own code, so a message is read
 * only when it has exactly this shape, and its text is cut short.
 */
import { z } from "zod"
import type { FrameToCard } from "./protocol"

/** The most characters of a message the card keeps. */
export const MAX_MESSAGE = 300

const text = z.string().transform((value) => (value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE - 3)}...` : value))
const run = z.number().int()

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), run }),
  z.object({ type: z.literal("size"), run, height: z.number().finite().min(0) }),
  z.object({ type: z.literal("rendered"), run, errors: z.array(z.object({ name: z.string().max(200), message: text })).max(20) }),
  z.object({ type: z.literal("failed"), run, message: text }),
  z.object({ type: z.literal("link"), run, href: z.string().max(4096) }),
])

/** The frame's message, or null when it is anything else. */
export function readFrameMessage(data: unknown): FrameToCard | null {
  const parsed = schema.safeParse(data)
  return parsed.success ? parsed.data : null
}
