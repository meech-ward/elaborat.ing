// A test-only page: the real drawing canvas on a synthetic scene, built with
// the app's Excalidraw plugins. Edits in tests go through Excalidraw's own UI;
// `window.harness` only observes (saved bytes, live canvas pixels, exports)
// and pushes scenes through the canvas's public `scene` prop.
//
// `?drawing=` picks the file: `demo` (the default) is the plain demo scene,
// `obsidian` the compressed Obsidian drawing.
import "@excalidraw/excalidraw/index.css"
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { configureExcalidrawAssets } from "../../../src/features/drawings/assets.ts"
import {
  DrawingCanvas,
  exportDrawingPng,
  exportDrawingSvg,
  parseDrawingFile,
  saveDrawingFile,
  type DrawingScene,
} from "../../../src/features/drawings/index.ts"
import demo from "../../../src/features/drawings/fixtures/demo.scene.json"
import obsidian from "../../../src/features/drawings/fixtures/synthetic.excalidraw.md?raw"

configureExcalidrawAssets()

const drawings: Record<string, { source: string; filename: string }> = {
  demo: { source: `${JSON.stringify(demo, null, 2)}\n`, filename: "demo.excalidraw" },
  obsidian: { source: obsidian, filename: "synthetic.excalidraw.md" },
}
const choice = new URLSearchParams(location.search).get("drawing") ?? "demo"
const drawing = drawings[choice]
if (!drawing) throw new Error(`Unknown drawing: ${choice}`)

let parsed = parseDrawingFile(drawing.source, drawing.filename)
let current = parsed.scene
let changeCount = 0
let handlerError: string | null = null
let setScene: ((scene: DrawingScene) => void) | undefined

function App() {
  const [scene, update] = useState(current)
  useEffect(() => {
    setScene = update
    return () => {
      setScene = undefined
    }
  }, [])
  return (
    <div style={{ width: 1280, height: 800 }}>
      <DrawingCanvas
        scene={scene}
        onChange={(next) => {
          current = next
          changeCount++
          update(next)
        }}
        onError={(error) => {
          handlerError = error
        }}
      />
    </div>
  )
}

// Composite the visible canvas layers in CSS pixels, using their live bounds.
function pixels() {
  const layers = [...document.querySelectorAll<HTMLCanvasElement>(".excalidraw canvas")].filter(
    (canvas) => canvas.width && canvas.height && canvas.getBoundingClientRect().width,
  )
  if (!layers.length) throw new Error("No visible canvas")
  const rect = layers[0].getBoundingClientRect()
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(rect.width)
  canvas.height = Math.round(rect.height)
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  for (const layer of layers) {
    const bounds = layer.getBoundingClientRect()
    context.drawImage(layer, bounds.left - rect.left, bounds.top - rect.top, bounds.width, bounds.height)
  }
  return { context, rect }
}

function colors(data: Uint8ClampedArray) {
  let dark = 0
  let magenta = 0
  let cyan = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++
    if (data[i] > 220 && data[i + 1] < 40 && data[i + 2] > 220) magenta++
    if (data[i] < 40 && data[i + 1] > 220 && data[i + 2] > 220) cyan++
  }
  return { dark, magenta, cyan }
}

const harness = {
  read: () => ({
    current,
    changeCount,
    handlerError,
    saved: saveDrawingFile(current, parsed),
    original: parsed.scene,
    originalSource: parsed.originalSource,
    sourceKind: parsed.sourceKind,
  }),
  push: (scene: DrawingScene) => {
    current = scene
    setScene?.(scene)
  },
  reopen: (text: string) => {
    parsed = parseDrawingFile(text, drawing.filename)
    current = parsed.scene
    setScene?.(current)
  },
  sample: ([x, y, width, height]: number[]) => {
    const { context, rect } = pixels()
    if (x < rect.left || y < rect.top || x + width > rect.right || y + height > rect.bottom) {
      throw new Error("Sample box is outside the canvas")
    }
    return colors(context.getImageData(x - rect.left, y - rect.top, width, height).data)
  },
  /** A 120x120 magenta image with a cyan cross: 10,000 magenta and 4,400 cyan pixels. */
  image: (x: number, y: number) => {
    const canvas = document.createElement("canvas")
    canvas.width = 120
    canvas.height = 120
    const context = canvas.getContext("2d")!
    context.fillStyle = "#ff00ff"
    context.fillRect(0, 0, 120, 120)
    context.fillStyle = "#00ffff"
    context.fillRect(50, 0, 20, 120)
    context.fillRect(0, 50, 120, 20)
    const dataURL = canvas.toDataURL("image/png")
    const element = {
      id: "test-image", type: "image", x, y, width: 120, height: 120, angle: 0,
      strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid",
      roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null,
      seed: 4242, version: 1, versionNonce: 4242, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false, fileId: "test-image-file", status: "saved", scale: [1, 1], crop: null,
    }
    return { element, file: { mimeType: "image/png", id: "test-image-file", dataURL, created: 1 } }
  },
  exportSvg: () => exportDrawingSvg(current),
  exports: async () => {
    const svg = await exportDrawingSvg(current)
    const png = await exportDrawingPng(current)
    const bitmap = await createImageBitmap(png)
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext("2d")!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pngColors = colors(context.getImageData(0, 0, canvas.width, canvas.height).data)
    const signature = [...new Uint8Array(await png.slice(0, 8).arrayBuffer())].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    return { svg, pngColors, signature }
  },
}

declare global {
  interface Window {
    harness: typeof harness
  }
}
window.harness = harness

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
