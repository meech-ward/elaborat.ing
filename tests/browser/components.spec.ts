import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { fakeSupabase, person, signedIn, type FakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Components in rendered notes: defined in the note, or imported from other
// project files with `workspace:` specifiers. Modules load from their saved
// copies, run only inside the isolated preview frame, and follow changes made
// in other tabs or brought in by sync.

// Each journey loads the full editor (Monaco and the note frame), which is slow on small CI machines.
test.describe.configure({ timeout: 60_000 })

/** A module whose file name needs care: spaces, and `%`, `#` and `?`, which URLs treat specially. */
const MODULE = "components/Release card 100% #1?.mdx"
const releaseCard = (body = `<section className="release-card"><h3>{title}</h3><p>{count} items, {ready ? "ready" : "waiting"}</p></section>`) => `export const ReleaseCard = ({ title, count, ready }) => ${body}

export const componentMeta = {
  ReleaseCard: {
    description: "Release status",
    props: {
      title: { type: "string", default: "Review" },
      count: { type: "number", default: 3 },
      ready: { type: "boolean", default: true },
    },
  },
}
`
const importCard = `import { ReleaseCard } from "workspace:${MODULE}"\n\n`

const PREVIEW = 'iframe[title="Isolated document preview"]'
const projectUrl = (id: string, path?: string) => new URL(`projects/${id}${path ? `/${path}` : ""}`, APP_URL).href
const frameOf = (page: Page) => page.frameLocator(PREVIEW)
const editorText = (page: Page) => page.locator(".monaco-editor:visible .view-lines").first()
const unsaved = (page: Page, path: string) => page.getByRole("tab", { name: path }).getByLabel("unsaved changes")

async function openProject(page: Page, files: Record<string, string>, path: string, phone = false) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Components")
  await remote.saveFiles(id, crypto.randomUUID(), Object.entries(files).map(([file, content]) => ({ op: "put" as const, path: file, content })))
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  // On a phone the project header (and its status) is in the navigation sheet.
  if (phone) await expect(page.getByRole("button", { name: "Navigation" }).first()).toBeVisible({ timeout: 15_000 })
  else await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  return { fake, id }
}

async function rendered(page: Page) {
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(page.locator(PREVIEW)).toBeVisible()
}

async function save(page: Page) {
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save" }).or(page.getByRole("button", { name: "Save" })).first().click()
}

/** Put the caret at the end of the visible source editor. */
async function endOfSource(page: Page) {
  await editorText(page).click()
  await page.keyboard.press("ControlOrMeta+End")
}

/** Replace the text on the last line of the visible source editor. */
async function replaceLastLine(page: Page, text: string) {
  await endOfSource(page)
  await page.keyboard.press("Shift+Home")
  await page.keyboard.press("Delete")
  if (text) await page.keyboard.type(text)
  await page.keyboard.press("Escape")
}

/** A module saved on the server by another device, announced to the open project. */
async function saveElsewhere(fake: FakeSupabase, id: string, path: string, content: string) {
  const version = fake.server.projects.get(id)!.files.get(path)!.version
  const saved = await fake.server.remote(person.id).saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content, base_version: version }])
  fake.signal(id, saved.project.revision)
}

const aliased = `import { ReleaseCard as Release } from "workspace:${MODULE}"

export const Greeting = ({ name }) => <p className="greeting">Hello, {name}!</p>

<Greeting name="team" />

<Release title="Launch" count={2} ready={false} />
`

test("a local component and an aliased import from an awkwardly named module both render", async ({ page }) => {
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), "notes/aliases.mdx": aliased }, "notes/aliases.mdx")
  await rendered(page)
  const frame = frameOf(page)
  await expect(frame.locator("p.greeting")).toHaveText("Hello, team!")
  await expect(frame.locator("section.release-card h3")).toHaveText("Launch")
  await expect(frame.locator("section.release-card p")).toHaveText("2 items, waiting")
  expect(fake.server.content(id, "notes/aliases.mdx")).toBe(aliased)
})

test("in the source view, typing <Rel offers the imported component with its default props", async ({ page }) => {
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), "notes/source.mdx": importCard }, "notes/source.mdx")
  await endOfSource(page)
  await page.keyboard.type("<Rel")
  const offered = page.getByRole("listbox", { name: "Suggest" }).getByRole("listitem", { name: /^ReleaseCard\b/ })
  // The suggestions can open before the imported module has loaded; ask again until it has.
  await expect(async () => {
    if (!(await offered.isVisible())) await page.keyboard.press("Control+Space")
    await expect(offered).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await page.keyboard.press("Enter")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => fake.server.content(id, "notes/source.mdx")).toBe(`${importCard}<ReleaseCard title="Review" count={3} ready={true} />`)
})

test("the prop controls change the output, and saving changes only those props", async ({ page }) => {
  const note = `${importCard}Fish &amp; chips, as written.\n\n<ReleaseCard title="Review" count={3} ready={true} />\n`
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), "notes/props.mdx": note }, "notes/props.mdx")
  await rendered(page)
  const frame = frameOf(page)
  const card = frame.locator("section.release-card")
  await expect(card.locator("p")).toHaveText("3 items, ready")
  await expect(frame.getByText("Fish & chips, as written.")).toBeVisible()

  const title = frame.getByLabel("ReleaseCard title")
  await title.fill("Ship & tell")
  await title.press("Tab")
  await expect(card.locator("h3")).toHaveText("Ship & tell")
  const count = frame.getByLabel("ReleaseCard count")
  await count.fill("12")
  await count.press("Tab")
  await expect(card.locator("p")).toHaveText("12 items, ready")
  // The checkbox shows the saved value, so it changes once the edit comes back.
  const ready = frame.getByLabel("ReleaseCard ready")
  await ready.click()
  await expect(card.locator("p")).toHaveText("12 items, waiting")
  await expect(ready).not.toBeChecked()

  await save(page)
  await expect.poll(() => fake.server.content(id, "notes/props.mdx")).toBe(
    `${importCard}Fish &amp; chips, as written.\n\n<ReleaseCard title="Ship &amp; tell" count={12} ready={false} />\n`,
  )
})

test("Insert block lists the local and imported components, and inserts one", async ({ page }) => {
  const note = `${importCard}export const Greeting = ({ name }) => <p className="greeting">Hello, {name}!</p>\n\nIntro.\n`
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), "notes/insert.mdx": note }, "notes/insert.mdx")
  await rendered(page)
  const frame = frameOf(page)
  await expect(frame.getByText("Intro.")).toBeVisible()
  await frame.getByRole("button", { name: "+ Insert block" }).click()
  const dialog = frame.getByRole("dialog", { name: "Insert block" })
  const type = dialog.getByLabel("Block type")
  await expect(type.locator("option")).toContainText(["Paragraph", "Greeting", "ReleaseCard"])
  await type.selectOption("ReleaseCard")
  await expect(dialog).toContainText("Release status")
  await dialog.getByRole("button", { name: "Insert", exact: true }).click()
  await expect(frame.locator("section.release-card h3")).toHaveText("Review")
  await expect(frame.locator("section.release-card p")).toHaveText("3 items, ready")

  await save(page)
  await expect.poll(async () => fake.server.content(id, "notes/insert.mdx")?.trimEnd()).toBe(
    `${note.trimEnd()}\n\n<ReleaseCard title="Review" count={3} ready={true} />`,
  )
})

const probe = `import { useEffect, useState } from "react"

export const Probe = () => {
  const [network, setNetwork] = useState("pending")
  useEffect(() => {
    fetch("https://probe.example/data").then(() => setNetwork("network reached"), () => setNetwork("network blocked"))
  }, [])
  let parent = "parent page read"
  try { void window.parent.document.title } catch { parent = "parent page blocked" }
  let storage = "storage written"
  try { localStorage.setItem("probe", "written") } catch { storage = "storage blocked" }
  return <ul className="probe"><li>{parent}</li><li>{storage}</li><li>{network}</li></ul>
}
`

test("inside the preview frame, the parent page, storage and the network are out of reach", async ({ page }) => {
  // Were the request allowed, it would succeed: the test can tell the difference.
  const reached: string[] = []
  await page.route("https://probe.example/**", (route) => {
    reached.push(route.request().url())
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "open" })
  })
  const note = `import { Probe } from "workspace:components/probe.mdx"\n\n<Probe />\n`
  await openProject(page, { "components/probe.mdx": probe, "notes/probe.mdx": note }, "notes/probe.mdx")
  await rendered(page)
  const items = frameOf(page).locator("ul.probe li")
  await expect(items).toHaveText(["parent page blocked", "storage blocked", "network blocked"])
  expect(reached).toEqual([])
})

test("a module that fails to compile or throws hides the frame, and fixing it brings the note back", async ({ page }) => {
  const notePath = "notes/errors.mdx"
  const note = `${importCard}<ReleaseCard title="Launch" count={2} ready={false} />\n`
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), [notePath]: note }, notePath)
  await rendered(page)
  const frame = frameOf(page)
  await expect(frame.locator("section.release-card h3")).toHaveText("Launch")
  await expect(frame.getByLabel("ReleaseCard title")).toBeVisible()
  const alert = page.locator("[data-rendered-editor]").getByRole("alert")

  // Open the module in another tab, and save it broken.
  await page.getByRole("button", { name: "Toggle explorer" }).click()
  await page.getByRole("button", { name: "Expand components", exact: true }).click()
  await page.getByRole("button", { name: MODULE, exact: true }).click()
  await expect(page.getByRole("tab", { name: MODULE })).toHaveAttribute("aria-selected", "true")
  const saveModule = async (lastLine: string) => {
    await page.getByRole("tab", { name: MODULE }).click()
    await replaceLastLine(page, lastLine)
    await save(page)
    await expect(unsaved(page, MODULE)).toHaveCount(0)
    await page.getByRole("tab", { name: notePath }).click()
  }

  await saveModule("export const = 1")
  await expect(alert).toBeVisible()
  await expect(page.locator(PREVIEW)).toBeHidden()
  await expect(frame.getByLabel("ReleaseCard title")).toBeHidden()

  await saveModule("export const missing = notDefined()")
  await expect(alert).toContainText("notDefined")
  await expect(page.locator(PREVIEW)).toBeHidden()
  await expect(frame.getByLabel("ReleaseCard title")).toBeHidden()

  await saveModule("")
  await expect(alert).toBeHidden()
  await expect(frame.locator("section.release-card h3")).toHaveText("Launch")
  await expect(frame.getByLabel("ReleaseCard title")).toBeVisible()
  await expect.poll(() => fake.server.content(id, MODULE)).toBe(releaseCard())
  expect(fake.server.content(id, notePath)).toBe(note)
  await expect(unsaved(page, notePath)).toHaveCount(0)
})

test("a module changed on another device reaches the open note through sync", async ({ page }) => {
  const note = `${importCard}<ReleaseCard title="Launch" count={2} ready={false} />\n`
  const { fake, id } = await openProject(page, { [MODULE]: releaseCard(), "notes/sync.mdx": note }, "notes/sync.mdx")
  await rendered(page)
  const card = frameOf(page).locator("section.release-card")
  await expect(card.locator("p")).toHaveText("2 items, waiting")

  await saveElsewhere(fake, id, MODULE, releaseCard(`<section className="release-card"><h3>{title}</h3><p>{count} to go, {ready ? "ready" : "not yet"}</p></section>`))
  await expect(card.locator("p")).toHaveText("2 to go, not yet")
  await expect(card.locator("h3")).toHaveText("Launch")
  expect(fake.server.content(id, "notes/sync.mdx")).toBe(note)
  await expect(unsaved(page, "notes/sync.mdx")).toHaveCount(0)
})

test("a module saved in another browser tab reaches the open note when its change signal arrives", async ({ page, context }) => {
  const stamp = `export const Stamp = () => <p className="stamp">{version}</p>\n\nexport const version = "one"`
  const notePath = "notes/stamp.mdx"
  const note = `import { Stamp } from "workspace:components/stamp.mdx"\n\n<Stamp />\n`
  const { fake, id } = await openProject(page, { "components/stamp.mdx": stamp, [notePath]: note }, notePath)
  await rendered(page)
  const output = frameOf(page).locator("p.stamp")
  await expect(output).toHaveText("one")

  // The same person edits the module in another tab, which saves it on the device and syncs it.
  const other = await context.newPage()
  await fakeSupabase(other, { server: fake.server })
  await signedIn(other)
  await other.goto(projectUrl(id, "components/stamp.mdx"))
  await expect(other.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await replaceLastLine(other, 'export const version = "two"')
  await save(other)
  await expect.poll(() => fake.server.content(id, "components/stamp.mdx")).toBe(stamp.replace('"one"', '"two"'))

  // The server announces the change, as Realtime does, and the open note follows.
  fake.signal(id, fake.server.projects.get(id)!.revision)
  await expect(output).toHaveText("two")
  expect(fake.server.content(id, notePath)).toBe(note)
})

const TALLY = "components/tally.mdx"
const tally = `import { useEffect, useState as useCount } from "react"

export const Tally = ({ name }) => {
  const [count, setCount] = useCount(0)
  useEffect(() => () => { (window.cleanups ??= []).push(name) }, [name])
  return <button type="button" className="tally" onClick={() => setCount(count + 1)}>{name}: {count}</button>
}
`
const stateNote = `import { useEffect, useState } from "react"
import { Tally } from "workspace:${TALLY}"

export const Toggle = ({ name }) => {
  const [on, setOn] = useState(false)
  useEffect(() => () => { (window.cleanups ??= []).push(name) }, [name])
  return <button type="button" className="toggle" onClick={() => setOn(!on)}>{name} {on ? "on" : "off"}</button>
}

<Toggle name="local" />

<Tally name="imported" />`

/** Names whose effect cleanups have run in the preview frame. */
const cleanups = (page: Page) => frameOf(page).locator(":root").evaluate(() => (window as unknown as { cleanups?: string[] }).cleanups ?? [])
const forgetCleanups = (page: Page) => frameOf(page).locator(":root").evaluate(() => {
  Object.assign(window, { cleanups: [] })
})

test("components keep their own state, clicks never edit the note, and replaced or removed components clean up", async ({ page }) => {
  const notePath = "notes/state.mdx"
  const { fake, id } = await openProject(page, { [TALLY]: tally, [notePath]: stateNote }, notePath)
  await rendered(page)
  const frame = frameOf(page)
  const toggle = frame.locator("button.toggle")
  const counter = frame.locator("button.tally")
  await expect(toggle).toHaveText("local off")
  await expect(counter).toHaveText("imported: 0")

  await counter.click()
  await counter.click()
  await toggle.click()
  await expect(counter).toHaveText("imported: 2")
  await expect(toggle).toHaveText("local on")
  await counter.click()
  await expect(counter).toHaveText("imported: 3")
  await expect(toggle).toHaveText("local on")
  // Clicks are not edits: give any edit time to arrive, then check none did.
  await page.waitForTimeout(500)
  await expect(unsaved(page, notePath)).toHaveCount(0)
  expect(await cleanups(page)).toEqual([])

  // Replace the imported component with another local one.
  await page.getByRole("button", { name: "Source" }).click()
  await replaceLastLine(page, '<Toggle name="swap" />')
  await rendered(page)
  await expect(frame.locator("button.toggle").filter({ hasText: "swap" })).toHaveText("swap off")
  await expect(counter).toHaveCount(0)
  await expect.poll(() => cleanups(page)).toContain("imported")
  await forgetCleanups(page)

  // Remove it again.
  await page.getByRole("button", { name: "Source" }).click()
  await replaceLastLine(page, "")
  await rendered(page)
  await expect(frame.locator("button.toggle")).toHaveText([/^local (on|off)$/])
  await expect.poll(() => cleanups(page)).toContain("swap")
  expect(fake.server.content(id, notePath)).toBe(stateNote)
})

for (const [width, scheme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test.describe(`at ${width}px in ${scheme} mode`, () => {
    const phone = width < 600
    test.use({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, colorScheme: scheme })

    test("components and their prop controls fit, with no accessibility problems", async ({ page }) => {
      await page.addInitScript((scheme) => {
        localStorage.setItem("elaborating.appearance.v1", JSON.stringify({ theme: "supabase-green", scheme }))
      }, scheme)
      await openProject(page, { [MODULE]: releaseCard(), "notes/aliases.mdx": aliased }, "notes/aliases.mdx", phone)
      await rendered(page)
      const frame = frameOf(page)
      await expect(frame.locator("p.greeting")).toHaveText("Hello, team!")
      await expect(frame.locator("section.release-card p")).toHaveText("2 items, waiting")
      await expect(frame.getByLabel("Release title")).toBeVisible()
      expect(await page.locator("html").evaluate((root) => root.classList.contains("dark"))).toBe(scheme === "dark")

      const fits = () => document.documentElement.scrollWidth <= innerWidth + 1
      expect(await page.evaluate(fits)).toBe(true)
      expect(await frame.locator(":root").evaluate(fits)).toBe(true)
      const controls = await new AxeBuilder({ page }).include([PREVIEW, ".custom-component-controls"]).analyze()
      expect(controls.passes.length).toBeGreaterThan(0)
      expect(controls.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
      const everything = await new AxeBuilder({ page }).analyze()
      const serious = everything.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      expect(serious.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([])
    })
  })
}
