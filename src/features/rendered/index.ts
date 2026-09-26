/**
 * Rendered view public interface.
 *
 * The workbench mounts the rendered editor from here in rendered mode.
 * Document types are owned by `src/features/document/index.ts` and
 * re-exported through `./types`.
 */
export { RenderedEditor, type RenderedEditorProps } from './RenderedEditor';
export { Counter, Callout } from './components';
export {
  compileForPreview,
  extractLiteralProps,
  instrumentMarkdownSource,
  instrumentMdxSource,
  booleanLiteral,
  numberLiteral,
  stringLiteral,
  type ComponentSlot,
  type Instrumentation,
  type LiteralProp,
  type TextLeaf,
} from './instrumentation';
export {
  checkChildMessage,
  checkParentMessage,
  checkPropEdit,
  checkProseEdit,
  encodePropLiteral,
  literalMatchesKind,
  parseExpressionLiteral,
  PREVIEW_CHILD_CSP,
  PREVIEW_SANDBOX,
  type ChildMessage,
  type LeafRange,
  type LiteralPropKind,
  type PropSyntax,
  type RenderMessage,
  type SlotInfo,
  type SlotRange,
} from './protocol';
export type { DocumentFormat, DocumentSnapshot, SourcePatch } from './types';
