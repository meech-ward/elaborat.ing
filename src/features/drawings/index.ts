// Public entry point for the native drawings feature.
//
// Native Excalidraw scene read/write/summary helpers plus the controlled
// React canvas. The workbench wires routes, saves and versions; the D2
// diagram feature consumes the scene types below without duplicating them.
//
// The canvas and SVG/PNG export need @excalidraw/excalidraw (pinned in
// package.json) plus one CSS import in the app bundle:
//   import "@excalidraw/excalidraw/index.css";
// Pure helpers (parse/serialize/summary/diff) need only lz-string, for
// Obsidian compressed fences.

export type {
  BinaryFileData,
  DrawingCanvasProps,
  DrawingCanvasTheme,
  DrawingChangeKind,
  DrawingElement,
  DrawingScene,
  DrawingSourceKind,
  DrawingSummary,
  DrawingSummaryArrow,
  DrawingSummaryText,
  ExportDrawingOptions,
  ParsedDrawing,
  SaveDrawingResult,
  SceneDiff,
  SceneElementFieldChange,
} from './types.ts';

export { DURABLE_APP_STATE_KEYS } from './types.ts';

export type { LibraryMergeResult, LibrarySnapshot } from './merge.ts';
export { mergeLibraryUpdate, snapshotLibraryState } from './merge.ts';
export { parseDrawingFile } from './parse.ts';
export {
  diffDrawingScenes,
  durableAppState,
  fingerprintScene,
  saveDrawingFile,
  scenesEqual,
  serializeDrawing,
} from './serialize.ts';
export { summarizeDrawing } from './summary.ts';
export { EXCALIDRAW_VERSION, exportDrawingPng, exportDrawingSvg } from './export.ts';
export { DrawingCanvas } from './DrawingCanvas.tsx';
