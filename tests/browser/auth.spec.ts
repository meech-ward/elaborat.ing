import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { fakeSupabase, person as user } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Sign-in and an agent's consent request, against the stand-in Supabase in
// fake-supabase.ts (the build points at it through `.env.browser-test`).

const fakeAuth = async (page: import("@playwright/test").Page, decision?: { redirect: string }) =>
  (await fakeSupabase(page, { consentRedirect: decision?.redirect })).requests

test("the sign-in page offers a password and an emailed link, with no accessibility problems", async ({ page }) => {
  await fakeAuth(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible()
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
    await page.getByLabel("Email", { exact: true }).first().fill(user.email)
    await page.getByLabel("Password", { exact: true }).fill("a password")
    await page.getByRole("button", { name: "Sign in" }).click()

    await expect(page).toHaveURL(new URL("oauth/consent?authorization_id=auth-123", APP_URL).href)
    await expect(page.getByText("Authorize Claude")).toBeVisible()
    await expect(page.getByText(user.email)).toBeVisible()
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

test("a consent page without a request says so", async ({ page }) => {
  await fakeAuth(page)
  await page.goto(new URL("oauth/consent", APP_URL).href)
  await expect(page.getByRole("alert")).toContainText("authorization_id")
})

test("the home page shows who is signed in, and signing out forgets the account on this device", async ({ page }) => {
  const seen = await fakeAuth(page)
  await page.goto(new URL("sign-in", APP_URL).href)
  await page.getByLabel("Email", { exact: true }).first().fill(user.email)
  await page.getByLabel("Password", { exact: true }).fill("a password")
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(page).toHaveURL(APP_URL)
  await expect(page.getByText(`Signed in as ${user.email}`)).toBeVisible()
  const remembered = () => page.evaluate(() => localStorage.getItem("elaborating.offline-account.v1"))
  expect(JSON.parse((await remembered())!)).toMatchObject({ userId: user.id, email: user.email })

  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible()
  expect(await remembered()).toBeNull()
  expect(seen.some((request) => new URL(request.url()).pathname.endsWith("/logout"))).toBe(true)
})
