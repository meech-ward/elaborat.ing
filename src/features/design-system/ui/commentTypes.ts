import { createContext, useContext } from "react"

// What the comment components show, in the words a person reads: the app
// turns the database's threads (src/features/comments) into these.

/** Who wrote a comment: their name (or email) and an optional picture. */
export type CommentAuthor = { name: string; image?: string }

/** One comment in a thread. The first comment opens the thread. */
export type CommentEntry = {
  id: string
  /** null: the account was deleted ("Deleted account"). */
  author: CommentAuthor | null
  /** Written by the author's agent, not by them in the app. */
  viaAgent?: boolean
  /** The agent's name, when `viaAgent`: the one its person approved it under. */
  agent?: string | null
  /** The version of the file this comment links to, such as the one an agent saved in answer. */
  version?: number | null
  /** null: the comment was deleted; a placeholder keeps its place among the replies. */
  body: string | null
  createdAt: string | Date
  editedAt?: string | Date | null
  /** The comment's author, as a person: offers Edit. */
  canEdit?: boolean
  /** Its author, or the project owner: offers Delete. */
  canDelete?: boolean
}

/**
 * What a thread is about, as its context line shows it. `detached`: the
 * anchor's text, heading or element is gone, and the stored quote shows
 * struck through.
 */
export type CommentAnchorView =
  | { kind: "document"; label?: string }
  | { kind: "text"; quote: string; detached?: boolean }
  | { kind: "section"; heading: string; detached?: boolean }
  | { kind: "element"; label: string; detached?: boolean }

/** When and by whom a thread was resolved. */
export type CommentResolution = { by: CommentAuthor | null; at: string | Date }

/** The desktop panel, or the phone's sheet (`touch`: 15px text, 40px targets). */
export type CommentsSize = "default" | "touch"

/** The size the panel or sheet around a thread gives it, unless it says its own. */
export const CommentsSizeContext = createContext<CommentsSize>("default")

export function useCommentsSize(size?: CommentsSize): CommentsSize {
  const inherited = useContext(CommentsSizeContext)
  return size ?? inherited
}
