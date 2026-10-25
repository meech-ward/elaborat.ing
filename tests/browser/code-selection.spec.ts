import { expect, test, type Locator, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const SOMEONE_ELSE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"
const code = 'int main() {\n  const int selected_value = 42;\n  return selected_value;\n}'
const paragraphs = (start: number, length: number) => Array.from({ length }, (_, index) =>
  `Paragraph ${start + index} of the long note, with ordinary editable prose before the code.`,
).join("\n\n")
const note = `# Selecting code\n\n${paragraphs(1, 40)}\n\n\`\`\`cpp\n${code}\n\`\`\`\n\n${paragraphs(41, 10)}\n\n\`\`\`\n${code}\n\`\`\`\n\n${paragraphs(51, 10)}\n`

async function openNote(page: Page, format: "md" | "mdx", viewer: boolean) {
  const fake = await fakeSupabase(page)
  const id = crypto.randomUUID()
  const path = `notes/select.${format}`
  const remote = fake.server.remote(viewer ? SOMEONE_ELSE : person.id)
  await remote.createProject(id, "Code selection")
  await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content: note }])
  if (viewer) fake.server.share(id, person.id, "viewer")
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })
  await showView(page, "Rendered")
  await expect(page.frameLocator(FRAME).locator(".document-code")).toHaveCount(2)
  await expect(page.frameLocator(FRAME).locator('[data-code-language="cpp"] .shiki code')).toHaveText(code)
  return { fake, id, path }
}

type CopyEventProbe = { prevented: boolean; text: string | null }
type ProbeWindow = Window & { __nativeCodeCopies: CopyEventProbe[] }

async function observeNativeCopy(page: Page) {
  await page.frameLocator(FRAME).locator(":root").evaluate(() => {
    const target = window as unknown as ProbeWindow
    target.__nativeCodeCopies = []
    window.addEventListener("copy", (event) => {
      target.__nativeCodeCopies.push({
        prevented: event.defaultPrevented,
        text: event.clipboardData?.getData("text/plain") ?? null,
      })
    })
  })
}

async function nativeCopy(page: Page) {
  const frame = page.frameLocator(FRAME)
  const events = () => frame.locator(":root").evaluate(() => (window as unknown as ProbeWindow).__nativeCodeCopies)
  const before = (await events()).length
  await page.keyboard.press("ControlOrMeta+c")
  await expect.poll(async () => (await events()).length).toBe(before + 1)
  const copied = (await events()).at(-1)!
  expect(copied.prevented, `The native copy path was replaced with ${JSON.stringify(copied.text)}`).toBe(false)
}

const scrollTop = (page: Page) => page.frameLocator(FRAME).locator(":root").evaluate(() => document.scrollingElement!.scrollTop)

/** Read a glyph's position; the selection itself is made by trusted pointer input. */
async function textPoint(page: Page, text: Locator, offset: number) {
  const local = await text.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = offset
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const box = range.getBoundingClientRect()
        return { x: box.x + box.width / 4, y: box.y + box.height / 2 }
      }
      remaining -= length
    }
    throw new Error("The character does not exist")
  }, offset)
  const frame = (await page.locator(FRAME).boundingBox())!
  return { x: frame.x + local.x, y: frame.y + local.y }
}

for (const format of ["md", "mdx"] as const) {
  for (const viewer of [false, true]) {
    test(`${format} ${viewer ? "viewer" : "editor"} can select part of highlighted and plain code without jumping or editing`, async ({ page }) => {
      const opened = await openNote(page, format, viewer)
      const frame = page.frameLocator(FRAME)
      await observeNativeCopy(page)
      for (const language of ["cpp", "text"]) {
        const block = frame.locator(`[data-code-language="${language}"]`)
        if (language === "text") {
          // Keep an old prose selection active near the top before scrolling
          // to plain code, independently of focus left by highlighted code.
          const prose = frame.locator("p").first()
          await prose.scrollIntoViewIfNeeded()
          const start = await textPoint(page, prose, 0)
          const end = await textPoint(page, prose, "Paragraph".length)
          await page.mouse.move(start.x, start.y)
          await page.mouse.down()
          await page.mouse.move(end.x, end.y, { steps: 8 })
          await page.mouse.up()
          await expect.poll(() => frame.locator(":root").evaluate(() => getSelection()?.toString())).toBe("Paragraph")
          if (!viewer) await expect(frame.getByRole("textbox", { name: "Rendered document" })).toBeFocused()
        }
        await block.scrollIntoViewIfNeeded()
        await page.waitForTimeout(100)
        const before = await scrollTop(page)
        expect(before).toBeGreaterThan(1_000)
        const from = code.indexOf("selected_value")
        const to = from + "selected_value".length
        const start = await textPoint(page, block.locator("pre code"), from)
        const end = await textPoint(page, block.locator("pre code"), to)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.waitForTimeout(40)
        const afterDown = await scrollTop(page)
        await page.mouse.move(end.x, end.y, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(200)
        const afterUp = await scrollTop(page)
        const selected = await frame.locator(":root").evaluate(() => getSelection()?.toString())
        expect(Math.abs(afterDown - before), "Pressing the code keeps the reading position").toBeLessThan(5)
        expect(Math.abs(afterUp - before), "Finishing a code selection keeps the reading position").toBeLessThan(5)
        await expect(block.locator("textarea")).toHaveCount(0)
        expect(selected).toBe("selected_value")
        await nativeCopy(page)

        // A double click selects the word instead of entering the code editor.
        const word = await textPoint(page, block.locator("pre code"), from + 3)
        await page.mouse.dblclick(word.x, word.y)
        await expect.poll(() => frame.locator(":root").evaluate(() => getSelection()?.toString())).toBe("selected_value")
        expect(Math.abs(await scrollTop(page) - before)).toBeLessThan(5)
        await expect(block.locator("textarea")).toHaveCount(0)
        await nativeCopy(page)
      }
      await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
      expect(opened.fake.requests.filter((request) => request.url().endsWith("/rpc/save_files"))).toHaveLength(0)
      expect(opened.fake.server.content(opened.id, opened.path)).toBe(note)
    })
  }
}
