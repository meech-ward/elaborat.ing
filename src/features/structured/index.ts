/**
 * @module structured
 *
 * Structured diagrams: real D2 source code compiles to native editable
 * Excalidraw geometry with stable source IDs, plus regeneration merge that
 * preserves freehand annotations and explicit user overrides.
 *
 * Public entry point for the feature. Route/UI layers import only from here.
 */
export type {
  AngularPoint,
  CompileOptions,
  CompileResult,
  D2Connection,
  D2Diagram,
  D2Shape,
  D2TableCell,
  D2TableColumn,
  Diagnostic,
  ExcalidrawElementSkeleton,
  GeneratedBaseline,
  GeneratedElementRecord,
  MergeConflict,
  MergeResult,
  NativeScene,
  OverrideSidecar,
  RegenerationRequest,
  StructuredLanguage,
} from './types.ts';

export {
  buildCompileRequest,
  compileStructured,
  createD2CompilePort,
  disposeSharedD2,
  getDefaultD2Port,
  getSharedD2,
} from './compiler.ts';
export type { CompilerPorts, D2CompilePort, D2CompileRequest } from './compiler.ts';
export { emitNativeScene, fractionalIndex } from './emitter.ts';
export {
  elementIdForConnection,
  elementIdForLabel,
  elementIdForShape,
  mergeRegeneration,
  resetOverrides,
} from './merge.ts';
export { CLOUD_D2_EXAMPLE, ERD_D2_EXAMPLE, FLOW_D2_EXAMPLE } from './examples.ts';
export { parseOverrideSidecar, serializeOverrideSidecar } from './sidecar.ts';
export { changedGeneratedLabels, isNodeLabel, pendingLabelsFromArtifact, synchronizeLabels } from './labelSync.ts';
export type { LabelEdit, LabelSyncResult } from './labelSync.ts';
