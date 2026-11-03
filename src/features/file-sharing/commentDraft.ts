import { z } from 'zod/mini'
import { RemoteAnchor } from '@/features/comments/remote'

export const ShareCommentDraft = z.object({
  shareId: z.uuid(), fileId: z.uuid(), fileVersion: z.int().check(z.nonnegative()),
  threadId: z.uuid(), commentId: z.uuid(), replyTo: z.optional(z.uuid()),
  anchor: RemoteAnchor, body: z.string().check(z.maxLength(10_000)),
  sourceOffset: z.optional(z.int().check(z.nonnegative(), z.maximum(5 * 1024 * 1024))),
  scroll: z.number().check(z.nonnegative(), z.maximum(20_000_000)), savedAt: z.number(),
})
export type ShareCommentDraft = z.infer<typeof ShareCommentDraft>
const PREFIX = 'elaborating.shared-comment.v1:'
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export function readShareDraft(shareId: string, storage?: DraftStorage, now = Date.now()): ShareCommentDraft | null {
  try {
    const raw = (storage ?? sessionStorage).getItem(PREFIX + shareId)
    if (!raw || raw.length > 50_000) return null
    const parsed = ShareCommentDraft.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.shareId !== shareId || now - parsed.data.savedAt > 86_400_000 || parsed.data.savedAt > now + 60_000) return null
    return parsed.data
  } catch { return null }
}
/** A failed storage write must not send the visitor away and lose their words. */
export function saveShareDraft(draft: ShareCommentDraft, storage?: DraftStorage, scroll = window.scrollY, now = Date.now()): void {
  const value = ShareCommentDraft.parse({...draft, savedAt: now, scroll})
  ;(storage ?? sessionStorage).setItem(PREFIX + draft.shareId, JSON.stringify(value))
}
export function forgetShareDraft(shareId: string, storage?: DraftStorage): void {
  try {(storage ?? sessionStorage).removeItem(PREFIX + shareId)} catch { /* No stored draft. */ }
}
