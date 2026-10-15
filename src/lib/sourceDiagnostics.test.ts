import { describe, expect, it } from "bun:test"
import { diagnoseSource, parseErrorPosition } from "./sourceDiagnostics"

describe("diagnoseSource", () => {
  it("accepts valid MDX", async () => {
    expect(await diagnoseSource("# Title\n\nSome **prose**.\n", "mdx")).toBeNull()
  })

  it("reports invalid MDX without throwing", async () => {
    const message = await diagnoseSource("# Title\n\n<Callout tone=>\n", "mdx")
    expect(message).toMatch(/Invalid MDX/)
  })

  it("keeps markdown braces literal (md is not MDX)", async () => {
    expect(await diagnoseSource("Compute {2 + 2} stays literal.\n", "md")).toBeNull()
  })

  it("accepts markdown emphasis and lists", async () => {
    expect(await diagnoseSource("- **one**\n- *two*\n", "md")).toBeNull()
  })
})

describe("parseErrorPosition", () => {
  it("reads the places MDX writes: leading, or in brackets", () => {
    expect(parseErrorPosition("3:6: Unexpected character")).toEqual({ line: 3, column: 6 })
    expect(parseErrorPosition("Expected a closing tag for `<Rel>` (3:6-3:11) before the end of `paragraph`")).toEqual({ line: 3, column: 6 })
    expect(parseErrorPosition("Unexpected end of file (4:1)")).toEqual({ line: 4, column: 1 })
    expect(parseErrorPosition("Unexpected character `!` (U+0021) before name")).toBeNull()
  })

  it("finds where the compiler found the error in a note", async () => {
    // MDX names an unclosed tag's place in its message.
    expect(parseErrorPosition((await diagnoseSource("# Title\n\nSome <Rel>text\n", "mdx")) ?? "")).toEqual({ line: 3, column: 6 })
    // An expression that doesn't parse has its place only on the error, which the message now ends with.
    expect(parseErrorPosition((await diagnoseSource("# Title\n\nSome {1 +} text\n", "mdx")) ?? "")).toEqual({ line: 3, column: 10 })
  })
})
