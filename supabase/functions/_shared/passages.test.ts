import { expect } from "jsr:@std/expect@1.0.17"
import { describe, it as test } from "jsr:@std/testing@1.0.16/bdd"
import { extractPassages, type Passage } from "./passages.ts"

/** The span of the first occurrence of `text` in `source`, running to `until` if given. */
function span(source: string, text: string, until = text): { start: number; end: number } {
  const start = source.indexOf(text)
  const endAt = source.indexOf(until, start)
  if (start === -1 || endAt === -1) throw new Error(`not in source: ${text} ... ${until}`)
  return { start, end: endAt + until.length }
}

/** Every word (run of letters and digits) of each passage appears in the source span it names. */
function expectSpansCoverText(source: string, passages: Passage[]): void {
  for (const passage of passages) {
    expect(passage.start).toBeGreaterThanOrEqual(0)
    expect(passage.end).toBeLessThanOrEqual(source.length)
    expect(passage.start).toBeLessThan(passage.end)
    const origin = source.slice(passage.start, passage.end)
    for (const word of passage.text.match(/[\p{L}\p{N}]+/gu) ?? []) expect(origin).toContain(word)
  }
}

describe("notes", () => {
  test("a note with no headings is one passage with no headings", () => {
    const source = "First paragraph.\n\nSecond *paragraph* with a [link](https://example.com).\n"
    expect(extractPassages("notes/plain.md", source)).toEqual([
      {
        headings: [],
        text: "First paragraph.\nSecond paragraph with a link.",
        ...span(source, "First", "(https://example.com)."),
      },
    ])
  })

  test("nested headings give each section its outermost-first headings", () => {
    const source = [
      "Intro text.",
      "# Guide",
      "Guide text.",
      "## Install",
      "Install text.",
      "### Linux",
      "Linux text.",
      "## Use",
      "Use text.",
      "# Empty",
      "## Only child",
      "Child text.",
    ].join("\n\n")
    expect(extractPassages("guide.md", source)).toEqual([
      { headings: [], text: "Intro text.", ...span(source, "Intro text.") },
      { headings: ["Guide"], text: "Guide text.", ...span(source, "Guide text.") },
      { headings: ["Guide", "Install"], text: "Install text.", ...span(source, "Install text.") },
      {
        headings: ["Guide", "Install", "Linux"],
        text: "Linux text.",
        ...span(source, "Linux text."),
      },
      { headings: ["Guide", "Use"], text: "Use text.", ...span(source, "Use text.") },
      { headings: ["Empty", "Only child"], text: "Child text.", ...span(source, "Child text.") },
    ])
  })

  test("frontmatter is dropped", () => {
    const yaml = "---\ntitle: Secret title\ntags: [a, b]\n---\n\nBody text.\n"
    expect(extractPassages("a.md", yaml)).toEqual([
      { headings: [], text: "Body text.", ...span(yaml, "Body text.") },
    ])
    const toml = '+++\ntitle = "Secret title"\n+++\n\nBody text.\n'
    expect(extractPassages("a.mdx", toml)).toEqual([
      { headings: [], text: "Body text.", ...span(toml, "Body text.") },
    ])
  })

  test("MDX keeps the text inside JSX and drops imports, exports and expressions", () => {
    const source = [
      'import { Chart } from "./chart"',
      'export const meta = { title: "Hidden" }',
      "# Report {meta.title}",
      'Revenue grew {2 + 2} percent <Badge color="green">this quarter</Badge>.',
      '<Callout type="warning">\n  Check the **numbers** twice.\n</Callout>',
      "{hiddenExpression}",
      "<Chart data={[1, 2, 3]} />",
      "## {section.title}",
      "Section text.",
    ].join("\n\n")
    expect(extractPassages("report.mdx", source)).toEqual([
      {
        headings: ["Report"],
        text: "Revenue grew percent this quarter.\nCheck the numbers twice.",
        ...span(source, "Revenue", "twice."),
      },
      // A heading that is only an expression has no text to list.
      { headings: ["Report"], text: "Section text.", ...span(source, "Section text.") },
    ])
  })

  test("Markdown files are not read as MDX", () => {
    const source = "Braces {stay} and <b>tags</b> go.\n"
    expect(extractPassages("a.md", source)).toEqual([
      { headings: [], text: "Braces {stay} and tags go.", ...span(source, "Braces", "go.") },
    ])
  })

  test("code blocks and inline code are kept", () => {
    const source = "# Setup\n\nRun `bun install` first:\n\n```sh\nbun install --frozen-lockfile\nbun run dev\n```\n"
    expect(extractPassages("setup.md", source)).toEqual([
      {
        headings: ["Setup"],
        text: "Run bun install first:\nbun install --frozen-lockfile\nbun run dev",
        ...span(source, "Run", "bun run dev\n```"),
      },
    ])
  })

  test("table cells are kept, one row per line", () => {
    const source = "| Name | Role |\n| --- | --- |\n| Ada | `admin` |\n| Grace | *viewer* |\n"
    expect(extractPassages("people.md", source)).toEqual([
      {
        headings: [],
        text: "Name | Role\nAda | admin\nGrace | viewer",
        ...span(source, "| Name", "| *viewer* |"),
      },
    ])
  })

  test("lists, block quotes, footnotes and image descriptions are kept", () => {
    const source = "- one\n- two\n  - nested\n\n> quoted\n\nSee ![a chart](c.png)[^1].\n\n[^1]: The note.\n"
    const [passage] = extractPassages("misc.md", source)
    expect(passage.text).toBe("one\ntwo\nnested\nquoted\nSee a chart.\nThe note.")
    expectSpansCoverText(source, [passage])
  })
})

describe("long sections", () => {
  test("a section over 1,500 characters splits between blocks", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(40).trim()}.`)
    const source = `# Long\n\n${paragraphs.join("\n\n")}\n`
    const passages = extractPassages("long.md", source)

    // Paragraphs of 212 or 213 characters: seven and their newlines make 1,490.
    expect(passages.map((passage) => passage.text)).toEqual([
      paragraphs.slice(0, 7).join("\n"),
      paragraphs.slice(7).join("\n"),
    ])
    expect(passages.map((passage) => passage.headings)).toEqual([["Long"], ["Long"]])
    expect(passages[0]).toMatchObject(span(source, paragraphs[0], paragraphs[6]))
    expect(passages[1]).toMatchObject(span(source, paragraphs[7], paragraphs[11]))
  })

  test("a single block over 1,500 characters splits at whitespace", () => {
    const words = Array.from({ length: 700 }, (_, i) => `w${i}`)
    const source = `${words.join(" ")}\n`
    const passages = extractPassages("wall.md", source)

    expect(passages.length).toBe(3)
    for (const passage of passages) expect(passage.text.length).toBeLessThanOrEqual(1500)
    expect(passages.map((passage) => passage.text).join(" ")).toBe(words.join(" "))
    // Pieces of one paragraph each point at the whole paragraph.
    for (const passage of passages) expect(passage).toMatchObject(span(source, "w0 ", "w699"))
  })

  test("a word over 1,500 characters is cut, but never inside a surrogate pair", () => {
    const word = `${"x".repeat(1499)}😀${"y".repeat(1600)}`
    const passages = extractPassages("blob.md", word)
    expect(passages.map((passage) => passage.text)).toEqual([
      "x".repeat(1499),
      `😀${"y".repeat(1498)}`,
      "y".repeat(102),
    ])
  })
})

test("invalid MDX falls back to Markdown instead of throwing", () => {
  const source = "# Draft\n\nAn unclosed {expression\n\n<Callout>\nstill open\n\nMore text.\n"
  const passages = extractPassages("draft.mdx", source)
  expect(passages).toEqual([
    {
      headings: ["Draft"],
      text: "An unclosed {expression\nMore text.",
      ...span(source, "An unclosed", "More text."),
    },
  ])
})

describe("D2 diagrams", () => {
  test("a short diagram is one passage of its whole text", () => {
    const source = "\n# Architecture\ndirection: right\n\nbrowser -> supabase: session\nsupabase -> postgres\n\n"
    const text = source.trim()
    expect(extractPassages("docs/architecture.d2", source)).toEqual([
      { headings: [], text, ...span(source, text) },
    ])
  })

  test("a long diagram splits at blank lines, each passage verbatim", () => {
    const blocks = Array.from(
      { length: 30 },
      (_, i) => `group${i}: {\n  a${i} -> b${i}: "a labelled connection number ${i}"\n}`,
    )
    const source = blocks.join("\n\n")
    const passages = extractPassages("big.d2", source)

    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(1500)
      expect(passage.text).toBe(source.slice(passage.start, passage.end))
      expect(passage.headings).toEqual([])
    }
    expect(passages.map((passage) => passage.text).join("\n\n")).toBe(source)
  })

  test("a block over 1,500 characters splits at whitespace, each piece verbatim", () => {
    const source = Array.from({ length: 150 }, (_, i) => `node${i} -> node${i + 1}`).join("\n")
    const passages = extractPassages("chain.d2", source)

    // 2,631 characters in one block: two pieces, cut at whitespace.
    expect(passages.length).toBe(2)
    const [first, second] = passages
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(1500)
      expect(passage.text).toBe(source.slice(passage.start, passage.end))
    }
    expect(first.start).toBe(0)
    expect(source.slice(first.end, second.start)).toMatch(/^\s+$/)
    expect(second.end).toBe(source.length)
  })

  test("an empty diagram has no passages", () => {
    expect(extractPassages("empty.d2", "  \n\n")).toEqual([])
  })
})

test("other files have no passages", () => {
  expect(extractPassages("notes.txt", "# Not a note\n\nText.")).toEqual([])
  expect(extractPassages("README", "# Not a note\n\nText.")).toEqual([])
  expect(extractPassages("drawing.excalidraw", '{"type":"excalidraw"}')).toEqual([])
  expect(extractPassages("NOTES.MD", "Upper case works.")).toEqual([
    { headings: [], text: "Upper case works.", start: 0, end: 17 },
  ])
})

test("every passage's span covers the source its text came from", () => {
  const source = [
    "---\ntitle: Cover\n---",
    "# Café 😀",
    "Some *emphasis*, a [link](https://example.com), `code` and **bold**.",
    "## Table",
    "| A | B |\n|---|---|\n| 1 | 😀 |",
    "## Code",
    "```js\nconst x = 1\n```",
    '<Callout kind="note">\n  Inside the callout.\n</Callout>',
  ].join("\n\n")
  const passages = extractPassages("cover.mdx", source)
  expect(passages.map((passage) => passage.headings)).toEqual([
    ["Café 😀"],
    ["Café 😀", "Table"],
    ["Café 😀", "Code"],
  ])
  expectSpansCoverText(source, passages)
})
