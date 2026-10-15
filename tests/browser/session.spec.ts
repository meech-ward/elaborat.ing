import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, session, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The session once signed in, against the stand-in Auth in fake-supabase.ts:
// token refreshes, a device whose clock runs ahead, and another tab signing out.

/** The token requests made so far. */
const tokens = (fake: FakeSupabase) => fake.requests.filter((request) => new URL(request.url()).pathname === "/auth/v1/token").length

/** The token requests made in the next second of the test's own time, whatever the page's clock does. */
async function nextSecond(fake: FakeSupabase) {
  const before = tokens(fake)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  return tokens(fake) - before
}

const account = (page: Page) => page.getByRole("banner").getByRole("button", { name: `Signed in as ${person.email}` })

test("a page whose clock runs an hour ahead signs in, then asks for a token only when the client checks it", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await signedIn(page)
  // The stand-in's tokens expire an hour after the test machine's time. With the page's clock an hour
  // ahead, each one expires as it arrives, as Auth's do on a device whose clock runs an hour fast, and
  // supabase-js refreshes a token it reads within 90 s of expiring.
  await page.clock.install({ time: Date.now() + 60 * 60_000 })
  await page.goto(APP_URL)
  // Signing in reads the session a few times, and each read refreshes the token. Then the page stops asking.
  await expect.poll(() => nextSecond(fake), { timeout: 15_000 }).toBe(0)
  await expect(account(page)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()

  // The client checks the token every 30 s. With the page's clock held still it makes no check, and
  // nothing asks for a token. The clock stops where it is, as in workbench.spec.ts.
  const now = await page.evaluate(() => Date.now())
  await page.clock.setFixedTime(now)
  await page.clock.pauseAt(now)
  await page.clock.setSystemTime(now)
  await expect.poll(() => nextSecond(fake)).toBe(0)
  const held = tokens(fake)
  // A check refreshes the token at most twice: reading the session refreshes the token it finds, and
  // then the check refreshes the one it read, which expires as it arrives too. Then the page stops asking.
  await page.clock.runFor(30_000)
  await expect.poll(() => tokens(fake)).toBeGreaterThan(held)
  await expect.poll(() => nextSecond(fake)).toBe(0)
  expect(tokens(fake) - held).toBeLessThanOrEqual(2)
  await expect(account(page)).toBeVisible()
})

test("a token close to expiring is refreshed once, and the page stays signed in", async ({ page }) => {
  const fake = await fakeSupabase(page)
  // 100 s left. The client refreshes a token with under two minutes left when it checks: as the page loads, and every 30 s.
  await signedIn(page, { ...session(), expires_at: Math.floor(Date.now() / 1000) + 100 })
  await page.goto(APP_URL)
  await expect(account(page)).toBeVisible()
  await expect.poll(() => tokens(fake)).toBe(1)
  await expect.poll(() => nextSecond(fake)).toBe(0)
  expect(tokens(fake)).toBe(1)
  await expect(account(page)).toBeVisible()
})

test("signing out in another tab signs this one out too", async ({ page, context, browserName }) => {
  test.skip(
    browserName === "firefox",
    "Firefox tells this tab of the sign-out before its storage changes, so this tab asks for the user of the session it still reads: Auth refuses a session that signed out, the stand-in does not.",
  )
  const fake = await fakeSupabase(page)
  await signedIn(page)
  await page.goto(APP_URL)
  await expect(account(page)).toBeVisible()

  const other = await context.newPage()
  await fakeSupabase(other, { server: fake.server })
  await other.goto(APP_URL)
  await account(other).click()
  await other.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(other.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
})
