import { describe, expect, test } from "bun:test";
import { applySourcePatches } from "./index";
import {
  editBlock,
  encodeInlineInput,
  type AuthoringBlock,
} from "./structural";

const source =
  "export const untouched = 1\n\nHello world\n\n<Unknown value={untouched} />";
const from = source.indexOf("Hello");
const block: AuthoringBlock = {
  id: "p",
  from,
  to: from + 11,
  contentFrom: from,
  contentTo: from + 11,
  value: "Hello world",
  kind: "paragraph",
  prefix: "",
  after: from + 11,
};
const snapshot = { text: source, revision: 7, format: "mdx" as const };

describe("rendered structural source edits", () => {
  test("splits a paragraph while preserving adjacent exports and unsupported JSX byte-for-byte", () => {
    const result = editBlock(snapshot, 7, [block], {
      block: "p",
      action: "enter",
      value: "Hello world",
      caret: 5,
    });
    expect(applySourcePatches(snapshot, 7, [result.patch]).text).toBe(
      source.replace("Hello world", "Hello\n\n world"),
    );
    expect(result.focus).toBe(from + 7);
  });
  test("rejects stale revision, forged block and out-of-bounds caret", () => {
    const intent = {
      block: "p",
      action: "enter" as const,
      value: "Hello world",
      caret: 5,
    };
    expect(() => editBlock(snapshot, 6, [block], intent)).toThrow(/stale/i);
    expect(() =>
      editBlock(snapshot, 7, [block], { ...intent, block: "jsx" }),
    ).toThrow(/block/i);
    expect(() =>
      editBlock(snapshot, 7, [block], { ...intent, caret: 999 }),
    ).toThrow(/caret/i);
  });
  test("continues a list and exits its empty item", () => {
    const list: AuthoringBlock = {
      id: "l",
      from: 0,
      to: 6,
      contentFrom: 2,
      contentTo: 6,
      value: "item",
      kind: "list",
      prefix: "- ",
      after: 6,
    };
    const doc = { text: "- item", revision: 0, format: "mdx" as const };
    expect(
      editBlock(doc, 0, [list], {
        block: "l",
        action: "enter",
        value: "item",
        caret: 4,
      }).patch.insert,
    ).toBe("- item\n- ");
    const empty = { ...list, to: 2, contentTo: 2, value: "" };
    expect(
      editBlock({ ...doc, text: "- " }, 0, [empty], {
        block: "l",
        action: "enter",
        value: "",
        caret: 0,
      }).patch.insert,
    ).toBe("\n\n");
  });
  test("accepts bounded heading and divider shortcuts, never pasted JSX", () => {
    const gap: AuthoringBlock = {
      id: "g",
      from: 0,
      to: 0,
      contentFrom: 0,
      contentTo: 0,
      value: "",
      kind: "gap",
      prefix: "",
      after: 0,
    };
    const doc = { text: "", revision: 0, format: "mdx" as const };
    expect(
      editBlock(doc, 0, [gap], {
        block: "g",
        action: "enter",
        value: "- item",
        caret: 6,
      }).patch.insert,
    ).toBe("- item\n- ");
    expect(
      editBlock(doc, 0, [gap], {
        block: "g",
        action: "enter",
        value: "~~gone~~",
        caret: 8,
      }).patch.insert,
    ).toBe("~~gone~~\n\n");
    expect(
      editBlock(doc, 0, [gap], {
        block: "g",
        action: "shortcut",
        value: "### ",
        caret: 4,
      }).patch.insert,
    ).toBe("### ");
    expect(
      editBlock(doc, 0, [gap], {
        block: "g",
        action: "enter",
        value: "---",
        caret: 3,
      }).patch.insert,
    ).toBe("---\n\n");
    expect(
      editBlock(doc, 0, [gap], {
        block: "g",
        action: "commit",
        value: "<Evil />",
        caret: 8,
      }).patch.insert,
    ).toBe("\\<Evil />");
  });
  test("encodes only bounded inline pairs, shielding code and escaped markers", () => {
    expect(
      encodeInlineInput("**strong** *em* ~~gone~~ `*literal*`", "mdx"),
    ).toBe("**strong** *em* ~~gone~~ `*literal*`");
    expect(encodeInlineInput("\\*literal* <Evil /> {run()}", "mdx")).toContain(
      "\\<Evil /> \\{run()\\}",
    );
    expect(encodeInlineInput("*", "mdx")).toBe("\\*");
  });
});
