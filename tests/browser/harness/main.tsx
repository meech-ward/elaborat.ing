// A test-only page: the real drawing canvas on the synthetic demo scene,
// built with the app's Excalidraw plugins, so browser tests can prove the
// fonts and the font-subset worker work in a production build.
import "@excalidraw/excalidraw/index.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { configureExcalidrawAssets } from "../../../src/features/drawings/assets.ts"
import { DrawingCanvas, exportDrawingSvg, parseDrawingFile } from "../../../src/features/drawings/index.ts"
import demo from "../../../src/features/drawings/fixtures/demo.scene.json"

configureExcalidrawAssets()

const { scene } = parseDrawingFile(JSON.stringify(demo), "demo.excalidraw")

declare global {
  interface Window {
    harness: { exportSvg: () => Promise<string> }
  }
}
window.harness = { exportSvg: () => exportDrawingSvg(scene) }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ width: 1000, height: 700 }}>
      <DrawingCanvas scene={scene} onChange={() => {}} />
    </div>
  </StrictMode>,
)
