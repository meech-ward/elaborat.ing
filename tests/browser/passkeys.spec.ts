import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Passkeys, against the stand-in Supabase in fake-supabase.ts and, for the
// passkey itself, Chromium's virtual authenticator (WebAuthn over the
// DevTools protocol). WebAuthn needs a domain, so these pages open at
// localhost rather than 127.0.0.1.

const APP = APP_URL.replace("127.0.0.1", "localhost")

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials }
}

const openAccountMenu = (page: Page) => page.getByRole("banner").getByRole("button", { name: `Signed in as ${person.email}` }).click()

async function signInWithPassword(page: Page) {
  await page.goto(new URL("sign-in", APP).href)
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await page.getByLabel("Email", { exact: true }).fill(person.email)
  await page.getByLabel("Password", { exact: true }).fill("a password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(APP)
}

async function signOut(page: Page) {
  await openAccountMenu(page)
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
}

async function noAxeViolations(page: Page, selector?: string) {
  const builder = new AxeBuilder({ page })
  const results = await (selector ? builder.include(selector) : builder).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

test("a person adds a passkey in Settings, signs out, and signs back in with it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The virtual authenticator is Chromium's")
  const fake = await fakeSupabase(page, { passkeys: true })
  const authenticator = await virtualAuthenticator(page)

  await signInWithPassword(page)

  await openAccountMenu(page)
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await expect(settings.getByText("No passkeys yet.")).toBeVisible()
  await settings.getByRole("button", { name: "Add a passkey" }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Passkey added." })).toBeVisible()
  // The dialog scrolls at this size: the notice and Add a passkey under it stay in sight.
  await expect(settings.getByRole("status").filter({ hasText: "Passkey added." })).toBeInViewport({ ratio: 1 })
  await expect(settings.getByRole("button", { name: "Add a passkey" })).toBeInViewport({ ratio: 0.9 })
  await expect(settings.getByRole("list", { name: "Passkeys" }).getByRole("listitem")).toContainText(["Test authenticator"])
  expect(await authenticator.credentials()).toMatchObject([{ rpId: "localhost", isResidentCredential: true }])
  expect(fake.passkeys).toHaveLength(1)
  await expect.poll(() => settings.evaluate((element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"))).toBe(true)
  await noAxeViolations(page, '[role="dialog"]')
  await page.keyboard.press("Escape")

  await signOut(page)

  // No email: the authenticator offers the account's passkey, and Auth signs
  // in whoever it belongs to, then the page that asked for sign-in opens.
  await page.goto(new URL("sign-in?next=%2Fagents", APP).href)
  await noAxeViolations(page)
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page).toHaveURL(new URL("agents", APP).href)
  await expect(page.getByRole("banner").getByRole("button", { name: `Signed in as ${person.email}` })).toBeVisible()
  expect(fake.passkeys[0].last_used_at).toBeDefined()
})

test("a passkey removed in Settings no longer signs in, and the sign-in page says what to do", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The virtual authenticator is Chromium's")
  const fake = await fakeSupabase(page, { passkeys: true })
  await virtualAuthenticator(page)
  await signInWithPassword(page)
  await openAccountMenu(page)
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("button", { name: "Add a passkey" }).click()
  // Remove asks first; Cancel keeps the passkey.
  await settings.getByRole("button", { name: "Remove Test authenticator" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove Test authenticator?" })
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toBeHidden()
  await expect(settings.getByRole("button", { name: "Remove Test authenticator" })).toBeFocused()
  expect(fake.passkeys).toHaveLength(1)
  await settings.getByRole("button", { name: "Remove Test authenticator" }).click()
  await confirm.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Passkey removed." })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Add a passkey" })).toBeFocused()
  await expect(settings.getByText("No passkeys yet.")).toBeVisible()
  expect(fake.passkeys).toEqual([])
  await page.keyboard.press("Escape")

  // The device still offers it, but Auth no longer knows it.
  await signOut(page)
  await page.goto(new URL("sign-in", APP).href)
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByRole("alert")).toHaveText("That passkey is not linked to an account here. Sign in another way, then add a passkey in Settings.")
  await expect(page).toHaveURL(new URL("sign-in", APP).href)
})

test("with passkey sign-in off in Auth, neither the sign-in page nor Settings offers it", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const settingsReads = () => fake.requests.filter((request) => new URL(request.url()).pathname === "/auth/v1/settings").length
  await page.goto(new URL("sign-in", APP).href)
  await expect.poll(settingsReads).toBe(1)
  await expect(page.getByRole("button", { name: "Use a password instead" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toHaveCount(0)

  await signedIn(page)
  await page.goto(APP)
  await openAccountMenu(page)
  const before = settingsReads()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await expect(settings.getByRole("heading", { name: "Reading" })).toBeVisible()
  await expect.poll(settingsReads).toBeGreaterThan(before)
  await expect(settings.getByRole("heading", { name: "Passkeys" })).toHaveCount(0)
})
