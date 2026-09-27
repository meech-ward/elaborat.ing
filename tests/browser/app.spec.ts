import { readdir } from "node:fs/promises"
import path from "node:path"
import AxeBuilder from "./axe.ts"
import { expect, test } from "@playwright/test"
import { APP_URL } from "./urls.ts"

test("the home page has no accessibility violations", async ({ page }) => {
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

// A positive control: the check above only means something if it can fail.
test("the accessibility check catches a planted violation", async ({ page }) => {
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.evaluate(() => {
    const image = document.createElement("img")
    image.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
    document.querySelector("main")?.append(image)
  })
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => violation.id)).toContain("image-alt")
})

// Page zoom is off on phones and tablets (docs/architecture.md).
test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the page never zooms: the viewport caps the scale, no double-tap zoom, 16px fields", async ({ page }) => {
    await page.goto(new URL("sign-in", APP_URL).href)
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible()
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /(^|,)\s*maximum-scale=1\s*(,|$)/)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe("manipulation")
    // iOS Safari zooms the page into a focused field under 16px.
    await expect(page.getByRole("textbox").first()).toHaveCSS("font-size", "16px")
  })
})

test("the app build serves Excalidraw's fonts from this site", async ({ request }) => {
  const fonts = path.join(import.meta.dirname, "..", "..", "dist", "excalidraw-assets", "fonts", "Excalifont")
  const font = (await readdir(fonts)).find((name) => name.endsWith(".woff2"))!
  const response = await request.get(new URL(`excalidraw-assets/fonts/Excalifont/${font}`, APP_URL).href)
  expect(response.status()).toBe(200)
  expect((await response.body()).subarray(0, 4).toString("latin1")).toBe("wOF2")
})
