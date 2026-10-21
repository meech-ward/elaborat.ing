import { expect, test } from "./fixtures.ts"
import {
  accepted,
  clickAt,
  expectNoErrors,
  frameOf,
  load,
  openHarness,
  press,
  releaseTransactions,
  revision,
  selection,
  settled,
  source,
} from "./rendered-support.ts"

// The person adds a list item in Rendered and immediately changes their mind.
// Joining it back must keep the original Markdown and the caret, even while
// the Enter transaction is still waiting for the source editor.
test.use({ serviceWorkers: "allow", viewport: { width: 1280, height: 900 } })

const prefix = "export const untouched = 7;\n\n{/* preserve  this comment */}\n\nBefore paragraph.\n\n"
const suffix = "\n\n<Counter initial={untouched} />\n\nAfter paragraph.\n"
const fixtures = [
  { name: "bullet", items: "* first\n* second\n* third", second: "second", split: 3 },
  { name: "numbered", items: "3. first\n4. second\n5. third", second: "second", split: 3 },
  { name: "parenthesized numbered", items: "3) first\n4) second\n5) third", second: "second", split: 3 },
  { name: "task", items: "- [ ] first\n- [x] second\n- [ ] third", second: "second", split: 3 },
  { name: "formatted bullet", items: "* first\n* **second** *item*\n* third", second: "second item", split: 3 },
] as const

for (const fixture of fixtures) {
  for (const rapid of [false, true]) {
    for (const middle of [false, true]) {
      test(`${fixture.name}: ${rapid ? "rapid" : "settled"} Enter then Backspace ${middle ? "inside" : "after"} a middle item restores it`, async ({ page }) => {
        const errors = await openHarness(page)
        const original = `${prefix}${fixture.items}${suffix}`
        const mark = await load(page, original, "mdx", "After paragraph.")
        await page.evaluate(() => {
          const seen = { notice: false }
          ;(window as unknown as { listDeleteNotice: typeof seen }).listDeleteNotice = seen
          new MutationObserver(() => {
            if (document.body.textContent?.includes("Edit not applied:")) seen.notice = true
          }).observe(document.body, { childList: true, subtree: true, characterData: true })
        })
        await clickAt(page, fixture.second, middle ? fixture.split : fixture.second.length - 1)
        if (!middle) await press(page, "ArrowRight")
        const expectedOffset = middle ? fixture.split : fixture.second.length
        expect((await selection(page)).focus).toEqual({ paragraph: fixture.second, offset: expectedOffset })

        if (rapid) await page.evaluate(() => { window.transactionGate.enabled = true })
        await press(page, "Enter")
        if (rapid) {
          await page.waitForFunction(() => window.transactionGate.held.length > 0)
        } else {
          await accepted(page, mark)
          await settled(page)
        }
        await expect(frameOf(page).locator("li")).toHaveCount(4)
        const afterEnter = await revision(page)
        await press(page, "Backspace")
        if (rapid) {
          expect(await releaseTransactions(page)).toBeGreaterThan(0)
          await accepted(page, mark)
        } else {
          await accepted(page, afterEnter)
        }
        await settled(page)
        await expect.poll(() => source(page)).toBe(original)
        await expect(frameOf(page).locator("li")).toHaveCount(3)
        expect((await selection(page)).focus).toEqual({ paragraph: fixture.second, offset: expectedOffset })
        expect(await page.evaluate(() => (window as unknown as { listDeleteNotice: { notice: boolean } }).listDeleteNotice.notice)).toBe(false)
        expectNoErrors(errors)
      })
    }
  }
}
