import AxeBuilder from "./axe.ts"
import { expect, test } from "@playwright/test"
import { fakeSupabase, otpCode, person as user, signedIn, SUPABASE } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Sign-in and an agent's consent request, against the stand-in Supabase in
// fake-supabase.ts (the build points at it through `.env.browser-test`).

const fakeAuth = async (page: import("@playwright/test").Page, decision?: { redirect: string }) =>
  (await fakeSupabase(page, { consentRedirect: decision?.redirect })).requests

/** Sign in with the password, the sign-in card's other option. */
async function signInWithPassword(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await page.getByLabel("Email", { exact: true }).fill(user.email)
  await page.getByLabel("Password", { exact: true }).fill("a password")
  await page.getByRole("button", { name: "Sign in" }).click()
}

test("the sign-in page offers an emailed link, and a password instead, with no accessibility problems", async ({ page }) => {
  await fakeAuth(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible()
  await page.getByRole("button", { name: "Use a password instead" }).click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
})

for (const [choice, button] of [
  ["approve", "Allow access"],
  ["deny", "Deny"],
] as const) {
  test(`an agent's request sends a signed-out person to sign in, then back to ${choice} it`, async ({ page }) => {
    const back = `https://claude.ai/api/mcp/auth_callback?result=${choice}`
    const seen = await fakeAuth(page, { redirect: back })
    await page.route("https://claude.ai/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Back at the agent</title>" }))

    await page.goto(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
    await expect(page).toHaveURL(new URL("sign-in?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dauth-123", APP_URL).href)
    await signInWithPassword(page)

    await expect(page).toHaveURL(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
    await expect(page.getByText("Authorize Claude")).toBeVisible()
    await expect(page.getByRole("main").getByText(user.email)).toBeVisible()
    await page.getByRole("button", { name: button }).click()
    await expect(page).toHaveURL(back)
    const consent = seen.find((request) => new URL(request.url()).pathname.endsWith("/consent"))
    expect(consent?.method()).toBe("POST")
    expect(consent?.postDataJSON()).toMatchObject({ action: choice })
  })
}

test("an emailed sign-in link is asked for, returning to the page that needed it", async ({ page }) => {
  const seen = await fakeAuth(page)
  await page.goto(new URL("sign-in?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dauth-123", APP_URL).href)
  await page.getByLabel("Email", { exact: true }).last().fill(user.email)
  await page.getByRole("button", { name: "Email me a sign-in link" }).click()
  await expect(page.getByRole("status")).toContainText(`Check ${user.email}`)
  const otp = seen.find((request) => new URL(request.url()).pathname.endsWith("/otp"))
  expect(otp?.postDataJSON()).toMatchObject({ email: user.email })
  expect(new URL(otp!.url()).searchParams.get("redirect_to")).toBe(new URL("sign-in?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dauth-123", APP_URL).href)
})

const consentNext = "sign-in?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dauth-123"

/** Ask for the emailed link and code, on the sign-in page that `next` leads back from. */
async function emailMe(page: import("@playwright/test").Page) {
  await page.getByLabel("Email", { exact: true }).last().fill(user.email)
  await page.getByRole("button", { name: "Email me a sign-in link" }).click()
  await expect(page.getByRole("status")).toContainText(`Check ${user.email}`)
}

test("the emailed code signs in and continues to the page that needed it", async ({ page }) => {
  const seen = await fakeAuth(page)
  await page.goto(new URL(consentNext, APP_URL).href)
  await emailMe(page)
  await page.getByLabel("Code from the email").fill(otpCode)
  await page.getByRole("button", { name: "Sign in with the code" }).click()

  await expect(page).toHaveURL(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
  await expect(page.getByText("Authorize Claude")).toBeVisible()
  const verify = seen.find((request) => new URL(request.url()).pathname.endsWith("/verify"))
  expect(verify?.postDataJSON()).toMatchObject({ email: user.email, token: otpCode, type: "email" })
})

test("a wrong code says so, and the person can send a new one or try again", async ({ page }) => {
  const seen = await fakeAuth(page)
  await page.goto(new URL(consentNext, APP_URL).href)
  await emailMe(page)
  await page.getByLabel("Code from the email").fill("000000")
  await page.getByRole("button", { name: "Sign in with the code" }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "That code did not work (Token has expired or is invalid). Check it and try again, or send a new one.",
  )
  await expect(page).toHaveURL(new URL(consentNext, APP_URL).href)

  await page.getByRole("button", { name: "Send a new link and code" }).click()
  await expect(page.getByRole("status")).toHaveText(`Sent a new link and code to ${user.email}.`)
  expect(seen.filter((request) => new URL(request.url()).pathname.endsWith("/otp"))).toHaveLength(2)

  await page.getByLabel("Code from the email").fill(otpCode)
  await page.getByRole("button", { name: "Sign in with the code" }).click()
  await expect(page).toHaveURL(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
})

test("a provider Auth has on gets a button that starts its sign-in, returning to the page that needed it", async ({ page }) => {
  await fakeSupabase(page, { providers: { github: true } })
  await page.goto(new URL(consentNext, APP_URL).href)
  await page.getByRole("button", { name: "Continue with GitHub" }).click()
  await expect(page).toHaveTitle("Provider sign-in")
  const authorize = new URL(page.url())
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${SUPABASE}/auth/v1/authorize`)
  expect(authorize.searchParams.get("provider")).toBe("github")
  expect(authorize.searchParams.get("redirect_to")).toBe(new URL(consentNext, APP_URL).href)
})

test("with GitHub and Google off, no provider buttons show", async ({ page }) => {
  await fakeAuth(page)
  const settings = page.waitForResponse((response) => response.url().endsWith("/auth/v1/settings"))
  await page.goto(new URL("sign-in", APP_URL).href)
  await settings
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Continue with/ })).toHaveCount(0)
})

for (const width of [1280, 390]) {
  test(`at ${width}px, the sign-in page with providers and the code step has no accessibility problems`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await fakeSupabase(page, { providers: { github: true, google: true } })
    await page.goto(new URL("sign-in", APP_URL).href)
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible()
    const check = async () => {
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    }
    await check()
    await emailMe(page)
    await expect(page.getByLabel("Code from the email")).toBeVisible()
    await check()
  })
}

test("a consent page without a request says so", async ({ page }) => {
  await fakeAuth(page)
  await page.goto(new URL("oauth/consent", APP_URL).href)
  await expect(page.getByRole("alert")).toContainText("authorization_id")
})

test("the home page shows who is signed in, and signing out forgets the account on this device", async ({ page }) => {
  const seen = await fakeAuth(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  await signInWithPassword(page)

  await expect(page).toHaveURL(APP_URL)
  await expect(page.getByText(`Signed in as ${user.email}`)).toBeVisible()
  const remembered = () => page.evaluate(() => localStorage.getItem("elaborating.offline-account.v1"))
  expect(JSON.parse((await remembered())!)).toMatchObject({ userId: user.id, email: user.email })

  // Sign out is in the account's menu, which the account in the top bar opens.
  await page.getByRole("banner").getByRole("button", { name: `Signed in as ${user.email}` }).click()
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Settings", "Connected agents", "Sign out"])
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
  expect(await remembered()).toBeNull()
  expect(seen.some((request) => new URL(request.url()).pathname.endsWith("/logout"))).toBe(true)
})

test("the signed-out home offers Sign in, Start writing and sign up, and Sign in leads to the sign-in page", async ({ page }) => {
  await fakeAuth(page)
  await page.goto(APP_URL)
  const banner = page.getByRole("banner")
  await expect(banner.getByRole("button", { name: /^Signed in as/ })).toHaveCount(0)
  await expect(banner.getByRole("link", { name: "Start writing" })).toHaveAttribute("href", "/projects/6c0ca1a0-0000-4000-8000-000000000001")
  await expect(page.getByRole("main").getByRole("link", { name: "sign up" })).toHaveAttribute("href", "/sign-up")
  await banner.getByRole("link", { name: "Sign in" }).click()
  await expect(page).toHaveURL(new URL("sign-in", APP_URL).href)
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible()
})

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`in Supabase Green ${scheme} at ${width}px, the home, sign-in and consent pages fit and axe finds nothing`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: scheme })
      const fake = await fakeSupabase(page, { providers: { github: true } })
      await fake.server.remote(user.id).createProject(crypto.randomUUID(), "Notes")
      const check = async () => {
        expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.scheme])).toEqual(["supabase-green", scheme])
        const results = await new AxeBuilder({ page }).analyze()
        expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      }

      await page.goto(APP_URL)
      await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
      await check()
      await page.goto(new URL("sign-in", APP_URL).href)
      await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible()
      await check()

      await signedIn(page)
      await page.goto(APP_URL)
      await expect(page.getByRole("link", { name: "Notes" })).toBeVisible()
      await check()
      await page.goto(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
      await expect(page.getByText("Authorize Claude")).toBeVisible()
      await check()
    })
  }
}
