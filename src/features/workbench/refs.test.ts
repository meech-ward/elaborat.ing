import { describe, expect, it } from "bun:test"
import { parseSourceRefs } from "./refs"

describe("parseSourceRefs", () => {
  it("reads moved canonical percent/space/Unicode/fragment identities and bounded long embeds", () => {
    const path = " Moved % #? café/a.excalidraw";
    expect(parseSourceRefs(`<Drawing src="${path}" />`)).toEqual([
      { kind: "drawing", path, label: "Drawing" },
    ]);
    const long = `${"x".repeat(180)}/${"y".repeat(180)}.excalidraw`;
    expect(parseSourceRefs(`<Drawing src="${long}" />`)[0]?.path).toBe(long);
    expect(parseSourceRefs("[x](Moved%20%25%20%23%3F%20caf%C3%A9/a.excalidraw?view=1#part)")[0]?.path)
      .toBe("Moved % #? café/a.excalidraw");
    expect(parseSourceRefs('<Drawing src="old/a%23b.excalidraw" />')[0]?.path).toBe("old/a%23b.excalidraw");
    expect(parseSourceRefs('[x](old/a%2520b.md)')[0]?.path).toBe("old/a%20b.md");
  });

  it("resolves emitted JSX resource escapes once to the exact workspace path", () => {
    expect(parseSourceRefs('<Drawing src="drawings/a&amp;&quot;$1.excalidraw" />')).toEqual([
      { kind: "drawing", path: 'drawings/a&"$1.excalidraw', label: "Drawing" },
    ]);
    expect(parseSourceRefs("<Diagram src='diagrams/it&#39;s&amp;amp;.d2' />")).toEqual([
      { kind: "diagram", path: "diagrams/it's&amp;.d2", label: "Diagram" },
    ]);
    expect(parseSourceRefs('<Drawing src="drawings/a&lt;b&gt;.excalidraw" />')[0]?.path).toBe('drawings/a<b>.excalidraw');
    expect(parseSourceRefs('<Drawing src="drawings/a&#10;.excalidraw" />')[0]?.path).toBe('drawings/a\n.excalidraw');
  });
  it("finds markdown links to workspace files", () => {
    const refs = parseSourceRefs("See [the drawing](drawings/sketch.excalidraw) and [flow](diagrams/flow.d2).\n")
    expect(refs).toEqual([
      { kind: "link", path: "drawings/sketch.excalidraw", label: "the drawing" },
      { kind: "link", path: "diagrams/flow.d2", label: "flow" },
    ])
  })

  it("finds Drawing and Diagram tags with single or double quotes", () => {
    const refs = parseSourceRefs('<Drawing src="drawings/a.excalidraw" />\n<Diagram src=\'diagrams/b.d2\' />\n')
    expect(refs).toEqual([
      { kind: "drawing", path: "drawings/a.excalidraw", label: "Drawing" },
      { kind: "diagram", path: "diagrams/b.d2", label: "Diagram" },
    ])
  })

  it("ignores external, absolute, relative and disallowed targets", () => {
    const source = [
      "[web](https://example.com/a.md)",
      "[mail](mailto:someone@example.com)",
      "[abs](/etc/passwd)",
      "[rel](../secret.md)",
      "[dot](./notes/a.md)",
      "[exe](notes/run.html)",
      "[frag](#section)",
      "<Drawing src=\"https://evil.example/d.excalidraw\" />",
      "<Drawing src=\"../../../escape.excalidraw\" />",
    ].join("\n")
    expect(parseSourceRefs(source)).toEqual([])
  })

  it("dedupes repeated references", () => {
    const refs = parseSourceRefs("[a](notes/x.md) and [b](notes/x.md)\n")
    expect(refs).toEqual([{ kind: "link", path: "notes/x.md", label: "a" }])
  })

  it("ignores image syntax and code spans are left to the author", () => {
    // `![alt](img.png)`: .png is not a workspace suffix, so no ref.
    expect(parseSourceRefs("![logo](assets/logo.png)\n")).toEqual([])
    expect(parseSourceRefs("[](notes/empty-label.md)\n")).toEqual([])
  })
})
