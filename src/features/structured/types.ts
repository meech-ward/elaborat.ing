/**
 * Shared types for the structured-diagram (D2) feature.
 *
 * The D2 input types below describe the measured subset of
 * `result.diagram` returned by `@terrastruct/d2` (measured from real
 * compiler output). They are intentionally narrow: only fields the
 * emitter reads. Unknown D2 fields pass through untouched inside the
 * fixture JSON and are ignored, never trusted.
 *
 * The native scene types mirror the Excalidraw element JSON shape measured
 * from real Excalidraw output (arrow bindings
 * as `{ elementId, focus, gap }`, bound text via `containerId` +
 * `boundElements`). This feature owns the compatible envelope only; the
 * drawings feature owns validation and canvas behaviour.
 */

export type StructuredLanguage = 'd2';

/** A 2D point as returned by D2 (`{ x, y }`) and used for arrow routes. */
export type AngularPoint = { x: number; y: number };

/** One measured column cell inside a D2 `sql_table` shape. */
export type D2TableCell = {
  label?: string;
};

/** One measured column of a D2 `sql_table` shape. */
export type D2TableColumn = {
  name?: D2TableCell;
  type?: D2TableCell;
  constraint?: string[] | null;
};

/** Measured subset of one D2 shape. */
export type D2Shape = {
  id: string;
  type: string;
  pos: AngularPoint;
  width: number;
  height: number;
  label?: string;
  /** D2-measured label box (font metrics), when the compiler provides it. */
  fontSize?: number;
  labelWidth?: number;
  labelHeight?: number;
  /** Column data for `sql_table` shapes; absent on other types. */
  columns?: D2TableColumn[];
  /**
   * Colours. D2 gives a theme colour code (`B6`, `N1`, `AA4`) unless the
   * source sets one (`style.fill`, `style.stroke`, `style.font-color`): a hex
   * code, a named colour or a gradient. `color` is the label text.
   */
  fill?: string;
  stroke?: string;
  color?: string;
};

/** Measured subset of one D2 connection. */
export type D2Connection = {
  id: string;
  src: string;
  dst: string;
  srcArrow?: string;
  dstArrow?: string;
  label?: string;
  labelPosition?: string;
  fontSize?: number;
  labelWidth?: number;
  labelHeight?: number;
  route?: AngularPoint[];
  /** True means route contains Bezier control points, not elbow waypoints. */
  isCurve?: boolean;
  /** Line and label text colours, as on {@link D2Shape}. */
  stroke?: string;
  color?: string;
};

/** Measured subset of `result.diagram` from `@terrastruct/d2`. */
export type D2Diagram = {
  shapes?: D2Shape[];
  connections?: D2Connection[];
};

/** One native scene element: Excalidraw-compatible JSON, no functions. */
export type ExcalidrawElementSkeleton = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Native scene envelope: the element list is the authority. Canvas
 * preferences, image payloads and any other root fields ride along and
 * are preserved verbatim by merge and reset (which only rewrite
 * `elements`).
 */
export type NativeScene = {
  elements: ExcalidrawElementSkeleton[];
  /** Canvas preferences persisted with the drawing. Preserved verbatim. */
  appState?: Record<string, unknown>;
  /** Image/file payloads keyed by file id. Preserved verbatim. */
  files?: Record<string, unknown>;
  /** Unknown root fields from the editor scene. Preserved verbatim. */
  [key: string]: unknown;
};

export type Diagnostic = {
  /** error blocks the compile; warning degrades one element; info is context. */
  severity: 'error' | 'warning' | 'info';
  /** Stable machine code, e.g. 'd2/syntax', 'emit/shape-fallback'. */
  code: string;
  message: string;
  /** Generated element id this diagnostic refers to, when known. */
  elementId?: string;
};

/**
 * The last generated output for a source, used as the merge base.
 * `elements` records only generated ids. The `x/y/width/height/style`
 * projection is kept for cheap geometry checks; `snapshot` is the full
 * durable baseline (every field of the generated element, including text,
 * bindings, group/frame links, `isDeleted` and unknown native fields), so
 * user edits show up as baseline-vs-current diffs per field.
 */
export type GeneratedElementRecord = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Small style subset the generator owns (stroke/background/fontSize...). */
  style: Record<string, unknown>;
  /** Complete generated element JSON at baseline time (deep copy, minus nothing). */
  snapshot: Record<string, unknown>;
};

export type GeneratedBaseline = {
  language: StructuredLanguage;
  /** Hash of the D2 source that produced this baseline. */
  sourceHash: string;
  elements: Record<string, GeneratedElementRecord>;
};

export type OverrideSidecar = {
  version: 1;
  language: StructuredLanguage;
  sourceHash: string;
  /** User overrides keyed by generated element id (moved/restyled). */
  overrides: Record<string, Record<string, unknown>>;
  /**
   * The generated baseline the overrides were collected against: the last
   * generation the user saw. Reopen merges old baseline + saved native +
   * new compile, so an external source edit is read as a generator change
   * instead of a fake human override. Null only for sidecars written
   * before baseline persistence (recoverable: reopen falls back to the
   * fresh baseline for those).
   */
  baseline: GeneratedBaseline | null;
};

/** Options for {@link compileStructured}. */
export type CompileOptions = {
  language?: StructuredLanguage;
  /**
   * Previously generated baseline plus the current editor scene.
   * When present, the fresh compile is merged so freehand additions and
   * user overrides survive regeneration.
   */
  prior?: {
    baseline: GeneratedBaseline | null;
    scene: NativeScene;
  };
  /**
   * Virtual files bounding D2 `...@file` / import resolution.
   * Keys are import paths, values are file contents. Resolution never
   * touches storage or the network.
   */
  virtualFiles?: Record<string, string>;
};

/** Result of {@link compileStructured}. */
export type CompileResult = {
  /** False when D2 reported a syntax error: `scene` is the preserved prior. */
  ok: boolean;
  language: StructuredLanguage;
  scene: NativeScene;
  /** The new generated baseline (unchanged from prior when ok is false). */
  baseline: GeneratedBaseline | null;
  diagnostics: Diagnostic[];
  /** Merge conflicts detected during regeneration, if a prior was given. */
  conflicts: MergeConflict[];
};

export type MergeConflict = {
  /** Generated element id both the user and the new compile changed. */
  elementId: string;
  /**
   * Which fields both sides changed: geometry (`moved`), generator-owned
   * style (`styled`), anything else such as text/content (`edited`), a
   * user deletion the source dropped (`removed-by-source`), or a resurrected
   * deletion (`deleted`, currently informational via diagnostics).
   */
  kind: 'moved' | 'styled' | 'edited' | 'deleted' | 'removed-by-source';
  message: string;
};

export type RegenerationRequest = {
  baseline: GeneratedBaseline | null;
  currentScene: NativeScene;
  freshScene: NativeScene;
  freshBaseline: GeneratedBaseline;
};

export type MergeResult = {
  scene: NativeScene;
  baseline: GeneratedBaseline;
  conflicts: MergeConflict[];
  diagnostics: Diagnostic[];
};
