import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { recordFrameMessages, releaseTransactions } from "./rendered-support.ts"
import { APP_URL } from "./urls.ts"

// What typing in the rendered note does around it, in the app: the note's own
// session follows each keystroke, and nothing else does. The workbench, the
// file list, the screen reader's status, storage reads and the component
// environment stay as they are until something they show changes.

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 1280, height: 900 } })

// The note on screen: a project can keep other notes' frames, hidden.
const FRAME = 'iframe[title="Isolated document preview"]:visible'
const frameOf = (page: Page) => page.frameLocator(FRAME)

/** Click on the line of the paragraph that reads `text`, just past its end: the caret goes after its last character. */
async function caretAfter(page: Page, text: string) {
  const local = await frameOf(page).getByText(text, { exact: true }).evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const box = [...range.getClientRects()].at(-1)!
    return { x: box.right + 6, y: box.top + box.height / 2 }
  })
  const frame = (await page.locator(FRAME).boundingBox())!
  await page.mouse.click(frame.x + local.x, frame.y + local.y)
}

type Typing = {
  commits: number
  transactions: { readonly: number; readwrite: number }
  getAll: number
  posts: Record<string, number>
  status: string[]
  notices: string[]
  environments: number
}

declare global {
  interface Window {
    typing: Typing & { reset(): void }
  }
}

/** From the next load on, count in the page what typing sets off. */
async function countTyping(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return
    const fresh = (): Typing => ({ commits: 0, transactions: { readonly: 0, readwrite: 0 }, getAll: 0, posts: {}, status: [], notices: [], environments: 0 })
    const typing = Object.assign(fresh(), { reset: () => Object.assign(typing, fresh()) })
    window.typing = typing
    // React reports each commit to a devtools hook, when there is one.
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: {
        supportsFiber: true, isDisabled: false, renderers: new Map(),
        inject: () => 1, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {}, setStrictMode: () => {},
        onCommitFiberRoot: () => { typing.commits++ },
      },
    })
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      typing.transactions[args[1] === "readwrite" ? "readwrite" : "readonly"]++
      return transaction.apply(this, args)
    } as IDBDatabase["transaction"]
    const getAll = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
      typing.getAll++
      return getAll.apply(this, args)
    }
    const post = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: Parameters<MessagePort["postMessage"]>) {
      const kind = (args[0] as { kind?: unknown } | null)?.kind
      if (typeof kind === "string") typing.posts[kind] = (typing.posts[kind] ?? 0) + 1
      return post.apply(this, args)
    } as MessagePort["postMessage"]
    // The component environment measures the whole note before it compiles it.
    const encode = TextEncoder.prototype.encode
    TextEncoder.prototype.encode = function (this: TextEncoder, input?: string) {
      if (new Error().stack?.includes("/componentModules-")) typing.environments++
      return encode.call(this, input)
    }
    // The session's two live regions, its status and then its last notice:
    // each text they change to after the first.
    const shown: { status?: string; notice?: string } = {}
    new MutationObserver(() => {
      const [status, notice] = [...document.querySelectorAll(".wb-session > [aria-live]")].map((region) => region.textContent ?? "")
      if (status !== undefined && status !== shown.status) {
        if (shown.status !== undefined) typing.status.push(status)
        shown.status = status
      }
      if (notice !== undefined && notice !== shown.notice) {
        if (shown.notice !== undefined) typing.notices.push(notice)
        shown.notice = notice
      }
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })
}

const projectUrl = (id: string, path: string) => new URL(`projects/${id}/${path}`, APP_URL).href

async function openProject(page: Page, files: Record<string, string>, path: string) {
  await countTyping(page)
  await recordFrameMessages(page)
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, "Notes")
  for (const [file, content] of Object.entries(files)) await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path: file, content }])
  await signedIn(page)
  await page.goto(projectUrl(id, path))
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  return { fake, id }
}

/** Every edit typed so far has been answered (the frame says so once its last edit has an answer). */
async function settled(page: Page) {
  // The last key's edit has started by now.
  await page.waitForTimeout(150)
  await page.waitForFunction(() => window.frameMessages.filter((message) => message.kind === "fluid-pending").at(-1)?.pending === false)
}

/** Put the caret after `text`'s last character and type one character, so the note is already unsaved. */
async function startTyping(page: Page, text: string) {
  await caretAfter(page, text)
  await page.keyboard.type(" ")
  await settled(page)
  await expect(page.getByRole("tab", { name: /, unsaved changes$/ })).toBeVisible()
  // The first edit's draft gives the file its unsaved marker in the list.
  await page.waitForTimeout(500)
}

/** Type `text` key by key, as a person does, and count what it set off. */
async function typed(page: Page, text: string): Promise<Typing> {
  await page.evaluate(() => window.typing.reset())
  await page.keyboard.type(text, { delay: 100 })
  await settled(page)
  // Whatever the last edit started afterwards (a draft write, the next checks) has finished.
  await page.waitForTimeout(800)
  return page.evaluate(() => {
    const { reset: _reset, ...counts } = window.typing
    void _reset
    return JSON.parse(JSON.stringify(counts)) as Typing
  })
}

test("typing in the rendered note renders its session only, and lists, reads and announces nothing", async ({ page }) => {
  await openProject(page, {
    "a.md": "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n",
    "b.md": "# Other\n",
    "sketch.excalidraw": '{"type":"excalidraw","version":2,"elements":[]}',
  }, "a.md")
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  // Another note open behind it.
  await page.getByRole("button", { name: "b.md", exact: true }).click()
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "a.md" }).click()
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  await startTyping(page, "First paragraph.")
  const counts = await typed(page, "abcdefghij")
  await expect(frameOf(page).getByText("First paragraph. abcdefghij", { exact: true })).toBeVisible()
  // About nine commits a keystroke before; two now: the edit's, and the rendered view's own.
  expect(counts.commits).toBeLessThanOrEqual(25)
  // A draft write a keystroke, and nothing read back: no list, no image.
  expect(counts.transactions.readonly).toBe(0)
  expect(counts.transactions.readwrite).toBeLessThanOrEqual(10)
  expect(counts.getAll).toBe(0)
  // The status said "Unsaved changes" before, and still does; no notice came.
  expect(counts.status).toEqual([])
  expect(counts.notices).toEqual([])
  await expect(page.locator(".wb-session > [aria-live]").first()).toHaveText("Unsaved changes")
  // The paths the note may embed reach the frame at most once a keystroke, not once a render.
  expect(counts.posts["authoring-paths"] ?? 0).toBeLessThanOrEqual(10)
  expect(counts.posts.images ?? 0).toBeLessThanOrEqual(10)
})

test("typing prose into an MDX note without code compiles no component environment", async ({ page }) => {
  await openProject(page, { "notes/plain.mdx": "# Plain\n\nFirst paragraph.\n\n<Callout type=\"info\">A note with a built-in component.</Callout>\n" }, "notes/plain.mdx")
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  // Opening the note compiled its environment once.
  expect(await page.evaluate(() => window.typing.environments)).toBeGreaterThan(0)
  await startTyping(page, "First paragraph.")
  const counts = await typed(page, "abcdefgh")
  await expect(frameOf(page).getByText("First paragraph. abcdefgh", { exact: true })).toBeVisible()
  expect(counts.environments).toBe(0)
  expect(counts.commits).toBeLessThanOrEqual(20)
})

test("typing prose into an MDX note with code compiles its component environment once the typing pauses", async ({ page }) => {
  await openProject(page, { "notes/code.mdx": "# Code\n\nFirst paragraph.\n\n<Counter initial={3} />\n\n```js\nconst value = { a: 1 }\n```\n" }, "notes/code.mdx")
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  await startTyping(page, "First paragraph.")
  const counts = await typed(page, "abcdefgh")
  await expect(frameOf(page).getByText("First paragraph. abcdefgh", { exact: true })).toBeVisible()
  // Its braces could be code, so the text is compiled: once it pauses, not once a keystroke.
  expect(counts.environments).toBeGreaterThanOrEqual(1)
  expect(counts.environments).toBeLessThanOrEqual(2)
})

test("an edit that keeps waiting shows as finishing in the status and the file's menu, and stops once it lands", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n" }, "a.md")
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  const status = page.locator(".wb-session > [aria-live]").first()
  await expect(status).toHaveText("Saved")
  await caretAfter(page, "First paragraph.")
  await page.evaluate(() => { window.transactionGate.enabled = true })
  await page.keyboard.type(" More.")
  await page.waitForFunction(() => window.transactionGate.held.length > 0)
  // Held back, the edit has waited long enough to show.
  await expect(status).toHaveText("Finishing edit…")
  await page.getByRole("button", { name: "File actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Format" })).toBeDisabled()
  await expect(page.getByRole("menuitem", { name: "Export to Notion" })).toBeDisabled()
  await releaseTransactions(page)
  await expect(status).toHaveText("Unsaved changes")
  await expect(page.getByRole("menuitem", { name: "Format" })).toBeEnabled()
  await expect(page.getByRole("menuitem", { name: "Save" })).toBeEnabled()
  await page.getByRole("menuitem", { name: "Save" }).click()
  await expect.poll(() => fake.server.content(id, "a.md")).toBe("# Title\n\nFirst paragraph. More.\n")
  await expect(status).toHaveText("Saved")
  // The save's notice is said once, in a region of its own.
  await expect(page.locator(".wb-session > [aria-live]").nth(1)).toHaveText("Saved a.md.")
  expect((await page.evaluate(() => window.typing.status)).filter((text) => text === "Finishing edit…")).toHaveLength(1)
})

/** Hold the edit of the next key, and choose `item` from the file's menu before that edit shows as finishing. */
async function chooseAsEditStarts(page: Page, key: string, item: string) {
  await page.evaluate(() => { window.transactionGate.enabled = true })
  await page.keyboard.type(key)
  await page.waitForFunction(() => window.transactionGate.held.length > 0)
  await page.getByRole("button", { name: "File actions" }).click()
  // The menu offers it in the edit's first moments: chosen now, it has to wait.
  const offered = await page.getByRole("menuitem", { name: item, exact: true }).evaluate((element) => {
    const on = element.getAttribute("aria-disabled") !== "true"
    ;(element as HTMLElement).click()
    return on
  })
  expect(offered).toBe(true)
  expect(await page.evaluate(() => window.transactionGate.held.length)).toBeGreaterThan(0)
  await releaseTransactions(page)
}

test("Format and Export to Notion chosen in an edit's first moments wait for the edit, then run with it", async ({ page }) => {
  const { fake, id } = await openProject(page, { "a.md": "# Title\n\nFirst paragraph.\n\n* one\n* two\n" }, "a.md")
  await expect(frameOf(page).getByText("First paragraph.", { exact: true })).toBeVisible()
  const [status, notice] = [page.locator(".wb-session > [aria-live]").first(), page.locator(".wb-session > [aria-live]").nth(1)]
  await caretAfter(page, "First paragraph.")
  await chooseAsEditStarts(page, "X", "Format")
  // Prettier's bullets, and the edit in the formatted text.
  await expect(notice).toHaveText("Formatted with Prettier.")
  await expect(status).toHaveText("Unsaved changes")
  await page.getByRole("button", { name: "File actions" }).click()
  await page.getByRole("menuitem", { name: "Save", exact: true }).click()
  await expect.poll(() => fake.server.content(id, "a.md")).toBe("# Title\n\nFirst paragraph.X\n\n- one\n- two\n")
  await expect(status).toHaveText("Saved")

  await caretAfter(page, "First paragraph.X")
  await chooseAsEditStarts(page, "Y", "Export to Notion")
  await expect(page.getByRole("dialog", { name: "Export to Notion", exact: true })).toBeVisible()
  await expect(notice).not.toHaveText("Finishing edit…")
  await expect(status).toHaveText("Unsaved changes")
})

test("typing beside an image reads it once, and gives the note frame the same pixels", async ({ page }) => {
  // A new project, a note and an upload before the typing.
  test.slow()
  await countTyping(page)
  await recordFrameMessages(page)
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible()
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("pictures.mdx")
  await page.keyboard.press("Enter")
  const lines = page.locator(".monaco-editor:visible .view-lines").first()
  await expect(lines).toBeVisible()
  await lines.click()
  await page.keyboard.type("# Pictures\n\nAnchor paragraph.\n\nAfter paragraph.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "pictures.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  const frame = frameOf(page)
  await frame.getByText("Anchor paragraph.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menu", { name: "Insert block" }).getByRole("menuitem", { name: "Image", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Insert image", exact: true })
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")
  await dialog.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "red.png", mimeType: "image/png", buffer: png })
  await dialog.getByLabel("Image description", { exact: true }).fill("A red pixel")
  await dialog.getByRole("button", { name: "Insert image", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(frame.getByRole("img", { name: "A red pixel", exact: true })).toBeVisible()
  await startTyping(page, "After paragraph.")
  const counts = await typed(page, "abcdefgh")
  await expect(frame.getByText("After paragraph. abcdefgh", { exact: true })).toBeVisible()
  await expect(frame.getByRole("img", { name: "A red pixel", exact: true })).toBeVisible()
  // Each keystroke wrote its draft and read nothing: not the image, not the list.
  expect(counts.transactions.readonly).toBe(0)
  // Two image posts a keystroke before (the new text, then the same pixels again): now at most the new text's.
  expect(counts.posts.images ?? 0).toBeLessThanOrEqual(8)
})
