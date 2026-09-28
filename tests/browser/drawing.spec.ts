import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { HARNESS_URL } from "./urls.ts"

const dist = path.join(import.meta.dirname, "harness", "dist")
const appDist = path.join(import.meta.dirname, "..", "..", "dist")

test("the canvas draws with fonts from this site and nothing else", async ({ page }) => {
  const errors: string[] = []
  const elsewhere: string[] = []
  const fonts: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => {
    const url = new URL(request.url())
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== new URL(HARNESS_URL).origin) elsewhere.push(url.href)
  })
  page.on("response", (response) => {
    if (response.url().includes("/excalidraw-assets/fonts/") && response.ok()) fonts.push(response.url())
  })
  await page.goto(HARNESS_URL)
  await expect(page.getByTestId("drawing-canvas")).toBeVisible()
  await expect.poll(() => fonts.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.waitForLoadState("networkidle")
  expect(elsewhere).toEqual([])
  expect(errors).toEqual([])
})

// Excalidraw falls back to subsetting on the main thread when its worker
// fails, so the worker itself is checked directly in the next test.
test("SVG export embeds a subset font and starts the bundled worker", async ({ page }) => {
  const workers: string[] = []
  page.on("worker", (worker) => workers.push(worker.url()))
  await page.goto(HARNESS_URL)
  await expect(page.getByTestId("drawing-canvas")).toBeVisible()
  const svg = await page.evaluate(() => window.harness.exportSvg())
  expect(svg).toContain("hello")
  expect(svg).toContain("data:font/woff2;base64,")
  expect(workers.some((url) => /\/subset-worker\.chunk-[^/]*\.js$/.test(url))).toBe(true)
})

// The page and the worker each import it; one file serves both.
test("the font subsetting code ships once, for the page and the worker", async () => {
  for (const build of [dist, appDist]) {
    const assets = (await readdir(path.join(build, "assets"))).filter((file) => file.endsWith(".js"))
    const copies: string[] = []
    for (const name of assets) if ((await readFile(path.join(build, "assets", name), "utf8")).includes("hb_subset_input_create_or_fail")) copies.push(name)
    expect(copies, build).toHaveLength(1)
  }
})

// Excalidraw loads this worker as an ordinary module; bundled as app code it
// pulled the DOM entry in and failed with "document is not defined". This
// sends a real font straight to the built worker.
test("the built font worker returns a real subset font", async ({ page }) => {
  const assets = await readdir(path.join(dist, "assets"))
  const entries: string[] = []
  for (const name of assets.filter((file) => /^subset-worker\.chunk-.*\.js$/.test(file))) {
    if ((await readFile(path.join(dist, "assets", name), "utf8")).includes("onmessage")) entries.push(name)
  }
  expect(entries).toHaveLength(1)
  const fontDir = path.join(dist, "excalidraw-assets", "fonts", "Excalifont")
  const font = (await readdir(fontDir)).find((name) => name.endsWith(".woff2"))
  expect(font).toBeDefined()

  await page.goto(HARNESS_URL)
  const result = await page.evaluate(
    async ({ worker, font }) => {
      const input = await (await fetch(font)).arrayBuffer()
      return new Promise<{ status: string; message?: string; inputBytes?: number; outputBytes?: number; signature?: string }>((resolve) => {
        const subset = new Worker(worker, { type: "module" })
        const done = (value: Parameters<typeof resolve>[0]) => {
          clearTimeout(timer)
          subset.terminate()
          resolve(value)
        }
        const timer = setTimeout(() => done({ status: "timeout" }), 15_000)
        subset.onerror = (event) => done({ status: "error", message: event.message })
        subset.onmessage = ({ data }: MessageEvent<ArrayBuffer>) =>
          done({
            status: "ok",
            inputBytes: input.byteLength,
            outputBytes: data.byteLength,
            signature: String.fromCharCode(...new Uint8Array(data).slice(0, 4)),
          })
        subset.postMessage({ command: "SUBSET", arrayBuffer: input, codePoints: [65, 66, 67] })
      })
    },
    { worker: `/assets/${entries[0]}`, font: `/excalidraw-assets/fonts/Excalifont/${font}` },
  )
  expect(result).toMatchObject({ status: "ok", signature: "wOF2" })
  expect(result.outputBytes).toBeGreaterThan(0)
  expect(result.outputBytes).toBeLessThan(result.inputBytes!)
})
