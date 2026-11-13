import { expect, test, type Page } from "./fixtures.ts"
import { fakeSupabase } from "./fake-supabase.ts"
import { APP_URL } from "./urls.ts"

// Project-picker uploads become native embedded bytes with their own identity.
// The same drawing continues to work without the source image or an account.
test.use({ viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 60_000 })
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")

async function newDrawing(page: Page) {
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await page.getByRole("button", { name: "New file", exact: true }).click()
  await page.getByRole("menuitem", { name: "New drawing", exact: true }).click()
  await expect(page.getByRole("textbox", { name: /^Name of the new drawing in / })).toBeFocused()
  await page.keyboard.press("Enter")
  const canvas = page.locator(".excalidraw canvas").first()
  const status = page.locator(".wb-native-view [aria-live]").first()
  await expect(canvas).toBeVisible()
  await expect(status).toContainText("0 elements")
  return { canvas, status }
}

async function exportDrawing(page: Page) {
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Excalidraw", exact: true }).click()
  const stream = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const bytes = Buffer.concat(chunks)
  return {
    bytes,
    scene: JSON.parse(bytes.toString("utf8")) as {
      elements: Array<{ type: string; fileId?: string; isDeleted?: boolean; width: number; height: number }>
      files: Record<string, { dataURL: string; mimeType: string }>
    },
  }
}

async function noisyImageFiles(page: Page, sizes: Array<[number, number]>) {
  const images = await page.evaluate((sizes) => {
    let random = 0x12345678
    return sizes.map(([width, height], index) => {
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")!
      const pixels = context.createImageData(width, height)
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        random ^= random << 13
        random ^= random >>> 17
        random ^= random << 5
        pixels.data[offset] = random & 255
        pixels.data[offset + 1] = (random >>> 8) & 255
        pixels.data[offset + 2] = (random >>> 16) & 255
        pixels.data[offset + 3] = 255
      }
      context.putImageData(pixels, 0, 0)
      return { name: `noise-${index}.png`, data: canvas.toDataURL("image/png").split(",")[1] }
    })
  }, sizes)
  return images.map((image) => ({ name: image.name, mimeType: "image/png", buffer: Buffer.from(image.data, "base64") }))
}

test("dropping several oversized images resizes and compresses the whole batch, with Undo, Save and reload", async ({ page }) => {
  const { canvas, status } = await newDrawing(page)
  const sources = await canvas.evaluate(async (target) => {
    const transfer = new DataTransfer()
    const sources: Array<{ width: number; height: number; bytes: number }> = []
    // Noise prevents PNG's lossless compression from making these originals
    // fit the image/drawing limits by accident. Both are above 5 MiB.
    let random = 0x12345678
    for (const [index, [width, height]] of [[3000, 600], [600, 3000]].entries()) {
      const image = document.createElement("canvas")
      image.width = width
      image.height = height
      const context = image.getContext("2d")!
      const pixels = context.createImageData(width, height)
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        random ^= random << 13
        random ^= random >>> 17
        random ^= random << 5
        pixels.data[offset] = random & 255
        pixels.data[offset + 1] = (random >>> 8) & 255
        pixels.data[offset + 2] = (random >>> 16) & 255
        pixels.data[offset + 3] = 255
      }
      context.putImageData(pixels, 0, 0)
      const blob = await new Promise<Blob>((resolve) => image.toBlob((blob) => resolve(blob!), "image/png"))
      sources.push({ width, height, bytes: blob.size })
      transfer.items.add(new File([blob], `large-${index}.png`, { type: "image/png" }))
    }
    const bounds = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
    return sources
  })
  expect(sources.every((source) => source.bytes > 5 * 1024 * 1024)).toBe(true)
  await expect(status).toContainText("2 elements", { timeout: 20_000 })
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Undo/ }).click()
  await expect(status).toContainText("0 elements")
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Redo/ }).click()
  await expect(status).toContainText("2 elements")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "untitled.excalidraw", exact: true })).toBeVisible()
  await page.reload()
  await expect(canvas).toBeVisible({ timeout: 15_000 })
  await expect(status).toContainText("2 elements")
  const { bytes, scene } = await exportDrawing(page)
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024)
  const images = scene.elements.filter((element) => element.type === "image" && !element.isDeleted)
  expect(images).toHaveLength(2)
  expect(new Set(images.map((image) => image.fileId)).size).toBe(2)
  const decoded = await page.evaluate(async (files) => Promise.all(files.map(async (file) => {
    const image = new Image()
    image.src = file.dataURL
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight, bytes: atob(file.dataURL.split(",")[1]).length }
  })), images.map((image) => scene.files[image.fileId!]))
  for (const [index, image] of decoded.entries()) {
    expect(Math.max(image.width, image.height)).toBeLessThan(3000)
    expect(image.width / image.height).toBeCloseTo(sources[index].width / sources[index].height, 1)
    expect(image.bytes).toBeLessThan(sources[index].bytes / 2)
    expect(images[index].width / images[index].height).toBeCloseTo(image.width / image.height, 1)
  }
})

test("the native image tool uploads multiple files and resized copies retain transparency", async ({ page }) => {
  const { status } = await newDrawing(page)
  const transparent = await page.evaluate(() => {
    const image = document.createElement("canvas")
    image.width = 2000
    image.height = 1000
    const context = image.getContext("2d")!
    context.fillStyle = "#ff0000"
    context.fillRect(0, 0, 1000, 1000)
    return image.toDataURL("image/png").split(",")[1]
  })
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Image", exact: true }).click()
  const files = await chooser
  expect(files.isMultiple()).toBe(true)
  await files.setFiles([
    { name: "transparent.png", mimeType: "image/png", buffer: Buffer.from(transparent, "base64") },
    { name: "pixel.png", mimeType: "image/png", buffer: png },
  ])
  await expect(status).toContainText("2 elements")
  const { scene } = await exportDrawing(page)
  const images = scene.elements.filter((element) => element.type === "image" && !element.isDeleted)
  expect(images).toHaveLength(2)
  expect(scene.files[images[1].fileId!].dataURL).toBe(`data:image/png;base64,${png.toString("base64")}`)
  const resized = scene.files[images[0].fileId!]
  expect(resized.mimeType).toMatch(/^image\/(?:png|webp)$/)
  const pixels = await page.evaluate(async (dataURL) => {
    const image = new Image()
    image.src = dataURL
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d")!
    context.drawImage(image, 0, 0)
    return {
      width: canvas.width,
      height: canvas.height,
      opaque: [...context.getImageData(Math.floor(canvas.width / 4), Math.floor(canvas.height / 2), 1, 1).data],
      transparent: [...context.getImageData(Math.floor(canvas.width * 3 / 4), Math.floor(canvas.height / 2), 1, 1).data],
    }
  }, resized.dataURL)
  expect(pixels.width).toBeLessThan(2000)
  expect(pixels.width / pixels.height).toBe(2)
  expect(pixels.opaque[0]).toBeGreaterThan(245)
  expect(pixels.opaque[3]).toBe(255)
  expect(pixels.transparent[3]).toBe(0)
})

test("the image keyboard shortcut and pasting several files use the same native batch insertion", async ({ page }) => {
  const { canvas, status } = await newDrawing(page)
  await page.locator(".excalidraw").first().focus()
  const chooser = page.waitForEvent("filechooser")
  await page.keyboard.press("9")
  const files = await chooser
  expect(files.isMultiple()).toBe(true)
  await files.setFiles([{ name: "keyboard.png", mimeType: "image/png", buffer: png }])
  await expect(status).toContainText("1 elements")
  await canvas.evaluate((target, valid) => {
    const transfer = new DataTransfer()
    for (const name of ["first.png", "second.png"]) transfer.items.add(new File([Uint8Array.from(atob(valid), (character) => character.charCodeAt(0))], name, { type: "image/png" }))
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })
    Object.defineProperty(event, "clipboardData", { value: transfer })
    target.dispatchEvent(event)
  }, png.toString("base64"))
  await expect(status).toContainText("3 elements")
  const { scene } = await exportDrawing(page)
  const images = scene.elements.filter((element) => element.type === "image" && !element.isDeleted)
  expect(images).toHaveLength(3)
  expect(new Set(images.map((image) => image.fileId)).size).toBe(3)
  for (const image of images) expect(scene.files[image.fileId!].dataURL).toBe(`data:image/png;base64,${png.toString("base64")}`)
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Undo/ }).click()
  await expect(status).toContainText("1 elements")
})

test("the drawing image picker accepts several oversized uploads and prepares each copy before insertion", async ({ page }) => {
  const { status } = await newDrawing(page)
  const files = await noisyImageFiles(page, [[3000, 600], [600, 3000]])
  expect(files.every((file) => file.buffer.length > 5 * 1024 * 1024)).toBe(true)
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Insert image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await picker.getByLabel("Upload images", { exact: true }).setInputFiles(files)
  await expect(picker.getByRole("checkbox", { name: "Decorative image", exact: true })).toBeEnabled({ timeout: 20_000 })
  await expect(picker).toContainText("noise-0.png")
  await picker.getByRole("checkbox", { name: "Decorative image", exact: true }).check()
  await picker.getByRole("button", { name: "Next image", exact: true }).click()
  await expect(picker).toContainText("noise-1.png")
  await picker.getByRole("checkbox", { name: "Decorative image", exact: true }).check()
  await picker.getByRole("button", { name: "Insert 2 images", exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(status).toContainText("2 elements")
  const { bytes, scene } = await exportDrawing(page)
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024)
  expect(scene.elements.filter((element) => element.type === "image" && !element.isDeleted)).toHaveLength(2)
  expect(Object.keys(scene.files)).toHaveLength(2)
  for (const file of Object.values(scene.files)) expect(file.dataURL.length).toBeLessThan(400_000)
})

test("eight noisy images share the drawing byte budget and remain saveable as one batch", async ({ page }) => {
  const { canvas, status } = await newDrawing(page)
  const [source] = await noisyImageFiles(page, [[1000, 600]])
  expect(source.buffer.length * 8).toBeLessThan(20 * 1024 * 1024)
  await canvas.evaluate((target, data) => {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
    const transfer = new DataTransfer()
    for (let index = 0; index < 8; index++) transfer.items.add(new File([bytes], `noise-${index}.png`, { type: "image/png" }))
    const bounds = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
  }, source.buffer.toString("base64"))
  await expect(status).toContainText("8 elements", { timeout: 20_000 })
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "untitled.excalidraw", exact: true })).toBeVisible()
  const { bytes, scene } = await exportDrawing(page)
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024)
  const images = scene.elements.filter((element) => element.type === "image" && !element.isDeleted)
  expect(images).toHaveLength(8)
  expect(new Set(images.map((image) => image.fileId)).size).toBe(8)
  expect(Object.keys(scene.files)).toHaveLength(8)
  for (const image of images) {
    const dataURL = scene.files[image.fileId!].dataURL
    expect(Buffer.from(dataURL.split(",")[1], "base64").length).toBeLessThan(192 * 1024)
  }
})

test("a corrupt image in a dropped batch leaves the drawing unchanged", async ({ page, appErrors }) => {
  appErrors.expect("Choose a PNG, JPEG, WebP, GIF or SVG image.")
  const { canvas, status } = await newDrawing(page)
  await canvas.evaluate((target, valid) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(valid), (character) => character.charCodeAt(0))], "valid.png", { type: "image/png" }))
    transfer.items.add(new File(["broken image"], "corrupt.png", { type: "image/png" }))
    const bounds = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
  }, png.toString("base64"))
  await expect(page.getByRole("alert")).toContainText("Choose a PNG, JPEG, WebP, GIF or SVG image.")
  await expect(status).toContainText("0 elements")
  const { scene } = await exportDrawing(page)
  expect(scene.elements.filter((element) => !element.isDeleted)).toEqual([])
  expect(Object.keys(scene.files ?? {})).toHaveLength(0)
})

test("the image picker creates an independent native drawing image with Undo, Redo, Save and export", async ({ page }) => {
  const modelRequests: string[] = []
  await page.route("**/chatgpt/responses", async route => {
    modelRequests.push(route.request().url())
    await route.abort()
  })
  await fakeSupabase(page)
  await page.goto(APP_URL)
  await page.getByRole("banner").getByRole("link", { name: "Start writing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Local project" })).toBeVisible()
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New note", exact: true }).click()
  await page.getByRole("textbox", { name: /^Name of the new note in / }).fill("image-source.mdx")
  await page.keyboard.press("Enter")
  const source = page.locator(".monaco-editor:visible .view-lines").first()
  await source.click()
  await page.keyboard.type("Before image.\n\nAfter image.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("tab", { name: "image-source.mdx", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Rendered", exact: true }).click()
  const frame = page.frameLocator('iframe[title="Isolated document preview"]:visible')
  await frame.getByText("Before image.", { exact: true }).click({ button: "right" })
  await frame.getByRole("menuitem", { name: "Image", exact: true }).click()
  const sourcePicker = page.getByRole("dialog", { name: "Insert image", exact: true })
  await sourcePicker.getByLabel("Upload images", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png })
  await expect(sourcePicker.getByRole("checkbox", { name: "Decorative image", exact: true })).toBeEnabled()
  await sourcePicker.getByRole("checkbox", { name: "Decorative image", exact: true }).check()
  await sourcePicker.getByRole("button", { name: "Insert image", exact: true }).click()
  await expect(sourcePicker).toBeHidden()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.getByRole("button", { name: "New file" }).click()
  await page.getByRole("menuitem", { name: "New drawing", exact: true }).click()
  await expect(page.getByRole("textbox", { name: /^Name of the new drawing in / })).toBeFocused()
  await page.keyboard.press("Enter")
  const canvas = page.locator(".excalidraw canvas").first()
  const status = page.locator(".wb-native-view [aria-live]").first()
  await expect(canvas).toBeVisible()
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Insert image", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Insert image", exact: true })
  const projectImages = picker.getByLabel("Choose from project", { exact: true })
  const originalPath = (await projectImages.locator("option").last().getAttribute("value"))!
  await projectImages.selectOption(originalPath)
  await expect(picker.getByRole("checkbox", { name: "Decorative image", exact: true })).toBeEnabled()
  await expect(picker.getByRole("button", { name: "Suggest a description", exact: true })).toHaveCount(0)
  await picker.getByRole("checkbox", { name: "Decorative image", exact: true }).check()
  await picker.getByRole("button", { name: "Insert image", exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(status).toContainText("1 elements")
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Undo/ }).click()
  await expect(status).toContainText("0 elements")
  await page.getByRole("button", { name: "More tools", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Redo/ }).click()
  await expect(status).toContainText("1 elements")
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("tab", { name: "untitled.excalidraw", exact: true })).toBeVisible()
  await page.reload()
  await expect(canvas).toBeVisible({ timeout: 15_000 })
  await expect(status).toContainText("1 elements")
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "File actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Excalidraw", exact: true }).click()
  const stream = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const exported = Buffer.concat(chunks).toString("utf8")
  expect(exported).not.toContain(originalPath)
  expect(exported).not.toContain("project-images")
  const drawing = JSON.parse(exported) as { elements: Array<{ type: string; fileId?: string; isDeleted?: boolean }>; files: Record<string, { dataURL: string }> }
  const image = drawing.elements.find((element) => element.type === "image" && !element.isDeleted)!
  expect(image.fileId).toBeTruthy()
  expect(drawing.files[image.fileId!].dataURL).toBe(`data:image/png;base64,${png.toString("base64")}`)
  expect(modelRequests).toEqual([])
})
