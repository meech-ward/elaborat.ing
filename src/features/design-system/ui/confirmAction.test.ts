import { afterEach, describe, expect, test } from "bun:test"
import { confirmAction } from "./ConfirmAction"

// In the app's own window confirmAction is the browser's confirm, unchanged;
// the dialog it shows in a chat's panel (with a ConfirmActionHost mounted) is
// checked in tests/browser/embed.spec.ts.

const global = globalThis as { window?: unknown }
const before = global.window

afterEach(() => {
  global.window = before
})

describe("confirmAction without a host", () => {
  test("asks with the browser's confirm and answers as it does", async () => {
    const asked: string[] = []
    let answer = true
    global.window = { confirm: (message: string) => (asked.push(message), answer) }
    expect(await confirmAction("Discard your edits?", { confirmLabel: "Discard" })).toBe(true)
    answer = false
    expect(await confirmAction("Reset the layout?")).toBe(false)
    expect(asked).toEqual(["Discard your edits?", "Reset the layout?"])
  })
})
