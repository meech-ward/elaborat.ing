import { expect } from "jsr:@std/expect@1.0.17"
import { describe, it as test } from "jsr:@std/testing@1.0.16/bdd"
import LZString from "npm:lz-string@1.5.0"
import { extractPassages, noteHeadings, type Passage } from "./passages.ts"

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

describe("drawings", () => {
  /** A text element, as Excalidraw saves one. */
  const text = (id: string, x: number, y: number, value: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "text",
    x,
    y,
    width: 100,
    height: 25,
    text: value,
    originalText: value,
    ...extra,
  })
  const scene = {
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "box", type: "rectangle", x: 0, y: 100, width: 200, height: 80, boundElements: [{ id: "label", type: "text" }] },
      text("label", 20, 120, "Postgres", { containerId: "box" }),
      { id: "arrow", type: "arrow", x: 200, y: 140, width: 100, height: 0, points: [[0, 0], [100, 0]] },
      text("arrow-label", 230, 130, "reads from", { containerId: "arrow" }),
      text("title", 0, 0, "Data flow"),
      // Excalidraw adds line breaks to wrap text in a narrow shape; originalText is what was typed.
      text("note", 0, 300, "Wrapped\nnote", { originalText: "Wrapped note" }),
      text("gone", 0, 50, "Deleted words", { isDeleted: true }),
      text("blank", 0, 60, "   "),
    ],
  }

  test("a drawing is one passage of its text, top to bottom then left to right", () => {
    const source = JSON.stringify(scene)
    expect(extractPassages("flows/data.excalidraw", source)).toEqual([
      { headings: [], text: "Data flow\nPostgres\nreads from\nWrapped note", start: 0, end: source.length },
    ])
  })

  test("Obsidian drawings are read from their scene, compressed or plain", () => {
    const json = JSON.stringify(scene)
    // Obsidian's Text Elements section can be stale: the scene is what counts.
    const markdown = "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n## Text Elements\nOld words ^title\n\n%%\n## Drawing\n"
    const compressed = `${markdown}\`\`\`compressed-json\n${LZString.compressToBase64(json)}\n\`\`\`\n%%`
    const plain = `${markdown}\`\`\`json\n${json}\n\`\`\`\n%%`
    for (const source of [compressed, plain]) {
      expect(extractPassages("Sketch.excalidraw.md", source)).toEqual([
        { headings: [], text: "Data flow\nPostgres\nreads from\nWrapped note", start: 0, end: source.length },
      ])
    }
  })

  test("a drawing with no text, or that cannot be read, has no passages", () => {
    const shapes = { type: "excalidraw", elements: [{ id: "a", type: "rectangle", x: 0, y: 0 }] }
    expect(extractPassages("shapes.excalidraw", JSON.stringify(shapes))).toEqual([])
    expect(extractPassages("empty.excalidraw", '{"type":"excalidraw","version":2,"elements":[]}')).toEqual([])
    expect(extractPassages("broken.excalidraw", '{"type":"excalidraw"}')).toEqual([])
    expect(extractPassages("broken.excalidraw", "{not json")).toEqual([])
    expect(extractPassages("prose.excalidraw.md", "# Just a note\n\nNo drawing here.")).toEqual([])
  })

  test("a drawing with a lot of text splits into passages under 1,500 characters", () => {
    const labels = Array.from({ length: 60 }, (_, i) => `Label ${i} ${"word ".repeat(8).trim()}`)
    const source = JSON.stringify({ elements: labels.map((label, i) => text(`t${i}`, 0, i * 30, label)) })
    const passages = extractPassages("big.excalidraw", source)
    expect(passages.length).toBe(2)
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(1500)
      expect(passage).toMatchObject({ headings: [], start: 0, end: source.length })
    }
    expect(passages.map((passage) => passage.text).join("\n")).toBe(labels.join("\n"))
  })
})

test("other files have no passages", () => {
  expect(extractPassages("notes.txt", "# Not a note\n\nText.")).toEqual([])
  expect(extractPassages("README", "# Not a note\n\nText.")).toEqual([])
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

describe("noteHeadings", () => {
  /** A heading's line as noteHeadings reports it. */
  const line = (source: string, text: string) => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length })

  test("ATX headings give their whole line and their path", () => {
    const source = "# Guide\n\nIntro.\n\n## Setup ##\n\nSteps.\n\n### Tools\n\n## Use\n"
    expect(noteHeadings("notes/guide.md", source)).toEqual([
      { depth: 1, text: "Guide", path: "Guide", ...line(source, "# Guide") },
      { depth: 2, text: "Setup", path: "Guide > Setup", ...line(source, "## Setup ##") },
      { depth: 3, text: "Tools", path: "Guide > Setup > Tools", ...line(source, "### Tools") },
      { depth: 2, text: "Use", path: "Guide > Use", ...line(source, "## Use") },
    ])
  })

  test("setext headings give their text line, not the underline", () => {
    const source = "Guide\r\n=====\r\n\r\nIntro.\r\n\r\nSetup\r\n-----\r\n"
    expect(noteHeadings("notes/guide.md", source)).toEqual([
      { depth: 1, text: "Guide", path: "Guide", start: 0, end: 5 },
      { depth: 2, text: "Setup", path: "Guide > Setup", ...line(source, "Setup") },
    ])
  })

  test("headings with inline code and links read as plain text", () => {
    const source = "# The `save_files` [call](https://example.com)\n\nText.\n"
    expect(noteHeadings("notes/api.md", source)).toEqual([
      { depth: 1, text: "The save_files call", path: "The save_files call", start: 0, end: source.indexOf("\n") },
    ])
  })

  test("MDX notes skip frontmatter, imports and headings inside components", () => {
    const source = [
      "---\ntitle: Plan\n---",
      'import { Callout } from "workspace:components/callout.mdx"',
      "# Plan 😀",
      "<Callout>\n\n## Inside\n\n</Callout>",
      "## Steps",
    ].join("\n\n")
    expect(noteHeadings("notes/plan.mdx", source)).toEqual([
      { depth: 1, text: "Plan 😀", path: "Plan 😀", ...line(source, "# Plan 😀") },
      { depth: 2, text: "Steps", path: "Plan 😀 > Steps", ...line(source, "## Steps") },
    ])
  })

  test("only notes have headings", () => {
    expect(noteHeadings("plan.d2", "# not a heading")).toEqual([])
    expect(noteHeadings("sketch.excalidraw.md", "# Excalidraw Data")).toEqual([])
  })
})
