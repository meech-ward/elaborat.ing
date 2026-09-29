// Native SVG/PNG export through the installed Excalidraw package.
//
// Browser-only: both functions need the @excalidraw/excalidraw runtime
// and DOM APIs (XMLSerializer for SVG,
// canvas for PNG). They dynamically import the package so unit tests and
// the Node/Bun side never load it; failures throw descriptive Errors.
// Exported SVG inlines fonts by default, so output is self-contained and
// never references a CDN.

import type { DrawingScene, ExportDrawingOptions } from './types.ts';

// Pinned native package this feature was built and tested against
// (the same version is pinned in package.json).
export const EXCALIDRAW_VERSION = '0.18.1';

interface NativeExporters {
  exportToSvg: (opts: {
    elements: unknown;
    appState?: unknown;
    files: unknown;
    exportPadding?: number;
  }) => Promise<SVGSVGElement>;
  exportToBlob: (opts: {
    elements: unknown;
    appState?: unknown;
    files: unknown;
    mimeType?: string;
    exportPadding?: number;
    getDimensions?: (width: number, height: number) => { width: number; height: number };
  }) => Promise<Blob>;
}

async function loadExporters(): Promise<NativeExporters> {
  let mod: Record<string, unknown>;
  try {
    // Must stay @ts-ignore (not @ts-expect-error): unit tests typecheck
    // this module whether or not the package's types resolve.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- reason above
    // @ts-ignore - see above.
    mod = (await import('@excalidraw/excalidraw')) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `drawing export needs @excalidraw/excalidraw@${EXCALIDRAW_VERSION} in a browser bundle ` +
        `(npm/bun add @excalidraw/excalidraw@${EXCALIDRAW_VERSION}, then import the component): ${detail}`,
    );
  }
  if (typeof mod['exportToSvg'] !== 'function' || typeof mod['exportToBlob'] !== 'function') {
    throw new Error(
      `drawing export needs @excalidraw/excalidraw@${EXCALIDRAW_VERSION} ` +
        `with exportToSvg/exportToBlob; the loaded copy has neither`,
    );
  }
  return mod as unknown as NativeExporters;
}

function assertExportable(scene: DrawingScene): void {
  if (typeof scene !== 'object' || scene === null || !Array.isArray(scene.elements)) {
    throw new Error('invalid scene: expected { type, version, elements: [] }');
  }
  if (scene.elements.length === 0) {
    throw new Error('cannot export an empty drawing: the scene holds no elements');
  }
}

function exportAppState(scene: DrawingScene, options?: ExportDrawingOptions): unknown {
  const base =
    scene.appState !== undefined && scene.appState !== null
      ? { ...scene.appState }
      : {};
  (base as Record<string, unknown>)['theme'] =
    options?.theme ?? (base as Record<string, unknown>)['theme'] ?? 'light';
  return base;
}

/**
 * Export the scene as a self-contained SVG string (fonts inlined, no CDN
 * references). Rejects with a descriptive Error outside a browser bundle
 * or when the native package is missing.
 */
export async function exportDrawingSvg(
  scene: DrawingScene,
  options?: ExportDrawingOptions,
): Promise<string> {
  assertExportable(scene);
  // The mask repair loads with the exporter, off the project page's first paint.
  const [{ exportToSvg }, { repairNativeSvgMasks }] = await Promise.all([loadExporters(), import('./svgMask.ts')]);
  const svg = await exportToSvg({
    elements: scene.elements,
    appState: exportAppState(scene, options),
    files: scene.files ?? null,
    exportPadding: options?.padding ?? 10,
  });
  if (typeof XMLSerializer === 'undefined') {
    throw new Error('drawing export needs a browser DOM (XMLSerializer is unavailable)');
  }
  repairNativeSvgMasks(svg);
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Export the scene as a PNG Blob via the native renderer. Options.scale
 * scales both dimensions (default 1). Rejects with a descriptive Error
 * outside a browser bundle or when the native package is missing.
 */
export async function exportDrawingPng(
  scene: DrawingScene,
  options?: ExportDrawingOptions,
): Promise<Blob> {
  assertExportable(scene);
  const scale = options?.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`invalid export scale: expected a positive number, got ${String(scale)}`);
  }
  const { exportToBlob } = await loadExporters();
  return exportToBlob({
    elements: scene.elements,
    appState: exportAppState(scene, options),
    files: scene.files ?? null,
    mimeType: 'image/png',
    exportPadding: options?.padding ?? 10,
    getDimensions: (width: number, height: number) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    }),
  });
}
