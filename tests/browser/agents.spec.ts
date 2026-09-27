import AxeBuilder from "./axe.ts"
import { expect, test } from "@playwright/test"
import { fakeSupabase, signedIn, type OAuthGrant } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// The connected agents page: the agents a person approved, and disconnecting
// one, against Supabase Auth's grant endpoints.

const agentsUrl = new URL("agents", APP_URL).href
const grant = (id: string, name: string, uri: string): OAuthGrant => ({
  client: { id, name, uri, logo_uri: "" },
  scopes: ["email"],
  granted_at: "2026-09-20T15:30:00Z",
})

test("the page lists connected agents, and disconnecting one revokes its grant", async ({ page }) => {
  const fake = await fakeSupabase(page, {
    grants: [grant("client-claude", "Claude", "https://claude.ai"), grant("client-chatgpt", "ChatGPT", "https://chatgpt.com")],
  })
  await signedIn(page)
  await page.goto(agentsUrl)
  const list = page.getByRole("list", { name: "Connected agents" })
  await expect(list.getByRole("listitem")).toHaveCount(2)
  await expect(list.getByRole("listitem").first()).toContainText("Claude")
  await expect(list.getByRole("link", { name: "https://claude.ai" })).toHaveAttribute("rel", "noopener noreferrer")
  await expect(list.getByRole("listitem").first()).toContainText("2026")

  // Declining the confirmation changes nothing.
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "Disconnect Claude" }).click()
  await expect(list.getByRole("listitem")).toHaveCount(2)
  expect(fake.requests.filter((request) => request.method() === "DELETE")).toHaveLength(0)

  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "Disconnect Claude" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Disconnected Claude." })).toBeVisible()
  await expect(list.getByRole("listitem")).toHaveCount(1)
  await expect(list).not.toContainText("Claude")
  const deletes = fake.requests.filter((request) => request.method() === "DELETE")
  expect(deletes.map((request) => new URL(request.url()).searchParams.get("client_id"))).toEqual(["client-claude"])

  // A reload asks Auth again: Claude stays gone.
  await page.reload()
  await expect(page.getByRole("list", { name: "Connected agents" }).getByRole("listitem")).toHaveCount(1)
})

test("with no agents connected, the page says how one gets there", async ({ page }) => {
  await fakeSupabase(page, { grants: [] })
  await signedIn(page)
  await page.goto(agentsUrl)
  await expect(page.getByText("No agents are connected.")).toBeVisible()
})

test("a failed listing says so and can be tried again", async ({ page }) => {
  await fakeSupabase(page, { grants: "error" })
  await signedIn(page)
  await page.goto(agentsUrl)
  await expect(page.getByRole("alert")).toContainText("Could not load connected agents")
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
})

test("a signed-out visitor is asked to sign in and brought back", async ({ page }) => {
  await fakeSupabase(page)
  await page.goto(agentsUrl)
  await expect(page.getByRole("link", { name: "Sign in" }).last()).toHaveAttribute("href", /\/sign-in\?next=%2Fagents/)
})

test("the account header links to the page", async ({ page }) => {
  await fakeSupabase(page, { grants: [] })
  await signedIn(page)
  await page.goto(APP_URL)
  await page.getByRole("link", { name: "Connected agents" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Connected agents" })).toBeVisible()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the page fits, and axe finds nothing", async ({ page }) => {
    await fakeSupabase(page, { grants: [grant("client-long", "An agent with a rather long name for a small screen", "https://example.com/a/very/long/path/that/wraps")] })
    await signedIn(page)
    await page.goto(agentsUrl)
    await expect(page.getByRole("list", { name: "Connected agents" })).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
})
