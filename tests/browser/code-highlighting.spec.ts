import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase, person, signedIn } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"
import { showView } from "./views.ts"

test.describe.configure({ timeout: 60_000 })

const FRAME = 'iframe[title="Isolated document preview"]'
const samples = [
  ["cpp", '#include <iostream>\nint main() { std::cout << "Hello"; return 0; }'],
  ["CPP", 'const int answer = 42; // Case-insensitive fences'],
  ["c++", 'constexpr int answer = 42; // Keep the alias'],
  ["c#", 'public class Example { public string Name => "Ada"; }'],
  ["rs", 'fn main() { let answer = 42; println!("{}", answer); }'],
  ["yml", 'name: "Example"\nenabled: true\ncount: 3'],
  ["shell", '# A shell alias\nexport GREETING="Hello"\necho "$GREETING"'],
  ["mdx", '{(() => { const value = 42; return value; })()}'],
] as const
const intro = "The code and fence spellings stay as written."
const note = `# Common code languages\n\n${intro}\n\n${samples.map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\`\n`).join("\n")}`

async function highlighted(page: Page) {
  const frame = page.frameLocator(FRAME)
  for (const [language, code] of samples) {
    const block = frame.locator(`[data-code-language="${language}"]`)
    const output = block.locator(".document-code-highlight .shiki code")
    await expect(output, language).toHaveText(code)
    // An HTML wrapper alone would pass a text assertion even with a missing
    // grammar. Verify that the browser paints tokens in multiple colors.
    await expect.poll(() => output.locator("span[style]").evaluateAll((tokens) =>
      new Set(tokens.map((token) => getComputedStyle(token).color)).size,
    ), { message: `${language} has colored syntax tokens` }).toBeGreaterThan(1)
    if (language === "mdx") {
      for (const keyword of ["const", "return"]) {
        await expect(output.locator('span[style*="--shiki-token-keyword"]').filter({ hasText: new RegExp(`\\b${keyword}\\b`) }),
          `MDX expression highlights ${keyword} as a keyword`).toHaveCount(1)
      }
    }
  }
}

for (const format of ["md", "mdx"] as const) {
  test(`${format} highlights C++ and common compiled, config and shell aliases without rewriting fences`, async ({ page }) => {
    const fake = await fakeSupabase(page)
    const remote = fake.server.remote(person.id)
    const id = crypto.randomUUID()
    const path = `notes/languages.${format}`
    await remote.createProject(id, "Code languages")
    await remote.saveFiles(id, crypto.randomUUID(), [{ op: "put", path, content: note }])
    await signedIn(page)
    await page.goto(new URL(`projects/${id}/${path}`, APP_URL).href)
    await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({ timeout: 15_000 })

    await showView(page, "Rendered")
    await highlighted(page)
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)

    await showView(page, "Source")
    await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("#include <iostream>")
    await showView(page, "Rendered")
    await highlighted(page)
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)

    // A real rendered edit and save verifies every code byte, delimiter and
    // language alias, rather than merely rereading an unchanged server copy.
    const paragraph = page.frameLocator(FRAME).locator("p").filter({ hasText: intro })
    await paragraph.click()
    await page.keyboard.press("End")
    await page.keyboard.type(" Saved.")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect.poll(() => fake.server.content(id, path)).toBe(note.replace(intro, `${intro} Saved.`))

    await page.reload()
    await showView(page, "Rendered")
    await highlighted(page)
  })
}
