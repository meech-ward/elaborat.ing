import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { fluidSchema } from "../rendered/fluidSchema";
import { appendedFrom, mapThroughDoc, mapThroughText, writeInMs, writeInStops } from "./writeIn";

describe("appendedFrom", () => {
  test("finds where text added on new lines starts, as append_to_note adds it", () => {
    const after = "# Plan\n\nFirst.\n\n## Next\n";
    expect(appendedFrom("# Plan\n\nFirst.\n", after)).toBe(after.indexOf("## Next"));
    // The whitespace the note ended with may have gone.
    expect(appendedFrom("# Plan\n\nFirst.  \n\n\n", after)).toBe(after.indexOf("## Next"));
    expect(appendedFrom("# Plan\n\nFirst.", after)).toBe(after.indexOf("## Next"));
    // An empty note gains all of it.
    expect(appendedFrom("", "## Next\n")).toBe(0);
    expect(appendedFrom("\n", "\n\n## Next\n")).toBe(2);
  });

  test("is null for any other change", () => {
    const before = "# Plan\n\nFirst.\n";
    expect(appendedFrom(before, "# Plan\n\nFirst!\n\n## Next\n")).toBeNull();
    expect(appendedFrom(before, "# Plan\n\nFirst. And more.\n")).toBeNull();
    expect(appendedFrom(before, "# Plan\n\nFirst.\n\n\n")).toBeNull();
    expect(appendedFrom(before, before)).toBeNull();
    expect(appendedFrom(before, "# Plan\n")).toBeNull();
  });
});

describe("the pace of writing in", () => {
  test("a line takes about a second, a short section about two, and nothing more than four", () => {
    expect(writeInMs(0)).toBe(0);
    expect(writeInMs(80)).toBeGreaterThan(800);
    expect(writeInMs(80)).toBeLessThan(1000);
    expect(writeInMs(200)).toBeGreaterThan(1500);
    expect(writeInMs(200)).toBeLessThan(2000);
    expect(writeInMs(4_000)).toBeLessThanOrEqual(4000);
    expect(writeInMs(4_000)).toBeGreaterThan(3990);
    // A longer addition goes faster.
    expect(writeInMs(1_000) / 1_000).toBeLessThan(writeInMs(100) / 100);
  });

  test("pauses after each word with the spaces before it, in a long word every eight characters, and at the end", () => {
    expect(writeInStops("Hello world, again")).toEqual([5, 12, 18]);
    expect(writeInStops("## Next\n\n- one ")).toEqual([2, 7, 10, 14, 15]);
    expect(writeInStops("see https://example.com/a")).toEqual([3, 12, 20, 25]);
  });
});

describe("mapThroughText", () => {
  const NOTE = "# Plan\n\nFirst we ship.\n";
  const caret = NOTE.indexOf("First we") + "First".length;

  test("keeps a place before the change, and moves one after it with its text", () => {
    expect(mapThroughText(NOTE, `${NOTE}\n## Next\n\nMore.\n`)(caret)).toBe(caret);
    // Above it, a paragraph that starts with the same word: a paragraph added, not words.
    const above = "# Plan\n\nFirst we test.\n\nFirst we ship.\n";
    expect(mapThroughText(NOTE, above)(caret)).toBe(above.lastIndexOf("First we") + "First".length);
    // Words changed earlier on its line.
    expect(mapThroughText("A quick fox jumps\n", "A slow fox jumps\n")(17)).toBe(16);
  });

  test("puts a place in replaced text at the nearer end of what replaced it", () => {
    const place = mapThroughText("a quick fox", "a slow fox");
    expect(place(3)).toBe(2);
    expect(place(6)).toBe(6);
  });

  test("keeps a place where text is added at it, unless whole lines go above its line", () => {
    expect(mapThroughText("Hello world", "Hello big world")(6)).toBe(6);
    expect(mapThroughText("A\n\nB\n", "A\n\nX\n\nB\n")(3)).toBe(6);
    expect(mapThroughText("A\n", "A\n\n## X\n")(2)).toBe(2);
  });
});

describe("mapThroughDoc", () => {
  const p = (words: string) => fluidSchema.node("paragraph", null, [fluidSchema.text(words)]);
  const h = (words: string) => fluidSchema.node("heading", { level: 2 }, [fluidSchema.text(words)]);
  const ul = (...items: string[]) => fluidSchema.node("bullet_list", null, items.map((item) => fluidSchema.node("list_item", null, [p(item)])));
  const doc = (...blocks: PMNode[]) => fluidSchema.node("doc", null, blocks);
  /** The position after `words` in the first text that has them. */
  const after = (document: PMNode, words: string) => {
    let found = -1;
    document.descendants((child, pos) => {
      if (found === -1 && child.isText && child.text!.includes(words)) found = pos + child.text!.indexOf(words) + words.length;
    });
    return found;
  };

  test("keeps a position before the change, and moves one after it with its text", () => {
    const before = doc(h("Plan"), p("First we ship."));
    const caret = after(before, "First");
    expect(mapThroughDoc(before, doc(h("Plan"), p("First we ship."), h("Next"), p("More.")))(caret)).toBe(caret);
    // Above it, a paragraph or list item that starts with the same word.
    const above = doc(h("Plan"), p("First we test."), p("First we ship."));
    expect(mapThroughDoc(before, above)(caret)).toBe(after(above, "First we test.") + 2 + "First".length);
    const list = doc(ul("Buy milk", "Buy eggs"));
    const longer = doc(ul("Buy bread", "Buy milk", "Buy eggs"));
    expect(mapThroughDoc(list, longer)(after(list, "Bu"))).toBe(after(longer, "Buy milk") - "y milk".length);
    // Words changed earlier in its paragraph.
    const fox = doc(p("A quick fox jumps"));
    expect(mapThroughDoc(fox, doc(p("A slow fox jumps")))(after(fox, "jumps"))).toBe(after(fox, "jumps") - 1);
  });

  test("keeps a position where text is added at it", () => {
    const hello = doc(p("Hello world"));
    expect(mapThroughDoc(hello, doc(p("Hello big world")))(after(hello, "Hello "))).toBe(after(hello, "Hello "));
  });
});
