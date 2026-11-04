import { expect, test } from "bun:test";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { liftListItem } from "prosemirror-schema-list";
import { ReplaceStep, Step } from "prosemirror-transform";
import type { DocumentFormat } from "../document";
import {
  afterHeldBreak,
  emptyListBackspace,
  hardBreak,
  leftBreak,
  liftItem,
  listItemBackspace,
  listItemDelete,
  toggleTask,
  trailingBreak,
  typedTogether,
} from "./fluidCommands";
import { fluidPositionForSourceOffset, prepareFluidTransaction, projectFluidSource } from "./fluidProjection";
import { fluidSchema } from "./fluidSchema";

// The frame's list and line keys (fluidEditor.ts), as commands on the
// document a note projects to. Each edit must be one the parent writes into
// the note exactly: the source it writes reads back as the editor's document.

/** The note's document with the caret `offset` characters into the first `word` of its source. */
async function at(text: string, word: string, offset = word.length, format: DocumentFormat = "md") {
  const projection = await projectFluidSource(text, format);
  const position = fluidPositionForSourceOffset(projection, text.indexOf(word) + offset)!;
  const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, position) });
  return { projection, state };
}

/** Run `command` there; null when it does not apply. */
async function run(text: string, word: string, command: Command, { offset = word.length, format = "md" as DocumentFormat } = {}) {
  const { projection, state } = await at(text, word, offset, format);
  let made: Transaction | undefined;
  if (!command(state, (tr) => (made = tr)) || !made) return null;
  const tr: Transaction = made;
  return { state, tr, write: () => prepareFluidTransaction({ text, revision: 1, format }, projection, tr.steps.map((step) => step.toJSON())) };
}

/** What the parent writes for `command` there, after checking it reads back as the editor's document. */
async function written(text: string, word: string, command: Command, options?: { offset?: number; format?: DocumentFormat }) {
  const result = await run(text, word, command, options);
  expect(result).not.toBeNull();
  const accepted = await result!.write();
  expect(accepted.projection.doc.eq(result!.tr.doc)).toBe(true);
  expect(accepted.nearest).toBeNull();
  return { text: accepted.text, steps: result!.tr.steps.length, caret: result!.tr.selection.$head };
}

const shiftTab = liftItem;

for (const format of ["md", "mdx"] satisfies DocumentFormat[]) {
  test(`${format}: Shift+Tab on an item with a nested list and items after it makes one list of them`, async () => {
    const options = { format };
    // The plain lift leaves the nested list and the items after it side by
    // side: two lists, which Markdown keeps apart only with another bullet.
    const plain = await written("- alpha\n  - beta\n- gamma", "alpha", liftListItem(fluidSchema.nodes.list_item), options);
    expect(plain.text).toBe("alpha\n\n- beta\n\n* gamma");
    for (const [text, expected] of [
      ["- alpha\n  - beta\n- gamma", "alpha\n\n- beta\n- gamma"],
      ["- zero\n- alpha\n  - b\n- c", "- zero\n\nalpha\n\n- b\n- c"],
      ["1. alpha\n   1. beta\n2. gamma", "alpha\n\n1. beta\n2. gamma"],
      ["- alpha\n  - beta\n  - delta\n- gamma", "alpha\n\n- beta\n- delta\n- gamma"],
      ["Intro.\n\n- alpha\n  - beta\n- gamma\n\nTail.\n", "Intro.\n\nalpha\n\n- beta\n- gamma\n\nTail.\n"],
    ]) {
      const lifted = await written(text, "alpha", shiftTab, options);
      expect(lifted.text).toBe(expected);
      expect(lifted.steps).toBe(1);
      expect(lifted.caret.parent.textContent).toBe("alpha");
      expect(lifted.caret.parentOffset).toBe(5);
    }
    // Another bullet in the nested list, or after a list of another bullet:
    // the items after it join the nested list and take its bullet.
    for (const [text, word, expected] of [
      ["- alpha\n  * beta\n- gamma", "alpha", "alpha\n\n* beta\n* gamma"],
      ["* alpha\n  - beta\n* gamma", "alpha", "alpha\n\n- beta\n- gamma"],
      ["- a\n\n* b\n  - c\n* d", "b", "- a\n\nb\n\n- c\n- d"],
    ] as const) {
      const lifted = await written(text, word, shiftTab, options);
      expect(lifted.text).toBe(expected);
      expect(lifted.steps).toBe(1);
      expect(lifted.caret.parent.textContent).toBe(word);
    }
    // A nested item with its own nested list and an item after it: the
    // standard lift's first step has two lists side by side in the item.
    const deeper = await run("- a\n  - b\n    - c\n  - d\n- e", "b", liftListItem(fluidSchema.nodes.list_item), options);
    await expect(deeper!.write()).rejects.toThrow("Source projection differs");
    const moved = await written("- a\n  - b\n    - c\n  - d\n- e", "b", shiftTab, options);
    expect(moved.text).toBe("- a\n- b\n  - c\n  - d\n- e");
    expect(moved.steps).toBe(1);
  });

  test(`${format}: Shift+Tab keeps a one-step lift, and sends a longer one as one step`, async () => {
    const options = { format };
    for (const [text, word, expected] of [
      // A nested item back out, and the last item, and lists of two kinds.
      ["- alpha\n  - beta\n- gamma", "beta", "- alpha\n- beta\n- gamma"],
      ["- alpha\n  - beta\n\nTail.", "alpha", "alpha\n\n- beta\n\nTail."],
      ["- alpha\n  1. beta\n- gamma", "alpha", "alpha\n\n1. beta\n\n- gamma"],
    ] as const) {
      const standard = await run(text, word, liftListItem(fluidSchema.nodes.list_item), options);
      expect(standard!.tr.steps.length).toBe(1);
      const ours = await written(text, word, shiftTab, options);
      expect(ours.text).toBe(expected);
      expect(ours.steps).toBe(1);
      expect(ours.text).toBe((await standard!.write()).text);
    }
    for (const [text, word, expected] of [
      // The standard lift wraps the items after it for a moment.
      ["- a\n  - b\n  - c\n- d", "b", "- a\n- b\n  - c\n- d"],
      ["> - a\n>   - b\n>   - c\n> - d", "b", "> - a\n> - b\n>   - c\n> - d"],
      // A list of another marker just before: as many lists side by side
      // before as after, and the standard steps are refused.
      ["* y\n\n- alpha\n  - beta\n- gamma", "alpha", "* y\n\nalpha\n\n- beta\n- gamma"],
    ] as const) {
      const ours = await written(text, word, shiftTab, options);
      expect(ours.text).toBe(expected);
      expect(ours.steps).toBe(1);
    }
    // Lists the note already has side by side (two markers) are not joined.
    const separate = await written("- alpha\n  - beta\n\n* gamma", "alpha", shiftTab, options);
    expect(separate.text).toBe("alpha\n\n- beta\n\n* gamma");
  });

  test(`${format}: Backspace at the start of a nested list's first item moves it out a level`, async () => {
    const options = { offset: 0, format };
    const backspace = chainCommands(emptyListBackspace, listItemBackspace, baseKeymap.Backspace);
    // The standard Backspace makes the item a second paragraph of the one above.
    const standard = await run("- a\n  - b\n- c", "b", baseKeymap.Backspace, options);
    expect((await standard!.write()).text).toBe("- a\n\n  b\n- c");
    // (null: the source as the parent writes it, checked to read back as the editor's document.)
    for (const [text, expected] of [
      ["- a\n  - b\n- c", "- a\n- b\n- c"],
      ["- a\n  - b\n  - c\n- d", null],
      ["- [ ] a\n  - [ ] b\n- [ ] c", "- [ ] a\n- [ ] b\n- [ ] c"],
      ["- a\n  - b\n\n    second\n- c", null],
      ["- a\n  - b\n    - c\n  - d\n- e", "- a\n- b\n  - c\n  - d\n- e"],
    ] as const) {
      const lifted = await written(text, "b", backspace, options);
      if (expected) expect(lifted.text).toBe(expected);
      expect(lifted.caret.parent.textContent).toBe("b");
      expect(lifted.caret.parentOffset).toBe(0);
    }
    // Three levels: the innermost first item moves out one level.
    expect((await written("- a\n  - b\n    - c\n- d", "c", backspace, options)).text).toBe("- a\n  - b\n  - c\n- d");
    // Numbered and mixed lists too, and lists of two bullets: the item takes
    // the marker of the list it moves into, which keeps counting.
    for (const [text, expected] of [
      ["- a\n  1. b\n- d", "- a\n- b\n- d"],
      ["1. a\n   - b\n2. c", "1. a\n2. b\n3. c"],
      ["1. a\n   1. b\n   2. c\n2. d", "1. a\n2. b\n   1. c\n3. d"],
      ["1) a\n   1) b\n2) c", "1) a\n2) b\n3) c"],
      ["> 1. a\n>    1. b\n> 2. c", "> 1. a\n> 2. b\n> 3. c"],
      ["- a\n  * b\n- c", "- a\n- b\n- c"],
      ["* a\n  - b\n* c", "* a\n* b\n* c"],
      ["- a\n  + b\n  + bb\n- c", "- a\n- b\n  + bb\n- c"],
      ["- [ ] a\n  * [ ] b\n- [ ] c", "- [ ] a\n- [ ] b\n- [ ] c"],
    ] as const) {
      const lifted = await written(text, "b", backspace, options);
      expect(lifted.text).toBe(expected);
      expect(lifted.steps).toBe(1);
      expect(lifted.caret.parent.textContent).toBe("b");
      expect(lifted.caret.parentOffset).toBe(0);
    }
    // The first item of a list that is not nested still leaves the list.
    expect(listItemBackspace((await at("- a\n- b", "a", 0, format)).state)).toBe(false);
    expect(listItemBackspace((await at("> - a\n> - b", "a", 0, format)).state)).toBe(false);
  });

  test(`${format}: Delete at the end of an item joins the text after it, as Backspace at that text does`, async () => {
    const options = { format };
    const del = chainCommands(listItemDelete, baseKeymap.Delete);
    // The standard Delete joins the two items into one with two paragraphs.
    const standard = await run("- alpha\n- bravo\n- charlie", "alpha", baseKeymap.Delete, options);
    expect((await standard!.write()).text).toBe("- alpha\n\n  bravo\n- charlie");
    for (const [text, word, expected] of [
      ["- alpha\n- bravo\n- charlie", "alpha", "- alphabravo\n- charlie"],
      // A list numbered 1, 2, 3 keeps counting.
      ["1. alpha\n2. bravo\n3. charlie", "alpha", "1. alphabravo\n2. charlie"],
      ["- [ ] alpha\n- [x] bravo", "alpha", "- [ ] alphabravo"],
      ["- a\n  - child\n- b", "a", "- achild\n- b"],
      ["- a\n  - child\n- b", "child", "- a\n  - childb"],
      ["- a\n- b\n\nAfter.", "b", "- a\n- bAfter."],
      ["- **a**\n- b", "a", "- **a**b"],
    ]) {
      const joined = await written(text, word, del, options);
      expect(joined.text).toBe(expected);
      expect(joined.caret.parent.textContent.startsWith(word)).toBe(true);
      expect(joined.caret.parentOffset).toBe(word.length);
    }
    // An empty middle item takes the next item's text; the standard Delete is refused there.
    const empty = await run("- alpha\n-\n- charlie", "-\n", baseKeymap.Delete, { offset: 1, format });
    await expect(empty!.write()).rejects.toThrow();
    expect((await written("- alpha\n-\n- charlie", "-\n", del, { offset: 1, format })).text).toBe("- alpha\n- charlie");
    // At the end of the note, and before an island, it is the standard Delete.
    expect(listItemDelete((await at("- a\n- b", "b", 1, format)).state, () => {})).toBe(false);
    if (format === "mdx")
      expect(listItemDelete((await at("- a\n\n<Counter />\n", "a", 1, format)).state, () => {})).toBe(false);
    // Only at the very end of the item's text.
    expect(listItemDelete((await at("- alpha\n- b", "alpha", 2, format)).state, () => {})).toBe(false);
  });

  test(`${format}: Mod-Enter in a task item ticks and unticks its box`, async () => {
    const options = { format };
    const ticked = await written("- [ ] Pack\n- [x] Book", "Pack", toggleTask, options);
    expect(ticked.text).toBe("- [x] Pack\n- [x] Book");
    const unticked = await written("- [ ] Pack\n- [x] Book", "Book", toggleTask, options);
    expect(unticked.text).toBe("- [ ] Pack\n- [ ] Book");
    expect(unticked.caret.parentOffset).toBe(4);
    // Nested: the item holding the caret.
    expect((await written("- [ ] a\n  - [ ] b", "b", toggleTask, options)).text).toBe("- [ ] a\n  - [x] b");
    // Not in a task item: nothing.
    expect(await run("- a\n- b", "a", toggleTask, options)).toBeNull();
    expect(await run("Para.", "Para", toggleTask, options)).toBeNull();
    expect(await run("- [ ] a\n  - b", "b", toggleTask, options)).toBeNull();
  });

  test(`${format}: Shift+Enter writes a line break in a paragraph`, async () => {
    const options = { format };
    // Mid-line, the break takes the spaces after it, which a line cannot start with.
    expect((await written("alpha bravo", "alpha", hardBreak, options)).text).toBe("alpha\\\nbravo");
    expect((await written("alpha bravo", "alpha ", hardBreak, options)).text).toBe("alpha \\\nbravo");
    expect((await written("- alpha bravo\n- b", "alpha", hardBreak, options)).text).toBe("- alpha\\\nbravo\n- b");
    // The caret goes on the new line, after the break, also when the break
    // takes spaces or a selection; what is typed next goes there.
    for (const [text, word, offset, selected, typed] of [
      ["alpha bravo", "alpha", 5, 0, "alpha\\\nxbravo"],
      ["- one two\n- b", "one", 3, 0, "- one\\\nxtwo\n- b"],
      ["alpha bravo charlie", "bravo", 0, 5, "alpha \\\nxcharlie"],
    ] as const) {
      const { projection, state } = await at(text, word, offset, format);
      const selection = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.selection.from, state.selection.from + selected)));
      let made: Transaction | undefined;
      hardBreak(selection, (tr) => (made = tr));
      const shown = selection.apply(made!);
      expect(shown.selection.empty).toBe(true);
      expect(shown.selection.$head.nodeBefore?.type).toBe(fluidSchema.nodes.hard_break);
      const typing = shown.tr.insertText("x");
      const accepted = await prepareFluidTransaction({ text, revision: 1, format }, projection, [...made!.steps, ...typing.steps].map((step) => step.toJSON()));
      expect(accepted.text).toBe(typed);
      expect(accepted.projection.doc.eq(typing.doc)).toBe(true);
    }
    // Before a line break the note has (one typed in Source), that one
    // becomes a break too, and the caret goes between the two, on the new line.
    for (const [text, word, shown, typed] of [
      ["Dear team,\nthanks for the notes.", "Dear team,", "Dear team,\\\n\\\nthanks for the notes.", "Dear team,\\\nx\\\nthanks for the notes."],
      ["- item one\n  continued\n- b", "item one", "- item one\\\n\\\ncontinued\n- b", "- item one\\\n  x\\\n  continued\n- b"],
      ["> quoted one\n> quoted two", "quoted one", "> quoted one\\\n\\\nquoted two", "> quoted one\\\n> x\\\n> quoted two"],
    ]) {
      const { projection, state } = await at(text, word, word.length, format);
      let made: Transaction | undefined;
      hardBreak(state, (tr) => (made = tr));
      const after = state.apply(made!);
      expect(after.selection.$head.nodeBefore?.type).toBe(fluidSchema.nodes.hard_break);
      expect(after.selection.$head.nodeAfter?.type).toBe(fluidSchema.nodes.hard_break);
      expect(after.selection.$head.parent.textContent).not.toContain("\n");
      expect(trailingBreak(made!.steps, made!.doc)).toBeNull();
      const accepted = await prepareFluidTransaction({ text, revision: 1, format }, projection, made!.steps.map((step) => step.toJSON()));
      expect(accepted.text).toBe(shown);
      expect(accepted.projection.doc.eq(made!.doc)).toBe(true);
      const typing = after.tr.insertText("x");
      const next = await prepareFluidTransaction({ text: accepted.text, revision: 2, format }, accepted.projection, typing.steps.map((step) => step.toJSON()));
      expect(next.text).toBe(typed);
      expect(next.projection.doc.eq(typing.doc)).toBe(true);
    }
    // Inside formatting the break has none, as Markdown writes it.
    const bold = await run("**alpha bravo**", "alpha", hardBreak, options);
    const inserted = (bold!.tr.steps[0] as ReplaceStep).slice.content.firstChild!;
    expect(inserted.type).toBe(fluidSchema.nodes.hard_break);
    expect(inserted.marks).toEqual([]);
    expect((await bold!.write()).projection.doc.eq(bold!.tr.doc)).toBe(true);
    // A heading has no line breaks: the key does nothing there.
    const { state } = await at("# Title\n\nBody.", "Title", 5, format);
    let dispatched = false;
    expect(hardBreak(state, () => (dispatched = true))).toBe(true);
    expect(dispatched).toBe(false);
  });

  test(`${format}: a line break at the end of a paragraph waits for the text typed after it, then goes with it as one step`, async () => {
    for (const [text, word, typed, expected] of [
      ["- a\n- b", "a", "x", "- a\\\nx\n- b"],
      ["- a\n- b", "b", "x", "- a\n- b\\\nx"],
      ["alpha bravo", "bravo", "next", "alpha bravo\\\nnext"],
      ["> quoted", "quoted", "x", "> quoted\\\nx"],
      ["- [ ] a\n- [ ] b", "a", "x", "- [ ] a\\\nx\n- [ ] b"],
    ]) {
      const { projection, state } = await at(text, word, word.length, format);
      let made: Transaction | undefined;
      hardBreak(state, (tr) => (made = tr));
      const held = trailingBreak(made!.steps, made!.doc)!;
      expect(held).not.toBeNull();
      // Alone, the break has no Markdown form.
      await expect(prepareFluidTransaction({ text, revision: 1, format }, projection, made!.steps.map((step) => step.toJSON()))).rejects.toThrow();
      const shown = state.apply(made!);
      // Spaces typed after it cannot be written; text can, with the break.
      expect(afterHeldBreak(held, shown.tr.insertText(" ").steps)).toBe("spaces");
      const typing = shown.tr.insertText(typed);
      const step = afterHeldBreak(held, typing.steps);
      expect(step).toBeInstanceOf(ReplaceStep);
      expect(trailingBreak([step as Step], typing.doc)).toBeNull();
      const accepted = await prepareFluidTransaction({ text, revision: 1, format }, projection, [(step as Step).toJSON()]);
      expect(accepted.text).toBe(expected);
      expect(accepted.projection.doc.eq(typing.doc)).toBe(true);
    }
    // A second break after the first is held with it; then the text goes with both.
    const { projection, state } = await at("alpha", "alpha", 5, format);
    let first: Transaction | undefined;
    hardBreak(state, (tr) => (first = tr));
    const held = trailingBreak(first!.steps, first!.doc)!;
    const once = state.apply(first!);
    let second: Transaction | undefined;
    hardBreak(once, (tr) => (second = tr));
    const both = afterHeldBreak(held, second!.steps) as ReplaceStep;
    expect(trailingBreak([both], second!.doc)).not.toBeNull();
    const typing = once.apply(second!).tr.insertText("x");
    const step = afterHeldBreak(both, typing.steps) as Step;
    expect((await prepareFluidTransaction({ text: "alpha", revision: 1, format }, projection, [step.toJSON()])).text).toBe("alpha\\\n\\\nx");
    // Other edits are not taken with the break.
    expect(afterHeldBreak(held, once.tr.insertText("x", 1).steps)).toBeNull();
    expect(afterHeldBreak(held, once.tr.delete(6, 7).steps)).toBeNull();
    // A break in the middle of a line is not held.
    const middle = await run("alpha bravo", "alpha", hardBreak, { format });
    expect(trailingBreak(middle!.tr.steps, middle!.tr.doc)).toBeNull();
  });

  test(`${format}: taking out the text after a line break holds the break and sends the rest, and text typed after it goes with the break`, async () => {
    for (const [text, word, edit, sent, typed] of [
      // Backspace over the one letter typed after Shift+Enter.
      ["- a\\\nx\n- b", "x", (s: EditorState) => s.tr.delete(s.selection.from - 1, s.selection.from), "- a\n- b", "- a\\\ny\n- b"],
      ["alpha\\\nxy", "xy", (s: EditorState) => s.tr.delete(s.selection.from - 2, s.selection.from), "alpha", "alpha\\\ny"],
      // A word cut, and another typed over the line after the break.
      ["> quoted\\\nmore", "more", (s: EditorState) => s.tr.delete(s.selection.from - 4, s.selection.from), "> quoted", "> quoted\\\ny"],
    ] as const) {
      const { projection, state } = await at(text, word, word.length, format);
      const tr = edit(state);
      // As the keys make it, the edit has no Markdown form.
      await expect(prepareFluidTransaction({ text, revision: 1, format }, projection, tr.steps.map((step) => step.toJSON()))).rejects.toThrow();
      const left = leftBreak(tr.before, tr.doc)!;
      expect(left).not.toBeNull();
      expect(left.steps).toHaveLength(1);
      const accepted = await prepareFluidTransaction({ text, revision: 1, format }, projection, left.steps.map((step) => step.toJSON()));
      expect(accepted.text).toBe(sent);
      expect(accepted.projection.doc.eq(left.base)).toBe(true);
      // The held break is the one on screen, and goes with the text typed after it.
      expect(left.hold.apply(left.base).doc!.eq(tr.doc)).toBe(true);
      const typing = state.apply(tr).tr.insertText("y");
      const step = afterHeldBreak(left.hold, typing.steps) as Step;
      expect(step).toBeInstanceOf(ReplaceStep);
      const now = await projectFluidSource(accepted.text, format);
      const next = await prepareFluidTransaction({ text: accepted.text, revision: 2, format }, now, [step.toJSON()]);
      expect(next.text).toBe(typed);
      expect(next.projection.doc.eq(typing.doc)).toBe(true);
    }
    // Other edits leave no break at the end of a line.
    const { state } = await at("- a\\\nxy\n- b", "xy", 2, format);
    const tr = state.tr.delete(state.selection.from - 1, state.selection.from);
    expect(leftBreak(tr.before, tr.doc)).toBeNull();
  });

  test(`${format}: a burst of typing waiting to be sent goes as one step, written as the keys one by one write it`, async () => {
    for (const [text, word, burst] of [
      ["Start **bold** end.\n\nSecond.", "Second", " and more words, typed fast."],
      ["- First item\n- Second item", "First item", " with *stars* and _marks_"],
      ["A paragraph to finish", "finish", ". Then 1. 2. 3. # not a heading"],
      // A heading's closing "#" is written escaped only when sent alone.
      ["# Head", "Head", " more #"],
      ["## Head", "Head", " issue ## a #"],
    ]) {
      const { projection, state } = await at(text, word, word.length, format);
      let current = state;
      let sequential = { text, projection };
      // What the frame sends: each key merged into the one before where it can be.
      const sends: Step[] = [];
      for (const character of burst) {
        const tr = current.tr.insertText(character);
        const steps = tr.steps;
        const merged = sends.length ? typedTogether([sends.at(-1)!], steps) : null;
        if (merged) sends[sends.length - 1] = merged;
        else sends.push(steps[0]);
        const next = await prepareFluidTransaction({ text: sequential.text, revision: 1, format }, sequential.projection, steps.map((step) => step.toJSON()));
        sequential = { text: next.text, projection: next.projection };
        current = current.apply(tr);
      }
      // Each "#" goes alone, and the rest in as few steps as that leaves.
      const typed = sends.map((step) => (step as ReplaceStep).slice.content.textBetween(0, (step as ReplaceStep).slice.content.size));
      expect(typed.join("")).toBe(burst);
      expect(typed.filter((part) => part.includes("#") && part !== "#")).toEqual([]);
      expect(typed.length).toBe(burst.split(/#/).filter(Boolean).length + [...burst].filter((character) => character === "#").length);
      // The same document, every character in order; the source may escape less.
      let once = { text, projection, nearest: null as unknown };
      for (const step of sends) once = await prepareFluidTransaction({ text: once.text, revision: 1, format }, once.projection, [step.toJSON()]);
      expect(once.projection.doc.eq(current.doc)).toBe(true);
      expect(once.projection.doc.eq(sequential.projection.doc)).toBe(true);
      expect(once.nearest).toBeNull();
    }
    // Backspace held down merges too; a split or a mark does not.
    const { state } = await at("alpha bravo", "bravo", 5, format);
    const one = state.tr.delete(state.selection.from - 1, state.selection.from);
    const two = state.apply(one).tr.delete(state.selection.from - 2, state.selection.from - 1);
    expect(typedTogether(one.steps, two.steps)).not.toBeNull();
    const split = state.apply(one).tr.split(state.selection.from - 1);
    expect(typedTogether(one.steps, split.steps)).toBeNull();
    const marked = state.tr.addMark(1, 3, fluidSchema.marks.strong.create());
    expect(typedTogether(marked.steps, marked.steps)).toBeNull();
    // Not next to each other: two edits.
    const far = state.apply(one).tr.insertText("x", 1);
    expect(typedTogether(one.steps, far.steps)).toBeNull();
  });
}

test("Shift+Enter does nothing across paragraphs or over a select-all", async () => {
  const { state } = await at("alpha\n\nbravo", "alpha", 2);
  const across = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3, 10)));
  let dispatched = false;
  expect(hardBreak(across, () => (dispatched = true))).toBe(true);
  expect(dispatched).toBe(false);
});

test("a held line break with what it replaced: taking it out puts that back", async () => {
  const { state } = await at("alpha bravo", "bravo", 0);
  const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.selection.from, state.selection.from + 5)));
  let made: Transaction | undefined;
  hardBreak(selected, (tr) => (made = tr));
  const held = trailingBreak(made!.steps, made!.doc)!;
  expect(held).not.toBeNull();
  const back = held.invert(selected.doc).apply(made!.doc).doc!;
  expect(back.eq(selected.doc)).toBe(true);
});

