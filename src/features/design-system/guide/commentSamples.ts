import { useState } from "react"
import type { CommentAnchorView, CommentAuthor, CommentEntry, CommentResolution } from "../ui/commentTypes"

// The comment samples: threads on customer-model.mdx and art/flow.excalidraw
// from C5's project, and a small in-memory store so the samples can be
// replied to, edited, resolved and deleted on the page.

/** The time the samples' "5 minutes ago" counts from. */
export const NOW = new Date("2026-09-27T15:00:00Z")
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

/** The signed-in person, who owns the project. */
export const ME: CommentAuthor = { name: "Person" }
const ADA: CommentAuthor = { name: "Ada Park" }
const RAVI: CommentAuthor = { name: "Ravi Shah" }
const MEI: CommentAuthor = { name: "Mei Tan" }

export type SampleThread = {
  id: string
  anchor: CommentAnchorView
  comments: CommentEntry[]
  resolved: CommentResolution | null
  /** Its author asked their agent to deal with it. */
  askAgent?: boolean
}

/** Someone else's comment: the owner may delete it, not edit it. */
const theirs = (id: string, author: CommentAuthor | null, body: string | null, minutes: number, extra: Partial<CommentEntry> = {}): CommentEntry => ({
  id,
  author,
  body,
  createdAt: ago(minutes),
  canDelete: body !== null,
  ...extra,
})

/** The signed-in person's comment: theirs to edit and delete. */
const mine = (id: string, body: string, minutes: number, extra: Partial<CommentEntry> = {}): CommentEntry => ({
  id,
  author: ME,
  body,
  createdAt: ago(minutes),
  canEdit: true,
  canDelete: true,
  ...extra,
})

export const QUOTE = "How a customer moves from sign-up to their first project"

export const sampleThreads = {
  quote: {
    id: "quote",
    anchor: { kind: "text", quote: QUOTE },
    comments: [
      theirs("q1", ADA, "Should this cover invited teammates too? They never see the sign-up page.", 130),
      mine(
        "q2",
        "Invited teammates sign in with the same email link, so everything after step 1 is the same. I can add a line under Steps.",
        64,
        { viaAgent: true, agent: "Claude", version: 12 },
      ),
      theirs("q3", RAVI, "Yes please, and link the members page from it.", 21, { editedAt: ago(18) }),
    ],
    resolved: null,
  },
  steps: {
    id: "steps",
    anchor: { kind: "section", heading: "Steps" },
    comments: [theirs("s1", RAVI, "Step 3 needs a link to the agent setup guide.", 45)],
    resolved: null,
  },
  whole: {
    id: "whole",
    anchor: { kind: "document" },
    comments: [theirs("w1", MEI, "Ready for review once the diagram shows the email link.", 300)],
    resolved: null,
  },
  created: {
    id: "created",
    anchor: { kind: "text", quote: "Create a project." },
    comments: [
      mine("c1", "Should this say create or join a project?", 2900),
      theirs("c2", ADA, "Kept it short: joining is covered by the invite line.", 2860),
    ],
    resolved: { by: ADA, at: ago(2850) },
  },
  detached: {
    id: "detached",
    anchor: { kind: "text", quote: "Agents can only read the projects their person owns.", detached: true },
    comments: [theirs("d1", RAVI, "This changed: agents act as the signed-in person in every project they can open.", 4 * 1440)],
    resolved: null,
  },
  deleted: {
    id: "deleted",
    anchor: { kind: "section", heading: "Pricing" },
    comments: [
      theirs("x1", RAVI, null, 3 * 1440),
      theirs("x2", null, "Agreed, the free plan line can go.", 2 * 1440 + 30),
      mine("x3", "Removed it.", 1440 + 20),
    ],
    resolved: null,
  },
  signUp: {
    id: "sign-up",
    anchor: { kind: "element", label: "Sign up" },
    comments: [
      theirs("e1", ADA, "Sign up should lead to the email link step, not straight to Project.", 95),
      mine("e2", "Right, I'll add the box between them.", 80),
    ],
    resolved: null,
  },
  agent: {
    id: "agent",
    anchor: { kind: "element", label: "Agent?" },
    comments: [theirs("a1", MEI, "Is this a question for the person, or a step the app decides?", 40)],
    resolved: null,
  },
  asked: {
    id: "asked",
    anchor: { kind: "section", heading: "Steps" },
    comments: [
      mine("k1", "Add a date to each step.", 90),
      mine("k2", "Added a target date under each step.", 12, { viaAgent: true, agent: "Claude", version: 14, canEdit: false }),
    ],
    resolved: null,
    askAgent: true,
  },
  theirsAsked: {
    id: "theirs-asked",
    anchor: { kind: "document" },
    comments: [theirs("t1", RAVI, "Tighten the intro to two sentences.", 25)],
    resolved: null,
    askAgent: true,
  },
  gone: {
    id: "gone",
    anchor: { kind: "element", label: "Pricing page", detached: true },
    comments: [theirs("g1", ADA, "Do we still link pricing from the landing page?", 6 * 1440)],
    resolved: null,
  },
} satisfies Record<string, SampleThread>

const pause = () => new Promise((resolve) => setTimeout(resolve, 450))

/**
 * Sample threads that answer like the real ones: reply and edit take a
 * moment, resolve and reopen move a thread between the groups, and delete
 * leaves a placeholder while other comments remain (the thread goes with
 * its last one). `announcement` says what the last change did, for the
 * panel's live region.
 */
export function useSampleThreads(initial: readonly SampleThread[]) {
  const [threads, setThreads] = useState<readonly SampleThread[]>(initial)
  const [announcement, setAnnouncement] = useState("")
  const update = (id: string, change: (thread: SampleThread) => SampleThread) =>
    setThreads((current) => current.map((thread) => (thread.id === id ? change(thread) : thread)))
  const handlers = (thread: SampleThread) => ({
    // Only the thread's author asks their agent, or stops.
    onAskAgentChange:
      thread.comments[0]?.author === ME
        ? async (ask: boolean) => {
            await pause()
            update(thread.id, (current) => ({ ...current, askAgent: ask }))
            setAnnouncement(ask ? "Your agent is asked about this thread" : "Your agent is no longer asked")
          }
        : undefined,
    onResolve: () => {
      update(thread.id, (current) => ({ ...current, resolved: { by: ME, at: new Date() } }))
      setAnnouncement("Thread resolved, moved to Resolved")
    },
    onReopen: () => {
      update(thread.id, (current) => ({ ...current, resolved: null }))
      setAnnouncement("Thread reopened")
    },
    onReply: async (body: string) => {
      await pause()
      update(thread.id, (current) => ({
        ...current,
        comments: [...current.comments, { id: crypto.randomUUID(), author: ME, body, createdAt: new Date(), canEdit: true, canDelete: true }],
      }))
      setAnnouncement("Reply sent")
    },
    onEdit: async (commentId: string, body: string) => {
      await pause()
      update(thread.id, (current) => ({
        ...current,
        comments: current.comments.map((comment) => (comment.id === commentId ? { ...comment, body, editedAt: new Date() } : comment)),
      }))
      setAnnouncement("Comment saved")
    },
    onDelete: (commentId: string) => {
      setAnnouncement("Comment deleted")
      setThreads((current) =>
        current.flatMap((each) => {
          if (each.id !== thread.id) return [each]
          const comments = each.comments.map((comment) =>
            comment.id === commentId ? { ...comment, body: null, canEdit: false, canDelete: false } : comment,
          )
          return comments.some((comment) => comment.body !== null) ? [{ ...each, comments }] : []
        }),
      )
    },
  })
  return {
    open: threads.filter((thread) => !thread.resolved),
    resolved: threads.filter((thread) => thread.resolved),
    all: threads,
    handlers,
    announcement,
    changed: threads !== initial,
    reset: () => setThreads(initial),
  }
}
