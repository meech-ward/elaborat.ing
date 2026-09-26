/**
 * Workbench public entry point.
 *
 * Pure pieces of the file workbench: open-file state, literal source
 * references, and the canvas theme hook. The workbench shell and the
 * drawing and diagram views are added by later port steps.
 */
export { parseSourceRefs } from "./refs.ts";
export type { RefKind, SourceRef } from "./refs.ts";
export { useCanvasTheme } from "./viewTheme.ts";
export {
  applyReload,
  clearSave,
  editorLanguageForPath,
  initialOpenFile,
  kindForPath,
  markConflict,
  markSaved,
  markSaving,
  newUntitledNote,
  openWorkspaceFile,
  resolveSaveCompletion,
  saveTarget,
  suggestUntitledName,
} from "./session.ts";
export type { EditorLanguage, FileKind, OpenFile, SaveCompletion, SaveStatus } from "./session.ts";
