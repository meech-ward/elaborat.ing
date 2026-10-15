import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The interface font, Space Grotesk, can arrive after the page has drawn. Until
// then the page draws in its stand-in (features/appearance/themes.css), which
// has Space Grotesk's metrics, so text wraps onto the same lines and nothing
// jumps when the font arrives. These tests hold the font back, note where
// everything on the sign-in page sits, let the font arrive and look again.
// They check the stand-in the machine has: Arial's where Arial, Liberation Sans
// or Arimo is installed (as in the test image), otherwise Roboto's (on a
// machine with Roboto and none of those three, as an Android phone).

/** Where each heading, paragraph, label, field, button and link sits. */
const positions = (page: Page) =>
  page.evaluate(() => {
    const seen = new Map<string, number>()
    return [...document.querySelectorAll("h1, p, label, input, button, a")].flatMap((element) => {
      const box = element.getBoundingClientRect()
      if (!box.width && !box.height) return []
      const text = element.textContent?.trim() || element.getAttribute("aria-label") || element.getAttribute("placeholder") || ""
      const name = `${element.tagName.toLowerCase()} "${text.replace(/\s+/g, " ").slice(0, 40)}"`
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return [{ name: count > 1 ? `${name} (${count})` : name, x: box.left, y: box.top }]
    })
  })

const fontLoaded = (page: Page, family: string) => page.evaluate((family) => document.fonts.check(`13px '${family}'`), family)
/** The stand-in the page draws in until then: Arial's, or Roboto's on a device without Arial, Liberation Sans or Arimo (an Android phone). */
const standIn = (page: Page) =>
  page.evaluate(() => {
    const loaded = new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, "")))
    return ["Space Grotesk Fallback", "Space Grotesk Roboto Fallback"].find((family) => loaded.has(family)) ?? null
  })

/**
 * How far everything on the sign-in page moves when Space Grotesk arrives, in
 * the email or the password form. `uiFont` replaces the page's font list.
 */
async function movesOnArrival(page: Page, { password = false, uiFont }: { password?: boolean; uiFont?: string } = {}) {
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/assets\/space-grotesk-[\w-]+\.woff2$/, async (route) => {
    await held
    await route.continue()
  })
  // Text is placed at fractions of a pixel, as phones and Macs place it:
  // Chromium on Linux otherwise rounds each letter to whole pixels, which by
  // itself moves what follows a word by several pixels, whatever the stand-in.
  await page.addInitScript((uiFont) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style")
      style.textContent = `:root { text-rendering: geometricPrecision; ${uiFont ? `--ui-font: ${uiFont} !important` : ""} }`
      document.head.append(style)
    })
  }, uiFont ?? "")
  await fakeSupabase(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  if (password) {
    await page.getByRole("button", { name: "Use a password instead" }).click()
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible()
  } else {
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible()
  }
  await expect(page.getByText("Checking your session...")).toHaveCount(0)
  if (!uiFont) await expect.poll(() => standIn(page)).not.toBeNull()
  expect(await fontLoaded(page, "Space Grotesk Variable")).toBe(false)
  const before = await positions(page)

  release()
  await expect.poll(() => fontLoaded(page, "Space Grotesk Variable")).toBe(true)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const after = await positions(page)
  return before.map(({ name, x, y }) => {
    const moved = after.find((element) => element.name === name)
    return { name, dx: moved ? Math.round((moved.x - x) * 10) / 10 : NaN, dy: moved ? Math.round((moved.y - y) * 10) / 10 : NaN }
  })
}

/**
 * Moves past a pixel up or down, or past 3.5 pixels sideways. A line that wraps
 * differently moves everything under it by a whole line. Sideways, the
 * stand-in's letters are not quite Space Grotesk's widths, so what sits after
 * a word can shift by up to 3 pixels.
 */
const jumps = (moves: { name: string; dx: number; dy: number }[]) => moves.filter(({ dx, dy }) => !(Math.abs(dy) <= 1 && Math.abs(dx) <= 3.5))

for (const [width, form] of [
  [1280, "email"],
  [1280, "password"],
  [390, "email"],
  [390, "password"],
] as const) {
  test(`at ${width} wide, nothing on the sign-in page's ${form} form jumps when its font arrives`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    expect(jumps(await movesOnArrival(page, { password: form === "password" }))).toEqual([])
  })
}

// A positive control: with a stand-in of Arial's own size, as before, the
// description wraps differently and the form below it jumps when the font arrives.
test("the check catches a page that jumps when its font arrives", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const moves = await movesOnArrival(page, { uiFont: "'Space Grotesk Variable', 'Liberation Sans', Arimo, Arial, sans-serif" })
  expect(jumps(moves).map(({ name }) => name)).toContain('button "Email me a sign-in link"')
})
