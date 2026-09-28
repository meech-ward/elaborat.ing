import { useEffect, useState } from "react";
import type { DocumentSnapshot } from "@/features/document";
import type { CommentMark, NoteCommentRequest } from "@/features/comments";
import { Banner, BannerAction, LoadingLine, type Shortcut } from "@/features/design-system";
import { moduleLoader, useModule } from "@/lib/moduleLoader";
import type { ComponentDefinition } from "../document/componentCatalog";
import { createSourceHandoff, type SourceEditorApi } from "./sourceBuffer";

export type { SourceEditorApi };

/** The note's commented text, and the Comment actions when the person may comment. */
export type SourceComments = {
  /** Where the commented text is in `source`. Marks placed in other text wait for the next. */
  marks: readonly CommentMark[];
  source: string;
  /** Offer Comment on a selection (and Comment on section on a heading, with `sections`). */
  canComment: boolean;
  /** Only the connection keeps the person from commenting: Comment shows over a selection, off, saying so. */
  offline?: boolean;
  /** Headings take section comments (notes). */
  sections: boolean;
  /** The key that comments, shown on the Comment button. */
  shortcut?: Shortcut;
  /** A marker (`focus`: the keyboard goes to the thread) or commented text was chosen. */
  onOpen: (threadId: string, focus: boolean) => void;
  /** Comment on part of `source`, the editor's text. */
  onComment: (request: NoteCommentRequest, source: string) => void;
};

export interface SourceEditorProps {
  initialText: string;
  /**
   * Authoritative document text/format from the workbench. Typing flows
   * model -> store; older acknowledgements may briefly lag the model. Only
   * a genuine outside replacement resets the model and its undo history.
   */
  documentText: string;
  format: DocumentSnapshot["format"];
  /**
   * Store-side document identity (bumps on every file open, even when the
   * new bytes equal the old ones). A change forces a model reset so the
   * previous document's undo history never leaks into the new one.
   */
  documentId: number;
  /**
   * Explicit Monaco language for non-note workspace files: `json` for
   * native scenes/sidecars, `d2` for diagram sources (small local Monarch
   * grammar, never parsed as MDX), `plaintext` otherwise. Defaults to the
   * document format's Markdown/MDX language.
   */
  editorLanguage?: "markdown" | "mdx" | "json" | "plaintext" | "d2";
  /** Current workspace listing for contextual resource-path suggestions. */
  workspacePaths?: readonly string[];
  componentCatalog?: readonly ComponentDefinition[];
  visible: boolean;
  /** Latest render error message, if any; parsed for line info into markers. */
  renderError: string | null;
  onChange: (text: string) => void;
  onCursor: (line: number, column: number) => void;
  onSave: () => void;
  /** Set while mounted: calls reach the code editor once it has loaded, and the text kept without it before. */
  apiRef: React.RefObject<SourceEditorApi | null>;
  /** Why the text cannot be changed here, or null (the default) when it can. Monaco shows it when someone tries to type. */
  readOnly?: string | null;
  comments?: SourceComments | null;
}

/** Pull a leading `line:column` (MDX/VFile style) out of an error message. */
export function parseErrorPosition(
  message: string,
): { line: number; column: number } | null {
  const match = /(?:^|\s)(\d+):(\d+)(?:\s|-|:|$)/.exec(message);
  if (!match) return null;
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (
    !Number.isInteger(line) ||
    line < 1 ||
    !Number.isInteger(column) ||
    column < 1
  )
    return null;
  return { line, column };
}

// Monaco and the editor around it are about half of the project page's
// code, so they load in their own chunk the first time a Source, Split or
// Code view shows (the service worker has them cached for offline use).
const codeEditor = moduleLoader(() => import("./MonacoSourceEditor"));

/** Start loading the code editor, for example when the pointer reaches the view switch. */
export function preloadSourceEditor(): void {
  codeEditor.preload();
}

/**
 * A file's source: the code editor (Monaco) once it has shown. Until then
 * the text and its undo history are kept here without it (see
 * `createSourceBuffer`), so a note read and edited only in Rendered, or a
 * drawing only on its canvas, never loads Monaco.
 */
export function SourceEditor(props: SourceEditorProps) {
  const { visible, apiRef, documentText, documentId, onChange, readOnly } = props;
  const [handoff] = useState(() => createSourceHandoff(props.initialText, props.documentId));
  useEffect(() => {
    handoff.connect({ onChange, readOnly: Boolean(readOnly) });
  }, [handoff, onChange, readOnly]);
  useEffect(() => {
    apiRef.current = handoff.api;
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, handoff]);
  // Until the code editor has loaded, outside replacements (a reload, a
  // copy saved elsewhere) reset the buffer; after, the editor does it.
  useEffect(() => {
    if (!handoff.attached()) handoff.documentSync.receive(handoff.buffer, { text: documentText, docId: documentId });
  }, [documentId, documentText, handoff]);

  // Once shown, the code editor stays mounted, so its undo history does too.
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  const { module, error, retry } = useModule(codeEditor, shown);
  if (shown && module) {
    const { MonacoSourceEditor } = module;
    return <MonacoSourceEditor {...props} handoff={handoff} />;
  }
  return (
    <div hidden={!visible} className="relative flex h-full w-full flex-col">
      {error ? (
        <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
          The code editor could not load.
        </Banner>
      ) : (
        shown && <LoadingLine label="Loading the code editor" />
      )}
    </div>
  );
}
