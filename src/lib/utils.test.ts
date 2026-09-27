import { expect, test } from "bun:test"
import { cn } from "./utils"

test("a later style guide radius or shadow replaces an earlier one", () => {
  expect(cn("rounded-button", "rounded-tool")).toBe("rounded-tool")
  expect(cn("rounded-button", "rounded-[8px]")).toBe("rounded-[8px]")
  expect(cn("rounded-panel", "rounded-menu")).toBe("rounded-menu")
  expect(cn("shadow-panel", "shadow-none")).toBe("shadow-none")
  expect(cn("shadow-island", "shadow-panel")).toBe("shadow-panel")
})
