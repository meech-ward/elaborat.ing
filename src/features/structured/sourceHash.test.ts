import { expect, test } from "bun:test"
import { hashSource } from "./sourceHash.ts"

// The MCP server's chat card computes the same fingerprint to tell a diagram
// drawn from older source (supabase/functions/mcp-server/tools/fileView.ts).
test("the source fingerprint is stable", () => {
  expect(hashSource("a -> b")).toBe("294b0b8d")
})
