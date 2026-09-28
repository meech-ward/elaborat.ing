import { expect, test } from "bun:test"
import { parseDrawingFile } from "@/features/drawings/parse"
import { isValidProjectPath } from "@/features/project-storage/model"
import { projectDiagramArtifact } from "@/features/workbench/diagramArtifact"
import { parseSourceRefs } from "@/features/workbench/refs"
import { WELCOME_FILES, WELCOME_NOTE } from "."

const content = (path: string) => WELCOME_FILES.find((file) => file.path === path)?.content ?? null

test("the welcome note embeds a drawing and a diagram that come with it", () => {
  expect(WELCOME_FILES.every((file) => isValidProjectPath(file.path))).toBe(true)
  const note = content(WELCOME_NOTE)!
  const embeds = parseSourceRefs(note).filter((ref) => ref.kind !== "link")
  expect(embeds.map((ref) => [ref.kind, ref.path])).toEqual([
    ["drawing", "sketch.excalidraw"],
    ["diagram", "flow.d2"],
  ])
  expect(parseDrawingFile(content("sketch.excalidraw")!, "sketch.excalidraw").scene.elements.length).toBeGreaterThan(0)
  expect(note).not.toContain("—")
})

test("the welcome diagram shows from its saved canvas, without compiling its code", async () => {
  const result = await projectDiagramArtifact({
    source: content("flow.d2")!,
    nativePath: "flow.excalidraw",
    nativeContent: content("flow.excalidraw"),
    sidecarContent: content("flow.d2.json"),
    compile: () => {
      throw new Error("The saved canvas is out of date with flow.d2: open it in the app and copy the files it saves.")
    },
  })
  expect(result.ok).toBe(true)
  expect(result.scene.elements.length).toBeGreaterThan(0)
})
