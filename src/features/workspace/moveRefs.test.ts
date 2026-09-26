import { expect, test } from "bun:test";
import { planMoveReferences, referencesWorkspaceModule } from "./moveRefs";

test("rename import guard compares parsed literal values, including escaped prefixes", () => {
  const escaped = String.raw`import { X } from 'work\u0073pace:components/card.mdx';`;
  expect(referencesWorkspaceModule(escaped, "components/card.mdx")).toBe(true);
  expect(referencesWorkspaceModule(`\`\`\`mdx\n${escaped}\n\`\`\`\n\nUse workspace:components/card.mdx in prose.`, "components/card.mdx")).toBe(false);
  expect(referencesWorkspaceModule("import { X } from 'https://example.test/card.mdx';", "components/card.mdx")).toBe(false);
});

test("rename import guard refuses unparseable MDX instead of guessing from raw text", () => {
  const escaped = String.raw`import { X } from 'workspace:components/c\u0061rd.mdx';`;
  expect(() => referencesWorkspaceModule(`${escaped}\n\n<Broken`, "components/card.mdx")).toThrow("Cannot certify workspace imports");
  expect(() => referencesWorkspaceModule("<Broken", "components/card.mdx")).toThrow("Cannot certify workspace imports");
});

test("moves active references while preserving identical code, comments and frontmatter", () => {
  const source = [
    "---", 'example: <Drawing src="old/a.excalidraw" />', "---", "",
    '`<Drawing src="old/a.excalidraw" />`', "", "```mdx",
    '<Drawing src="old/a.excalidraw" />', "```", "",
    '{/* <Drawing src="old/a.excalidraw" /> */}', "",
    '<Drawing src="old/a.excalidraw" />', "",
    '[drawing](old/a.excalidraw "keep title")', "",
  ].join("\r\n");
  const result = planMoveReferences([{ path: "notes/ref.mdx", content: source }], [
    { from: "old/a.excalidraw", to: "new/a.excalidraw" },
  ]);
  expect(result.blockers).toEqual([]);
  expect(result.updates).toEqual([{
    path: "notes/ref.mdx",
    content: source.replace('<Drawing src="old/a.excalidraw" />\r\n\r\n[drawing]', '<Drawing src="new/a.excalidraw" />\r\n\r\n[drawing]')
      .replace('(old/a.excalidraw "keep title")', '(new/a.excalidraw "keep title")'),
    references: [
      { from: "old/a.excalidraw", to: "new/a.excalidraw", line: 13 },
      { from: "old/a.excalidraw", to: "new/a.excalidraw", line: 15 },
    ],
  }]);
});

const one = (content: string, path = "notes/ref.mdx", from = "old/a.excalidraw", to = "new/a.excalidraw") =>
  planMoveReferences([{ path, content }], [{ from, to }]);

test("patches repeated self links and definitions, preserving titles and URL suffixes", () => {
  const source = '[self](old/a.md?x=1#two) [again][self]\n\n[self]: <old/a.md> \'title\'\n';
  const result = one(source, "old/a.md", "old/a.md", "new/a.md");
  expect(result.blockers).toEqual([]);
  expect(result.updates[0]?.content).toBe(source.replaceAll("old/a.md", "new/a.md"));
  expect(result.updates[0]?.references).toHaveLength(2);
});

test("preserves literal-percent, entity, Unicode and JSX fragment-character identities", () => {
  const source = "😀\n\n<Drawing src='old/a&amp;&#39;#?% 華.excalidraw' />\n";
  const result = one(source, "note.mdx", "old/a&'#?% 華.excalidraw", "100% done/a&'#?% 華.excalidraw");
  expect(result.blockers).toEqual([]);
  expect(result.updates[0]?.content).toBe(source.replace("old/", "100% done/"));
  const link = one("[x](old/a%23b.md?q=1#part)", "note.md", "old/a#b.md", "100% done/a#b.md");
  expect(link.blockers).toEqual([]);
  expect(link.updates[0]?.content).toBe("[x](100%25%20done/a%23b.md?q=1#part)");
});

test("refuses ambiguous percent targets without rejecting unrelated percent names", () => {
  const result = planMoveReferences([
    { path: "note.md", content: "[x](old/a%20b.md)" },
    { path: "old/a%20b.md", content: "literal" },
    { path: "old/a b.md", content: "decoded" },
  ], [{ from: "old/a b.md", to: "new/a b.md" }]);
  expect(result.blockers.some((entry) => entry.reason.includes("Ambiguous"))).toBe(true);
  expect(result.updates).toEqual([]);
});

test("retains escaped and entity-encoded suffixes and safely emits destination delimiters", () => {
  for (const suffix of ["\\?query=1#part", "&#63;query=1&#35;part"]) {
    const result = one(`[x](old/a.md${suffix})`, "note.md", "old/a.md", "new (copy)/a.md");
    expect(result.blockers).toEqual([]);
    expect(result.updates[0]?.content).toBe(`[x](new%20%28copy%29/a.md${suffix})`);
  }
  expect(one("[x](old/a%2520b.md)", "note.md", "old/a%20b.md", "100%/a%20b.md").updates[0]?.content)
    .toBe("[x](100%25/a%2520b.md)");
});

test("does not rewrite Markdown raw tags, escaped examples, external URLs or fragments", () => {
  const source = '<Drawing src="old/a.excalidraw" />\n\n\\[example](old/a.excalidraw)\n\n[external](https://x.test/old/a.excalidraw) [fragment](#old/a.excalidraw)';
  expect(one(source, "note.md")).toEqual({ updates: [], blockers: [] });
});

test("refuses relevant unsupported resource tags while permitting known unrelated literals", () => {
  for (const source of [
    '<Drawing src="old/a.excalidraw" extra="yes" />',
    '<Drawing src="old/a.excalidraw"></Drawing>',
    '<Drawing src={chosen} />', '<Drawing {...props} />',
    '<Drawing src={"old/a.excalidraw"} />',
    '{true && <Drawing src="old/a.excalidraw" />}',
    'export const Widget = () => <Drawing src="old/a.excalidraw" />',
  ]) {
    const result = one(source);
    expect(result.blockers.length, source).toBeGreaterThan(0);
    expect(result.updates, source).toEqual([]);
  }
  for (const source of ['<Drawing src={"other.excalidraw"} />', '<Drawing src="other.excalidraw" extra="yes" />', '<Diagram src={chosen} />']) {
    expect(one(source).blockers, source).toEqual([]);
  }
});

test("refuses relevant images, HTML and JSX links and moved-note relative destinations", () => {
  for (const source of ['![x](old/a.excalidraw)', '![x][resource]\n\n[resource]: old/a.excalidraw', '<a href="old/a.excalidraw">x</a>', '<img src="old/a.excalidraw" />']) {
    expect(one(source).blockers.length, source).toBeGreaterThan(0);
    expect(one(source, "note.md").blockers.length, source).toBeGreaterThan(0);
  }
  for (const source of ['[x](../photo.png)', '![x](./photo.png)', '<img src="../photo.png" />']) {
    expect(one(source, "note.md", "note.md", "new/note.md").blockers.length, source).toBeGreaterThan(0);
  }
  const outside = one('[x](https://x.test/a) [y](#part)', "note.md", "note.md", "new/note.md");
  expect(outside).toEqual({ updates: [], blockers: [] });
});

test("refuses malformed notes and non-roundtrippable text", () => {
  expect(one('<Drawing src="unterminated').blockers[0]?.reason).toContain("parse");
  expect(one("bad\ud800").blockers[0]?.reason).toContain("UTF");
});

test("keeps native payloads exact and refuses relevant native hyperlinks", () => {
  const scene = (link: string) => JSON.stringify({ elements: [{ id: "e", type: "rectangle", x: 0, y: 0, link, customData: { note: "old/a.excalidraw" } }], files: { picture: { dataURL: "data:image/png;base64,AA==" } }, custom: "keep" }, null, 3);
  const safe = scene("https://x.test/");
  expect(one(safe, "drawing.excalidraw")).toEqual({ updates: [], blockers: [] });
  expect(one(scene("old/a.excalidraw"), "drawing.excalidraw").blockers[0]?.reason).toContain("hyperlink");
  expect(one(scene("../other.md"), "drawing.excalidraw", "drawing.excalidraw", "new/drawing.excalidraw").blockers[0]?.reason).toContain("relative");
});

test("preserves D2 virtual imports and source, refuses detected local resource destinations", () => {
  const safe = '# a.link: old/a.excalidraw\n...@library\na: {link: https://x.test}\nb: "old/a.excalidraw"\n';
  expect(one(safe, "diagram.d2")).toEqual({ updates: [], blockers: [] });
  expect(one('a: { link: "old/a.excalidraw" }', "diagram.d2").blockers[0]?.reason).toContain("D2");
  expect(one('a.icon: ../image.png', "diagram.d2", "diagram.d2", "new/diagram.d2").blockers[0]?.reason).toContain("D2");
});

test("rewrites workspace module imports when the module moves, preserving aliases and chains", () => {
  const note = [
    "import { StatusCard, Badge as MyBadge } from 'workspace:components/cards.mdx';",
    "import { Helper } from 'workspace:components/other.mdx';",
    "",
    "# Note",
    "",
    "Body text.",
    "",
  ].join("\n");
  const wrapper = "import { Card } from 'workspace:components/cards.mdx';\n\nexport const Wrapper = () => null;\n";
  const result = planMoveReferences([
    { path: "notes/use.mdx", content: note },
    { path: "components/wrapper.mdx", content: wrapper },
    { path: "components/cards.mdx", content: "export const StatusCard = () => null;\n" },
  ], [{ from: "components/cards.mdx", to: "shared/cards.mdx" }]);
  expect(result.blockers).toEqual([]);
  expect(result.updates).toHaveLength(2);
  const use = result.updates.find((u) => u.path === "notes/use.mdx");
  expect(use?.content).toBe(note.replace("workspace:components/cards.mdx", "workspace:shared/cards.mdx"));
  expect(use?.content).toContain("Badge as MyBadge");
  expect(use?.content).toContain("workspace:components/other.mdx");
  expect(use?.references).toEqual([{ from: "components/cards.mdx", to: "shared/cards.mdx", line: 1 }]);
  const wrap = result.updates.find((u) => u.path === "components/wrapper.mdx");
  expect(wrap?.content).toContain("workspace:shared/cards.mdx");
});

test("leaves fenced, prose and external imports untouched", () => {
  const source = [
    "```mdx",
    "import { X } from 'workspace:components/cards.mdx';",
    "```",
    "",
    "Use import { X } from 'workspace:components/cards.mdx' in prose.",
    "",
    "import { X } from 'react';",
    "import { Y } from './local.js';",
    "import { Z } from 'workspace:components/other.mdx';",
    "",
  ].join("\n");
  const result = one(source, "notes/ref.mdx", "components/cards.mdx", "shared/cards.mdx");
  expect(result.blockers).toEqual([]);
  expect(result.updates).toEqual([]);
});

test("rewrites quoted, escaped, percent and multiline workspace imports", () => {
  const dq = 'import { A } from "workspace:old/a.mdx";\n';
  expect(one(dq, "notes/n.mdx", "old/a.mdx", "new/a.mdx").updates[0]?.content)
    .toBe('import { A } from "workspace:new/a.mdx";\n');
  const ml = "import {\n  StatusCard,\n  Badge as MyBadge,\n} from 'workspace:components/cards.mdx';\n";
  const mlResult = one(ml, "notes/n.mdx", "components/cards.mdx", "shared/cards.mdx");
  expect(mlResult.blockers).toEqual([]);
  expect(mlResult.updates[0]?.content).toBe(ml.replace("workspace:components/cards.mdx", "workspace:shared/cards.mdx"));
  const pct = "import { A } from 'workspace:100% ready/a%20b.mdx';\n";
  const pctResult = one(pct, "notes/n.mdx", "100% ready/a%20b.mdx", "done/a%20b.mdx");
  expect(pctResult.blockers).toEqual([]);
  expect(pctResult.updates[0]?.content).toBe("import { A } from 'workspace:done/a%20b.mdx';\n");
  const esc = "import { A } from 'workspace:old/a\\'b.mdx';\n";
  const escResult = one(esc, "notes/n.mdx", "old/a'b.mdx", "new/a'b.mdx");
  expect(escResult.blockers).toEqual([]);
  expect(escResult.updates[0]?.content).toBe("import { A } from 'workspace:new/a\\'b.mdx';\n");
  const desc = 'import { A } from "workspace:old/a\\"b.mdx";\n';
  const descResult = one(desc, "notes/n.mdx", 'old/a"b.mdx', 'new/a"b.mdx');
  expect(descResult.blockers).toEqual([]);
  expect(descResult.updates[0]?.content).toBe('import { A } from "workspace:new/a\\"b.mdx";\n');
});

test("keeps root-based imports identical when only the importing note moves", () => {
  const source = "import { StatusCard } from 'workspace:components/cards.mdx';\n\n# Note\n";
  expect(one(source, "notes/note.mdx", "notes/note.mdx", "archive/note.mdx")).toEqual({ updates: [], blockers: [] });
});

test("refuses unsupported workspace import forms referencing a moved module", () => {
  for (const source of [
    "import Def from 'workspace:components/cards.mdx';\n",
    "import * as NS from 'workspace:components/cards.mdx';\n",
    "import 'workspace:components/cards.mdx';\n",
    "export { X } from 'workspace:components/cards.mdx';\n",
    "export * from 'workspace:components/cards.mdx';\n",
    "export const f = () => import('workspace:components/cards.mdx');\n",
  ]) {
    const result = one(source, "notes/n.mdx", "components/cards.mdx", "shared/cards.mdx");
    expect(result.blockers.length, source).toBeGreaterThan(0);
    expect(result.updates, source).toEqual([]);
  }
  for (const source of [
    "import Def from 'workspace:components/other.mdx';\n",
    "import * as NS from 'workspace:components/other.mdx';\n",
  ]) {
    expect(one(source, "notes/n.mdx", "components/cards.mdx", "shared/cards.mdx").blockers, source).toEqual([]);
  }
  expect(one("import { X from 'workspace:components/cards.mdx';\n", "notes/n.mdx", "components/cards.mdx", "shared/cards.mdx").blockers[0]?.reason).toContain("parse");
});
