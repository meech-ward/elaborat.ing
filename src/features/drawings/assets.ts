// Excalidraw loads its fonts from a CDN unless told otherwise. The build
// copies the pinned package's fonts to /excalidraw-assets/ on this site
// (vite-plugins/native-font-assets.ts), so drawings work offline and no
// font request leaves the site.

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

/** The absolute URL of this site's Excalidraw assets, correct under any route. */
export function excalidrawAssetBase(): string {
  return new URL(`${import.meta.env?.BASE_URL ?? "/"}excalidraw-assets/`, window.location.origin).href
}

/** Point Excalidraw at this site's fonts. Call once at startup, before a drawing opens. */
export function configureExcalidrawAssets(): void {
  window.EXCALIDRAW_ASSET_PATH = excalidrawAssetBase()
}
