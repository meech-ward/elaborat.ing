import { describe, expect, it } from "bun:test"
import { diagnoseSource } from "./sourceDiagnostics"

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
