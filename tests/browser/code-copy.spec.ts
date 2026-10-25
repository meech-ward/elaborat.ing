import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const samples = [
  ["cpp", '#include <iostream>\n// [!code highlight:2]\nint main() {\n  const char* html = "<button>& copy</button>"; // [!code focus]\n\n\tstd::cout << html;\n  return 0; // [!code ++]\n}\n\n'],
  ["unknown-copy-language", '  Keep these spaces.  \n\n\t<img src="literal-code.png"> & {expression}'],
  ["", 'first line\n\n  second line\n\tthird line'],
] as const
const note = `# Copyable code\n\n${samples.map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\``).join("\n\n")}\n`

type ClipboardProbe = { writes: string[]; reject: boolean }
type ProbeWindow = Window & { __codeCopyProbe: ClipboardProbe }

/** Exercise the trusted parent bridge without platform clipboard permissions. */
async function clipboardProbe(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return
    const probe: ClipboardProbe = { writes: [], reject: false }
    const target = window as unknown as ProbeWindow
    target.__codeCopyProbe = probe
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          probe.writes.push(text)
          if (probe.reject) throw new DOMException("Clipboard permission refused", "NotAllowedError")
        },
      },
    })
  })
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__codeCopyProbe.writes)
const refuseClipboard = (page: Page, reject: boolean) => page.evaluate((value) => {
  const target = window as unknown as ProbeWindow
  target.__codeCopyProbe.reject = value
}, reject)

async function openNote(page: Page, format: "md" | "mdx", viewer = false) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const path = `notes/code.${format}`
  const remote = fake.server.remote(viewer ? SOMEONE_ELSE : person.id)
  await remote.createProject(id, "Copy code")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content: note }])
  if (viewer) fake.server.share(id, person.id, "viewer")
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Rendered")
  await expect(page.frameLocator(FRAME).locator(".document-code")).toHaveCount(samples.length)
  return { fake, id, path }
}

async function unchanged(page: Page, opened: Awaited<ReturnType<typeof openNote>>) {
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  await expect(page.getByRole("main").getByText("Unsaved changes", { exact: true })).toHaveCount(0)
  expect(opened.fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))).toHaveLength(0)
  expect(opened.fake.server.content(opened.id, opened.path)).toBe(note)
}

for (const format of ["md", "mdx"] as const) {
  test(`${format} copies original highlighted, unknown and unlabelled code without editing the note`, async ({ page }) => {
    await clipboardProbe(page)
    const opened = await openNote(page, format)
    const frame = page.frameLocator(FRAME)
    // Shiki removes annotations from its display. Copy must still include
    // them, with the original indentation, blank lines and literal markup.
    const highlighted = frame.locator('[data-code-language="cpp"] .document-code-highlight .shiki code')
    await expect(highlighted).toContainText("int main()")
    await expect(highlighted).not.toContainText("[!code")
    for (let index = 0; index < samples.length; index++) {
      const block = frame.locator(".document-code").nth(index)
      await block.getByRole("button", { name: "Copy code", exact: true }).click()
      await expect.poll(() => copied(page)).toEqual(samples.slice(0, index + 1).map(([, code]) => code))
      await expect(block.getByRole("status")).toContainText(/copied/i)
      await expect(block.locator("textarea")).toHaveCount(0)
    }
    await unchanged(page, opened)
  })

  test(`${format} reports a refused clipboard write and can retry without changing code`, async ({ page }) => {
    await clipboardProbe(page)
    const opened = await openNote(page, format)
    await refuseClipboard(page, true)
    const block = page.frameLocator(FRAME).locator('[data-code-language="cpp"]')
    await block.getByRole("button", { name: "Copy code", exact: true }).click()
    await expect(block.getByRole("status")).toContainText(/(?:couldn.t|could not|unable to) copy|copy failed/i)
    await expect.poll(() => copied(page)).toEqual([samples[0][1]])
    await unchanged(page, opened)

    await refuseClipboard(page, false)
    await block.getByRole("button", { name: "Copy code", exact: true }).click()
    await expect(block.getByRole("status")).toContainText(/copied/i)
    await expect.poll(() => copied(page)).toEqual([samples[0][1], samples[0][1]])
    await unchanged(page, opened)
  })

  test(`${format} copies the active code draft without leaving its editor or saving it`, async ({ page }) => {
    await clipboardProbe(page)
    const opened = await openNote(page, format)
    const block = page.frameLocator(FRAME).locator('[data-code-language="cpp"]')
    await block.getByRole("button", { name: "Edit code", exact: true }).click()
    const editor = block.getByRole("textbox", { name: "Edit cpp code", exact: true })
    const draft = `${samples[0][1]}  // A draft still being edited.\n\treturn 7;`
    await editor.fill(draft)
    await expect(editor).toBeFocused()

    await block.getByRole("button", { name: "Copy code", exact: true }).click()
    await expect(block.getByRole("status")).toContainText(/copied/i)
    await expect.poll(() => copied(page)).toEqual([draft])
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(draft)
    await expect(block.getByText("Editing code", { exact: true })).toBeVisible()
    expect(opened.fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))).toHaveLength(0)
    expect(opened.fake.server.content(opened.id, opened.path)).toBe(note)
  })

  test(`${format} lets a project viewer copy code while the note remains read-only`, async ({ page }) => {
    await clipboardProbe(page)
    const opened = await openNote(page, format, true)
    const frame = page.frameLocator(FRAME)
    await expect(frame.getByRole("textbox", { name: "Rendered document" })).toHaveAttribute("contenteditable", "false")
    await expect(frame.getByRole("button", { name: "Edit code", exact: true })).toHaveCount(0)
    const block = frame.locator('[data-code-language="cpp"]')
    await block.getByRole("button", { name: "Copy code", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(block.getByRole("status")).toContainText(/copied/i)
    await expect.poll(() => copied(page)).toEqual([samples[0][1]])
    await expect(frame.locator("textarea")).toHaveCount(0)
    await unchanged(page, opened)
  })
}
