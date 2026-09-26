import { describe, expect, test } from "bun:test"
import { MoveRefusedError, planFolderMove, planMove, type MoveSourceFile } from "./movePlan"

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
    expect(error).toBeInstanceOf(MoveRefusedError)
    return (error as Error).message
  }
  throw new Error("expected the move to be refused")
}

describe("moving a note into a folder", () => {
  const files = [
    file("plan.md", "# Plan\n"),
    file("index.mdx", "See [the plan](plan.md) and [elsewhere](other.md).\n"),
    file("other.md", "Unrelated.\n"),
  ]

  test("moves it and rewrites the links to it in the same save", () => {
    const plan = planMove(files, ["archive"], { path: "plan.md", folder: "archive" })
    expect(plan.moves).toEqual([{ from: "plan.md", to: "archive/plan.md" }])
    expect(plan.updates).toEqual([{ path: "index.mdx", references: [{ from: "plan.md", to: "archive/plan.md", line: 1 }] }])
    expect(plan.blockers).toEqual([])
    expect(plan.changes).toEqual([
      { kind: "move", from: "plan.md", to: "archive/plan.md", expectedRevision: "rev:plan.md" },
      {
        kind: "write",
        path: "index.mdx",
        content: "See [the plan](archive/plan.md) and [elsewhere](other.md).\n",
        expectedRevision: "rev:index.mdx",
      },
    ])
  })

  test("moves it back to the top level", () => {
    const nested = [file("archive/plan.md", "# Plan\n")]
    expect(planMove(nested, ["archive"], { path: "archive/plan.md", folder: "" }).moves).toEqual([{ from: "archive/plan.md", to: "plan.md" }])
  })

  test("a file that refers to itself keeps working, through the move's own content", () => {
    const self = [file("notes/self.md", "Back to [top](notes/self.md).\n")]
    const plan = planMove(self, ["notes", "done"], { path: "notes/self.md", folder: "done" })
    expect(plan.changes).toEqual([
      { kind: "move", from: "notes/self.md", to: "done/self.md", expectedRevision: "rev:notes/self.md", content: "Back to [top](done/self.md).\n" },
    ])
  })
})

describe("renaming", () => {
  test("renames in place and rewrites embeds and imports", () => {
    const files = [
      file("art/sketch.excalidraw", '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'),
      file("cards.mdx", "export const Card = () => <p>card</p>\n"),
      file("page.mdx", 'import { Card } from "workspace:cards.mdx"\n\n<Drawing src="art/sketch.excalidraw" />\n\n<Card />\n'),
    ]
    const drawing = planMove(files, ["art"], { path: "art/sketch.excalidraw", name: "diagram.excalidraw" })
    expect(drawing.moves).toEqual([{ from: "art/sketch.excalidraw", to: "art/diagram.excalidraw" }])
    expect(drawing.changes[1]).toMatchObject({ kind: "write", path: "page.mdx", content: expect.stringContaining('<Drawing src="art/diagram.excalidraw" />') })

    const module = planMove(files, ["art"], { path: "cards.mdx", name: "widgets.mdx" })
    expect(module.changes[1]).toMatchObject({ kind: "write", path: "page.mdx", content: expect.stringContaining('from "workspace:widgets.mdx"') })
  })

  test("refuses a name that changes the file's kind, or a name that is already taken", () => {
    const files = [file("a.md", "a\n"), file("b.md", "b\n")]
    expect(refusal(() => planMove(files, [], { path: "a.md", name: "a.mdx" }))).toContain("Keep its extension")
    expect(refusal(() => planMove(files, [], { path: "a.md", name: "b.md" }))).toBe("b.md already exists.")
    expect(refusal(() => planMove(files, [], { path: "a.md", name: "a.md" }))).toContain("not a valid name")
  })
})

describe("D2 diagrams", () => {
  const scene = '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
  const files = [
    file("flow.d2", "a -> b\n"),
    file("flow.excalidraw", scene),
    file("flow.d2.json", '{"layout":"elk"}\n'),
    file("sketch.excalidraw", scene),
  ]

  test("a diagram's generated files move and rename with it, byte for byte", () => {
    const moved = planMove(files, ["diagrams"], { path: "flow.d2", folder: "diagrams" })
    expect(moved.moves).toEqual([
      { from: "flow.d2", to: "diagrams/flow.d2" },
      { from: "flow.excalidraw", to: "diagrams/flow.excalidraw" },
      { from: "flow.d2.json", to: "diagrams/flow.d2.json" },
    ])
    expect(moved.changes.every((change) => change.kind === "move" && change.content === undefined)).toBe(true)

    const renamed = planMove(files, [], { path: "flow.d2", name: "pipeline.d2" })
    expect(renamed.moves.map((move) => move.to)).toEqual(["pipeline.d2", "pipeline.excalidraw", "pipeline.d2.json"])
  })

  test("a generated file cannot move on its own, but a plain drawing can", () => {
    expect(refusal(() => planMove(files, ["diagrams"], { path: "flow.excalidraw", folder: "diagrams" }))).toContain("generated from flow.d2")
    expect(refusal(() => planMove(files, ["diagrams"], { path: "flow.d2.json", folder: "diagrams" }))).toContain("generated from flow.d2")
    expect(planMove(files, ["diagrams"], { path: "sketch.excalidraw", folder: "diagrams" }).moves).toHaveLength(1)
  })

  test("a taken destination for any generated file refuses the whole move", () => {
    const taken = [...files, file("diagrams/flow.d2.json", "{}\n")]
    expect(refusal(() => planMove(taken, ["diagrams"], { path: "flow.d2", folder: "diagrams" }))).toBe("diagrams/flow.d2.json already exists.")
  })
})

describe("destinations", () => {
  const files = [file("a.md", "a\n"), file("notes/a.md", "other a\n"), file("box.md", "b\n")]

  test("the folder must exist, the file must not already be there, and no file can stand in for a folder", () => {
    expect(refusal(() => planMove(files, ["notes"], { path: "a.md", folder: "missing" }))).toBe("There is no folder missing.")
    expect(refusal(() => planMove(files, ["notes"], { path: "a.md", folder: "notes" }))).toBe("notes/a.md already exists.")
    expect(refusal(() => planMove(files, ["notes"], { path: "notes/a.md", folder: "notes" }))).toBe("notes/a.md is already there.")
    // A stale folder list can name a path that is now a file.
    expect(refusal(() => planMove([file("box.md", "b\n"), file("x.md", "x\n")], ["box.md"], { path: "x.md", folder: "box.md" }))).toBe(
      "box.md is a file, so it cannot hold box.md/x.md.",
    )
  })

  test("files of kinds the app does not edit are left where they are", () => {
    expect(refusal(() => planMove([file("agent/output.txt", "hello\n")], ["notes"], { path: "agent/output.txt", folder: "notes" }))).toBe(
      "agent/output.txt is not a kind of file that can be renamed or moved here.",
    )
  })

  test("a file that was never saved, or is not in the project, cannot move", () => {
    expect(refusal(() => planMove([file("new.md", "", { revision: "", saved: null, draft: "draft" })], ["notes"], { path: "new.md", folder: "notes" }))).toContain(
      "Save new.md",
    )
    expect(refusal(() => planMove(files, ["notes"], { path: "gone.md", folder: "notes" }))).toBe("gone.md is not in this project.")
  })
})

describe("unsaved edits and conflicts block the files they touch", () => {
  const base = [file("plan.md", "# Plan\n"), file("index.md", "[plan](plan.md)\n"), file("unrelated.md", "Nothing here.\n")]
  const with_ = (path: string, extra: Partial<MoveSourceFile>) => base.map((entry) => (entry.path === path ? { ...entry, ...extra } : entry))
  const move = (files: MoveSourceFile[]) => planMove(files, ["archive"], { path: "plan.md", folder: "archive" })

  test("the moved file itself", () => {
    expect(move(with_("plan.md", { draft: "# Plan, edited\n" })).blockers).toEqual([
      { path: "plan.md", reason: "It has unsaved edits. Save or discard them before moving it." },
    ])
    expect(move(with_("plan.md", { conflict: true })).blockers).toEqual([{ path: "plan.md", reason: "It has a sync conflict. Resolve it before moving it." }])
  })

  test("a file whose references would change, in its saved copy or in its unsaved edits", () => {
    const reason = "It has unsaved edits. Save or discard them before its references are updated."
    expect(move(with_("index.md", { draft: "[plan](plan.md) and more\n" })).blockers).toEqual([{ path: "index.md", reason }])
    expect(move(with_("unrelated.md", { draft: "Now linking [plan](plan.md)\n" })).blockers).toEqual([{ path: "unrelated.md", reason }])
    expect(move(with_("index.md", { conflict: true })).blockers).toEqual([
      { path: "index.md", reason: "It has a sync conflict. Resolve it before its references are updated." },
    ])
  })

  test("unsaved edits in a file the move does not touch are left alone", () => {
    const plan = move(with_("unrelated.md", { draft: "Still nothing.\n" }))
    expect(plan.blockers).toEqual([])
    expect(plan.changes.map((change) => (change.kind === "move" ? change.from : change.path))).toEqual(["plan.md", "index.md"])
  })

  test("references the planner cannot rewrite safely are blockers", () => {
    const plan = planMove([file("notes/plan.md", "x\n"), file("notes/index.md", "[plan](./plan.md)\n")], ["notes", "archive"], {
      path: "notes/plan.md",
      folder: "archive",
    })
    expect(plan.blockers).toEqual([{ path: "notes/index.md", reason: "Unsupported document-relative link or image would be affected by this move" }])
  })
})

describe("renaming and moving a folder", () => {
  const scene = '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
  const files = [
    file("docs/plan.mdx", '# Plan\n\n<Drawing src="docs/art/sketch.excalidraw" />\n\nSee [other](other.md).\n'),
    file("docs/art/sketch.excalidraw", scene),
    file("docs/flow.d2", "a -> b\n"),
    file("docs/flow.excalidraw", scene),
    file("docs/flow.d2.json", '{"layout":"elk"}\n'),
    file("index.md", "[The plan](docs/plan.mdx)\n"),
    file("other.md", "Unrelated.\n"),
    file("docs-old/kept.md", "Not in the folder.\n"),
  ]
  const folders = ["archive", "docs", "docs-old", "docs/art", "docs/empty"]
  const explicit = ["archive", "docs", "docs/empty"]

  test("a rename moves everything in the folder and rewrites references into it and within it", () => {
    const plan = planFolderMove(files, folders, explicit, { folder: "docs", name: "notes" })
    expect(plan.folder).toEqual({ from: "docs", to: "notes" })
    expect(plan.moves).toEqual([
      { from: "docs/plan.mdx", to: "notes/plan.mdx" },
      { from: "docs/art/sketch.excalidraw", to: "notes/art/sketch.excalidraw" },
      { from: "docs/flow.d2", to: "notes/flow.d2" },
      { from: "docs/flow.excalidraw", to: "notes/flow.excalidraw" },
      { from: "docs/flow.d2.json", to: "notes/flow.d2.json" },
    ])
    expect(plan.blockers).toEqual([])
    // Into the folder from outside, and within it; a link out of it to other.md is unchanged.
    expect(plan.changes).toContainEqual({
      kind: "move",
      from: "docs/plan.mdx",
      to: "notes/plan.mdx",
      expectedRevision: "rev:docs/plan.mdx",
      content: '# Plan\n\n<Drawing src="notes/art/sketch.excalidraw" />\n\nSee [other](other.md).\n',
    })
    expect(plan.changes).toContainEqual({ kind: "write", path: "index.md", content: "[The plan](notes/plan.mdx)\n", expectedRevision: "rev:index.md" })
    // Explicit folders stay explicit (the empty one too); docs/art was only implied by its file.
    expect(plan.changes.filter((change) => change.kind === "mkdir" || change.kind === "rmdir")).toEqual([
      { kind: "mkdir", path: "notes" },
      { kind: "mkdir", path: "notes/empty" },
      { kind: "rmdir", path: "docs/empty" },
      { kind: "rmdir", path: "docs" },
    ])
    // A folder whose name only starts the same stays put.
    expect(plan.changes.some((change) => JSON.stringify(change).includes("docs-old"))).toBe(false)
  })

  test("a move into another folder, or to the top level, keeps the folder's name", () => {
    const into = planFolderMove(files, folders, explicit, { folder: "docs", into: "archive" })
    expect(into.folder).toEqual({ from: "docs", to: "archive/docs" })
    expect(into.moves[0]).toEqual({ from: "docs/plan.mdx", to: "archive/docs/plan.mdx" })
    const nested = [file("archive/docs/a.md", "a\n"), file("index.md", "[a](archive/docs/a.md)\n")]
    const out = planFolderMove(nested, ["archive", "archive/docs"], [], { folder: "archive/docs", into: "" })
    expect(out.moves).toEqual([{ from: "archive/docs/a.md", to: "docs/a.md" }])
    expect(out.changes).toContainEqual({ kind: "write", path: "index.md", content: "[a](docs/a.md)\n", expectedRevision: "rev:index.md" })
  })

  test("an empty explicit folder moves as folders alone", () => {
    const plan = planFolderMove(files, folders, explicit, { folder: "docs/empty", into: "archive" })
    expect(plan.moves).toEqual([])
    expect(plan.changes).toEqual([
      { kind: "mkdir", path: "archive/empty" },
      { kind: "rmdir", path: "docs/empty" },
    ])
  })

  test("unsaved edits, sync conflicts, never-saved files and file kinds the app does not move are blockers", () => {
    const with_ = (path: string, extra: Partial<MoveSourceFile>) => files.map((entry) => (entry.path === path ? { ...entry, ...extra } : entry))
    const rename = (list: MoveSourceFile[]) => planFolderMove(list, folders, explicit, { folder: "docs", name: "notes" }).blockers
    expect(rename(with_("docs/flow.d2", { draft: "a -> c\n" }))).toEqual([
      { path: "docs/flow.d2", reason: "It has unsaved edits. Save or discard them before moving its folder." },
    ])
    expect(rename(with_("docs/art/sketch.excalidraw", { conflict: true }))).toEqual([
      { path: "docs/art/sketch.excalidraw", reason: "It has a sync conflict. Resolve it before moving its folder." },
    ])
    expect(rename([...files, file("docs/new.md", "", { revision: "", saved: null, draft: "draft" })])).toContainEqual({
      path: "docs/new.md",
      reason: "It has never been saved. Save it before moving its folder.",
    })
    expect(rename([...files, file("docs/output.txt", "from an agent\n")])).toEqual([
      { path: "docs/output.txt", reason: "It is a kind of file that cannot be renamed or moved here, so its folder cannot move either." },
    ])
    // A file outside whose references would change must be settled too.
    expect(rename(with_("index.md", { draft: "[The plan](docs/plan.mdx), edited\n" }))).toEqual([
      { path: "index.md", reason: "It has unsaved edits. Save or discard them before its references are updated." },
    ])
  })

  test("a taken target, a move into itself, a bad name or a missing folder is refused", () => {
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", name: "docs-old" }))).toBe("docs-old already exists.")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", name: "other.md" }))).toBe("other.md already exists.")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", into: "docs" }))).toBe(
      "docs cannot move into itself or one of its own folders.",
    )
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", into: "docs/art" }))).toBe(
      "docs cannot move into itself or one of its own folders.",
    )
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", name: "a/b" }))).toContain("is not a valid folder name")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", name: ".hidden" }))).toContain("is not a valid folder name")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", name: "docs" }))).toBe("docs is already there.")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs/art", into: "docs" }))).toBe("docs/art is already there.")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "missing", name: "x" }))).toBe("There is no folder missing.")
    expect(refusal(() => planFolderMove(files, folders, explicit, { folder: "docs", into: "missing" }))).toBe("There is no folder missing.")
  })

  test("a move that needs more changes than one save holds is refused, not split", () => {
    const many = Array.from({ length: 4096 }, (_, index) => file(`big/n${index}.md`, "x\n"))
    expect(refusal(() => planFolderMove(many, ["big"], ["big"], { folder: "big", name: "large" }))).toBe(
      "Moving big takes 4098 changes, more than the 4096 one save can hold. Move some of what is in it first.",
    )
  })
})
