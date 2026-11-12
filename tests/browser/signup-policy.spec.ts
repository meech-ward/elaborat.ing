import { expect, test } from "./fixtures.ts"
import { fakeSupabase, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Run against a browser-test build with VITE_SIGNUPS_DISABLED=1 by setting
// ELABORATING_TEST_SIGNUPS_DISABLED=1 on the test runner. The ordinary build
// also exercises the default, public-registration behavior in CI.
const closed = process.env.ELABORATING_TEST_SIGNUPS_DISABLED === "1"

test("the signup route follows account policy while existing accounts still continue to next", async ({ page }) => {
  const fake = await fakeSupabase(page)
  const next = "/agents"
  await page.goto(new URL(`sign-up?next=${encodeURIComponent(next)}`, APP_URL).href)
  if (closed) {
    await expect(page.getByRole("heading", { name: "Accounts are created by an administrator", exact: true })).toBeVisible()
    await expect(page.getByRole("main").locator("form")).toHaveCount(0)
    await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0)
    await expect(page.getByLabel("Repeat password", { exact: true })).toHaveCount(0)
  } else {
    await expect(page.getByRole("heading", { name: "Sign up", exact: true })).toBeVisible()
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible()
    await expect(page.getByLabel("Repeat password", { exact: true })).toBeVisible()
  }
  const signIn = page.getByRole("main").getByRole("link", { name: "Sign in", exact: true })
  await expect(signIn).toHaveAttribute("href", `/sign-in?next=${encodeURIComponent(next)}`)
  await signIn.click()
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  await expect(page.getByRole("main").getByRole("link", { name: "Sign up", exact: true })).toHaveCount(closed ? 0 : 1)
  if (closed) await expect(page.getByText("Accounts are created by an administrator.", { exact: true })).toBeVisible()
  expect(fake.requests.filter(request => new URL(request.url()).pathname.endsWith("/signup"))).toHaveLength(0)

  await signedIn(page)
  await page.goto(new URL(`sign-up?next=${encodeURIComponent(next)}`, APP_URL).href)
  await expect(page).toHaveURL(new URL("agents", APP_URL).href)
})

test("home and local project prompts offer only the available account action", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Write, draw and diagram alongside your agents.", exact: true })).toBeVisible()
  await expect(page.getByRole("main").getByRole("link", { name: "sign up", exact: true })).toHaveCount(closed ? 0 : 1)
  await page.getByRole("main").getByRole("link", { name: "Start writing", exact: true }).click()
  const action = closed ? "Sign in" : "Sign up"
  const destination = closed ? "/sign-in" : "/sign-up"
  for (const purpose of ["create projects", "share", "connect agents"]) {
    await expect(page.getByRole("link", { name: `${action} to ${purpose}`, exact: true })).toHaveAttribute("href", destination)
  }
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "Comments" }).getByRole("link", { name: `${action} to comment`, exact: true })).toHaveAttribute("href", destination)
  if (closed) await expect(page.locator('a[href="/sign-up"]')).toHaveCount(0)
})

test("embedded sign-in follows the same registration policy", async ({ page }) => {
  await fakeSupabase(page)
  // The embed intentionally redirects to the site unless it is framed.
  await page.goto(APP_URL)
  await page.setContent(`<iframe title="Account panel" src="${new URL("embed", APP_URL).href}" style="width:100%;height:800px;border:0"></iframe>`)
  const panel = page.frameLocator('iframe[title="Account panel"]')
  await expect(panel.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Email me a code", exact: true })).toBeVisible()
  const signUp = panel.getByRole("link", { name: "Sign up", exact: true })
  await expect(signUp).toHaveCount(closed ? 0 : 1)
  if (closed) {
    await expect(panel.getByText("Accounts are created by an administrator.", { exact: true })).toBeVisible()
  } else {
    await expect(signUp).toHaveAttribute("target", "_blank")
    await expect(signUp).toHaveAttribute("href", new URL("sign-up", APP_URL).href)
  }
})
