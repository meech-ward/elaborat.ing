import { configureExcalidrawAssets } from '../features/drawings/assets.ts'
import { parsePreviewJob, type PreviewRenderJob, type PreviewRenderReply } from './protocol.ts'

declare global {
  interface Window {
    renderAgentPreview: (job: PreviewRenderJob) => Promise<PreviewRenderReply>
  }
}

// This entry lives in assets/ inside its immutable renderer folder. Configure
// fonts before loading the native renderer, including its registration effects.
configureExcalidrawAssets(new URL('../excalidraw-assets/', import.meta.url).href)
window.renderAgentPreview = async (input) => {
  const job = parsePreviewJob(input)
  const { renderAgentPreview } = await import('./render.ts')
  return renderAgentPreview(job)
}
document.documentElement.dataset.previewReady = 'true'
