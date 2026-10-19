import { expect, test } from "bun:test";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { fluidSchema } from "./fluidSchema";
import { rebaseSteps, sameMarkdownForm } from "./nearestForm";

const { em, strong, link } = fluidSchema.marks;
const text = (value: string, ...marks: MarkType[]) =>
  fluidSchema.text(value, marks.map((mark) => (mark === link ? mark.create({ href: "u" }) : mark.create())));
const p = (...content: PMNode[]) => fluidSchema.node("paragraph", null, content);
const h = (...content: PMNode[]) => fluidSchema.node("heading", { level: 2 }, content);
const doc = (...blocks: PMNode[]) => fluidSchema.node("doc", null, blocks);

test("two documents have the same Markdown form only when they differ by whitespace Markdown cannot hold", () => {
  // Spaces or tabs at the start of a paragraph or heading.
  expect(sameMarkdownForm(doc(p(text("A.")), p(text(" \tWorld"))), doc(p(text("A.")), p(text("World"))))).toBe(true);
  expect(sameMarkdownForm(doc(h(text(" words"))), doc(h(text("words"))))).toBe(true);
  // A space at the edge of italics or bold, moved just outside them.
  expect(sameMarkdownForm(doc(p(text("a ", em), text("b"))), doc(p(text("a", em), text(" b"))))).toBe(true);
  expect(sameMarkdownForm(doc(p(text("one ", strong), text("two"), text(" three", strong))), doc(p(text("one", strong), text(" two "), text("three", strong))))).toBe(true);
  // Anything else differs: a letter, a space between words or ending a paragraph,
  // formatting on a letter, a link's spaces, a line break, an empty paragraph.
  expect(sameMarkdownForm(doc(p(text("World"))), doc(p(text("Word"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(text("a  b"))), doc(p(text("a b"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(text("a "))), doc(p(text("a"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(text("ab", em))), doc(p(text("a", em), text("b"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(text("a ", link), text("b"))), doc(p(text("a", link), text(" b"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(text("a\n"))), doc(p(text("a"))))).toBe(false);
  expect(sameMarkdownForm(doc(p(), p()), doc(p()))).toBe(false);
});

test("edits made after one taken in its nearest form are redone on the document it took, where they were made", () => {
  // Enter before " World" made a paragraph starting with the space, which the
  // source drops; "New. " was typed at its start before that came back.
  const made = doc(p(text("Hello.")), p(text(" World")));
  const taken = doc(p(text("Hello.")), p(text("World")));
  const typed = new Transform(made);
  for (const [index, character] of [..."New. "].entries()) typed.insert(9 + index, fluidSchema.text(character));
  const redone = rebaseSteps(typed.steps, made, taken)!;
  expect(redone.docs.at(-1)!.eq(doc(p(text("Hello.")), p(text("New. World"))))).toBe(true);
  // The caret after the typing stays after it.
  expect(redone.mapping(typed.steps.length).map(14)).toBe(14);
  // The italics that kept a space in a delete are taken without it: a later edit's places move with no text.
  const deleted = doc(p(text("a ", em), text("b")));
  const kept = doc(p(text("a", em), text(" b")));
  const more = new Transform(deleted).insert(4, fluidSchema.text("c"));
  expect(rebaseSteps(more.steps, deleted, kept)!.docs.at(-1)!.eq(doc(p(text("a", em), text(" bc"))))).toBe(true);
});
