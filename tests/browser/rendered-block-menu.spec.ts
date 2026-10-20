import AxeBuilder from "./axe.ts"
import { expect, test } from "./fixtures.ts"
import { clickAt, expectNoErrors, frameOf, load, openHarness, paragraph, releaseTransactions, settled, source } from "./rendered-support.ts"

// The note's context menu inserts at a parsed top-level boundary. All edits
// come from real mouse or keyboard input in the isolated rendered frame.
test.use({ serviceWorkers: "allow", viewport: { width: 1280, height: 900 } })

let errors: string[] = []
test.beforeEach(async ({ page }) => {
  errors = await openHarness(page)
})
test.afterEach(() => expectNoErrors(errors))

const note = "# Title\n\nFirst **formatted** paragraph.\n\nSecond paragraph.\n"

test("right-click inserts a block after the clicked formatted paragraph", async ({ page }) => {
  await load(page, note, "md", "First formatted paragraph.")
  await paragraph(page, "First formatted paragraph.").locator("strong").click({ button: "right" })
  const menu = frameOf(page).getByRole("menu", { name: "Insert block" })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("menuitem")).toHaveText(["Paragraph", "Heading", "Bullet list", "Quote", "Divider", "Image"])
  await menu.getByRole("menuitem", { name: "Divider", exact: true }).click()
  await expect(menu).toBeHidden()
  await expect.poll(() => source(page)).toBe("# Title\n\nFirst **formatted** paragraph.\n\n---\n\n\n\nSecond paragraph.\n")
  await expect(frameOf(page).locator(".ProseMirror > hr")).toHaveCount(1)
})

test("a list item and a component insert after their top-level blocks despite hidden exports", async ({ page }) => {
  const original = "export const hidden = 7\n\nBefore list.\n\n- First item\n- Second item\n\n<Counter initial={hidden} />\n\nAfter island.\n"
  await load(page, original, "mdx", "Before list.")
  const frame = frameOf(page)
  const menu = frame.getByRole("menu", { name: "Insert block" })
  await frame.getByText("First item", { exact: true }).click({ button: "right" })
  await menu.getByRole("menuitem", { name: "Divider", exact: true }).click()
  const afterList = original.replace("- Second item", "- Second item\n\n---\n\n")
  await expect.poll(() => source(page)).toBe(afterList)
  await expect(frame.locator(".ProseMirror > ul > li")).toHaveText(["First item", "Second item"])

  await frame.locator('[data-component="Counter"] output').click({ button: "right" })
  await menu.getByRole("menuitem", { name: "Divider", exact: true }).click()
  await expect.poll(() => source(page)).toBe(afterList.replace("<Counter initial={hidden} />", "<Counter initial={hidden} />\n\n---\n\n"))
  await expect(frame.locator('[data-component="Counter"] output')).toHaveText("7")
  await expect(frame.locator(".ProseMirror > hr")).toHaveCount(2)
})

test("the block menu supports keyboard selection", async ({ page }) => {
  await load(page, note, "md", "First formatted paragraph.")
  await paragraph(page, "First formatted paragraph.").click({ button: "right" })
  const menu = frameOf(page).getByRole("menu", { name: "Insert block" })
  const first = menu.getByRole("menuitem", { name: "Paragraph", exact: true })
  await expect(first).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(menu.getByRole("menuitem", { name: "Heading", exact: true })).toBeFocused()
  await page.keyboard.press("End")
  await expect(menu.getByRole("menuitem", { name: "Image", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(menu.getByRole("menuitem", { name: "Divider", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(menu).toBeHidden()
  await expect.poll(() => source(page)).toBe("# Title\n\nFirst **formatted** paragraph.\n\n---\n\n\n\nSecond paragraph.\n")
})

test("Escape and a click outside dismiss the block menu without changing the note", async ({ page }) => {
  await load(page, note, "md", "First formatted paragraph.")
  const first = paragraph(page, "First formatted paragraph.")
  const menu = frameOf(page).getByRole("menu", { name: "Insert block" })
  await first.click({ button: "right" })
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  expect(await source(page)).toBe(note)

  await first.click({ button: "right" })
  await expect(menu).toBeVisible()
  await frameOf(page).getByRole("heading", { name: "Title", exact: true }).click()
  await expect(menu).toBeHidden()
  expect(await source(page)).toBe(note)
})

test("block insertion waits until typed edits have reached the source", async ({ page }) => {
  await load(page, note, "md", "First formatted paragraph.")
  const first = paragraph(page, "First formatted paragraph.")
  await clickAt(page, "First formatted paragraph.", "First formatted paragraph.".length - 1)
  await page.keyboard.press("ArrowRight")
  await page.evaluate(() => { window.transactionGate.enabled = true })
  await page.keyboard.type("x")
  await page.waitForFunction(() => window.transactionGate.held.length > 0)
  await first.click({ button: "right" })
  const menu = frameOf(page).getByRole("menu", { name: "Insert block" })
  await expect(menu).toBeHidden()
  expect(await source(page)).toBe(note)

  await releaseTransactions(page)
  await settled(page)
  await paragraph(page, "Second paragraph.").click({ button: "right" })
  await menu.getByRole("menuitem", { name: "Divider", exact: true }).click()
  await expect.poll(() => source(page)).toBe("# Title\n\nFirst **formatted** paragraph.x\n\nSecond paragraph.\n\n---\n\n\n")
})

test("the full block menu fits near the viewport corner and has no accessibility problems", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  const original = `# Menu bounds\n\n${Array.from({ length: 25 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n")}\n`
  await load(page, original, "mdx", /^Paragraph 1\.$/)
  const last = paragraph(page, /^Paragraph 25\.$/)
  await last.scrollIntoViewIfNeeded()
  const box = (await last.boundingBox())!
  await last.click({ button: "right", position: { x: box.width - 2, y: box.height - 2 } })
  const menu = frameOf(page).getByRole("menu", { name: "Insert block" })
  await expect(menu).toBeVisible()
  const bounds = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  expect(await frameOf(page).locator("html").evaluate((root) => root.scrollWidth <= innerWidth + 1)).toBe(true)
  const results = await new AxeBuilder({ page }).include(['iframe[title="Isolated document preview"]', '[role="menu"]']).analyze()
  expect(results.passes.length).toBeGreaterThan(0)
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
  expect(await source(page)).toBe(original)
})
