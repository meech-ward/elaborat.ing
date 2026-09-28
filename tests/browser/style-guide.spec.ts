import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { palettes } from "../../src/features/appearance/palettes.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The style guide page: the foundations in the active palette, the palette
// and mode switch, the approved sheet's components card, and the rest of the
// library's sections in their places.

const styleGuideUrl = new URL("style-guide", APP_URL).href
const supabase = palettes.find((palette) => palette.id === "supabase-green")!
const glacier = palettes.find((palette) => palette.id === "glacier-cyan")!

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`

/** Every swatch as [token, the hex it shows, the colour its chip paints]. */
const swatches = (page: Page) =>
  page.locator("[data-token]").evaluateAll((items) =>
    items.map((item) => [
      item.getAttribute("data-token"),
      item.lastElementChild?.textContent,
      getComputedStyle(item.firstElementChild!).backgroundColor,
    ]),
  )

async function expectSwatchesMatch(page: Page, colors: Record<string, string>) {
  const found = await swatches(page)
  expect(found).toHaveLength(39)
  for (const [token, shown, painted] of found) {
    expect(shown, `${token} shows the palette value`).toBe(colors[token!])
    expect(painted, `${token} paints its value`).toBe(rgb(shown!))
  }
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await fakeSupabase(page)
})

test("the foundations show the active palette, and the component sections sit in order", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  await expect(page.getByRole("heading", { level: 1, name: "elaborat.ing style guide" })).toBeVisible()
  await expect(page.getByText("Supabase Green, light. Every value is a token", { exact: false })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex")

  const cards = page.getByRole("region")
  const colours = cards.filter({ has: page.getByRole("heading", { level: 2, name: "Colour tokens" }) })
  for (const group of ["Surfaces", "Text", "Accent", "Status", "Files and code", "Canvas"]) {
    await expect(colours.getByRole("heading", { level: 3, name: group, exact: true })).toBeVisible()
  }
  await expectSwatchesMatch(page, supabase.light as unknown as Record<string, string>)
  for (const name of ["Type", "Space, radius, elevation, icons"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible()
  }
  await expect(cards.filter({ has: page.getByRole("heading", { level: 2, name: "Type", exact: true }) }).getByText("Customer model")).toBeVisible()

  // The approved sheet's card: its six captions, and no groups inside.
  const sheet = cards.filter({ has: page.getByRole("heading", { level: 2, name: "Components and states", exact: true }) })
  for (const caption of ["Buttons", "View switch and tabs", "Tree rows and search", "Menu", "Banner, callout, status", "Canvas"]) {
    await expect(sheet.getByText(caption, { exact: true })).toBeVisible()
  }
  await expect(sheet.getByRole("heading", { level: 3 })).toHaveCount(0)
  const more = cards.filter({ has: page.getByRole("heading", { level: 2, name: "More components and states" }) })
  const c5 = cards.filter({ has: page.getByRole("heading", { level: 2, name: "C5 components" }) })
  await expect(more.getByRole("heading", { level: 3 })).toHaveText(["Controls", "Navigation"])
  await expect(c5.getByRole("heading", { level: 3 })).toHaveText(["Editor chrome", "Canvas"])
})

test("the palette and mode switch repaint the page and stay chosen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  await page.getByRole("combobox", { name: "Palette" }).click()
  await page.getByRole("option", { name: "Glacier Cyan" }).click()
  const mode = page.getByRole("group", { name: "Mode" })
  await mode.getByRole("button", { name: "Dark" }).click()
  await expect(mode.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByText("Glacier Cyan, dark.", { exact: false })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "glacier-cyan")
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark")
  await expectSwatchesMatch(page, glacier.dark as unknown as Record<string, string>)

  await page.reload()
  await expect(page.getByRole("combobox", { name: "Palette" })).toContainText("Glacier Cyan")
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark")
})

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(styleGuideUrl)
    await expect(page.locator("[data-token]").first()).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme)
    await expectAxeClean(page)
  })
}

test("an open menu stays inside the page's landmarks, with this platform's keys", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent))
  const more = page.getByRole("region").filter({ has: page.getByRole("heading", { level: 2, name: "More components and states" }) })
  await more.getByRole("button", { name: "File actions" }).click()
  // The sheet's menu is a picture of one: the open menu is the only menu.
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await expect(page.locator("main").getByRole("menu")).toBeVisible()
  const duplicate = menu.getByRole("menuitem", { name: /Duplicate/ })
  await expect(duplicate).toHaveAttribute("aria-keyshortcuts", apple ? "Meta+D" : "Control+D")
  await expect(duplicate).toContainText(apple ? "⌘D" : "Ctrl+D")
  await expectAxeClean(page)
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
})

test("the comment samples answer: a reply sends with the keyboard, and Resolve folds the thread under Resolved", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto(styleGuideUrl)
  const card = page.getByRole("region", { name: "Comments", exact: true })
  for (const group of ["Comment threads", "Composer and markers", "Comments panel", "Comments in the C5 screens"]) {
    await expect(card.getByRole("region", { name: group, exact: true })).toBeVisible()
  }
  // The panel with threads, the first of the panel samples.
  const panel = card.getByRole("region", { name: "Comments panel", exact: true }).getByText("With threads", { exact: true }).locator("xpath=following-sibling::*[1]")
  const thread = panel.getByRole("article", { name: /^Comments on section Steps/ })
  await thread.getByRole("button", { name: "Reply" }).click()
  const field = thread.getByRole("textbox", { name: "Reply" })
  await expect(field).toBeFocused()
  await field.fill("Linked it from step 3.")
  await field.press("ControlOrMeta+Enter")
  await expect(thread.getByText("Linked it from step 3.")).toBeVisible()
  await expect(field).toHaveValue("")
  await thread.getByRole("button", { name: "Resolve" }).click()
  await expect(thread).toBeHidden()
  await panel.getByRole("button", { name: "Resolved 2" }).click()
  await expect(thread.getByRole("button", { name: "Reopen" })).toBeVisible()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the page fits", async ({ page }) => {
    await page.goto(styleGuideUrl)
    await expect(page.locator("[data-token]").first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })

  test("the desktop screens show whole, scaled down to the column", async ({ page }) => {
    await page.goto(styleGuideUrl)
    for (const label of ["C5 note in Split", "C5 drawing, full screen", "C5 diagram, full screen", "Tool island"]) {
      const specimen = page.getByText(label, { exact: true }).last().locator("xpath=following-sibling::*[1]")
      await specimen.scrollIntoViewIfNeeded()
      await expect(specimen).toHaveAttribute("data-slot", "scale-to-fit")
      // The screen lies inside the page's 16px gutters, so none of it is cut off.
      await expect
        .poll(() => specimen.evaluate((node) => node.firstElementChild?.getBoundingClientRect().right ?? Infinity), { message: label })
        .toBeLessThanOrEqual(390 - 16)
    }
    // On the full screens the tools and the header keep apart, as at 1440.
    const screen = page.getByText("C5 drawing, full screen", { exact: true }).locator("xpath=following-sibling::*[1]")
    const tools = await screen.getByRole("group", { name: "Drawing tools" }).boundingBox()
    const save = await screen.getByRole("button", { name: /^Save/ }).boundingBox()
    expect(tools && save && tools.x + tools.width < save.x).toBe(true)
  })

  test("fields, the brand link and a phone row's actions are at least 40 on a touch screen", async ({ page }) => {
    await page.goto(styleGuideUrl)
    test.skip(!(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)), "this browser reports no coarse pointer")
    const targets = [
      page.getByPlaceholder("Project title"),
      page.getByRole("link", { name: "elaborat.ing" }).first(),
      page.getByRole("button", { name: "Actions for docs/customer-model.mdx, phone sample" }),
    ]
    for (const target of targets) {
      await target.scrollIntoViewIfNeeded()
      const box = await target.boundingBox()
      expect(box?.height, String(target)).toBeGreaterThanOrEqual(40)
    }
    const actions = await targets[2].boundingBox()
    expect(actions?.width).toBeGreaterThanOrEqual(40)
  })

  test("the comments sheet opens from the bottom with 40px targets, and Escape closes it", async ({ page }) => {
    await page.goto(styleGuideUrl)
    await page.getByRole("button", { name: "Open the comments sheet" }).click()
    // The live sheet renders at the end of the page, after the style guide's picture of one.
    const sheet = page.getByRole("dialog", { name: "Comments" }).last()
    await expect(sheet).toBeVisible()
    // Once it has slid in, it sits on the bottom edge.
    await expect.poll(async () => sheet.evaluate((node) => Math.round(node.getBoundingClientRect().bottom))).toBe(844)
    const targets = [
      sheet.getByRole("button", { name: "Close comments" }),
      sheet.getByRole("button", { name: "Resolve" }).first(),
      sheet.getByRole("button", { name: "Actions for the comment by Ada Park" }).first(),
      sheet.getByRole("button", { name: "Reply" }).first(),
    ]
    for (const target of targets) {
      const size = await target.boundingBox()
      expect(size?.height, String(target)).toBeGreaterThanOrEqual(40)
    }
    await page.keyboard.press("Escape")
    // Only the style guide's picture of the sheet is left.
    await expect(page.getByRole("dialog", { name: "Comments" })).toHaveCount(1)
  })

  test("buttons are at least 40 high on a touch screen", async ({ page }) => {
    await page.goto(styleGuideUrl)
    test.skip(!(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)), "this browser reports no coarse pointer")
    const sheet = page.getByRole("region").filter({ has: page.getByRole("heading", { level: 2, name: "Components and states", exact: true }) })
    for (const name of ["Save", "New folder", "Cancel", "Delete", "Focused"]) {
      const box = await sheet.getByRole("button", { name, exact: true }).boundingBox()
      expect(box?.height, name).toBeGreaterThanOrEqual(40)
    }
  })
})
