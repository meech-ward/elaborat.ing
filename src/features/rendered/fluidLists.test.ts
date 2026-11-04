import { expect, test } from "bun:test";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, NodeSelection, TextSelection, type Command, type Selection, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import type { DocumentFormat } from "../document";
import { emptyListBackspace, keepingEmptyParagraphs, listItemBackspace, quoteStartEnter } from "./fluidCommands";
import {
  fluidSourceOffsetForPosition,
  prepareFluidTransaction,
  projectFluidSource,
  type FluidProjection,
} from "./fluidProjection";
import { fluidSchema } from "./fluidSchema";
import { changeTo } from "./nearestForm";

// List edits in the rendered view, written into the note's source. Each edit
// runs the editor's own key commands (as fluidEditor.ts binds them) on the
// projected document and must be written exactly: the source it makes reads
// back as the document the edit made.

const nodes = fluidSchema.nodes;
const enter: Command = keepingEmptyParagraphs(chainCommands(
  quoteStartEnter,
  (state, dispatch) => {
    const { $from } = state.selection;
    const task = $from.depth > 1 && $from.node(-1).attrs.checked != null;
    return splitListItem(nodes.list_item, task ? { checked: false } : undefined)(state, dispatch);
  },
  baseKeymap.Enter,
));
// Backspace as the frame binds it, then the browser's own deletion of a
// character, which ProseMirror reads back as a step.
const backspace: Command = chainCommands(emptyListBackspace, listItemBackspace, baseKeymap.Backspace, (state, dispatch) => {
  const { from, to, empty } = state.selection;
  dispatch?.(state.tr.delete(empty ? from - 1 : from, to));
  return true;
});
const del = baseKeymap.Delete;
const tab = sinkListItem(nodes.list_item);
const untab = liftListItem(nodes.list_item);

type Note = { text: string; format: DocumentFormat; projection: FluidProjection; selection: Selection };

async function note(text: string, format: DocumentFormat = "mdx"): Promise<Note> {
  const projection = await projectFluidSource(text, format);
  return { text, format, projection, selection: TextSelection.atStart(projection.doc) };
}

/** The caret in the `nth` textblock whose text is `block`, `offset` into it (its end by default), or a selection to `to`. */
function caret(n: Note, block: string, offset?: number, to?: number, nth = 0): Note {
  const found: number[] = [];
  n.projection.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.textContent === block) found.push(pos + 1);
    return false;
  });
  if (found[nth] === undefined) throw new Error(`No textblock ${JSON.stringify(block)}`);
  const from = found[nth] + (offset ?? block.length);
  return { ...n, selection: TextSelection.create(n.projection.doc, from, to === undefined ? from : found[nth] + to) };
}

/** The caret at the end of the `nth` textblock. */
function end(n: Note, nth = 0): Note {
  const found: number[] = [];
  n.projection.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    found.push(pos + 1 + node.content.size);
    return false;
  });
  return { ...n, selection: TextSelection.create(n.projection.doc, found[nth]) };
}

async function write(n: Note, tr: Transaction): Promise<Note> {
  const next = await prepareFluidTransaction({ text: n.text, revision: 1, format: n.format }, n.projection, tr.steps.map((step) => step.toJSON()), tr.getMeta("fluidSyntax"));
  // Written exactly: the source reads back as the document the edit made.
  expect(next.nearest).toBeNull();
  expect(next.projection.doc.eq(tr.doc)).toBe(true);
  return { text: next.text, format: n.format, projection: next.projection, selection: TextSelection.create(next.projection.doc, tr.selection.anchor, tr.selection.head) };
}

async function press(n: Note, command: Command): Promise<Note> {
  const state = EditorState.create({ doc: n.projection.doc, selection: n.selection });
  let made: Transaction | undefined;
  expect(command(state, (tr) => (made = tr))).toBe(true);
  return write(n, made!);
}

async function type(n: Note, characters: string): Promise<Note> {
  for (const character of characters) {
    const state = EditorState.create({ doc: n.projection.doc, selection: n.selection });
    n = await write(n, state.tr.insertText(character));
  }
  return n;
}

async function refused(n: Note, command: Command, message: RegExp | string) {
  const state = EditorState.create({ doc: n.projection.doc, selection: n.selection });
  let made: Transaction | undefined;
  expect(command(state, (tr) => (made = tr))).toBe(true);
  await expect(prepareFluidTransaction({ text: n.text, revision: 1, format: n.format }, n.projection, made!.steps.map((step) => step.toJSON()))).rejects.toThrow(message);
}

const shape = (node: PMNode): string => {
  if (node.isText) return JSON.stringify(node.text);
  if (node.type === nodes.object || node.type === nodes.inline_object) return node.type.name;
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return `${node.type.name}(${children.join(", ")})`;
};
const islandSources = (n: Note) => n.projection.islands.map((island) => [island.id, n.text.slice(island.from, island.to)]);

for (const format of ["md", "mdx"] as const) {
  test(`${format}: an item that opens with a block, not text, is part of an editable list`, async () => {
    const shapes: Array<[string, string]> = [
      // Nothing after the marker: an empty paragraph there, then the item's blocks.
      ["- \n  - b", "bullet_list(list_item(paragraph(), bullet_list(list_item(paragraph(\"b\")))))"],
      ["-\n  - b", "bullet_list(list_item(paragraph(), bullet_list(list_item(paragraph(\"b\")))))"],
      ["1. \n   - b", "ordered_list(list_item(paragraph(), bullet_list(list_item(paragraph(\"b\")))))"],
      ["- \n  ```js\n  x()\n  ```\n- c", "bullet_list(list_item(paragraph(), object), list_item(paragraph(\"c\")))"],
      ["- \n  # Title\n- c", "bullet_list(list_item(paragraph(), heading(\"Title\")), list_item(paragraph(\"c\")))"],
      // A block on the marker's line: that block alone is an island.
      ["- ```js\n  x()\n  ```\n- b\n- c", "bullet_list(list_item(object), list_item(paragraph(\"b\")), list_item(paragraph(\"c\")))"],
      ["- a\n- # Title\n- c", "bullet_list(list_item(paragraph(\"a\")), list_item(object), list_item(paragraph(\"c\")))"],
      ["- - b\n- c", "bullet_list(list_item(object), list_item(paragraph(\"c\")))"],
      ["- > quoted\n- c", "bullet_list(list_item(object), list_item(paragraph(\"c\")))"],
    ];
    for (const [text, expected] of shapes) expect(shape((await projectFluidSource(text, format)).doc.firstChild!), text).toBe(expected);
    // Its other items take typing, Enter and Tab.
    const fenced = "- ```js\n  x()\n  ```\n- b\n- c";
    expect((await type(caret(await note(fenced, format), "b"), "x")).text).toBe("- ```js\n  x()\n  ```\n- bx\n- c");
    expect((await press(caret(await note(fenced, format), "b"), enter)).text).toBe("- ```js\n  x()\n  ```\n- b\n- \n- c");
    expect((await press(caret(await note(fenced, format), "b"), tab)).text).toBe("- ```js\n  x()\n  ```\n  - b\n- c");
    expect((await press(caret(await note("- # Title\n- b", format), "b", 0), backspace)).text).toBe("- # Title\n\n  b");
  });

  test(`${format}: Enter at the end of an item with a nested list starts an item that holds the nested list`, async () => {
    const entered = await press(caret(await note("- a\n  - b\n- c", format), "a"), enter);
    expect(entered.text).toBe("- a\n- \n  - b\n- c");
    expect((await type(entered, "x")).text).toBe("- a\n- x\n  - b\n- c");
    expect((await press(caret(await note("- alpha\n  - beta\n- gamma", format), "alpha"), enter)).text).toBe("- alpha\n- \n  - beta\n- gamma");
    expect((await press(caret(await note("1. a\n   - b", format), "a"), enter)).text).toBe("1. a\n2. \n   - b");
    expect((await press(caret(await note("- [ ] a\n  - b", format), "a"), enter)).text).toBe("- [ ] a\n- [ ] \n  - b");
    // A list with blank lines between its items keeps them, and the nested list stays in the new item.
    expect((await press(caret(await note("- a\n\n  - b\n\n- c", format), "a"), enter)).text).toBe("- a\n\n- \n  - b\n\n- c");
    // Deleting such an item's text, and Tab under an empty item.
    expect((await press(caret(await note("- alpha\n  - beta\n- gamma", format), "alpha", 0, 5), backspace)).text).toBe("- \n  - beta\n- gamma");
    expect((await press(caret(await note("- a\n  - b\n  - \n  - d", format), "d"), tab)).text).toBe("- a\n  - b\n  - \n    - d");
    // Typing after a bare marker writes the space the item needs.
    expect((await type(caret(await note("-\n  - b", format), "", 0), "x")).text).toBe("- x\n  - b");
    // In a quote.
    expect((await press(caret(await note("> - a\n>   - b\n> - c", format), "a"), enter)).text).toBe("> - a\n> - \n>   - b\n> - c");
  });

  test(`${format}: a nested list whose first item is empty is set off by a blank line until the item has text`, async () => {
    for (const [list, after, nested] of [
      ["- a\n- b", "- a\n- b\n\n  - ", "- a\n- b\n  - n"],
      ["* a\n* b", "* a\n* b\n\n  * ", "* a\n* b\n  * n"],
      ["+ a\n+ b", "+ a\n+ b\n\n  + ", "+ a\n+ b\n  + n"],
      ["1. a\n2. b", "1. a\n2. b\n\n   1. ", "1. a\n2. b\n   1. n"],
      ["1) a\n2) b", "1) a\n2) b\n\n   1) ", "1) a\n2) b\n   1) n"],
      ["- a\n  - b", "- a\n  - b\n\n    - ", "- a\n  - b\n    - n"],
      ["> - a\n> - b", "> - a\n> - b\n> \n>   - ", "> - a\n> - b\n>   - n"],
    ] as const) {
      // Enter, Tab, then typing: the standard way to start a nested item.
      const sunk = await press(await press(caret(await note(list, format), "b"), enter), tab);
      expect(sunk.text, list).toBe(after);
      expect((await type(sunk, "n")).text, list).toBe(nested);
    }
    // Emptying the first nested item, and typing in it again.
    const emptied = await press(caret(await note("- a\n  - b\n- c", format), "b"), backspace);
    expect(emptied.text).toBe("- a\n\n  - \n- c");
    expect((await type(emptied, "x")).text).toBe("- a\n  - x\n- c");
    expect((await press(emptied, backspace)).text).toBe("- a\n- \n- c");
    // Tab on an empty middle item, and Shift+Tab on an item before an empty one.
    expect((await press(caret(await note("- a\n- \n- c", format), "", 0), tab)).text).toBe("- a\n\n  - \n- c");
    expect((await press(caret(await note("- a\n  - b\n  - \n- c", format), "b"), untab)).text).toBe("- a\n- b\n\n  - \n- c");
    // A list spaced with blank lines keeps them, and a task's box needs none.
    expect((await type(await press(await press(caret(await note("- a\n\n- b", format), "b"), enter), tab), "n")).text).toBe("- a\n\n- b\n\n  - n");
    expect((await press(await press(caret(await note("- [ ] a\n- [ ] b", format), "b"), enter), tab)).text).toBe("- [ ] a\n- [ ] b\n  - [ ] ");
    // Nested lists spaced with blank lines keep them when the item gets text.
    expect((await type(caret(await note("- a\n\n  - \n\n  - c", format), "", 0), "x")).text).toBe("- a\n\n  - x\n\n  - c");
  });

  test(`${format}: an item moved into another list takes that list's marker and number`, async () => {
    for (const d of [".", ")"]) {
      const list = `1${d} a\n2${d} b\n3${d} c`;
      const nested = await press(caret(await note(list, format), "b"), tab);
      expect(nested.text).toBe(`1${d} a\n   1${d} b\n2${d} c`);
      // Shift+Tab brings it back as it was.
      expect((await press(caret(nested, "b"), untab)).text).toBe(list);
      expect((await press(caret(await note(list, format), "c"), tab)).text).toBe(`1${d} a\n2${d} b\n   1${d} c`);
      expect((await press(caret(await note(list, format), "a"), untab)).text).toBe(`a\n\n1${d} b\n2${d} c`);
      expect((await press(caret(await note(list, format), "b"), untab)).text).toBe(`1${d} a\n\nb\n\n1${d} c`);
    }
    expect((await press(caret(await note("3. a\n4. b", format), "b"), tab)).text).toBe("3. a\n   1. b");
    expect((await press(caret(await note("3. a\n4. b", format), "a"), untab)).text).toBe("a\n\n3. b");
    // Lifting an item with siblings after it is two steps; each is written.
    expect((await press(caret(await note("1. a\n   1. b\n   2. c\n2. d", format), "b"), untab)).text).toBe("1. a\n2. b\n   1. c\n3. d");
    // Between bullet and ordered lists, the item's later lines move with its marker.
    expect((await press(caret(await note("1. a\n   - b\n   - c\n2. d", format), "b"), untab)).text).toBe("1. a\n2. b\n   - c\n3. d");
    expect((await press(caret(await note("1. a\n   - b\n   - c\n2. d", format), "c"), untab)).text).toBe("1. a\n   - b\n2. c\n3. d");
    expect((await press(caret(await note("- a\n  1. x\n  2. y", format), "y"), tab)).text).toBe("- a\n  1. x\n     1. y");
    expect((await press(caret(await note("- a\n- b\n  - c\n    - d\n- e", format), "c"), untab)).text).toBe("- a\n- b\n- c\n  - d\n- e");
    // Joining two lists with different bullets makes one list with the first's.
    expect((await press(caret(await note("* a\n+ b", format), "b", 0), backspace)).text).toBe("* a\n* b");
    // In a quote.
    expect((await press(caret(await note("> 1. a\n> 2. b\n> 3. c", format), "b"), tab)).text).toBe("> 1. a\n>    1. b\n> 2. c");
  });

  test(`${format}: a list numbered 1, 2, 3 keeps counting; one numbered 1, 1, 1 or by no rule keeps its numbers`, async () => {
    const entered = await type(await press(caret(await note("1) a\n2) b", format), "a"), enter), "c");
    expect(entered.text).toBe("1) a\n2) c\n3) b");
    // Enter then Backspace gives the note back as it was.
    expect((await press(caret(entered, "c", 0), backspace)).text).toBe("1) ac\n2) b");
    expect((await press(caret(await note("1. a\n1. b", format), "a"), enter)).text).toBe("1. a\n1. \n1. b");
    expect((await press(caret(await note("1. a\n5. b\n3. c", format), "a"), enter)).text).toBe("1. a\n2. \n5. b\n3. c");
    // From 9 to 10 the item's later lines move one column with it.
    expect((await press(caret(await note("8. a\n9. b\n   - x\n10. c", format), "a"), enter)).text).toBe("8. a\n9. \n10. b\n    - x\n11. c");
    expect((await press(caret(await note("8. a\n9. b\n10. c\n11. d", format), "b", 0), backspace)).text).toBe("8. ab\n9. c\n10. d");
    // A selection across items, and Delete at an item's end.
    expect((await press(caret(await note("1. one\n2. two\n3. three\n4. four", format), "one", 2), (state, dispatch) => {
      const two = state.doc.resolve(state.selection.from).end() + 5;
      dispatch?.(state.tr.delete(state.selection.from, two));
      return true;
    })).text).toBe("1. onwo\n2. three\n3. four");
    // Delete at an item's end, as ProseMirror's joinForward makes it (b's paragraph moves into a).
    expect((await press(caret(await note("1. a\n2. b\n3. c", format), "a"), del)).text).toBe("1. a\n\n   b\n2. c");
    // The items that count on keep the gaps between them as written.
    expect((await press(caret(await note("1. a\n2. b\n\n3. c", format), "a"), enter)).text).toBe("1. a\n2. \n3. b\n\n4. c");
    expect((await press(caret(await note("1. a\n2. b\n\n3. c", format), "a"), del)).text).toBe("1. a\n\n   b\n\n2. c");
    expect((await press(caret(await note("1. a\n\n2. b\n3. c\n4. d", format), "a"), enter)).text).toBe("1. a\n\n2. \n\n3. b\n4. c\n5. d");
    expect((await press(caret(await note("1. a\n2. b\n3. c\n\n4. d", format), "b"), tab)).text).toBe("1. a\n   1. b\n2. c\n\n3. d");
    expect((await press(caret(await note("8. a\n9. b\n   - x\n\n10. c", format), "a"), enter)).text).toBe("8. a\n9. \n10. b\n    - x\n\n11. c");
  });

  test(`${format}: "1. " typed at the start of a bullet item makes it a numbered list under the item before`, async () => {
    let n = caret(await note("- a\n- b", format), "b", 0);
    n = await type(n, "1.");
    const state = EditorState.create({ doc: n.projection.doc, selection: n.selection });
    // The frame's input rule (fluidEditor.ts): take out "1." and wrap the paragraph in a list.
    const tr = state.tr.delete(state.selection.from - 2, state.selection.from);
    wrapInList(nodes.ordered_list, { order: 1 })(state.apply(tr), (next) => {
      for (const step of next.steps) tr.step(step);
    });
    expect((await write(n, tr)).text).toBe("- a\n  1. b");
  });

  test(`${format}: Enter or Shift+Tab on an empty middle item splits the list around an empty paragraph`, async () => {
    for (const [list, split] of [
      ["- a\n- \n- c", "- a\n\n\n\n* c"],
      ["* a\n* \n* c", "* a\n\n\n\n- c"],
      ["1. a\n2. \n3. c", "1. a\n\n\n\n1) c"],
      ["1) a\n2) \n3) c", "1) a\n\n\n\n1. c"],
      ["- [ ] a\n- [ ] \n- [ ] c", "- [ ] a\n\n\n\n* [ ] c"],
      ["- a\n\n- \n\n- c", "- a\n\n\n\n* c"],
    ] as const) {
      const entered = await press(caret(await note(list, format), "", 0), enter);
      expect(entered.text, list).toBe(split);
      expect((await press(caret(await note(list, format), "", 0), untab)).text, list).toBe(split);
    }
    // Backspace on the empty paragraph, or Delete at the end of the first
    // list, joins the lists again, with one bullet.
    const split = await press(caret(await note("- a\n- \n- c", format), "", 0), enter);
    expect((await press(caret(split, "", 0), backspace)).text).toBe("- a\n- \n- c");
    expect((await press(caret(split, "a"), del)).text).toBe("- a\n- \n- c");
    expect((await press(caret(await note("- a\n\n* c", format), "c", 0), backspace)).text).toBe("- a\n- c");
    // On the first item, the empty paragraph goes above the list.
    expect((await press(caret(await note("- \n- b\n- c", format), "", 0), enter)).text).toBe("\n\n\n\n- b\n- c");
    // Markdown has no empty paragraph inside a quote: there it is refused.
    await refused(caret(await note("> - a\n> - \n> - c", format), "", 0), enter, "Source projection differs");
  });

  test(`${format}: a block rewritten next to another on the line before or after it is set apart by a blank line`, async () => {
    expect((await press(caret(await note("* a\n+ b", format), "b"), untab)).text).toBe("* a\n\nb");
    expect((await press(caret(await note("para\n- a", format), "a"), untab)).text).toBe("para\n\na");
    expect((await press(caret(await note("para\n- a", format), "a", 0, 1), backspace)).text).toBe("para\n\n- ");
  });

  test(`${format}: text typed or deleted beside an image is written at the image's edge`, async () => {
    expect((await type(end(await note("Hello ![x](a.png)", format)), "z")).text).toBe("Hello ![x](a.png)z");
    expect((await type(await note("![x](a.png) there", format), "z")).text).toBe("z![x](a.png) there");
    expect((await type(end(await note("![x](a.png)", format)), "z")).text).toBe("![x](a.png)z");
    expect((await type(end(await note("- ![x](a.png)", format)), "z")).text).toBe("- ![x](a.png)z");
    // Inside the image's formatting.
    expect((await type(end(await note("**![x](a.png)**", format)), "z")).text).toBe("**![x](a.png)z**");
    // Between two images, after the first.
    const two = await note("![a](a.png)![b](b.png)", format);
    expect((await type({ ...two, selection: TextSelection.create(two.projection.doc, 2) }, "z")).text).toBe("![a](a.png)z![b](b.png)");
    // The space before an image, and Backspace joining an item to an image's item.
    expect((await press(caret(await note("Hello ![x](a.png)", format), "Hello ", 6), backspace)).text).toBe("Hello![x](a.png)");
    expect((await press(caret(await note("- ![x](a.png)\n- b", format), "b", 0), backspace)).text).toBe("- ![x](a.png)b");
    // The image's edges have source offsets, as text does.
    const image = await note("Hello ![x](a.png)", format);
    expect(fluidSourceOffsetForPosition(image.projection, 8)).toBe("Hello ![x](a.png)".length);
    // Typing over a selected image is still refused.
    const selected = { ...image, selection: NodeSelection.create(image.projection.doc, 7) };
    await refused(selected, (state, dispatch) => {
      dispatch?.(state.tr.insertText("z"));
      return true;
    }, /protected/);
  });

  test(`${format}: Enter, Tab and Shift+Tab around a code block in a list move it as written`, async () => {
    const fenced = "- a\n  ```js\n  x()\n  ```\n- b";
    const entered = await press(caret(await note(fenced, format), "a"), enter);
    expect(entered.text).toBe("- a\n- \n  ```js\n  x()\n  ```\n- b");
    expect(islandSources(entered)).toEqual(islandSources(await note(fenced, format)));
    expect((await press(caret(await note(fenced, format), "b"), tab)).text).toBe("- a\n  ```js\n  x()\n  ```\n  - b");
    expect((await press(caret(await note(fenced, format), "b"), untab)).text).toBe("- a\n  ```js\n  x()\n  ```\n\nb");
    expect((await press(caret(await note(fenced, format), "b", 0), backspace)).text).toBe("- a\n  ```js\n  x()\n  ```\n\n  b");
    // Out of the list the code block keeps its name, and its code is exactly as it was.
    const lifted = await press(caret(await note(fenced, format), "a"), untab);
    expect(lifted.text).toBe("a\n\n```js\nx()\n```\n\n- b");
    expect(lifted.projection.islands.map((island) => island.id)).toEqual((await note(fenced, format)).projection.islands.map((island) => island.id));
    // In an ordered list the code block moves one column with a wider number.
    expect((await press(caret(await note("8. a\n9. ```js\n   x\n   ```", format), "a"), enter)).text).toBe("8. a\n9. \n10. ```js\n    x\n    ```");
    // An image in a list.
    expect((await press(caret(await note("- ![x](a.png)\n- b", format), "b"), tab)).text).toBe("- ![x](a.png)\n  - b");
    expect((await press(caret(await note("- ![x](a.png)\n- b", format), "b"), untab)).text).toBe("- ![x](a.png)\n\nb");
    expect((await press(caret(await note("- ![x](a.png)\n- b", format), "b", 0), untab)).text).toBe("- ![x](a.png)\n\nb");
    // Deleting across the code block is still refused.
    await refused(caret(await note(fenced, format), "a", 0, undefined, 0), (state, dispatch) => {
      const b = state.doc.content.size - 3;
      dispatch?.(state.tr.delete(state.selection.from, b));
      return true;
    }, /protected/);
  });
}

test("a code block set in further than its item's text keeps that indent, and its code, wherever it goes", async () => {
  const text = "- a\n\n   ```js\n   x()\n    y()\n   ```\n- b";
  const original = (await note(text)).projection.islands.map((island) => island.id);
  const kept = await press(caret(await note(text), "b"), tab);
  expect(kept.text).toBe("- a\n\n   ```js\n   x()\n    y()\n   ```\n  - b");
  const lifted = await press(caret(await note(text), "a"), untab);
  expect(lifted.text).toBe("a\n\n ```js\n x()\n  y()\n ```\n\n- b");
  for (const edited of [kept, lifted]) expect(edited.projection.islands.map((island) => island.id)).toEqual(original);
});

test("a code block in a quoted list is not moved out of its item", async () => {
  // Its lines carry the quote's markers, which the island cannot be rewritten with exactly.
  await refused(caret(await note("> - a\n>   ```js\n>   x()\n>   ```\n> - b"), "a"), untab, /protected/);
});

test("components in a list move with their items", async () => {
  const text = "- a\n  <Counter initial={1} />\n- b";
  expect((await press(caret(await note(text), "b"), tab)).text).toBe("- a\n  <Counter initial={1} />\n  - b");
  expect((await press(caret(await note(text), "a"), enter)).text).toBe("- a\n- \n  <Counter initial={1} />\n- b");
  expect((await type(end(await note("Hello <Counter />")), "z")).text).toBe("Hello <Counter />z");
  expect((await type(await note("<Counter /> there"), "z")).text).toBe("z<Counter /> there");
  expect((await press(caret(await note("- <Counter />\n- b"), "b"), tab)).text).toBe("- <Counter />\n  - b");
});

test("Shift+Tab on an item with a nested list and items after it, sent as one step with the lists joined, is written", async () => {
  // The frame joins the two lists liftListItem would leave side by side.
  for (const [text, lifted] of [
    ["- alpha\n  - b\n- c", "alpha\n\n- b\n- c"],
    ["1. alpha\n   1. b\n2. c", "alpha\n\n1. b\n2. c"],
  ] as const) {
    const n = caret(await note(text), "alpha");
    const state = EditorState.create({ doc: n.projection.doc, selection: n.selection });
    let made: Transaction | undefined;
    untab(state, (tr) => (made = tr));
    const blocks: PMNode[] = [];
    made!.doc.forEach((block) => {
      const last = blocks.at(-1);
      if (last && last.type === block.type && (block.type === nodes.bullet_list || block.type === nodes.ordered_list))
        blocks[blocks.length - 1] = last.copy(last.content.append(block.content));
      else blocks.push(block);
    });
    const joined = made!.doc.copy(Fragment.fromArray(blocks));
    const result = await prepareFluidTransaction({ text, revision: 1, format: "mdx" }, n.projection, changeTo(n.projection.doc, joined).steps.map((step) => step.toJSON()));
    expect(result.text).toBe(lifted);
    expect(result.projection.doc.eq(joined)).toBe(true);
  }
});

test("a step that moves, copies or formats an island in place of moving blocks around it is refused", async () => {
  const text = "- a\n  ```js\n  x()\n  ```\n- b ![i](i.png)";
  const projection = await projectFluidSource(text, "mdx");
  const object = projection.mapping.nodes.find((entry) => entry.node.type === nodes.object)!;
  const image = projection.mapping.nodes.find((entry) => entry.node.type === nodes.inline_object)!;
  // A second copy of the code block in a new item.
  const copy = nodes.list_item.create(null, [nodes.paragraph.create(), object.node]);
  const at = projection.doc.firstChild!.firstChild!.nodeSize + 1;
  // The image made bold by a block rewrite.
  const item = projection.doc.firstChild!.child(1);
  const bold = nodes.list_item.create(null, nodes.paragraph.create(null, [fluidSchema.text("b "), image.node.mark([fluidSchema.marks.strong.create()])]));
  for (const step of [
    new ReplaceStep(at, at, new Slice(Fragment.from(copy), 0, 0)),
    new ReplaceStep(at, at + item.nodeSize, new Slice(Fragment.from(bold), 0, 0)),
  ])
    await expect(prepareFluidTransaction({ text, revision: 1, format: "mdx" }, projection, [step.toJSON()])).rejects.toThrow("Selection crosses a protected object");
});
