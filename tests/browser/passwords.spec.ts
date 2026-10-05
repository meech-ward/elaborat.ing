import AxeBuilder from "./axe.ts"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, otpCode, person, session, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Email and password: signing in, signing up, a forgotten password and
// Settings > Account > Password, against the stand-in Auth in
// fake-supabase.ts, which holds Auth's password rules from supabase/config.toml.

const CONSENT = "/oauth/consent?authorization_id=auth-123"
const STRONG = "correct horse 42"

async function signInWithPassword(page: Page, password: string) {
  await page.goto(new URL("sign-in", APP_URL).href)
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await page.getByLabel("Email", { exact: true }).fill(person.email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}

async function openSettings(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: `Signed in as ${person.email}` }).click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  return page.getByRole("dialog", { name: "Settings" })
}

test("a wrong password says so plainly, and the page stays on sign-in", async ({ page }) => {
  await fakeSupabase(page)
  await signInWithPassword(page, "not my password 1")
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match. Try again, or reset your password.")
  await expect(page).toHaveURL(new URL("sign-in", APP_URL).href)
})

test("an email not confirmed yet says to confirm it first", async ({ page }) => {
  await fakeSupabase(page, { unconfirmed: true })
  await signInWithPassword(page, "a password")
  await expect(page.getByRole("alert")).toContainText("Confirm your email first")
})

test("signing up from an agent's request needs a strong password, then the emailed code signs in and returns to the request", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await page.goto(new URL(`sign-in?next=${encodeURIComponent(CONSENT)}`, APP_URL).href)
  await page.getByRole("main").getByRole("link", { name: "Sign up" }).click()
  await expect(page).toHaveURL(new URL(`sign-up?next=${encodeURIComponent(CONSENT)}`, APP_URL).href)
  await expect(page.getByText("At least 10 characters, with letters and digits.")).toBeVisible()

  await page.getByLabel("Email", { exact: true }).fill(person.email)
  await page.getByLabel("Password", { exact: true }).fill("short")
  await page.getByLabel("Repeat password").fill("short")
  await page.getByRole("button", { name: "Sign up" }).click()
  await expect(page.getByRole("alert")).toHaveText("Choose a stronger password. At least 10 characters, with letters and digits.")

  await page.getByLabel("Password", { exact: true }).fill(STRONG)
  await page.getByLabel("Repeat password").fill(STRONG)
  await page.getByRole("button", { name: "Sign up" }).click()
  await expect(page.getByRole("status")).toContainText(`Check ${person.email} for a link that confirms your account and signs you in.`)
  // The confirmation link comes back to sign-in, which continues to the request.
  const signUp = fake.requests.find((request) => new URL(request.url()).pathname.endsWith("/signup"))
  expect(new URL(signUp!.url()).searchParams.get("redirect_to")).toBe(new URL(`sign-in?next=${encodeURIComponent(CONSENT)}`, APP_URL).href)

  await page.getByLabel("Code from the email").fill(otpCode)
  await page.getByRole("button", { name: "Sign in with the code" }).click()
  await expect(page).toHaveURL(new URL(CONSENT.slice(1), APP_URL).href)
  await expect(page.getByText("Authorize Claude")).toBeVisible()
})

test("a forgotten password: the reset email is sent, and its link opens a page that saves a new one and signs in", async ({ page }) => {
  const fake = await fakeSupabase(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await page.getByRole("link", { name: "Forgot your password?" }).click()
  // Sign-in stays on screen until the reset page's code has arrived, and it has an Email field too.
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible()
  await page.getByLabel("Email", { exact: true }).fill(person.email)
  await page.getByRole("button", { name: "Send reset email" }).click()
  await expect(page.getByRole("status")).toHaveText(`If ${person.email} has an account, we sent it a link to choose a new password. It works once, for one hour.`)
  const recover = fake.requests.find((request) => new URL(request.url()).pathname.endsWith("/recover"))
  expect(new URL(recover!.url()).searchParams.get("redirect_to")).toBe(new URL("update-password", APP_URL).href)

  // The link signs in and lands on the page, with the session in the URL's fragment.
  const { access_token, refresh_token, expires_in, expires_at, token_type } = session()
  const fragment = new URLSearchParams({ access_token, refresh_token, expires_in: String(expires_in), expires_at: String(expires_at), token_type, type: "recovery" })
  await page.goto(new URL(`update-password#${fragment}`, APP_URL).href)
  await page.getByLabel("New password").fill("password")
  await page.getByRole("button", { name: "Save new password" }).click()
  await expect(page.getByRole("alert")).toHaveText("Choose a stronger password. At least 10 characters, with letters and digits.")
  await page.getByLabel("New password").fill(STRONG)
  await page.getByRole("button", { name: "Save new password" }).click()
  await expect(page).toHaveURL(APP_URL)
  await expect(page.getByRole("banner").getByRole("button", { name: `Signed in as ${person.email}` })).toBeVisible()
  expect(fake.password).toBe(STRONG)
})

test("a reset link that has expired says so and offers a new one", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(new URL("update-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", APP_URL).href)
  await expect(page.getByRole("alert")).toHaveText("This link has expired or was already used. Send yourself a new one.")
  await expect(page.getByRole("link", { name: "Send a new link" })).toHaveAttribute("href", "/forgot-password")
})

test("Settings saves a password at once in a recent session", async ({ page }) => {
  const fake = await fakeSupabase(page)
  fake.password = "an old password 1"
  await signedIn(page)
  await page.goto(APP_URL)
  const settings = await openSettings(page)
  await settings.getByLabel("New password").fill("an old password 1")
  await settings.getByRole("button", { name: "Save password" }).click()
  await expect(settings.getByRole("alert")).toHaveText("That is already your password.")
  await settings.getByLabel("New password").fill(STRONG)
  await settings.getByRole("button", { name: "Save password" }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Password saved." })).toBeVisible()
  expect(fake.password).toBe(STRONG)
  expect(fake.requests.some((request) => new URL(request.url()).pathname.endsWith("/reauthenticate"))).toBe(false)
})

test("Settings asks for the emailed code before it changes the password of an older session", async ({ page }) => {
  const fake = await fakeSupabase(page, { staleSession: true })
  await signedIn(page)
  await page.goto(APP_URL)
  const settings = await openSettings(page)
  await settings.getByLabel("New password").fill(STRONG)
  await settings.getByRole("button", { name: "Save password" }).click()
  await expect(settings.getByRole("status").filter({ hasText: `To save it, enter the code we emailed to ${person.email}.` })).toBeVisible()
  expect(fake.requests.some((request) => new URL(request.url()).pathname.endsWith("/reauthenticate"))).toBe(true)
  expect(fake.password).toBe("a password")

  await settings.getByLabel("Code from the email").fill("00000000")
  await settings.getByRole("button", { name: "Save password" }).click()
  await expect(settings.getByRole("alert")).toHaveText("That code did not work. Check it, or send a new one.")
  await settings.getByLabel("Code from the email").fill(otpCode)
  await settings.getByRole("button", { name: "Save password" }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Password saved." })).toBeVisible()
  expect(fake.password).toBe(STRONG)
  await expect(settings.getByLabel("Code from the email")).toHaveCount(0)

  await expect.poll(() => settings.evaluate((element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"))).toBe(true)
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
})
