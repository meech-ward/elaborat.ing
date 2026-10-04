import { expect, test } from "bun:test";
import { AddMarkStep, ReplaceStep, Transform } from "prosemirror-transform";
import { Slice, Fragment } from "prosemirror-model";
import { fluidSchema } from "./fluidSchema";
import { codeFenceFromParagraph, projectFluidSource, prepareFluidTransaction } from "./fluidProjection";
import { applySourcePatches } from "../document";
import {
  fluidPositionForSourceOffset,
  fluidSourceOffsetForPosition,
} from "./fluidProjection";
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import {
  splitListItem,
  liftListItem,
  sinkListItem,
  wrapInList,
} from "prosemirror-schema-list";
import { emptyListBackspace } from "./fluidCommands";

const guard = "export const preserved = 7;\n\n{/* keep  this comment */}\n\n";
const tail = "\n\n<Counter initial={preserved} />\n\nUntouched tail.";
const replace = (from: number, to: number, text: string) =>
  new ReplaceStep(
    from,
    to,
    new Slice(
      text ? Fragment.from(fluidSchema.text(text)) : Fragment.empty,
      0,
      0,
    ),
  ).toJSON();
async function edit(text: string, steps: readonly unknown[]) {
  const projection = await projectFluidSource(text, "mdx");
  return prepareFluidTransaction(
    { text, revision: 3, format: "mdx" },
    projection,
    steps,
  );
}

test("ordinary typing retains intermediate trailing spaces and following letters", async () => {
  let projection = await projectFluidSource("", "mdx");
  let expected = "";
  for (const character of "An empty document can begin.") {
    const position = 1 + expected.length;
    expected += character;
    const accepted = await prepareFluidTransaction(
      { text: projection.text, format: "mdx", revision: expected.length },
      projection,
      [replace(position, position, character)],
    );
    expect(accepted.text).toBe(expected);
    expect(accepted.projection.doc.textContent).toBe(expected);
    projection = accepted.projection;
  }
});

test("typing in a terminal picker paragraph preserves existing four-newline gap", async () => {
  const text = guard + "<Counter initial={preserved} />\n\n\n\n";
  let projection = await projectFluidSource(text, "mdx");
  let expected = text;
  for (const character of "After component.") {
    const position = fluidPositionForSourceOffset(projection, expected.length)!;
    expected += character;
    const accepted = await prepareFluidTransaction(
      { text: projection.text, format: "mdx", revision: expected.length },
      projection,
      [replace(position, position, character)],
    );
    expect(accepted.text).toBe(expected);
    projection = accepted.projection;
  }
});

test("decoded escapes/entities remain source-mapped and unrelated MDX stays exact", async () => {
  const text = guard + "A &amp; B \\*literal\\* and &#x1F642;." + tail;
  const projection = await projectFluidSource(text, "mdx");
  expect(projection.doc.firstChild!.textContent).toBe(
    "A & B *literal* and 🙂.",
  );
  const next = await prepareFluidTransaction(
    { text, revision: 3, format: "mdx" },
    projection,
    [replace(3, 4, "plus")],
  );
  expect(next.text).toBe(text.replace("&amp;", "plus"));
});

test("cross-format replacement retains the unselected portion and original neighboring delimiters", async () => {
  const text = guard + "Alpha __bold__ omega. __untouched__" + tail;
  const next = await edit(text, [replace(4, 9, "X")]);
  // Underscore strong cannot begin inside a word. Only the modified mark's
  // delimiters change to stars; unrelated underscore formatting stays exact.
  expect(next.text).toBe(guard + "AlpX**ld** omega. __untouched__" + tail);
});

test("ordinary headings, list items and quotes project as editable structure", async () => {
  const projection = await projectFluidSource(
    "# Title\n\n- first\n- **second**\n\n> Quote",
    "mdx",
  );
  expect(projection.doc.content.content.map((node) => node.type.name)).toEqual([
    "heading",
    "bullet_list",
    "blockquote",
  ]);
  expect(projection.doc.child(1).child(1).firstChild!.textContent).toBe(
    "second",
  );
});

test("explicit inline and bullet shortcut spellings survive source projection", async () => {
  const guarded = await projectFluidSource("word", "mdx");
  await expect(
    prepareFluidTransaction(
      { text: guarded.text, revision: 0, format: "mdx" },
      guarded,
      [replace(1, 1, "x")],
      { marker: "<Injected />" } as never,
    ),
  ).rejects.toThrow();
  expect(guarded.text).toBe("word");
  for (const [name, delimiter] of [
    ["strong", "__"],
    ["em", "_"],
  ] as const) {
    const projection = await projectFluidSource("word", "mdx");
    const transform = new Transform(projection.doc).addMark(
      1,
      5,
      fluidSchema.marks[name].create(),
    );
    const next = await prepareFluidTransaction(
      { text: projection.text, revision: 0, format: "mdx" },
      projection,
      transform.steps.map((step) => step.toJSON()),
      { delimiter },
    );
    expect(next.text).toBe(delimiter + "word" + delimiter);
  }
  for (const marker of ["*", "+"] as const) {
    const projection = await projectFluidSource("word", "mdx");
    const state = EditorState.create({
      doc: projection.doc,
      selection: TextSelection.create(projection.doc, 2),
    });
    let transaction: Transaction | undefined;
    expect(
      wrapInList(fluidSchema.nodes.bullet_list)(state, (tr) => {
        transaction = tr;
      }),
    ).toBe(true);
    const next = await prepareFluidTransaction(
      { text: projection.text, revision: 0, format: "mdx" },
      projection,
      transaction!.steps.map((step) => step.toJSON()),
      { marker },
    );
    expect(next.text).toBe(marker + " word");
  }
});

test("a later invalid step rejects the entire batch without mutating source/projection", async () => {
  const text = guard + "Alpha." + tail;
  const projection = await projectFluidSource(text, "mdx");
  const before = projection.doc.toJSON();
  await expect(
    prepareFluidTransaction({ text, revision: 3, format: "mdx" }, projection, [
      replace(2, 2, "X"),
      replace(9999, 10000, "bad"),
    ]),
  ).rejects.toThrow();
  expect(projection.text).toBe(text);
  expect(projection.doc.toJSON()).toEqual(before);
});

test("split/join and empty-document text insertion reproject to the proposed document", async () => {
  const text = "Alphabeta.";
  const projection = await projectFluidSource(text, "mdx");
  const split = new Transform(projection.doc).split(6);
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    split.steps.map((step) => step.toJSON()),
  );
  expect(next.text).toBe("Alpha\n\nbeta.");
  expect(next.projection.doc.eq(split.doc)).toBe(true);
  expect((await edit("", [replace(1, 1, "Hello")])).text).toBe("Hello");
  expect(
    (await edit("export const value = 1;", [replace(1, 1, "Hello")])).text,
  ).toBe("export const value = 1;\n\nHello");
});

test("source bookmarks skip delimiter bytes and reject inside a decoded surrogate token", async () => {
  const text = "A &#x1F642; and **bold**";
  const projection = await projectFluidSource(text, "mdx");
  expect(fluidSourceOffsetForPosition(projection, 4)).toBeNull();
  const source = text.indexOf("bold") + 2;
  const position = fluidPositionForSourceOffset(projection, source)!;
  expect(fluidSourceOffsetForPosition(projection, position)).toBe(source);
});

test("stable islands preserve ESM and literal control slots without treating inline custom output as prose", async () => {
  const text =
    guard +
    'Before <Counter initial={2} /> after.\n\n<Callout tone="info" title="Keep">Editable body</Callout>';
  const projection = await projectFluidSource(text, "mdx");
  expect(projection.doc.firstChild!.child(1).type.name).toBe("inline_object");
  expect(projection.islands.map((island) => island.inline)).toEqual([
    true,
    false,
  ]);
  expect(projection.slots.map((slot) => slot.element)).toEqual([
    "Counter",
    "Callout",
  ]);
  expect(projection.code).toContain("FluidIsland");
  expect(projection.code).toContain("__slot");
  expect(projection.code).toContain("SourceText");
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    [replace(2, 2, "more")],
  );
  expect(next.projection.runtimeKey).toBe(projection.runtimeKey);
  expect(next.projection.islands.map((island) => island.id)).toEqual(
    projection.islands.map((island) => island.id),
  );
  await expect(
    prepareFluidTransaction({ text, revision: 0, format: "mdx" }, projection, [
      replace(3, 10, "bad"),
    ]),
  ).rejects.toThrow(/protected/);
});

test("inline mark updates and heading changes preserve unrelated encoded text and source-only neighbors", async () => {
  const text = guard + "Alpha &amp; __keep__" + tail;
  const projection = await projectFluidSource(text, "mdx");
  const transform = new Transform(projection.doc)
    .addMark(1, 6, fluidSchema.marks.em.create())
    .setBlockType(0, 1, fluidSchema.nodes.heading, { level: 2 });
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    transform.steps.map((step) => step.toJSON()),
  );
  expect(next.text).toBe(guard + "## *Alpha* &amp; __keep__" + tail);
  expect(next.projection.doc.eq(transform.doc)).toBe(true);
  const marked = await projectFluidSource("**bold** and `code`", "mdx");
  const inserted = new Transform(marked.doc).insert(
    5,
    fluidSchema.text(" ", [fluidSchema.marks.strong.create()]),
  );
  const spaced = await prepareFluidTransaction(
    { text: marked.text, revision: 0, format: "mdx" },
    marked,
    inserted.steps.map((step) => step.toJSON()),
  );
  expect(spaced.projection.doc.eq(inserted.doc)).toBe(true);
  expect(spaced.text).toContain("**bold&#32;**");
});

test("native list split and empty-item exit stay source/projection equivalent", async () => {
  for (const text of ["- First", "* First", "+ First", "1. First"]) {
    const projection = await projectFluidSource(text, "mdx");
    const position = fluidPositionForSourceOffset(projection, text.length)!;
    const state = EditorState.create({
      doc: projection.doc,
      selection: TextSelection.create(projection.doc, position),
    });
    let transaction: Transaction | undefined;
    expect(
      splitListItem(fluidSchema.nodes.list_item)(state, (tr) => {
        transaction = tr;
      }),
    ).toBe(true);
    const next = await prepareFluidTransaction(
      { text, revision: 0, format: "mdx" },
      projection,
      transaction!.steps.map((step) => step.toJSON()),
    );
    expect(next.projection.doc.eq(transaction!.doc)).toBe(true);
    if (/^[-+*]/.test(text))
      expect(next.text).toBe(text + "\n" + text[0] + " ");
    const empty = EditorState.create({
      doc: next.projection.doc,
      selection: transaction!.selection,
    });
    let exit: Transaction | undefined;
    expect(
      liftListItem(fluidSchema.nodes.list_item)(empty, (tr) => {
        exit = tr;
      }),
    ).toBe(true);
    const lifted = await prepareFluidTransaction(
      { text: next.text, revision: 1, format: "mdx" },
      next.projection,
      exit!.steps.map((step) => step.toJSON()),
    );
    expect(lifted.projection.doc.eq(exit!.doc)).toBe(true);
  }
});

test("wrap paragraph in a list and edit a decoded multiline quote without touching the next block", async () => {
  const text = "> A &amp; B\n> next\n\nTail";
  const projection = await projectFluidSource(text, "mdx");
  expect(projection.doc.firstChild!.textContent).toBe("A & B\nnext");
  const offset = fluidPositionForSourceOffset(
    projection,
    text.indexOf("next"),
  )!;
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    [replace(offset, offset + 4, "line")],
  );
  expect(next.text).toBe(text.replace("next", "line"));
  const plain = await projectFluidSource("A &amp; B", "mdx");
  const state = EditorState.create({
    doc: plain.doc,
    selection: TextSelection.create(plain.doc, 2),
  });
  let transaction: Transaction | undefined;
  expect(
    wrapInList(fluidSchema.nodes.bullet_list)(state, (tr) => {
      transaction = tr;
    }),
  ).toBe(true);
  const wrapped = await prepareFluidTransaction(
    { text: plain.text, revision: 0, format: "mdx" },
    plain,
    transaction!.steps.map((step) => step.toJSON()),
  );
  expect(wrapped.text).toBe("- A &amp; B");
});

test("backspace removing empty last bullet in three-item star list stays source/projection equivalent", async () => {
  const text = "* first\n* second\n* third";
  const projection = await projectFluidSource(text, "mdx");
  let target = -1;
  projection.doc.descendants((node, pos) => {
    if (node.isText && node.text === "third") target = pos;
  });
  expect(target).toBeGreaterThan(0);
  const emptied = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    [replace(target, target + 5, "")],
  );
  expect(emptied.projection.doc.child(0).childCount).toBe(3);
  expect(emptied.projection.doc.child(0).child(2).textContent).toBe("");
  let cursor = -1;
  emptied.projection.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "")
      cursor = pos + 1;
  });
  expect(cursor).toBeGreaterThan(0);
  const state = EditorState.create({
    doc: emptied.projection.doc,
    selection: TextSelection.create(emptied.projection.doc, cursor),
  });
  let transaction: Transaction | undefined;
  expect(
    emptyListBackspace(state, (tr) => {
      transaction = tr;
    }),
  ).toBe(true);
  const next = await prepareFluidTransaction(
    { text: emptied.text, revision: 1, format: "mdx" },
    emptied.projection,
    transaction!.steps.map((step) => step.toJSON()),
  );
  expect(next.projection.doc.eq(transaction!.doc)).toBe(true);
  // Same safe representation as lift/Enter: two items plus an empty root paragraph.
  expect(next.projection.doc.childCount).toBe(2);
  expect(next.projection.doc.child(0).type.name).toBe("bullet_list");
  expect(next.projection.doc.child(0).childCount).toBe(2);
  expect(next.projection.doc.child(1).type.name).toBe("paragraph");
  expect(next.projection.doc.child(1).textContent).toBe("");
  expect(next.text).toBe("* first\n* second\n\n");
  // Guards: nonempty list text and ordinary paragraphs stay on the native chain.
  const nonempty = EditorState.create({
    doc: projection.doc,
    selection: TextSelection.create(projection.doc, target + 1),
  });
  expect(emptyListBackspace(nonempty, () => {})).toBe(false);
  const inlineObjectDoc = fluidSchema.node("doc", null, [
    fluidSchema.node("bullet_list", null, [
      fluidSchema.node("list_item", null, [
        fluidSchema.node("paragraph", null, [
          fluidSchema.node("inline_object", { id: "preserved-inline-object" }),
        ]),
      ]),
    ]),
  ]);
  const inlineObject = EditorState.create({
    doc: inlineObjectDoc,
    selection: TextSelection.create(inlineObjectDoc, 3),
  });
  expect(emptyListBackspace(inlineObject, () => {})).toBe(false);
  const plain = await projectFluidSource("ordinary", "mdx");
  const outside = EditorState.create({
    doc: plain.doc,
    selection: TextSelection.create(plain.doc, 2),
  });
  expect(emptyListBackspace(outside, () => {})).toBe(false);
});

test("ordered prose stays editable beside a fenced code sibling in the same item", async () => {
  const text = [
    "1. **Lead one** intro with `code-a`",
    "2. **Lead two** intro with `code-b`",
    "3. **Lead three** intro with `code-c`",
    "4. **Lead four** intro with `code-d`",
    "   ```sql",
    "   SELECT 1",
    "   ```",
    "",
  ].join("\n");
  const projection = await projectFluidSource(text, "mdx");
  expect(projection.doc.firstChild!.type.name).toBe("ordered_list");
  expect(projection.doc.firstChild!.textContent).toContain("Lead one");
  expect(projection.doc.firstChild!.textContent).toContain("Lead four");
  expect(projection.islands).toHaveLength(1);
  expect(projection.islands[0].inline).toBe(false);
  expect(
    text.slice(projection.islands[0].from, projection.islands[0].to),
  ).toContain("SELECT 1");
  const offset = text.indexOf("intro with");
  const position = fluidPositionForSourceOffset(projection, offset)!;
  expect(position).not.toBeNull();
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    [replace(position, position + "intro".length, "INTRO")],
  );
  expect(next.text).toContain("**Lead one** INTRO with `code-a`");
  expect(next.text).toContain("SELECT 1");
  expect(next.projection.doc.firstChild!.type.name).toBe("ordered_list");
  expect(next.projection.islands).toHaveLength(1);
});

test("partial-bold cross-item replacement preserves an unrelated fenced item exactly", async () => {
  for (const fence of ["", "\n   ```sql\n   SELECT 1\n   ```"]) {
    const sibling = "\n3. Keeper" + fence;
    const text = guard + "1. Alpha omega.\n2. __second__ tail." + sibling + tail;
    const projection = await projectFluidSource(text, "mdx");
    const from = fluidPositionForSourceOffset(projection, text.indexOf("Alpha") + 3)!;
    const to = fluidPositionForSourceOffset(projection, text.indexOf("second") + 2)!;
    expect([from, to]).toEqual([6, 21]);
    const state = EditorState.create({
      doc: projection.doc,
      selection: TextSelection.create(projection.doc, from, to),
    });
    const transaction = state.tr.insertText("X");
    const next = await prepareFluidTransaction(
      { text, revision: 0, format: "mdx" },
      projection,
      transaction.steps.map((step) => step.toJSON()),
    );
    expect(next.text).toBe(guard + "1. AlpX**cond** tail." + sibling + tail);
    expect(next.projection.doc.eq(transaction.doc)).toBe(true);
    expect(next.projection.islands.map(({ id, from, to }) => [id, next.text.slice(from, to)])).toEqual(
      projection.islands.map(({ id, from, to }) => [id, text.slice(from, to)]),
    );
    expect(next.patches.every((patch) => patch.to <= text.indexOf(sibling))).toBe(true);
  }
});

test("crossing, deleting or marking a fenced island is still refused", async () => {
  const text = "1. Alpha omega.\n2. __second__ tail.\n3. Keeper\n   ```sql\n   SELECT 1\n   ```\n\nTail.";
  const projection = await projectFluidSource(text, "mdx");
  const before = projection.doc.toJSON();
  const island = projection.mapping.nodes.find((entry) => entry.node.type.name === "object")!;
  const from = fluidPositionForSourceOffset(projection, text.indexOf("Alpha") + 3)!;
  const to = fluidPositionForSourceOffset(projection, text.indexOf("Tail") + 2)!;
  const crossing = EditorState.create({
    doc: projection.doc,
    selection: TextSelection.create(projection.doc, from, to),
  }).tr.insertText("X");
  for (const steps of [
    crossing.steps.map((step) => step.toJSON()),
    [replace(island.pos, island.end, "")],
    [new AddMarkStep(from, to, fluidSchema.marks.strong.create()).toJSON()],
  ]) {
    await expect(
      prepareFluidTransaction({ text, revision: 0, format: "mdx" }, projection, steps),
    ).rejects.toThrow(/protected object/);
    expect(projection.text).toBe(text);
    expect(projection.doc.toJSON()).toEqual(before);
  }
});

test("quote prose stays editable beside a fenced code sibling", async () => {
  const text = [
    "> quoted **bold** line",
    ">",
    "> ```js",
    "> const x = 1;",
    "> ```",
    "",
  ].join("\n");
  const projection = await projectFluidSource(text, "mdx");
  expect(projection.doc.firstChild!.type.name).toBe("blockquote");
  expect(projection.doc.firstChild!.textContent).toContain("quoted bold line");
  expect(projection.islands).toHaveLength(1);
  expect(projection.islands[0].inline).toBe(false);
  expect(
    text.slice(projection.islands[0].from, projection.islands[0].to),
  ).toContain("const x = 1;");
  const offset = text.indexOf("quoted");
  const position = fluidPositionForSourceOffset(projection, offset)!;
  expect(position).not.toBeNull();
  const next = await prepareFluidTransaction(
    { text, revision: 0, format: "mdx" },
    projection,
    [replace(position, position + "quoted".length, "QUOTED")],
  );
  expect(next.text).toContain("> QUOTED **bold** line");
  expect(next.text).toContain("const x = 1;");
  expect(next.projection.doc.firstChild!.type.name).toBe("blockquote");
});

for (const format of ["md", "mdx"] as const) {
  test(`${format}: a file saved with a byte order mark is edited in place and keeps the mark`, async () => {
    const text = "﻿# Café \u{1F600}\r\n\r\nFirst `code` here \u{1F389} end.\r\n";
    const projection = await projectFluidSource(text, format);
    expect(projection.doc.textContent).toBe("Café \u{1F600}First code here \u{1F389} end.");
    // Every mapped range is exactly the text it shows.
    for (const leaf of projection.mapping.leaves) expect(text.slice(leaf.from, leaf.to)).toBe(leaf.value);
    const offset = text.indexOf("here");
    const position = fluidPositionForSourceOffset(projection, offset)!;
    const next = await prepareFluidTransaction({ text, revision: 1, format }, projection, [replace(position, position, "right ")]);
    expect(next.text).toBe("﻿# Café \u{1F600}\r\n\r\nFirst `code` right here \u{1F389} end.\r\n");
    const heading = await prepareFluidTransaction({ text, revision: 1, format }, projection, [replace(1, 1, "A ")]);
    expect(heading.text).toBe("﻿# A Café \u{1F600}\r\n\r\nFirst `code` here \u{1F389} end.\r\n");
  });

  test(`${format}: typing into a file that holds only a byte order mark adds no blank lines`, async () => {
    const projection = await projectFluidSource("﻿", format);
    const next = await prepareFluidTransaction({ text: "﻿", revision: 1, format }, projection, [replace(1, 1, "S")]);
    expect(next.text).toBe("﻿S");
  });
}

for (const format of ["md", "mdx"] as const) {
  test(`${format}: a typed code fence opening becomes an empty code block, saved as a plain fence`, async () => {
    for (const [typed, fence] of [["```js", "```js\n```"], ["```", "```\n```"], ["``` ", "```\n```"], ["````ts ", "````ts\n````"]]) {
      // Typed into a paragraph, the backticks are saved escaped.
      let projection = await projectFluidSource("", format);
      for (const [index, character] of [...typed].entries()) {
        const accepted = await prepareFluidTransaction(
          { text: projection.text, format, revision: index },
          projection,
          [replace(1 + index, 1 + index, character)],
        );
        projection = accepted.projection;
      }
      expect(projection.text).not.toContain(fence.split("\n")[0]);
      const text = `Intro.\n\n${projection.text}\n\nAfter.\n`;
      const before = await projectFluidSource(text, format);
      const made = codeFenceFromParagraph(before, before.mapping.roots[1].pos)!;
      const saved = applySourcePatches({ text, format, revision: 1 }, 1, [made.patch]).text;
      expect(saved).toBe(`Intro.\n\n${fence}\n\nAfter.\n`);
      // The caret goes inside the fence, where the code goes.
      expect(saved.slice(0, made.focus)).toBe(`Intro.\n\n${fence.split("\n")[0]}\n`);
      const after = await projectFluidSource(saved, format);
      expect(after.doc.child(1).type.name).toBe("object");
      expect(after.islands.map(({ from, to }) => saved.slice(from, to))).toEqual([fence]);
    }
  });
}

test("only a top-level paragraph holding just a fence opening becomes a code block", async () => {
  const text = "Not a fence.\n\nSay \\`\\`\\`js\n\n\\`\\`js\n\n- \\`\\`\\`js\n\n\\`\\`\\`js \\`\n\n**\\`\\`\\`js**\n";
  const projection = await projectFluidSource(text, "md");
  for (const root of projection.mapping.roots)
    expect(codeFenceFromParagraph(projection, root.pos)).toBeNull();
  expect(projection.mapping.roots).toHaveLength(6);
});

/** Steps that set the task box of the list item at `pos`. */
const tick = (doc: ConstructorParameters<typeof Transform>[0], pos: number, checked: boolean | null) =>
  new Transform(doc).setNodeMarkup(pos, undefined, { checked }).steps.map((step) => step.toJSON());

test("ticking a task item's box changes only the character in it, even beside an island", async () => {
  const text = "# Today\n\n- [ ] **Buy** milk\n- [x] Call the bank\n\n  ```sh\n  echo hi\n  ```\n\nTail.\n";
  const projection = await projectFluidSource(text, "mdx");
  const list = projection.doc.child(1);
  expect([list.child(0).attrs.checked, list.child(1).attrs.checked]).toEqual([false, true]);
  expect(list.child(0).firstChild!.textContent).toBe("Buy milk");
  const first = projection.doc.child(0).nodeSize + 1;
  const ticked = await edit(text, tick(projection.doc, first, true));
  expect(ticked.text).toBe(text.replace("- [ ] **Buy**", "- [x] **Buy**"));
  expect(ticked.patches).toEqual([{ from: text.indexOf("[ ]") + 1, to: text.indexOf("[ ]") + 2, insert: "x", expected: " " }]);
  // The second item holds a code block, which the editor cannot change.
  const second = first + list.child(0).nodeSize;
  const cleared = await edit(text, tick(projection.doc, second, false));
  expect(cleared.text).toBe(text.replace("- [x] Call", "- [ ] Call"));
  expect(cleared.projection.doc.child(1).child(1).attrs.checked).toBe(false);
});

test("Enter in a task item makes another task; an empty one keeps its box; typed [ ] makes one", async () => {
  const text = "- [x] **Done**\n- Next";
  let projection = await projectFluidSource(text, "mdx");
  const split = async (offset: number) => {
    const state = EditorState.create({
      doc: projection.doc,
      selection: TextSelection.create(projection.doc, fluidPositionForSourceOffset(projection, offset)!),
    });
    let transaction: Transaction | undefined;
    splitListItem(fluidSchema.nodes.list_item, { checked: false })(state, (tr) => {
      transaction = tr;
    });
    return edit(projection.text, transaction!.steps.map((step) => step.toJSON()));
  };
  // In the middle, both halves keep the box; at the end the new task is not ticked yet.
  expect((await split(text.indexOf("ne"))).text).toBe("- [x] **Do**\n- [x] **ne**\n- Next");
  const ended = await split(text.indexOf("**\n"));
  expect(ended.text).toBe("- [x] **Done**\n- [ ] \n- Next");
  projection = ended.projection;
  expect(projection.doc.child(0).child(1).attrs.checked).toBe(false);
  // Typing in the empty task writes after its box.
  const empty = projection.doc.child(0).child(0).nodeSize + 3;
  const typed = await prepareFluidTransaction({ text: projection.text, revision: 1, format: "mdx" }, projection, [replace(empty, empty, "M")]);
  expect(typed.text).toBe("- [x] **Done**\n- [ ] M\n- Next");

  // "[ ]" typed before an item's text, then a space: the input rule's steps give it a box.
  const plain = await projectFluidSource("- [ ]Next", "mdx");
  const rule = new Transform(plain.doc).delete(3, 6).setNodeMarkup(1, undefined, { checked: false });
  const ruled = await edit("- [ ]Next", rule.steps.map((step) => step.toJSON()));
  expect(ruled.text).toBe("- [ ] Next");
  // "]" typed in an empty item, and a box with no space after it: typing adds one.
  const bare = await projectFluidSource("- [x", "mdx");
  const closed = await edit("- [x", new Transform(bare.doc).delete(3, 5).setNodeMarkup(1, undefined, { checked: true }).steps.map((step) => step.toJSON()));
  expect(closed.text).toBe("- [x] ");
  const tight = await projectFluidSource("- [ ]", "mdx");
  expect(tight.doc.child(0).child(0).attrs.checked).toBe(false);
  expect((await edit("- [ ]", [replace(3, 3, "a")])).text).toBe("- [ ] a");
});

test("Enter, Tab and Shift+Tab keep a loose list loose and a tight one tight, and the rest as written", async () => {
  const run = async (text: string, at: number, command: Command) => {
    const projection = await projectFluidSource(text, "mdx");
    const state = EditorState.create({
      doc: projection.doc,
      selection: TextSelection.create(projection.doc, fluidPositionForSourceOffset(projection, at)!),
    });
    let transaction: Transaction | undefined;
    expect(command(state, (tr) => (transaction = tr))).toBe(true);
    const next = await edit(text, transaction!.steps.map((step) => step.toJSON()));
    expect(next.projection.doc.eq(transaction!.doc)).toBe(true);
    return next;
  };
  const item = fluidSchema.nodes.list_item;
  const enter = splitListItem(item), tab = sinkListItem(item), untab = liftListItem(item);
  for (const gap of ["\n", "\n\n"]) {
    const list = (...items: string[]) => "Intro.\n\n" + items.join(gap) + "\n\nTail.\n";
    const text = list("- one", "- two", "- three");
    const end = (word: string) => text.indexOf(word) + word.length;
    // Enter at the end of an item, at the end of the list, and in the middle of an item.
    expect((await run(text, end("two"), enter)).text).toBe(list("- one", "- two", "- ", "- three"));
    expect((await run(text, end("three"), enter)).text).toBe(list("- one", "- two", "- three", "- "));
    expect((await run(text, end("tw"), enter)).text).toBe(list("- one", "- tw", "- o", "- three"));
    // Tab nests an item under the one before; Shift+Tab brings it back as it was.
    const nested = await run(text, end("two"), tab);
    expect(nested.text).toBe(list(`- one${gap}  - two`, "- three"));
    const position = text.indexOf("two");
    const back = await prepareFluidTransaction(
      { text: nested.text, revision: 4, format: "mdx" },
      nested.projection,
      (() => {
        const state = EditorState.create({
          doc: nested.projection.doc,
          selection: TextSelection.create(nested.projection.doc, fluidPositionForSourceOffset(nested.projection, position + 2)!),
        });
        let transaction: Transaction | undefined;
        untab(state, (tr) => (transaction = tr));
        return transaction!.steps.map((step) => step.toJSON());
      })(),
    );
    expect(back.text).toBe(text);
  }
  // Only the new item is written: an uneven gap elsewhere, and a nested
  // list's own spacing, stay byte for byte.
  const uneven = "- one\n\n\n- two\n  - a\n\n  - b\n- three";
  const added = await run(uneven, uneven.indexOf("a") + 1, enter);
  expect(added.text).toBe("- one\n\n\n- two\n  - a\n\n  - \n\n  - b\n- three");
  expect(added.patches).toMatchObject([{ insert: "\n\n  - ", expected: "" }]);
  // A list holding a code block takes a new item; the block is not rewritten.
  const fenced = "- one\n- two\n\n  ```sh\n  echo hi\n  ```\n- three";
  expect((await run(fenced, 5, enter)).patches).toMatchObject([{ insert: "\n- ", expected: "" }]);
});

test("a new list item holding a protected object is refused", async () => {
  // Not even a copy of a code block already in the list.
  const text = "- one\n- two\n\n  ```sh\n  echo hi\n  ```";
  const projection = await projectFluidSource(text, "mdx");
  const copy = fluidSchema.node("list_item", null, [
    fluidSchema.node("paragraph", null, [fluidSchema.text("x")]),
    fluidSchema.node("object", { id: projection.islands[0].id }),
  ]);
  const at = projection.doc.child(0).child(0).nodeSize + 1;
  const step = new ReplaceStep(at, at, new Slice(Fragment.from(copy), 0, 0)).toJSON();
  await expect(edit(text, [step])).rejects.toThrow("Selection crosses a protected object");
});
