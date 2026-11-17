import type { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"
import { acceptReviewSuggestion, proposedSource, rejectReviewSuggestion, type ReviewState } from "../../src/features/suggestions/review.ts"
import { checkedReview } from "../../src/features/suggestions/validation.ts"

/** The persisted review contract, shared by every page using one fake server. */
export type FakeNoteReview = {
  id: string
  project_id: string
  file_id: string
  path: string
  base_version: number
  version: number
  status: "open" | "closed"
  payload: ReviewState
  original_bundle: ReviewState
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

export class FakeNoteReviewError extends RemoteError {
  constructor(readonly code: "40001" | "22023" | "55000" | "42501", message: string) {
    super(code === "42501" ? "access" : code === "55000" ? "archived" : "invalid", message)
  }
}

type Args = Record<string, unknown>
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)])) : value
const fingerprint = (value: unknown): string => JSON.stringify(ordered(value))

export class FakeNoteReviews {
  readonly records = new Map<string, FakeNoteReview>()
  readonly calls: Array<{ user: string; rpc: string; args: Args }> = []
  readonly decisions: Array<{ reviewId: string; decision: "accept" | "reject"; suggestionId: string | null; before: ReviewState; after: ReviewState }> = []
  private receipts = new Map<string, { user: string; request: string; result: unknown }>()
  private tail = Promise.resolve()
  private ticks = 0

  constructor(private readonly server: FakeProjectServer) {}

  static handles(rpc: string): boolean {
    return ["get_note_review", "save_note_review", "decide_note_review", "finish_note_review"].includes(rpc)
  }

  /** Serializing reads as well as writes makes an accepted file and review visible atomically. */
  call(user: string, rpc: string, args: Args): Promise<unknown> {
    this.calls.push({ user, rpc, args: structuredClone(args) })
    const next = this.tail.then(() => this.perform(user, rpc, args))
    this.tail = next.then(() => {}, () => {})
    return next
  }

  private now(): string { return new Date(Date.UTC(2026, 10, 17, 10, 0, ++this.ticks)).toISOString() }

  private project(user: string, id: string, write = false) {
    const project = this.server.projects.get(id)
    const role = project && this.server.role(user, project)
    if (!project || !role) throw new FakeNoteReviewError("42501", "Project unavailable")
    if (write && role !== "owner" && role !== "editor") throw new FakeNoteReviewError("42501", "Editor access required")
    return project
  }

  private record(projectId: string, id: string): FakeNoteReview {
    const record = this.records.get(id)
    if (!record || record.project_id !== projectId) throw new FakeNoteReviewError("42501", "Review unavailable")
    return record
  }

  private editable(record: FakeNoteReview, expected: unknown): void {
    if (record.version !== expected) throw new FakeNoteReviewError("40001", "This review changed. Reload it before trying again.")
    if (record.status !== "open") throw new FakeNoteReviewError("55000", "This review is closed.")
  }

  private payload(value: unknown): ReviewState {
    try { return checkedReview(value) }
    catch { throw new FakeNoteReviewError("22023", "Invalid review payload") }
  }

  private async perform(user: string, rpc: string, args: Args): Promise<unknown> {
    if (this.server.offline) throw new RemoteError("network", "Failed to fetch")
    const projectId = String(args.project_id)
    const project = this.project(user, projectId, rpc !== "get_note_review")
    if (rpc === "get_note_review") {
      const matches = [...this.records.values()].filter(record => record.project_id === projectId && record.file_id === args.file_id)
      matches.sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.updated_at.localeCompare(a.updated_at))
      return structuredClone({ review: matches[0] ?? null })
    }
    if (typeof args.mutation_id !== "string" || !args.mutation_id) throw new FakeNoteReviewError("22023", "A mutation id is required")
    const receiptKey = `${projectId}:${args.mutation_id}`
    const request = fingerprint({ rpc, args })
    const receipt = this.receipts.get(receiptKey)
    if (receipt) {
      if (receipt.user !== user || receipt.request !== request) throw new FakeNoteReviewError("22023", "This mutation id was already used for a different request")
      return structuredClone(receipt.result)
    }
    if (project.archivedAt) throw new FakeNoteReviewError("55000", "Project is archived")

    let record: FakeNoteReview
    let file: { id: string; path: string; version: number; content: string } | null = null
    if (rpc === "save_note_review") {
      const payload = this.payload(args.payload)
      const current = [...project.files.values()].find(file => file.id === args.file_id)
      if (!current || current.kind === "image" || current.version !== args.base_version || current.content !== payload.base)
        throw new FakeNoteReviewError("40001", "The accepted file changed or moved. Reload it before trying again.")
      const previous = this.records.get(String(args.review_id))
      if (args.expected_version === null) {
        if (previous || [...this.records.values()].some(record => record.project_id === projectId && record.file_id === current.id && record.status === "open"))
          throw new FakeNoteReviewError("40001", "A review is already open for this note.")
        const at = this.now()
        record = { id: String(args.review_id), project_id: projectId, file_id: current.id, path: current.path,
          base_version: current.version, version: 1, status: "open", payload, original_bundle: structuredClone(payload),
          created_by: user, updated_by: user, created_at: at, updated_at: at, closed_at: null }
      } else {
        record = this.record(projectId, String(args.review_id))
        this.editable(record, args.expected_version)
        if (record.file_id !== current.id || record.path !== current.path || record.base_version !== current.version || record.payload.base !== payload.base)
          throw new FakeNoteReviewError("40001", "The accepted file changed or moved. Reload it before trying again.")
        if (fingerprint(record.payload.provenance) !== fingerprint(payload.provenance)) throw new FakeNoteReviewError("22023", "Original review provenance cannot change")
        record = { ...record, path: current.path, payload, version: record.version + 1, updated_by: user, updated_at: this.now() }
      }
      project.revision++
    } else {
      record = this.record(projectId, String(args.review_id))
      this.editable(record, args.expected_version)
      if (rpc === "finish_note_review") {
        if (record.payload.suggestions.length) throw new FakeNoteReviewError("22023", "Accept or reject the remaining suggestions first.")
        const at = this.now()
        record = { ...record, version: record.version + 1, status: "closed", updated_by: user, updated_at: at, closed_at: at }
        project.revision++
      } else if (rpc === "decide_note_review") {
        if (args.decision !== "accept" && args.decision !== "reject") throw new FakeNoteReviewError("22023", "Choose accept or reject")
        if (!record.payload.suggestions.length) throw new FakeNoteReviewError("22023", "This review has no pending suggestions")
        const id = args.suggestion_id
        if (id !== null && (typeof id !== "string" || !record.payload.suggestions.some(suggestion => suggestion.id === id)))
          throw new FakeNoteReviewError("22023", "This suggestion is no longer pending.")
        const before = record.payload
        let after: ReviewState
        if (args.decision === "accept") {
          const current = [...project.files.values()].find(file => file.id === record.file_id)
          if (!current || current.path !== record.path || current.version !== record.base_version || current.content !== before.base)
            throw new FakeNoteReviewError("40001", "The accepted file changed or moved. Reload it before trying again.")
          after = id === null ? { ...before, base: proposedSource(before), suggestions: [] } : acceptReviewSuggestion(before, id as string)
          // The service's dropped response applies after both parts of the transaction.
          const lost = this.server.loseResponses
          this.server.loseResponses = 0
          try {
            const saved = await this.server.remote(user).saveFiles(projectId, String(args.mutation_id), [{ op: "put", path: current.path, base_version: current.version, content: after.base }])
            if (saved.status !== "saved") throw new FakeNoteReviewError("40001", "The accepted file changed. Reload it before trying again.")
          } finally { this.server.loseResponses = lost }
          const accepted = project.files.get(current.path)!
          file = { id: accepted.id, path: accepted.path, version: accepted.version, content: accepted.content }
          record = { ...record, path: accepted.path, base_version: accepted.version }
        } else {
          after = id === null ? { ...before, suggestions: [] } : rejectReviewSuggestion(before, id as string)
          project.revision++
        }
        this.decisions.push({ reviewId: record.id, decision: args.decision, suggestionId: id as string | null, before: structuredClone(before), after: structuredClone(after) })
        record = { ...record, payload: after, version: record.version + 1, updated_by: user, updated_at: this.now() }
      } else throw new FakeNoteReviewError("22023", `Unknown review function ${rpc}`)
    }
    this.records.set(record.id, structuredClone(record))
    const result = rpc === "decide_note_review" ? { review: record, file } : { review: record }
    this.receipts.set(receiptKey, { user, request, result: structuredClone(result) })
    if (this.server.loseResponses > 0) {
      this.server.loseResponses--
      throw new RemoteError("network", "The connection was lost")
    }
    return structuredClone(result)
  }
}

const services = new WeakMap<FakeProjectServer, FakeNoteReviews>()
export function noteReviewsFor(server: FakeProjectServer): FakeNoteReviews {
  let reviews = services.get(server)
  if (!reviews) { reviews = new FakeNoteReviews(server); services.set(server, reviews) }
  return reviews
}
