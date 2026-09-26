import { expect, test } from "bun:test";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { setBlockType } from "prosemirror-commands";
import { Transform } from "prosemirror-transform";
import { fluidSchema } from "./fluidSchema";
import { projectFluidSource, prepareFluidTransaction } from "./fluidProjection";

const body = 'Inline {2 + 2} and {3 + 3} text.';
const source = `export const keep = 7;\n\n${body}\n\n<Counter initial={keep} />\n\nTail.`;

test("a heading change preserves exact computed inline source and surrounding bytes", async () => {
  const projection = await projectFluidSource(source, "mdx");
  const root = projection.mapping.roots.find(entry => entry.node.type.name === "paragraph" && entry.node.textContent.startsWith("Inline"))!;
  const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, root.pos + 1) });
  let transaction: Transaction | undefined;
  expect(setBlockType(fluidSchema.nodes.heading, { level: 2 })(state, tr => { transaction = tr; })).toBe(true);
  const result = await prepareFluidTransaction({ text: source, format: "mdx", revision: 0 }, projection, transaction!.steps.map(step => step.toJSON()));
  expect(result.text).toBe(source.replace(body, `## ${body}`));
  expect(result.projection.doc.eq(transaction!.doc)).toBe(true);
  expect(result.projection.islands.map(island => result.text.slice(island.from, island.to))).toEqual(projection.islands.map(island => source.slice(island.from, island.to)));
});

test("a heading request cannot alter or reorder protected inline objects", async () => {
  const projection = await projectFluidSource(source, "mdx");
  const root = projection.mapping.roots.find(entry => entry.node.type.name === "paragraph" && entry.node.textContent.startsWith("Inline"))!;
  const children = [...root.node.content.content];
  const objects = children.filter(node => node.type.name === "inline_object");
  expect(objects).toHaveLength(2);
  for (const mode of ["forged", "reordered", "deleted", "marked"] as const) {
    let index = 0;
    const changed = children.flatMap(node => {
      if (node.type.name !== "inline_object") return [node];
      if (mode === "deleted") return [];
      if (mode === "marked") return [node.mark([fluidSchema.marks.strong.create()])];
      return [mode === "forged" ? fluidSchema.nodes.inline_object.create({ id: "forged" }) : objects[objects.length - 1 - index++]];
    });
    const tr = new Transform(projection.doc).replaceWith(root.pos, root.end, fluidSchema.nodes.heading.create({ level: 2 }, changed));
    await expect(prepareFluidTransaction({ text: source, format: "mdx", revision: 0 }, projection, tr.steps.map(step => step.toJSON()))).rejects.toThrow(/protected/);
    expect(projection.text).toBe(source);
  }
});
