import { expect, test } from "bun:test";
import { chainCommands } from "prosemirror-commands";
import { splitListItem } from "prosemirror-schema-list";
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import type { DocumentFormat } from "../document";
import { emptyListBackspace, listItemBackspace } from "./fluidCommands";
import {
  prepareFluidTransaction,
  projectFluidSource,
} from "./fluidProjection";
import { fluidSchema } from "./fluidSchema";

const backspace = chainCommands(emptyListBackspace, listItemBackspace);
function command(state: EditorState, action: Command): Transaction {
  let made: Transaction | undefined;
  expect(action(state, (tr) => { made = tr; })).toBe(true);
  expect(made).toBeDefined();
  return made!;
}
const steps = (tr: Transaction) => tr.steps.map((step) => step.toJSON());
function inParagraph(state: EditorState, text: string, offset: number): EditorState {
  let position = -1;
  state.doc.descendants((node, pos) => {
    if (node.type === fluidSchema.nodes.paragraph && node.textContent === text)
      position = pos + 1 + offset;
  });
  expect(position).toBeGreaterThan(0);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
}

for (const format of ["md", "mdx"] satisfies DocumentFormat[]) {
  for (const list of [
    "- First\n- Second\n- Third",
    "* First\n* **Second**\n* Third",
    "+ First\n+ Second\n+ Third",
    "3. First\n4. Second\n5. Third",
    "3) First\n4) Second\n5) Third",
    "- [ ] First\n- [x] **Second**\n- [ ] Third",
    "- First\n\n- Second\n\n- Third",
    "- Parent\n  - First\n  - **Second**\n  - Third\n- Tail",
  ]) {
    for (const offset of [3, 6]) {
      test(`${format} list Enter then Backspace at ${offset} restores ${JSON.stringify(list)}`, async () => {
        const text = format === "mdx"
          ? `export const kept = 7;\n\n{/* keep  spacing */}\n\n${list}\n\n<Counter initial={kept} />\n\nTail.`
          : `Before.\n\n${list}\n\nAfter.`;
        const projection = await projectFluidSource(text, format);
        const state = inParagraph(EditorState.create({ doc: projection.doc }), "Second", offset);
        const task = state.selection.$from.node(-1).attrs.checked != null;
        const split = command(state, splitListItem(fluidSchema.nodes.list_item, task ? { checked: false } : undefined));
        const removal = command(state.apply(split), backspace);
        expect(removal.doc.eq(projection.doc)).toBe(true);
        expect(removal.selection.from).toBe(state.selection.from);

        const added = await prepareFluidTransaction(
          { text, revision: 0, format }, projection, steps(split),
        );
        const deleted = await prepareFluidTransaction(
          { text: added.text, revision: 1, format }, added.projection, steps(removal),
        );
        expect(deleted.text).toBe(text);
        expect(deleted.projection.doc.eq(removal.doc)).toBe(true);
        expect(deleted.nearest).toBeNull();

        // Fast typing can send Enter and Backspace in the same pending batch.
        const batched = await prepareFluidTransaction(
          { text, revision: 0, format }, projection, [...steps(split), ...steps(removal)],
        );
        expect(batched.text).toBe(text);
        expect(batched.patches).toEqual([]);
        expect(batched.projection.doc.eq(removal.doc)).toBe(true);
        expect(batched.nearest).toBeNull();
      });
    }
  }
}

for (const { text, expected, caret } of [
  {
    text: "- **First**\n- \n- Third",
    expected: "- **First**\n- Third",
    caret: "First",
  },
  {
    text: "- First\n\n  second paragraph\n- \n- Third",
    expected: "- First\n\n  second paragraph\n- Third",
    caret: "second paragraph",
  },
  {
    text: "- First\n  - Nested\n- \n- Third",
    expected: "- First\n  - Nested\n- Third",
    caret: "Nested",
  },
  {
    text: "- First\n  ```js\n  kept()\n  ```\n- \n- Third",
    expected: "- First\n  ```js\n  kept()\n  ```\n- Third",
    caret: "First",
  },
  {
    text: "- Parent\n  - First\n  - \n  - Third\n- Tail",
    expected: "- Parent\n  - First\n  - Third\n- Tail",
    caret: "First",
  },
]) {
  test(`empty middle item removal preserves prior structure ${JSON.stringify(text)}`, async () => {
    const projection = await projectFluidSource(text, "mdx");
    const state = inParagraph(EditorState.create({ doc: projection.doc }), "", 0);
    const removal = command(state, emptyListBackspace);
    expect(removal.selection.$from.parent.textContent).toBe(caret);
    expect(removal.selection.$from.parentOffset).toBe(caret.length);
    const deleted = await prepareFluidTransaction(
      { text, revision: 0, format: "mdx" }, projection, steps(removal),
    );
    expect(deleted.text).toBe(expected);
    expect(deleted.projection.doc.eq(removal.doc)).toBe(true);
    expect(deleted.projection.islands).toEqual(projection.islands);
  });
}

test("Backspace still lifts an empty final item out of its list", async () => {
  const text = "* First\n* Second\n* ";
  const projection = await projectFluidSource(text, "mdx");
  const state = inParagraph(EditorState.create({ doc: projection.doc }), "", 0);
  const removal = command(state, backspace);
  const deleted = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" }, projection, steps(removal),
  );
  expect(deleted.text).toBe("* First\n* Second\n\n");
  expect(deleted.projection.doc.eq(removal.doc)).toBe(true);
  expect(deleted.projection.doc.child(1).type).toBe(fluidSchema.nodes.paragraph);
});

for (const suffix of ["\n\n  continuation", "\n  - Nested"]) {
  test(`joining item text preserves its following blocks ${JSON.stringify(suffix)}`, async () => {
    const text = `- First\n- Second${suffix}\n- Third`;
    const projection = await projectFluidSource(text, "mdx");
    const state = inParagraph(EditorState.create({ doc: projection.doc }), "Second", 0);
    const removal = command(state, listItemBackspace);
    const deleted = await prepareFluidTransaction(
      { text, revision: 0, format: "mdx" }, projection, steps(removal),
    );
    expect(deleted.text).toBe(`- FirstSecond${suffix}\n- Third`);
    expect(deleted.projection.doc.eq(removal.doc)).toBe(true);
    expect(removal.selection.$from.parentOffset).toBe("First".length);
  });
}

test("list text joining only handles the first paragraph's starting caret", async () => {
  const projection = await projectFluidSource("- First\n- Second\n\n  continuation", "mdx");
  const state = EditorState.create({ doc: projection.doc });
  expect(listItemBackspace(inParagraph(state, "First", 0), () => {})).toBe(false);
  expect(listItemBackspace(inParagraph(state, "Second", 1), () => {})).toBe(false);
  expect(listItemBackspace(inParagraph(state, "continuation", 0), () => {})).toBe(false);
  const atStart = inParagraph(state, "Second", 0);
  const selected = atStart.apply(atStart.tr.setSelection(TextSelection.create(atStart.doc, atStart.selection.from, atStart.selection.from + 1)));
  expect(listItemBackspace(selected, () => {})).toBe(false);
  const plain = await projectFluidSource("First\n\nSecond", "mdx");
  expect(listItemBackspace(inParagraph(EditorState.create({ doc: plain.doc }), "Second", 0), () => {})).toBe(false);
});
