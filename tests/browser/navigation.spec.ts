import { expect, test } from "@playwright/test"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// A link to a page whose code has not downloaded yet: the page being left
// takes no input from the moment the link is followed, and the loading state
// replaces it shortly after (main.tsx, routes/__root.tsx). The test holds the
// reset page's chunk back, and stops the page's clock to look at the moment
// before the loading state shows.

test("a link to a page whose code is still downloading shows the loading state, and the page being left takes no typing", async ({ page }) => {
  await fakeSupabase(page)
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/assets\/forgot-password-[\w-]+\.js$/, async (route) => {
    await released
    await route.continue()
  })
  await page.clock.install()
  await page.goto(new URL("sign-in", APP_URL).href)
  await page.getByRole("button", { name: "Use a password instead" }).click()
  const signInEmail = page.getByLabel("Email", { exact: true })
  await signInEmail.fill("someone@example.com")

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await page.getByRole("link", { name: "Forgot your password?" }).click()
  // Sign-in is still drawn, and its field takes neither focus nor typing.
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await signInEmail.focus()
  await page.keyboard.type(" more")
  await expect(signInEmail).not.toBeFocused()
  await expect(signInEmail).toHaveValue("someone@example.com")

  // A moment later, the loading state in its place.
  await page.clock.runFor(100)
  const loading = page.getByRole("status", { name: "Loading the page" })
  await expect(loading).toBeVisible()
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0)
  await page.keyboard.type("typed while it loads")

  release()
  await page.clock.resume()
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible()
  await expect(loading).toHaveCount(0)
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("")
})
