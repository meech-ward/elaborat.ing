import AxeBuilder from "./axe.ts"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Who a project is shared with, from its menu on the projects home: the owner
// changes roles and removes people, everyone else only sees the list.

const OWNER = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const MEMBER = "6e7f8091-ab2c-4d3e-8f4a-5b6c7d8e9fa0"
const INVITED = "7f8091a2-bc3d-4e4f-9a5b-6c7d8e9fa0b1"

/** A project `owner` owns, shared with MEMBER (accepted, as `role`) and INVITED (not yet accepted, as commenter). */
async function sharedProject(server: FakeProjectServer, owner: string, title: string, role: "viewer" | "editor" = "editor") {
  server.emails.set(OWNER, "owner@example.com")
  server.emails.set(MEMBER, "member@example.com")
  server.emails.set(INVITED, "invited@example.com")
  const id = crypto.randomUUID()
  await server.remote(owner).createProject(id, title)
  server.share(id, MEMBER, role)
  server.invite(id, INVITED, "commenter")
  return id
}

/** Pick a role in a role select (the shadcn select). */
async function chooseRole(scope: Locator, label: string, role: string) {
  await scope.getByLabel(label).click()
  await scope.page().getByRole("option", { name: role, exact: true }).click()
}

async function openMembers(page: Page, title: string) {
  await page.goto(APP_URL)
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible()
  await page.getByRole("button", { name: `Actions for ${title}` }).click()
  await page.getByRole("menuitem", { name: "Members" }).click()
  const dialog = page.getByRole("dialog", { name: `Members of ${title}` })
  await expect(dialog.getByRole("list", { name: "Members" })).toBeVisible()
  return dialog
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
}

test("the owner sees a member and an invitation, changes the member's role, and removes the invitation", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server, person.id, "Team notes")
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  const dialog = await openMembers(page, "Team notes")
  const entries = dialog.getByRole("list", { name: "Members" }).getByRole("listitem")
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(0)).toHaveText("person@example.com (you)Owner")
  await expect(entries).toContainText(["person@example.com", "member@example.com", "invited@example.com"])
  await expect(entries.nth(2)).toContainText("Invited, not yet accepted")
  await expect(dialog.getByLabel("Role for member@example.com")).toContainText("Editor")
  await expect(dialog.getByLabel("Role for invited@example.com")).toContainText("Commenter")
  // The owner's own entry has no controls.
  await expect(entries.nth(0).getByRole("combobox")).toHaveCount(0)
  await expect(entries.nth(0).getByRole("button")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused()
  await expectNoAxeViolations(page)

  await chooseRole(dialog, "Role for member@example.com", "Viewer")
  await expect(dialog.getByRole("status")).toHaveText("member@example.com is now a viewer.")
  expect(server.projects.get(id)!.members.get(MEMBER)?.role).toBe("viewer")
  await expect(dialog.getByLabel("Role for member@example.com")).toContainText("Viewer")

  // Dismissing the confirmation keeps the member.
  page.once("dialog", (confirmation) => void confirmation.dismiss())
  await dialog.getByRole("button", { name: "Remove member@example.com" }).click()
  await expect(entries).toHaveCount(3)
  expect(fake.requests.filter((request) => request.url().endsWith("/rpc/share_project")).map((request) => request.postDataJSON())).toEqual([
    { project_id: id, member_id: MEMBER, member_role: "viewer" },
  ])

  let question = ""
  page.once("dialog", (confirmation) => {
    question = confirmation.message()
    void confirmation.accept()
  })
  await dialog.getByRole("button", { name: "Remove the invitation for invited@example.com" }).click()
  await expect(dialog.getByRole("status")).toHaveText("Removed the invitation for invited@example.com.")
  expect(question).toBe("Remove the invitation for invited@example.com to Team notes?")
  await expect(entries).toHaveCount(2)
  await expect(dialog.getByRole("list", { name: "Members" })).not.toContainText("invited@example.com")
  expect(server.projects.get(id)!.members.has(INVITED)).toBe(false)
  // Focus stays in the dialog, on the list, once the button is gone.
  await expect(dialog.getByRole("list", { name: "Members" })).toBeFocused()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
})

const EDITOR_WARNING = "Editors can change and delete files, and their agents can too."
const shareCalls = (fake: FakeSupabase) =>
  fake.requests.filter((request) => request.url().endsWith("/functions/v1/share")).map((request) => request.postDataJSON())

test("the owner invites an email without an account, after a warning for an editor", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server, person.id, "Team notes")
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  const dialog = await openMembers(page, "Team notes")
  const form = dialog.getByRole("form", { name: "Invite people" })
  await expect(form).toContainText("People without an account get an email to join.")
  await expect(form.getByLabel("Role for the invitation")).toContainText("Viewer")
  await form.getByLabel("Invite by email").fill("new@example.com")
  await chooseRole(form, "Role for the invitation", "Editor")

  // Dismissing the warning invites nobody.
  let question = ""
  page.once("dialog", (confirmation) => {
    question = confirmation.message()
    void confirmation.dismiss()
  })
  await form.getByRole("button", { name: "Invite" }).click()
  await expect.poll(() => question).toBe(`Invite new@example.com to Team notes as an editor? ${EDITOR_WARNING}`)
  expect(shareCalls(fake)).toEqual([])

  page.once("dialog", (confirmation) => void confirmation.accept())
  await form.getByRole("button", { name: "Invite" }).click()
  await expect(dialog.getByRole("status")).toHaveText("Invited new@example.com.")
  expect(shareCalls(fake)).toEqual([{ projectId: id, email: "new@example.com", role: "editor" }])
  expect(server.invitationEmails).toEqual([{ to: "new@example.com", projectId: id, role: "editor" }])
  const entries = dialog.getByRole("list", { name: "Members" }).getByRole("listitem")
  await expect(entries).toHaveCount(4)
  await expect(entries.nth(3)).toContainText("new@example.com")
  await expect(entries.nth(3)).toContainText("Invited, not yet accepted")
  await expect(dialog.getByLabel("Role for new@example.com")).toContainText("Editor")
  await expect(form.getByLabel("Invite by email")).toHaveValue("")
  await expectNoAxeViolations(page)
})

test("the owner invites an existing account as a viewer without a warning, and not someone who already has access", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server, person.id, "Team notes")
  const FRIEND = "8091a2b3-cd4e-4f5a-8b6c-7d8e9fa0b1c2"
  server.emails.set(FRIEND, "friend@example.com")
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  const dialog = await openMembers(page, "Team notes")
  const form = dialog.getByRole("form", { name: "Invite people" })
  let asked = false
  page.on("dialog", (confirmation) => {
    asked = true
    void confirmation.dismiss()
  })

  await form.getByLabel("Invite by email").fill("Friend@Example.com")
  await form.getByRole("button", { name: "Invite" }).click()
  await expect(dialog.getByRole("status")).toHaveText("Invited Friend@Example.com.")
  expect(asked).toBe(false)
  expect(server.projects.get(id)!.members.get(FRIEND)).toMatchObject({ role: "viewer", acceptedAt: null })
  expect(server.invitationEmails).toEqual([])

  await form.getByLabel("Invite by email").fill("member@example.com")
  await form.getByRole("button", { name: "Invite" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("member@example.com already has access. Change their role in the list.")
  expect(shareCalls(fake)).toEqual([{ projectId: id, email: "Friend@Example.com", role: "viewer" }])
})

test("making a member an editor asks first", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server, person.id, "Team notes", "viewer")
  await fakeSupabase(page, { server })
  await signedIn(page)
  const dialog = await openMembers(page, "Team notes")
  let question = ""
  page.once("dialog", (confirmation) => {
    question = confirmation.message()
    void confirmation.dismiss()
  })
  await chooseRole(dialog, "Role for member@example.com", "Editor")
  await expect.poll(() => question).toBe(`Make member@example.com an editor of Team notes? ${EDITOR_WARNING}`)
  await expect(dialog.getByLabel("Role for member@example.com")).toContainText("Viewer")
  expect(server.projects.get(id)!.members.get(MEMBER)?.role).toBe("viewer")

  page.once("dialog", (confirmation) => void confirmation.accept())
  await chooseRole(dialog, "Role for member@example.com", "Editor")
  await expect(dialog.getByRole("status")).toHaveText("member@example.com is now an editor.")
  expect(server.projects.get(id)!.members.get(MEMBER)?.role).toBe("editor")
})

test("a member sees who has access, without controls or invitations", async ({ page }) => {
  const server = new FakeProjectServer()
  const id = await sharedProject(server, OWNER, "Their notes", "viewer")
  server.share(id, person.id, "editor")
  await fakeSupabase(page, { server })
  await signedIn(page)
  const dialog = await openMembers(page, "Their notes")
  await expect(dialog).toContainText("Only its owner can change this.")
  await expect(dialog.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveText([
    "owner@example.comOwner",
    "member@example.comViewer",
    "person@example.com (you)Editor",
  ])
  await expect(dialog.getByRole("combobox")).toHaveCount(0)
  await expect(dialog.getByRole("form")).toHaveCount(0)
  await expect(dialog.getByRole("button")).toHaveText(["Close"])
  await expectNoAxeViolations(page)
})

test("the members of a project need a connection", async ({ page }) => {
  const server = new FakeProjectServer()
  await sharedProject(server, person.id, "Team notes")
  const fake = await fakeSupabase(page, { server })
  await signedIn(page)
  await page.goto(APP_URL)
  await expect(page.getByRole("link", { name: "Team notes" })).toBeVisible()
  fake.offline = true
  await page.getByRole("button", { name: "Actions for Team notes" }).click()
  await page.getByRole("menuitem", { name: "Members" }).click()
  const dialog = page.getByRole("dialog", { name: "Members of Team notes" })
  await expect(dialog.getByRole("alert")).toHaveText("Seeing who a project is shared with needs a connection. Try again when you are online.")
  await expect(dialog.getByRole("list")).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the members dialog fits, and axe finds nothing in it", async ({ page }) => {
    const server = new FakeProjectServer()
    await sharedProject(server, person.id, "Team notes")
    await fakeSupabase(page, { server })
    await signedIn(page)
    const dialog = await openMembers(page, "Team notes")
    await expect(dialog.getByLabel("Role for invited@example.com")).toBeVisible()
    await expectNoAxeViolations(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  })
})
