import { describe, expect, test } from "bun:test"
import { parseConfig } from "./config"

describe("parseConfig", () => {
  test("accepts a Supabase URL and publishable key", () => {
    expect(
      parseConfig({
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
      }),
    ).toEqual({
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "sb_publishable_example",
    })
  })

  test("rejects a missing key", () => {
    expect(() => parseConfig({ VITE_SUPABASE_URL: "https://example.supabase.co" })).toThrow()
  })

  test("rejects a malformed URL", () => {
    expect(() =>
      parseConfig({ VITE_SUPABASE_URL: "not a url", VITE_SUPABASE_PUBLISHABLE_KEY: "key" }),
    ).toThrow()
  })
})
