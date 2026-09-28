import type { Page } from "@playwright/test"

/**
 * Show one of the open file's views by its name (Source, Split, Rendered, or
 * a canvas's Code and Canvas): the view switch on a desktop, the choice at
 * the top of the "..." menu on a phone.
 */
export async function showView(page: Page, name: string) {
  const more = page.locator('[data-slot="phone-header"]:visible').getByRole("button", { name: "File actions" })
  if (await more.isVisible()) {
    await more.click()
    await page.getByRole("menuitemradio", { name, exact: true }).click()
  } else {
    await page.getByRole("button", { name, exact: true }).click()
  }
}
