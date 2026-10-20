import { expect, test } from "bun:test";
import { projectFluidSource } from "./fluidProjection";
import { blockBoundariesFor, renderMessageSchema } from "./protocol";

test("rendered roots keep their own insertion boundaries after hidden source roots", async () => {
  const text = "---\ntitle: Note\n---\n\nexport const answer = 42\n\n[link]: https://example.com\n\n{/* Hidden */}\n\nVisible.\n\n<Counter />\n";
  const projection = await projectFluidSource(text, "mdx");
  const mapping = blockBoundariesFor(projection.mapping.roots, projection.instrumentation.boundaries);
  expect(mapping).toEqual(projection.mapping.roots.map((root) => ({
    position: root.pos,
    boundary: `after:${root.to}`,
  })));
  expect(mapping).toHaveLength(2);
  expect(mapping[0].boundary).toBe(`after:${text.indexOf("Visible.") + "Visible.".length}`);
});

test("synthetic blank roots use the nearest preceding parsed boundary", async () => {
  const text = "First.\n\n\n\nSecond.\n\n\n\n";
  const projection = await projectFluidSource(text, "md");
  const mapping = blockBoundariesFor(projection.mapping.roots, projection.instrumentation.boundaries);
  expect(projection.mapping.roots.map((root) => root.to)).toEqual([6, 8, 17, 19, 21]);
  expect(mapping.map((entry) => entry.boundary)).toEqual([
    "after:6", "after:6", "after:17", "after:17", "after:17",
  ]);
});

test("an empty or whitespace-only note maps its rendered paragraph to start", async () => {
  for (const text of ["", "\n\n"]) {
    const projection = await projectFluidSource(text, "md");
    expect(blockBoundariesFor(projection.mapping.roots, projection.instrumentation.boundaries)).toEqual([
      { position: 0, boundary: "start" },
    ]);
  }
});

test("authoring transport validates rendered boundary positions and identifiers", () => {
  const message = {
    kind: "render", session: "session-block-boundaries", revision: 1, code: "return {};", slots: [],
    authoring: { format: "mdx", boundaries: [], availableResourcePaths: [], blockBoundaries: [{ position: 0, boundary: "start" }] },
  };
  expect(renderMessageSchema.safeParse(message).success).toBe(true);
  expect(renderMessageSchema.safeParse({ ...message, authoring: { ...message.authoring, blockBoundaries: undefined } }).success).toBe(true);
  for (const entry of [{ position: -1, boundary: "start" }, { position: 0.5, boundary: "start" }, { position: 0, boundary: "x".repeat(129) }]) {
    expect(renderMessageSchema.safeParse({ ...message, authoring: { ...message.authoring, blockBoundaries: [entry] } }).success).toBe(false);
  }
});
