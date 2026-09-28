import type { CommentAnchorView, CommentAuthor, CommentEntry, CommentResolution } from "@/features/design-system"
import { anchorView } from "../anchorView"
import type { ThreadPlace } from "../controller"
import type { RemoteComment, RemoteThread } from "../remote"

// The database's threads as the panel shows them: who wrote each comment in
// words, what each thread is on (placed by the file on screen), and what the
// person looking may do. Pure, so the rules are tested without React.

/** Who is looking: their account, and whether they own the project (the owner deletes anyone's comment). */
export type Viewer = { userId: string | null; owner: boolean }

export type ThreadView = {
  id: string
  anchor: CommentAnchorView
  /** Its text, heading or element is gone from the file on screen. */
  detached: boolean
  comments: CommentEntry[]
  resolved: CommentResolution | null
}

/** A person as a comment shows them: their email, or null for a deleted account. */
export function author(person: RemoteThread["resolved_by"]): CommentAuthor | null {
  if (!person) return null
  return { name: person.email ?? "Unknown account" }
}

/** What the file is called in "Whole note", "Whole drawing" and "Comment on the whole ...". */
export function fileNoun(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md")) return "drawing"
  if (lower.endsWith(".d2")) return "diagram"
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "note"
  return "file"
}

function entry(comment: RemoteComment, viewer: Viewer): CommentEntry {
  const own = viewer.userId !== null && comment.author?.user_id === viewer.userId
  return {
    id: comment.id,
    author: author(comment.author),
    viaAgent: comment.via_agent,
    body: comment.body,
    createdAt: comment.created_at,
    editedAt: comment.edited_at,
    canEdit: own,
    canDelete: own || viewer.owner,
  }
}

/** Where a thread sorts: the whole file first, then text and sections, then elements, then detached. */
function group(thread: RemoteThread, place: ThreadPlace | undefined): number {
  if (place?.attached === false) return 3
  if (thread.anchor.kind === "document") return 0
  return thread.anchor.kind === "element" ? 2 : 1
}

/**
 * A file's open and resolved threads, as the panel lists them. `places` is
 * where the file on screen found each thread (CommentsController.placesFor);
 * a thread it has not placed shows its stored quote. Open threads go the
 * whole file first, then text and sections in file order, then elements,
 * then detached ones; resolved threads keep the order they were made in.
 */
export function threadViews(
  threads: readonly RemoteThread[],
  places: ReadonlyMap<string, ThreadPlace>,
  viewer: Viewer,
  noun: string,
): { open: ThreadView[]; resolved: ThreadView[] } {
  const view = (thread: RemoteThread): ThreadView => {
    const place = places.get(thread.id)
    return {
      id: thread.id,
      anchor: thread.anchor.kind === "document" ? { kind: "document", label: `Whole ${noun}` } : anchorView(thread.anchor, place),
      detached: place?.attached === false,
      comments: thread.comments.map((comment) => entry(comment, viewer)),
      resolved: thread.resolved_at ? { by: author(thread.resolved_by), at: thread.resolved_at } : null,
    }
  }
  const start = (thread: RemoteThread) => places.get(thread.id)?.range?.start ?? (thread.anchor.kind === "text" || thread.anchor.kind === "section" ? thread.anchor.position.start : 0)
  const open = threads
    .map((thread, index) => ({ thread, index }))
    .filter(({ thread }) => !thread.resolved_at)
    .sort(
      (a, b) =>
        group(a.thread, places.get(a.thread.id)) - group(b.thread, places.get(b.thread.id)) || start(a.thread) - start(b.thread) || a.index - b.index,
    )
    .map(({ thread }) => view(thread))
  return { open, resolved: threads.filter((thread) => thread.resolved_at).map(view) }
}

/**
 * Comments that arrived from elsewhere since `known`: not written by the
 * viewer in the app (their agent's count, as someone else's would). For the
 * panel's announcement, "2 new comments".
 */
export function newComments(threads: readonly RemoteThread[], known: ReadonlySet<string>, viewer: Viewer): number {
  let count = 0
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (known.has(comment.id) || comment.body === null) continue
      if (comment.author?.user_id === viewer.userId && !comment.via_agent) continue
      count++
    }
  }
  return count
}
