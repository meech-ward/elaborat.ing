import { describe, expect, test } from "bun:test"
import { DeleteRefusedError, planDelete } from "./deletePlan"
import type { MoveSourceFile } from "./movePlan"

const file = (path: string, saved: string, extra: Partial<MoveSourceFile> = {}): MoveSourceFile => ({
  path,
  revision: `rev:${path}`,
  saved,
  draft: null,
  conflict: false,
  ...extra,
})

const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DeleteRefusedError)
    return (error as Error).message
  }
  throw new Error("expected the delete to be refused")
}

const scene = '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'

describe("deleting a file", () => {
  test("deletes it, and lists the files that still refer to it without changing them", () => {
    const files = [file("plan.md", "# Plan\n"), file("index.mdx", "Intro.\n\nSee [the plan](plan.md).\n"), file("other.md", "Unrelated.\n")]
    expect(planDelete(files, [], [], { path: "plan.md" })).toEqual({
      files: ["plan.md"],
      folders: [],
      references: [{ path: "index.mdx", references: [{ to: "plan.md", line: 3 }] }],
      blockers: [],
      changes: [{ kind: "delete", path: "plan.md", expectedRevision: "rev:plan.md" }],
    })
  })

  test("a diagram's generated files go with it, and cannot go on their own", () => {
    const files = [
      file("flow.d2", "a -> b\n"),
      file("flow.excalidraw", scene),
      file("flow.d2.json", '{"layout":"elk"}\n'),
      file("page.mdx", '# Page\n\n<Diagram src="flow.d2" />\n'),
    ]
    const plan = planDelete(files, [], [], { path: "flow.d2" })
    expect(plan.files).toEqual(["flow.d2", "flow.excalidraw", "flow.d2.json"])
    expect(plan.changes.map((change) => change.kind)).toEqual(["delete", "delete", "delete"])
    expect(plan.references).toEqual([{ path: "page.mdx", references: [{ to: "flow.d2", line: 3 }] }])
    expect(refusal(() => planDelete(files, [], [], { path: "flow.excalidraw" }))).toBe(
      "flow.excalidraw is generated from flow.d2. Delete flow.d2 instead, and its generated files go with it.",
    )
  })

  test("a file of a kind the app does not edit can be deleted", () => {
    expect(planDelete([file("agent/output.txt", "hello\n")], ["agent"], [], { path: "agent/output.txt" }).changes).toEqual([
      { kind: "delete", path: "agent/output.txt", expectedRevision: "rev:agent/output.txt" },
    ])
  })

  test("a missing file is refused", () => {
    expect(refusal(() => planDelete([], [], [], { path: "gone.md" }))).toBe("gone.md is not in this project.")
  })
})

describe("deleting a folder", () => {
  const files = [
    file("docs/a.mdx", '# A\n\n<Drawing src="docs/deep/sketch.excalidraw" />\n'),
    file("docs/deep/sketch.excalidraw", scene),
    file("docs/output.txt", "from an agent\n"),
    file("docs-old/kept.md", "Not in the folder.\n"),
    file("index.md", "[A](docs/a.mdx) and [kept](docs-old/kept.md)\n"),
  ]
  const folders = ["docs", "docs-old", "docs/deep", "docs/empty"]
  const explicit = ["docs", "docs/empty"]

  test("takes every file and stored folder under it, in one save, and lists references from outside", () => {
    const plan = planDelete(files, folders, explicit, { folder: "docs" })
    expect(plan.files).toEqual(["docs/a.mdx", "docs/deep/sketch.excalidraw", "docs/output.txt"])
    // Every folder that goes is listed, though only the stored ones need removing.
    expect(plan.folders).toEqual(["docs", "docs/deep", "docs/empty"])
    // The embed inside the folder goes with it, so only the link from outside is listed.
    expect(plan.references).toEqual([{ path: "index.md", references: [{ to: "docs/a.mdx", line: 1 }] }])
    expect(plan.blockers).toEqual([])
    expect(plan.changes).toEqual([
      { kind: "delete", path: "docs/a.mdx", expectedRevision: "rev:docs/a.mdx" },
      { kind: "delete", path: "docs/deep/sketch.excalidraw", expectedRevision: "rev:docs/deep/sketch.excalidraw" },
      { kind: "delete", path: "docs/output.txt", expectedRevision: "rev:docs/output.txt" },
      { kind: "rmdir", path: "docs/empty" },
      { kind: "rmdir", path: "docs" },
    ])
  })

  test("an empty stored folder goes on its own, and a folder that only holds files goes with them", () => {
    expect(planDelete(files, folders, explicit, { folder: "docs/empty" }).changes).toEqual([{ kind: "rmdir", path: "docs/empty" }])
    const deep = planDelete(files, folders, explicit, { folder: "docs/deep" })
    expect(deep.folders).toEqual(["docs/deep"])
    expect(deep.changes).toEqual([{ kind: "delete", path: "docs/deep/sketch.excalidraw", expectedRevision: "rev:docs/deep/sketch.excalidraw" }])
  })

  test("a missing folder, or more changes than one save holds, is refused", () => {
    expect(refusal(() => planDelete(files, folders, explicit, { folder: "missing" }))).toBe("There is no folder missing.")
    const many = Array.from({ length: 4096 }, (_, index) => file(`big/n${index}.md`, "x\n"))
    expect(refusal(() => planDelete(many, ["big"], ["big"], { folder: "big" }))).toBe(
      "Deleting big takes 4097 changes, more than the 4096 one save can hold. Delete some of what is in it first.",
    )
  })
})

describe("unsaved edits and conflicts block what goes", () => {
  test("a file with unsaved edits or a sync conflict, or one never saved", () => {
    expect(planDelete([file("plan.md", "# Plan\n", { draft: "# Plan, edited\n" })], [], [], { path: "plan.md" }).blockers).toEqual([
      { path: "plan.md", reason: "It has unsaved edits. Save or discard them before deleting it." },
    ])
    expect(planDelete([file("plan.md", "# Plan\n", { conflict: true })], [], [], { path: "plan.md" }).blockers).toEqual([
      { path: "plan.md", reason: "It has a sync conflict. Resolve it before deleting it." },
    ])
    const draftOnly = file("docs/new.md", "", { revision: "", saved: null, draft: "a new note" })
    expect(planDelete([draftOnly], ["docs"], [], { folder: "docs" }).blockers).toEqual([
      { path: "docs/new.md", reason: "It has unsaved edits. Save or discard them before deleting its folder." },
    ])
  })

  test("unsaved edits in a file that stays are left alone", () => {
    const files = [file("plan.md", "# Plan\n"), file("index.md", "[plan](plan.md)\n", { draft: "[plan](plan.md), edited\n" })]
    const plan = planDelete(files, [], [], { path: "plan.md" })
    expect(plan.blockers).toEqual([])
    expect(plan.references).toEqual([{ path: "index.md", references: [{ to: "plan.md", line: 1 }] }])
  })
})
