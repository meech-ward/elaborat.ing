import { expect, test } from "bun:test";
import { instrumentMdxSource, compileForPreview } from "./instrumentation";
import { editBlock, splitRichLeaf } from "../document/structural";
import { applySourcePatches } from "../document";
import { insertBlock } from "./insertBlock";
import { checkChildMessage } from "./protocol";

test("parser exposes ordinary and empty blocks, never computed JSX/code as a structural target", async () => {
  const source =
    "export const Thing = () => <strong>computed</strong>\n\nPlain paragraph\n\n<Thing />\n\n```js\ncode\n```\n\n- \n\n";
  const map = await instrumentMdxSource(source);
  expect(map.blocks.map((block) => block.value)).toEqual([
    "Plain paragraph",
    "",
    "",
  ]);
  expect(map.blocks.map((block) => block.kind)).toEqual([
    "paragraph",
    "list",
    "gap",
  ]);
  const paragraph = map.blocks[0];
  const result = editBlock(
    { text: source, revision: 0, format: "mdx" },
    0,
    map.blocks,
    {
      block: paragraph.id,
      action: "enter",
      value: paragraph.value,
      caret: paragraph.value.length,
    },
  );
  const updated = applySourcePatches(
    { text: source, revision: 0, format: "mdx" },
    0,
    [result.patch],
  );
  expect(updated.text).toBe(
    source.replace("Plain paragraph", "Plain paragraph\n\n"),
  );
  const next = await instrumentMdxSource(updated.text);
  expect(
    next.blocks.some(
      (block) => block.kind === "gap" && block.from === result.focus,
    ),
  ).toBe(true);
  expect(
    await compileForPreview(updated.text, next.components, "mdx", true),
  ).toContain("SourceBlock");
});

test("picker inserts catalog defaults at parsed boundaries and rejects invented paths/JSX in Markdown", async () => {
  const document = {
    text: "Before\n\n<Counter initial={2} />",
    revision: 4,
    format: "mdx" as const,
  };
  const map = await instrumentMdxSource(document.text);
  const boundary = map.boundaries.at(-1)!.id;
  const result = insertBlock(
    document,
    4,
    map.boundaries,
    { boundary, element: "Drawing", path: "drawings/a.excalidraw" },
    ["drawings/a.excalidraw"],
  );
  expect(result.patch.insert).toBe(
    '\n\n<Drawing src="drawings/a.excalidraw" />\n\n',
  );
  const button = insertBlock(
    document,
    4,
    map.boundaries,
    { boundary, element: "Button" },
    [],
  );
  expect(button.patch.insert).toBe('\n\n<Button>Continue</Button>\n\n');
  const columns = insertBlock(
    document,
    4,
    map.boundaries,
    { boundary, element: "Columns" },
    [],
  );
  expect(columns.patch.insert).toContain('<Columns>');
  expect(columns.patch.insert).toContain('<Card>');
  expect(() =>
    insertBlock(
      document,
      4,
      map.boundaries,
      { boundary, element: "Diagram", path: "secret.d2" },
      [],
    ),
  ).toThrow(/allowed/i);
  expect(() =>
    insertBlock(
      document,
      4,
      map.boundaries,
      { boundary: "inside-jsx", element: "Counter" },
      [],
    ),
  ).toThrow(/boundary/i);
  expect(() =>
    insertBlock(
      document,
      4,
      map.boundaries,
      { boundary, element: "constructor" },
      [],
    ),
  ).toThrow(/Unknown component/i);
  expect(() =>
    insertBlock(
      { ...document, format: "md" },
      4,
      map.boundaries,
      { boundary, element: "Counter" },
      [],
    ),
  ).toThrow(/MDX/i);
});

test("structural protocol rejects stale/forged operations before parent domain validation", () => {
  const source = {};
  const base = {
    source,
    expectedSource: source,
    session: "session123",
    revision: 2,
  };
  const data = {
    kind: "block-edit",
    session: "session123",
    revision: 2,
    block: "block:0",
    action: "enter",
    value: "safe",
    caret: 4,
  };
  expect(checkChildMessage({ ...base, data }).ok).toBe(true);
  expect(
    checkChildMessage({ ...base, data: { ...data, revision: 1 } }).ok,
  ).toBe(false);
  expect(
    checkChildMessage({
      ...base,
      data: { ...data, action: "raw-code", code: "evil()" },
    }).ok,
  ).toBe(false);
  expect(checkChildMessage({ ...base, source: {}, data }).ok).toBe(false);
});

test("formatted paragraph retains exact delimiters when splitting and has a plain trailing caret", async () => {
  const document = {
    text: "Before __bold text__ after\n\n<Unknown />",
    revision: 1,
    format: "mdx" as const,
  };
  const map = await instrumentMdxSource(document.text);
  const leaf = map.richLeaves.find((entry) => entry.expected === "bold text")!;
  const split = splitRichLeaf(document, 1, map.richLeaves, {
    ...leaf,
    value: "bold text",
    caret: 4,
  });
  expect(applySourcePatches(document, 1, [split.patch]).text).toBe(
    "Before __bold__\n\n __text__ after\n\n<Unknown />",
  );
  const tail = map.richLeaves.at(-1)!;
  expect(tail.expected).toBe("");
  expect(
    splitRichLeaf(document, 1, map.richLeaves, {
      ...tail,
      value: " continued",
      caret: 10,
    }).patch.insert,
  ).toBe("Before __bold text__ after continued\n\n");
});
