// Native scene types for the drawings feature.
//
// These are project-owned structural types shaped like the public
// @excalidraw/excalidraw element envelope (v0.18.1, checked against its
// published types), NOT static imports of that package, so this module
// typechecks and unit-tests without loading it. Real package elements are assignable
// to DrawingElement, and DrawingScene converts 1:1 to the package
// ExcalidrawInitialDataState ({ elements, appState, files }).
//
// Losslessness rule: every object type below carries an index signature,
// so unknown present or future native fields (customData, link, locked,
// seed, versionNonce, per-element extras, top-level extras) survive
// parse, in-memory edits and serialize untouched.

/** One native canvas element. Unknown fields are preserved, never stripped. */
export interface DrawingElement {
  id: string;
  type: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

/** Binary file record (images), keyed by file id in DrawingScene.files. */
export interface BinaryFileData {
  mimeType: string;
  id: string;
  dataURL: string;
  created: number;
  [key: string]: unknown;
}

/**
 * A native drawing scene: the authority for one standalone or referenced
 * drawing. The same scene powers both uses; the shell resolves references
 * to the same file.
 */
export interface DrawingScene {
  /** Native marker. Always "excalidraw". */
  type: 'excalidraw';
  /** Native file version (current native files use 2). */
  version: number;
  /** Elements in canvas order. Order is significant and preserved. */
  elements: DrawingElement[];
  /** Canvas preferences persisted with the file. Unknown keys preserved. */
  appState?: Record<string, unknown>;
  /** Image/file payloads keyed by file id. Preserved verbatim. */
  files?: Record<string, BinaryFileData>;
  /** Native exporter marker (the JSON `source` URL). Preserved verbatim. */
  source?: string;
  /** Unknown top-level fields from the parsed file. Merged back on save. */
  extra?: Record<string, unknown>;
}

/** How a drawing source string was parsed. */
export type DrawingSourceKind =
  | 'excalidraw-json'
  | 'obsidian-compressed'
  | 'obsidian-json';

/**
 * The only app-state keys that are durable canvas preferences. Everything
 * else the native library reports (scroll, zoom, selection, collaborators,
 * hover, active tool) is ephemeral and must never dirty the saved file.
 */
export const DURABLE_APP_STATE_KEYS = ['theme', 'viewBackgroundColor'] as const;

/** Result of parsing one drawing file. Originals are never mutated. */
export interface ParsedDrawing {
  scene: DrawingScene;
  sourceKind: DrawingSourceKind;
  /** The exact input text; returned verbatim by saveDrawingFile on no-op. */
  originalSource: string;
}

/** One text leaf: raw text only, never interpreted meaning. */
export interface DrawingSummaryText {
  id: string;
  text: string;
}

/** One arrow: raw binding endpoints only, never interpreted meaning. */
export interface DrawingSummaryArrow {
  id: string;
  startElementId: string | null;
  endElementId: string | null;
  /** Which ends carry a native binding. */
  bound: 'both' | 'start' | 'end' | 'none';
  /** True when a binding references an element id absent from the scene. */
  dangling: boolean;
}

/**
 * Agent-readable scene facts: raw text, ids, shapes, positions, styles,
 * bindings and dangling arrows. Summaries never invent meaning and never
 * drop geometry: points/pressures stay in the saved scene, not here.
 */
export interface DrawingSummary {
  elementCount: number;
  activeCount: number;
  deletedCount: number;
  byType: Record<string, number>;
  /** All element ids in canvas order, including deleted ones. */
  ids: string[];
  texts: DrawingSummaryText[];
  /** Null for a scene with no positioned active elements. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  arrows: DrawingSummaryArrow[];
  /** Arrow ids whose binding points at a missing element id. */
  danglingArrows: string[];
  /** Arrow ids with no bindings at all: loose annotations, preserved as-is. */
  looseArrows: string[];
  groupIds: string[];
  frameIds: string[];
  imageIds: string[];
  hasImages: boolean;
  strokeColors: string[];
  backgroundColors: string[];
  /** Element ids carrying a customData payload. */
  customDataElementIds: string[];
}

/** One changed field on one surviving element. */
export interface SceneElementFieldChange {
  id: string;
  field: string;
  before: unknown;
  after: unknown;
}

/** Field-level diff between two scenes. Empty diff means no-op. */
export interface SceneDiff {
  addedElementIds: string[];
  removedElementIds: string[];
  changedElements: SceneElementFieldChange[];
  appStateChanged: boolean;
  /** File ids added, removed or replaced. */
  filesChanged: string[];
  empty: boolean;
  /** True when changedElements hit the cap and further fields were skipped. */
  truncated: boolean;
}

/** Result of saving: canonical text, or the original text on no-op. */
export interface SaveDrawingResult {
  text: string;
  noop: boolean;
  /** Null on no-op; the field-level diff otherwise. */
  diff: SceneDiff | null;
}

/** Options for SVG/PNG export. All fields optional. */
export interface ExportDrawingOptions {
  /** Canvas padding around content in px. Default 10. */
  padding?: number;
  /** Export scale for PNG. Default 1. */
  scale?: number;
  theme?: DrawingCanvasTheme;
}

export type DrawingCanvasTheme = 'light' | 'dark';

/**
 * Why onChange fired. "authored" is a real user edit; the component never
 * forwards restoration noise (the updates Excalidraw emits on load), so a
 * no-op reopen produces no callback at all.
 */
export type DrawingChangeKind = 'authored';

/** Props for the controlled native canvas. Shell owns scene + saves. */
export interface DrawingCanvasProps {
  /** Controlled scene. A new identity from outside is applied to the canvas. */
  scene: DrawingScene;
  /** Fires only for authored changes, with the next full scene. */
  onChange?: (next: DrawingScene, kind: DrawingChangeKind) => void;
  theme?: DrawingCanvasTheme;
  /** Compact chrome for referenced/embedded drawings. Default false. */
  active?: boolean;
  embedded?: boolean;
  autoFocus?: boolean;
  /** Hides editing UI; the canvas stays pannable/zoomable. Default false. */
  viewOnly?: boolean;
  onError?: (message: string) => void;
}
