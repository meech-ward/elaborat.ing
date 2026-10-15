import { describe, expect, test } from "bun:test"
import { AgentFollow } from "./follow"
import { offline, type AgentChange, type AgentChangeList, type AgentChangesRemote } from "./remote"

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"
const ME = "11111111-1111-4111-8111-111111111111"
const SOMEONE = "22222222-2222-4222-8222-222222222222"

/** Agent changes as list_agent_changes serves them, newest first, and the project's revision. */
class MemoryChanges implements AgentChangesRemote {
  revision = 4
  changes: AgentChange[] = []
  offline = false
  lists = 0

  /** An agent saved `path` for `user` at the next revision. */
  save(path: string, { user = ME, deleted = false }: { user?: string; deleted?: boolean } = {}) {
    this.revision++
    this.changes.unshift({
      file_id: crypto.randomUUID(),
      version: this.revision,
      path,
      deleted,
      size: deleted ? null : 10,
      created_at: "2026-10-14T00:00:00Z",
      author: { user_id: user, email: null },
      agent: "ChatGPT",
      latest: true,
      previous: null,
      thread: null,
    })
  }

  list(): Promise<AgentChangeList> {
    this.lists++
    if (this.offline) return Promise.reject(offline())
    return Promise.resolve(structuredClone({ project_id: PROJECT, revision: this.revision, seen: 0, more: false, changes: this.changes }))
  }
  contents(): never {
    throw new Error("unused")
  }
  count(): never {
    throw new Error("unused")
  }
  markSeen(): never {
    throw new Error("unused")
  }
}

describe("AgentFollow", () => {
  test("follows the person's agent's newest save after the first look, never one from before it", async () => {
    const remote = new MemoryChanges()
    remote.save("notes/old.md")
    const follow = new AgentFollow(remote, PROJECT, ME)
    await follow.refresh()
    expect(follow.getState()).toBeNull()

    remote.save("notes/plan.md")
    remote.save("notes/flow.excalidraw")
    await follow.refresh()
    expect(follow.getState()).toEqual({ path: "notes/flow.excalidraw", version: 7 })
  })

  test("leaves out other people's agents, deletions and files that are not a note, drawing or diagram", async () => {
    const remote = new MemoryChanges()
    const follow = new AgentFollow(remote, PROJECT, ME)
    await follow.refresh()
    remote.save("notes/flow.d2")
    remote.save("notes/theirs.md", { user: SOMEONE })
    remote.save("notes/gone.md", { deleted: true })
    remote.save("data/table.json")
    await follow.refresh()
    expect(follow.getState()).toEqual({ path: "notes/flow.d2", version: 5 })
  })

  test("each new save to the same file is a new save to follow, and a look that finds nothing new keeps the last", async () => {
    const remote = new MemoryChanges()
    const follow = new AgentFollow(remote, PROJECT, ME)
    let heard = 0
    follow.subscribe(() => heard++)
    await follow.refresh()
    remote.save("notes/plan.md")
    await follow.refresh()
    const first = follow.getState()
    await follow.refresh()
    expect(follow.getState()).toBe(first)
    remote.save("notes/plan.md")
    await follow.refresh()
    expect(follow.getState()).not.toBe(first)
    expect(follow.getState()).toEqual({ path: "notes/plan.md", version: 6 })
    expect(heard).toBe(2)
  })

  test("a look while the first is still answering waits for it, so a save made meanwhile is followed", async () => {
    const remote = new MemoryChanges()
    const follow = new AgentFollow(remote, PROJECT, ME)
    const first = follow.refresh()
    remote.save("notes/plan.md")
    await Promise.all([first, follow.refresh()])
    expect(follow.getState()).toEqual({ path: "notes/plan.md", version: 5 })
  })

  test("a first look that fails is made again, and still follows nothing from before it", async () => {
    const remote = new MemoryChanges()
    const follow = new AgentFollow(remote, PROJECT, ME)
    remote.offline = true
    await follow.refresh()
    remote.offline = false
    remote.save("notes/plan.md")
    await follow.refresh()
    expect(follow.getState()).toBeNull()
    remote.save("notes/next.md")
    await follow.refresh()
    expect(follow.getState()).toEqual({ path: "notes/next.md", version: 6 })
  })
})
