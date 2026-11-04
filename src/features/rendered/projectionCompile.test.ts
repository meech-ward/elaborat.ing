/**
 * The projection parses a note once. compileProjection reads the note's
 * instrumentation from the same compile that makes its preview code; before,
 * the note was instrumented by itself (instrumentMdxSource,
 * instrumentMarkdownSource) and then compiled again for the preview
 * (compileForPreview). These tests run projectFluidSource both ways, through
 * its own projection hooks, and require the same result: the same document,
 * mapping, slots, blocks, islands, runtime key and code, or the same error.
 */
import { afterAll, expect, spyOn, test } from "bun:test";
import { unified } from "unified";
import { Fragment, Slice } from "prosemirror-model";
import { ReplaceStep } from "prosemirror-transform";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { splitBlock, toggleMark } from "prosemirror-commands";
import { splitListItem } from "prosemirror-schema-list";
import * as instrumentation from "./instrumentation";
import {
  fluidPositionForSourceOffset,
  prepareFluidTransaction,
  projectFluidSource,
  type FluidProjection,
} from "./fluidProjection";
import { fluidSchema } from "./fluidSchema";
import { prepareComponentEnvironment, type ComponentEnvironment } from "../document/componentModules";
import { COMPONENT_CATALOG } from "../document/componentCatalog";
import { imageFigureMarkdown } from "../images/captions";
import { WELCOME_FILES } from "../projects/welcomeNote";
import { parseErrorPosition } from "../../lib/sourceDiagnostics";
import type { DocumentFormat } from "./types";

// The two compiles the projection made before, through the same hooks.
const oneCompile = instrumentation.compileProjection;
const twoCompiles: typeof oneCompile = async (source, format, hooks, catalog) => {
  const instrumented =
    format === "md"
      ? await instrumentation.instrumentMarkdownSource(source)
      : await instrumentation.instrumentMdxSource(source, catalog);
  const code = await instrumentation.compileForPreview(
    source,
    instrumented.components,
    format,
    false,
    { before: (tree) => hooks.before(tree, instrumented), after: hooks.after },
    catalog,
  );
  return { code, instrumentation: instrumented };
};
let separately = false;
const dispatch: typeof oneCompile = (...args) => {
  // The spy forgets each call: it would keep every compile's result until the file ends.
  compiler.mockClear();
  return (separately ? twoCompiles : oneCompile)(...args);
};
const compiler = spyOn(instrumentation, "compileProjection").mockImplementation(dispatch);
afterAll(() => compiler.mockRestore());

async function bothWays<T>(run: () => Promise<T>): Promise<[T, T]> {
  separately = false;
  const once = await run();
  separately = true;
  try {
    return [once, await run()];
  } finally {
    separately = false;
  }
}

/** Every source text the unified parser reads while `run` runs. */
async function parsed(run: () => Promise<unknown>): Promise<string[]> {
  const processor = Object.getPrototypeOf(unified) as { parse: (file: unknown) => unknown };
  const parse = processor.parse;
  const texts: string[] = [];
  const spy = spyOn(processor, "parse").mockImplementation(function (this: unknown, file: unknown) {
    texts.push(String(file));
    return parse.call(this, file);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return texts;
}

/** Everything a projection holds, as plain data. */
function shape(projection: FluidProjection) {
  return {
    text: projection.text,
    format: projection.format,
    doc: projection.doc.toJSON(),
    code: projection.code,
    slots: projection.slots,
    islands: projection.islands,
    instrumentation: projection.instrumentation,
    runtimeKey: projection.runtimeKey,
    leaves: projection.mapping.leaves.map((leaf) => ({
      ...leaf,
      frames: leaf.frames.map((frame) => ({ ...frame, mark: frame.mark.toJSON() })),
    })),
    nodes: projection.mapping.nodes.map(({ node, ...entry }) => ({ ...entry, node: node.toJSON() })),
    roots: projection.mapping.roots.map(({ node, ast, ...entry }) => ({ ...entry, type: ast.type, node: node.toJSON() })),
  };
}

async function outcome<T>(run: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const card = `export const StatusCard = ({ title, count, ready }) => <section>{title}: {count} {ready ? 'ready' : 'waiting'}</section>;

export const componentMeta = { StatusCard: { description: 'Release status', props: { title: {type: 'string', default: 'Review'}, count: {type: 'number', default: 3}, ready: {type: 'boolean', default: true} } } };
`;

const prose = `# Title with *emphasis*

Setext heading
==============

A paragraph with **strong**, *em*, __under strong__, _under em_, ~~gone~~, \`code\`, \`\` a \` tick \`\`,
a [link](https://example.com "Title"), www.example.com, and an entity &amp; an escape \\*not em\\*
and &#x1F642;. Hard break with two spaces
and with a backslash\\
then the end.

***

Trailing spaces stay here.
Final line.
`;

const lists = `- one
- two **bold**
  - nested *a*
  - nested b
    1. deep ordered
- three

* star item
* another

+ plus item

1. first
2. second

3) start three
4) next

- [ ] task open
- [x] task done
- [ ] **bold task**
- [ ]

- loose one

- loose two

  second paragraph of loose two

-
- empty above

1.

> - quoted item
> - another quoted
>   continued

- item with code

  \`\`\`js
  const inItem = 1;
  \`\`\`

- \`\`\`js
  fenced head
  \`\`\`
- after fenced head
`;

const tables = `| Left | Center | Right |
|:-----|:------:|------:|
| a **b** | \`c\` | d \\| e |
| [x](https://x.y) | ~~s~~ | 3 |

Text after the table.
`;

const code = `\`\`\`js
const a = 1;
\`\`\`

~~~ts title="x"
let b: number = 2;
~~~

    indented code
    second line

\`\`\`\`md
\`\`\`
nested fence
\`\`\`
\`\`\`\`

Inline \`code\` text.

\`\`\`python
unclosed at the end
`;

const images = `![Alt text](assets/a.png)

![With title](assets/b.png "Title")

![Reference][ref]

[ref]: assets/c.png

Inline ![small](assets/d.png) image in prose.

- ![in list](assets/e.png)

| img |
|-----|
| ![cell](assets/f.png) |

[![linked](assets/g.png)](https://example.com)
`;

const frontmatter = `---
title: "A note"
tags: [a, b]
---

# Body

Text.
`;

const footnotes = `Text with a note[^1] and another[^big].

[^1]: The note.

[^big]: A longer note

    with a second paragraph.
`;

const components = `<Counter initial={3} step={1} />

<Callout tone="info" title="A note">
Be careful with **nested** markup here.

- a list inside
</Callout>

Inline <Badge>Draft</Badge> badge and <Button>Go</Button> button.

<Counter initial={1 + 2} />

<Unknown x={1} label="y" />

<div>
  <span>raw jsx</span>
</div>

<Tabs current="One">
  <Tab name="One">

Markdown inside a tab with *em*.

  </Tab>
</Tabs>

<Callout title="First" title="Last">Body</Callout>

A line break<br />inside prose.
`;

const esm = `export const helper = (x) => x * 2;

export function Local() { return <b>local</b>; }

# Heading

Value {helper(21)} inline and

{helper(1)}

<Local />
`;

const documents = `Intro.

<Document src="notes/details.mdx" title="Details" defaultCollapsed />

- <Document src="notes/item.mdx" />

<Document src="notes/plain.mdx" />
`;

const comments = `{/* Keep this comment exactly: spacing  matters   here */}

Text {/* inline comment */} continues.

{/*
multi line
*/}

After.
`;

function generated(kilobytes: number, islands: boolean): string {
  const blocks: string[] = ["# Generated note"];
  for (let index = 1; blocks.join("\n\n").length < kilobytes * 1024; index++) {
    if (islands && index % 10 === 0) blocks.push("```ts\nconst value" + index + " = " + index + ";\n```");
    else if (islands && index % 13 === 0) blocks.push(`<Counter initial={${index}} />`);
    else if (index % 7 === 0) blocks.push(`- item ${index}\n- item **two** ${index}\n  - nested ${index}`);
    else if (index % 5 === 0) blocks.push(`## Heading ${index}`);
    else blocks.push(`Paragraph ${index} has **bold** and *em* with \`code\` and a [link](https://example.com/${index}) and plain words.`);
  }
  return blocks.join("\n\n") + "\n";
}

type Note = {
  name: string;
  format: DocumentFormat;
  text: string;
  load?: (path: string) => Promise<{ text: string; revision: string }>;
};

const caption = "A **red** pixel with a [caption](https://example.com) and {literal braces}.";
const duplicateLayout = "export default function A() {}\n\nexport default function B() {}\n";
/** A line the projection's own transform refuses: the parser reads its NUL as U+FFFD. */
const unmappable = "\na\u0000b\n";
const NOTES: Note[] = [
  ...Object.entries({ prose, lists, tables, code, images, frontmatter, footnotes }).flatMap(([name, text]) =>
    (["md", "mdx"] as const).map((format) => ({ name, format, text })),
  ),
  { name: "toml frontmatter", format: "mdx", text: '+++\ntitle = "toml"\n+++\n\nBody text.\n' },
  { name: "components", format: "mdx", text: components },
  { name: "catalog", format: "mdx", text: COMPONENT_CATALOG.map((entry) => entry.template).join("\n\n") + "\n" },
  { name: "esm", format: "mdx", text: esm },
  { name: "documents", format: "mdx", text: documents },
  { name: "comments", format: "mdx", text: comments },
  {
    name: "html, comments and braces",
    format: "md",
    text: '<div>\n<b>html block</b>\n</div>\n\nInline <span>html</span> and <!-- a comment --> here.\n\n<img src="assets/a.png" alt="Html image">\n\nBraces {stay literal} in md.\n',
  },
  ...(["md", "mdx"] as const).map((format) => ({
    name: "figure",
    format,
    text: `Before.\n\n${imageFigureMarkdown("assets/a.png", "A red pixel", caption, format)}\n\nAfter.\n`,
  })),
  {
    name: "jsx figure",
    format: "mdx",
    text: '<figure>\n  <img src="assets/a.png" alt="A" />\n  <figcaption>A *caption*</figcaption>\n</figure>\n\n<img src="assets/b.png" alt="B" />\n',
  },
  {
    name: "workspace import",
    format: "mdx",
    text: 'import { StatusCard as ReleaseCard } from "workspace:components/cards.mdx";\n\n# Cards\n\n<ReleaseCard title="Launch" count={2} ready={false} />\n\nText after.\n',
    load: async () => ({ text: card, revision: "a" }),
  },
  { name: "local component", format: "mdx", text: `${card}\n<StatusCard title="Hello" count={2} ready={true} />\n\nProse after.\n` },
  { name: "byte order mark", format: "md", text: "﻿# Title\n\nText with *em*.\n\n- a\n" },
  { name: "byte order mark", format: "mdx", text: "﻿# Title\n\nText with *em*.\n\n<Counter initial={1} />\n" },
  { name: "crlf", format: "md", text: "# Title\r\n\r\nPara *em*\r\nnext line\r\n\r\n- a\r\n- b\r\n\r\n```js\r\nx\r\n```\r\n" },
  { name: "crlf", format: "mdx", text: "# Title\r\n\r\nPara *em*\r\nnext line\r\n\r\n- a\r\n- b\r\n\r\n<Counter initial={1} />\r\n" },
  { name: "gaps", format: "mdx", text: "a\n\n\n\n\nb\n\n\n\n" },
  { name: "gaps", format: "md", text: "\n\n\n\nfirst\n\n\n\n\n\nsecond" },
  { name: "empty", format: "md", text: "" },
  { name: "empty", format: "mdx", text: "" },
  { name: "guarded", format: "mdx", text: "export const preserved = 7;\n\n{/* keep  this comment */}\n\nA &amp; B \\*literal\\* and &#x1F642;. Alpha __bold__ omega.\n\n<Counter initial={preserved} />\n\nUntouched tail." },
  { name: "welcome", format: "mdx", text: WELCOME_FILES.find((file) => file.path.endsWith(".mdx"))!.content },
  { name: "generated", format: "mdx", text: generated(20, true) },
  { name: "generated", format: "md", text: generated(20, false) },
  // Notes the compiler refuses.
  { name: "autolink", format: "mdx", text: "Text <https://example.com> here.\n" },
  { name: "empty expression", format: "mdx", text: "<Counter initial={} />\n" },
  { name: "unclosed tag", format: "mdx", text: "Before\n\n<Callout>\nunclosed\n" },
  { name: "bad export", format: "mdx", text: "# Fine\n\nexport const = 1\n" },
  { name: "duplicate layout", format: "mdx", text: "export default function A({children}) { return children }\n\nexport default function B({children}) { return children }\n\nText.\n" },
  { name: "default import", format: "mdx", text: "import x from 'y'\n\nText.\n" },
  // An error of the projection's own and a later one of the compiler.
  { name: "default import and duplicate layout", format: "mdx", text: "import x from 'y'\n\nexport default function A() {}\n\nexport default function B() {}\n" },
  // The parser reads a NUL as U+FFFD, which the projection cannot map back.
  { name: "unmappable character and duplicate layout", format: "mdx", text: `${duplicateLayout}${unmappable}` },
];

/** The environment the chat card and every edit attempt pass: ready, with the built-in components. */
const ready = (text: string): ComponentEnvironment => ({ source: text, catalog: COMPONENT_CATALOG, modules: [], key: "", code: [] });

test("every note projects the same from one compile as from two", async () => {
  // The comparison means something only if the second way really compiles twice.
  const [once, twice] = await bothWays(() => parsed(() => projectFluidSource(prose, "md")));
  expect(once).toEqual([prose]);
  expect(twice).toEqual([prose, prose]);
  for (const note of NOTES) {
    const environments: Array<ComponentEnvironment | undefined> = [undefined, ready(note.text)];
    if (note.format === "mdx") {
      const prepared = await outcome(() => prepareComponentEnvironment(note.text, note.load));
      if ("value" in prepared) environments.push(prepared.value);
    }
    for (const environment of environments) {
      const [once, twice] = await bothWays(async () => {
        const result = await outcome(() => projectFluidSource(note.text, note.format, environment));
        return "value" in result ? { value: shape(result.value) } : result;
      });
      expect(once, `${note.format} ${note.name}`).toEqual(twice);
    }
  }
}, 60_000);

test("edits write the same source from one compile as from two", async () => {
  const notes = NOTES.filter((note) =>
    ["prose", "lists", "tables", "images", "components", "documents", "comments", "guarded", "figure", "crlf"].includes(note.name),
  );
  for (const note of notes) {
    const environment = note.format === "mdx" ? await prepareComponentEnvironment(note.text) : undefined;
    const [projection, reference] = await bothWays(() => projectFluidSource(note.text, note.format, environment));
    const snapshot = { text: note.text, revision: 1, format: note.format };
    const doc = projection.doc;
    const edits: unknown[][] = [];
    const command = (run: Command, from: number, to = from) => {
      let steps: unknown[] | undefined;
      run(EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }), (tr) => (steps = tr.steps.map((step) => step.toJSON())));
      if (steps) edits.push(steps);
    };
    doc.descendants((node, pos) => {
      if (!node.isTextblock || node.content.size < 4) return;
      const start = pos + 1, end = pos + 1 + node.content.size;
      for (const at of [start, start + 2, end]) {
        for (const typed of ["x", " ", "*"]) edits.push([new ReplaceStep(at, at, new Slice(Fragment.from(fluidSchema.text(typed)), 0, 0)).toJSON()]);
        command(splitBlock, at);
        command(splitListItem(fluidSchema.nodes.list_item), at);
      }
      edits.push([new ReplaceStep(start + 1, start + 2, Slice.empty).toJSON()]);
      command(toggleMark(fluidSchema.marks.strong), start, start + 3);
    });
    for (const steps of edits) {
      const [once, twice] = await bothWays(async () => {
        const result = await outcome(() =>
          prepareFluidTransaction(snapshot, separately ? reference : projection, steps),
        );
        if (!("value" in result)) return result;
        const { patches, text, projection: next, nearest } = result.value;
        return { patches, text, projection: shape(next), nearest: nearest && [0, 1, 2, 3, 5, 8, 13].map(nearest) };
      });
      expect(once, `${note.format} ${note.name} ${JSON.stringify(steps)}`).toEqual(twice);
    }
  }
}, 120_000);

test("the compiler's errors read as the instrumentation's, with their place, and the projection's own keep theirs", async () => {
  const refused = async (text: string) => {
    const result = await outcome(() => projectFluidSource(text, "mdx", ready(text)));
    return "error" in result ? result.error : null;
  };
  for (const [text, place] of [
    ["<Counter initial={} />\n", { line: 1, column: 19 }],
    ["Before\n\n<Callout>\nunclosed\n", { line: 3, column: 1 }],
    ["# Fine\n\nexport const = 1\n", { line: 3, column: 14 }],
    ["Text <https://example.com> here.\n", { line: 1, column: 13 }],
  ] as const) {
    const message = await refused(text);
    // The same message Source shows from its own check (diagnoseSource).
    expect(message).toBe(await instrumentation.instrumentMdxSource(text).then(() => null, (error: Error) => error.message));
    expect(message).toStartWith("Invalid MDX: ");
    expect(parseErrorPosition(message!)).toEqual(place);
  }
  // A later stage of the compiler still names the note invalid.
  expect(await refused(duplicateLayout)).toStartWith("Invalid MDX: Unexpected duplicate layout");
  // The preview's own import check and the projection's own mapping keep
  // their messages. If the projection learns to map this line, choose
  // another it cannot, or the note below stops testing its error.
  expect(await refused("import x from 'y'\n\nText.\n")).toBe("Only named workspace: MDX component imports are supported");
  expect(await refused(unmappable)).toBe("Cannot map decoded source text exactly");
  // With both, the compiler's error comes first, as it did when the
  // instrumentation compiled the note by itself.
  expect(await refused(`import x from 'y'\n\n${duplicateLayout}`)).toStartWith("Invalid MDX: Unexpected duplicate layout");
  expect(await refused(`${duplicateLayout}${unmappable}`)).toStartWith("Invalid MDX: Unexpected duplicate layout");
});

test("a keystroke parses the note once", async () => {
  for (const format of ["md", "mdx"] as const) {
    const text = generated(4, format === "mdx");
    const environment = format === "mdx" ? await prepareComponentEnvironment(text) : undefined;
    const projection = await projectFluidSource(text, format, environment);
    expect(await parsed(() => projectFluidSource(text, format, environment))).toEqual([text]);
    const at = (offset: number) => fluidPositionForSourceOffset(projection, offset)!;
    const word = text.indexOf("plain words");
    const item = text.indexOf("- item 7\n") + "- item 7".length;
    const edits: Array<[string, () => unknown[]]> = [
      ["type a letter", () => [new ReplaceStep(at(word + 2), at(word + 2), new Slice(Fragment.from(fluidSchema.text("x")), 0, 0)).toJSON()]],
      ["Backspace", () => [new ReplaceStep(at(word + 1), at(word + 2), Slice.empty).toJSON()]],
      ["Enter", () => steps(projection, splitBlock, at(word + 2))],
      ["bold a word", () => steps(projection, toggleMark(fluidSchema.marks.strong), at(word), at(word + 5))],
      ["Enter in a list item", () => steps(projection, splitListItem(fluidSchema.nodes.list_item), at(item))],
    ];
    for (const [label, edit] of edits) {
      let written = "";
      const texts = await parsed(async () => {
        const result = await prepareFluidTransaction({ text, revision: 1, format }, projection, edit());
        written = result.text;
      });
      expect(texts, `${format} ${label}`).toEqual([written]);
    }
  }
});

test("attempts that write the same source parse it once", async () => {
  const text = "First words here.\n\nSecond paragraph.\n";
  for (const format of ["md", "mdx"] as const) {
    const projection = await projectFluidSource(text, format);
    const snapshot = { text, revision: 1, format };
    // Enter right before a space: the new paragraph cannot start with it, so
    // the split and the rewrite of the paragraph both write this.
    let enter: Awaited<ReturnType<typeof prepareFluidTransaction>> | undefined;
    const split = await parsed(async () => {
      enter = await prepareFluidTransaction(snapshot, projection, steps(projection, splitBlock, 6));
    });
    expect(enter!.text).toBe("First\n\nwords here.\n\nSecond paragraph.\n");
    expect(split).toEqual([enter!.text]);
    expect(enter!.nearest?.(7)).toBe(7);
    // A space at the start of a paragraph: Markdown cannot hold it, so nothing is written.
    let space: Awaited<ReturnType<typeof prepareFluidTransaction>> | undefined;
    const typed = await parsed(async () => {
      space = await prepareFluidTransaction(snapshot, projection, [
        new ReplaceStep(1, 1, new Slice(Fragment.from(fluidSchema.text(" ")), 0, 0)).toJSON(),
      ]);
    });
    expect(space!.patches).toEqual([]);
    expect(typed).toEqual([" " + text, text]);
  }
});

test("a transaction holds one step's projections at a time", async () => {
  // Select all and bold: a step for each paragraph, and each step projects the whole note.
  const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} with plain words.`).join("\n\n") + "\n";
  const projection = await projectFluidSource(text, "mdx", ready(text));
  const bold = steps(projection, toggleMark(fluidSchema.marks.strong), 1, projection.doc.content.size - 1);
  expect(bold).toHaveLength(40);
  // Each compile's instrumentation, which its projection holds.
  const compiled: Array<WeakRef<object>> = [];
  const alive: number[] = [];
  compiler.mockImplementation(async (...args) => {
    if (compiled.length && compiled.length % 10 === 0) {
      // A WeakRef keeps its object until the current job ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
      Bun.gc(true);
      alive.push(compiled.filter((ref) => ref.deref()).length);
    }
    const result = await dispatch(...args);
    compiled.push(new WeakRef(result.instrumentation));
    return result;
  });
  try {
    const result = await prepareFluidTransaction({ text, revision: 1, format: "mdx" }, projection, bold);
    expect(result.text).toBe(text.replace(/^Paragraph .*$/gm, "**$&**"));
  } finally {
    compiler.mockImplementation(dispatch);
  }
  expect(compiled).toHaveLength(40);
  // Of the earlier steps' projections, only the one the next step builds on
  // is left, give or take what the collector's stack scan keeps.
  expect(alive).toHaveLength(3);
  expect(Math.min(...alive)).toBeGreaterThanOrEqual(1);
  expect(Math.max(...alive)).toBeLessThanOrEqual(3);
});

function steps(projection: FluidProjection, command: Command, from: number, to = from): unknown[] {
  let made: unknown[] | undefined;
  const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, from, to) });
  expect(command(state, (tr) => (made = tr.steps.map((step) => step.toJSON())))).toBe(true);
  return made!;
}
