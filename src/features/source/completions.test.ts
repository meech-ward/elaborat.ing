import { describe, expect, it } from "bun:test";
import { completeSource } from "./completions";

const suggest = (
  marked: string,
  language = "mdx",
  workspacePaths: readonly string[] = [],
) => {
  const offset = marked.indexOf("¦");
  return completeSource({
    text: marked.replace("¦", ""),
    offset,
    language,
    workspacePaths,
  });
};
const labels = (marked: string, language = "mdx", paths?: readonly string[]) =>
  suggest(marked, language, paths).map((item) => item.label);

describe("source completion context", () => {
  it("offers only the current component props and enum values", () => {
    expect(labels("<Counter ¦/>")).toEqual(["initial", "step"]);
    expect(labels('<Callout tone="¦" />')).toEqual(["info", "warn", "error"]);
    expect(labels("<Button ¦></Button>")).toEqual(["variant", "size"]);
    expect(labels('<Button variant="¦"></Button>')).toEqual([
      "default",
      "secondary",
      "outline",
      "ghost",
      "link",
    ]);
    expect(labels("<Counter initial={3} ¦/>")).toEqual(["step"]);
  });
  it("replaces only the accepted token and leaves neighboring source intact", () => {
    const marked = '<Callout tone="wa¦rn" title="Keep this">Body</Callout>';
    const original = marked.replace("¦", "");
    const item = suggest(marked).find((item) => item.label === "warn")!;
    expect(
      original.slice(0, item.from) + item.insertText + original.slice(item.to),
    ).toBe(original);
    const prop = suggest("<Counter st¦/>").find(
      (item) => item.label === "step",
    )!;
    expect(prop.insertText).toContain("step={${1:");
  });
  it("offers catalog snippets only in MDX insertion contexts", () => {
    expect(labels("<Cou¦")).toEqual(["Counter"]);
    expect(suggest("<Cou¦")[0].insertText).toStartWith("<Counter");
    expect(labels("<But¦")).toEqual(["Button"]);
    expect(suggest("<But¦")[0].insertText).toStartWith("<Button");
    expect(labels("<Col¦")).toEqual(["Columns"]);
    expect(suggest("<Col¦")[0].insertText).toStartWith("<Columns");
    expect(labels("Ordinary prose ¦")).toEqual([]);
    for (const marked of [
      "```mdx\n<Co¦\n```",
      "~~~\n<Co¦\n~~~",
      "{/* <Counter ¦ */}",
      "<!-- <Counter ¦ -->",
      "`<Counter ¦`",
    ])
      expect(labels(marked)).toEqual([]);
    expect(labels("<Counter ¦", "markdown")).toEqual([]);
    expect(labels("<Counter ¦", "json")).toEqual([]);
    expect(labels("{/* <Counter */}\n¦")).toContain("Drawing");
    expect(labels("<Counter initial={1 + ¦2} />")).toEqual([]);
  });
  it("filters workspace choices by resource type and safely inserts literal paths", () => {
    const paths = [
      "drawings/a.excalidraw",
      "drawings/b.excalidraw.md",
      "diagrams/a.d2",
      "notes/a.mdx",
      "drawings/a.excalidraw",
    ];
    expect(labels('<Drawing src="¦" />', "mdx", paths)).toEqual(
      paths.slice(0, 2),
    );
    expect(labels('<Diagram src="¦" />', "mdx", paths)).toEqual([
      "diagrams/a.d2",
    ]);
    const special = suggest('<Drawing src="¦" />', "mdx", [
      'drawings/a&"$1.excalidraw',
    ])[0];
    expect(special.insertText).toBe("drawings/a&amp;&quot;$1.excalidraw");
    expect(special.snippet).toBe(false);
    expect(labels('<Counter src="¦" />', "mdx", paths)).toEqual([]);
  });
  it("offers D2 keys and values in property contexts, not comments or labels", () => {
    expect(labels("node: {\n  sha¦\n}", "d2")).toEqual(["shape"]);
    expect(labels("node.shape: ¦", "d2")).toContain("sql_table");
    expect(labels("direction: ¦", "d2")).toEqual([
      "right",
      "down",
      "left",
      "up",
    ]);
    expect(labels("node: { style: { fi¦ } }", "d2")).toEqual(["fill"]);
    expect(labels("node.style.fill: ¦", "d2")).toContain("transparent");
    expect(labels("# shape: ¦", "d2")).toEqual([]);
    expect(labels('node: "shape: ¦"', "d2")).toEqual([]);
    expect(labels("node: label¦", "d2")).toEqual([]);
    expect(labels("constructor: ¦", "d2")).toEqual([]);
    expect(labels("toString: ¦", "d2")).toEqual([]);
  });
  it("suggests existing node keys relative to the current nested map", () => {
    const marked =
      "outside: Outside\nzone: {\n api: API\n db: Database\n api -> ¦\n}\n# fake: Not a node\nother: { child: Child }";
    const names = labels(marked, "d2");
    expect(names).toContain("db");
    expect(names).toContain("_.outside");
    expect(names).toContain("_.other.child");
    expect(names).not.toContain("fake");
    expect(names).not.toContain("Database");
    expect(labels("a: { style: { fill: blue } }\nb: B\na -> ¦", "d2")).toEqual([
      "a",
      "b",
    ]);
  });
  it("offers the three starter snippets only at root key positions", () => {
    const snippets = suggest("¦", "d2").filter(
      (item) => item.kind === "template",
    );
    expect(snippets.map((item) => item.label)).toEqual([
      "Flow diagram",
      "ERD diagram",
      "Cloud architecture",
    ]);
    for (const item of snippets) {
      expect(item.snippet).toBe(true);
      expect(item.insertText).toContain("${1:");
    }
    expect(
      suggest("node: {\n¦\n}", "d2").some((item) => item.kind === "template"),
    ).toBe(false);
  });
});
