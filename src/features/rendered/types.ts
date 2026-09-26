/**
 * Document types, owned by `src/features/document/index.ts`. Re-exported
 * here so the rendered feature reads them from one place.
 */
export type {
  DocumentFormat,
  DocumentSnapshot,
  SourcePatch,
} from '../document/index.js';
export { applySourcePatches, encodeProseText } from '../document/index.js';
