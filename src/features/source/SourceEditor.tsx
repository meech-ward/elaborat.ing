import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { format } from "prettier/standalone";
import * as prettierMarkdown from "prettier/plugins/markdown";
import type { DocumentSnapshot, SourcePatch } from "@/features/document";
import { createModelDocumentSync, languageForFormat } from "./modelSync";
import { setupMonaco } from "./monacoSetup";
import { getAppearanceTokens, getPaletteColors, useAppearance } from "@/features/appearance";
import { monacoTheme } from "./monacoTheme";
import { completeSource } from "./completions";
import type { ComponentDefinition } from '../document/componentCatalog';
import { DRAFT_MARK, isHeadingLine, type CommentMark, type NoteCommentRequest } from "@/features/comments";
import { CommentActionButton, CommentMarker, commentHighlightClass, type Shortcut } from "@/features/design-system";
import type {
  RenderedPatchOptions,
  SourceHistoryResult,
  SourceSelection,
} from "./renderedHistory";

/**
 * VS Code-like Markdown/MDX source editor (Monaco, workers bundled locally).
 *
 * - One Monaco model per mount. The parent keeps this component mounted and
 *   hides it in rendered mode, so undo history survives mode switches.
 * - Rendered-view patches arrive via `applyExternalPatches` as a single
 *   undoable edit, so Ctrl+Z after a mode switch restores the source.
 * - No implicit formatting: formatOnType/formatOnPaste stay off and the only
 *   formatter is the explicit Format action (button or Shift+Alt+F).
 * - Multi-cursor via Alt+Click (Monaco default), next occurrence via
 *   Ctrl/Cmd+D (Monaco default), all occurrences via Ctrl/Cmd+Shift+L
 *   (bound explicitly below so it holds on every platform).
 */

export interface SourceEditorApi {
  /** Explicit Prettier format as one undoable edit. Throws on failure. */
  formatSource(): Promise<boolean>;
  /** Checked rendered-view patches as one undoable edit. */
  applyExternalPatches(
    patches: SourcePatch[],
    options?: RenderedPatchOptions,
  ): void;
  history(direction: "undo" | "redo"): SourceHistoryResult;
  focus(): void;
  /** Scroll source[from, to) into view and flash it; `focus` puts the cursor at its start. */
  revealRange(from: number, to: number, focus: boolean): void;
}

/** The note's commented text, and the Comment actions when the person may comment. */
export type SourceComments = {
  /** Where the commented text is in `source`. Marks placed in other text wait for the next. */
  marks: readonly CommentMark[];
  source: string;
  /** Offer Comment on a selection (and Comment on section on a heading, with `sections`). */
  canComment: boolean;
  /** Headings take section comments (notes). */
  sections: boolean;
  /** The key that comments, shown on the Comment button. */
  shortcut?: Shortcut;
  /** A marker (`focus`: the keyboard goes to the thread) or commented text was chosen. */
  onOpen: (threadId: string, focus: boolean) => void;
  /** Comment on part of `source`, the editor's text. */
  onComment: (request: NoteCommentRequest, source: string) => void;
};

/** The comment markers beside the lines, one per line with commented text. */
type RailMarker = { line: number; top: number; ids: string[]; active: boolean; label: string };

const LINE_HEIGHT = 22;

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
  apiRef: React.RefObject<SourceEditorApi | null>;
  /** Why the text cannot be changed here, or null (the default) when it can. Monaco shows it when someone tries to type. */
  readOnly?: string | null;
  comments?: SourceComments | null;
}

/** Pull a leading `line:column` (MDX/VFile style) out of an error message. */
function parseErrorPosition(
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

export function SourceEditor(props: SourceEditorProps) {
  const { appearance } = useAppearance();
  const { visible, readOnly } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const documentSyncRef = useRef<ReturnType<typeof createModelDocumentSync> | null>(null);
  // Comments: the markers beside the lines and the Comment button under a
  // selection, placed from the editor's own positions as it scrolls.
  const [rail, setRail] = useState<{ shown: boolean; markers: RailMarker[] }>({ shown: false, markers: [] });
  const [commentButton, setCommentButton] = useState<{ top: number; left: number } | null>(null);
  const commentMarksRef = useRef<((marks: readonly CommentMark[], source: string) => void) | null>(null);
  // Latest callbacks without rebinding the mount-once editor. Assigned in
  // an effect (never during render) so memoization stays valid.
  const live = useRef(props);
  useEffect(() => {
    live.current = props;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setupMonaco();

    const model = monaco.editor.createModel(
      live.current.initialText,
      "mdx",
      monaco.Uri.parse(
        `inmemory://elaborating/${crypto.randomUUID()}.mdx`,
      ),
    );
    modelRef.current = model;
    const documentSync = createModelDocumentSync({
      text: model.getValue(),
      docId: live.current.documentId,
    });
    documentSyncRef.current = documentSync;

    const editor = monaco.editor.create(container, {
      model,
      // C5's source pane: 13/22 code, the line numbers in a 22px column
      // at the pane's edge and the text 16px after them (the fold arrows
      // show in that gap on hover), 14px above the first line and below
      // the last, no line along the scroll bar.
      // The palette's code font replaces this at once (see the appearance effect).
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 22,
      glyphMargin: false,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 0,
      minimap: { enabled: false },
      wordWrap: "on",
      padding: { top: 14, bottom: 14 },
      overviewRulerBorder: false,
      // No overview ruler: C5's source pane has no marks along the scroll bar.
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderWhitespace: "selection",
      stickyScroll: { enabled: false },
      fixedOverflowWidgets: true,
      // Keep word suggestions local to this model, like our own providers.
      wordBasedSuggestions: "currentDocument",
      quickSuggestions: { other: true, comments: false, strings: true },
      // The suggestions list reads as the library's menus: rows of names
      // (no kind icons) at a menu row's height and size (index.css draws
      // the rest).
      suggest: { showIcons: false },
      suggestLineHeight: 30,
      suggestFontSize: 13,
      // Explicit formatting only: never format on type, paste, or save.
      formatOnType: false,
      formatOnPaste: false,
    });
    editorRef.current = editor;
    let renderedGroup: string | undefined;
    let applyingRendered = false;
    const selectionAt = (selection: SourceSelection) => {
      const anchor = model.getPositionAt(selection.anchor);
      const head = model.getPositionAt(selection.head);
      return new monaco.Selection(
        anchor.lineNumber,
        anchor.column,
        head.lineNumber,
        head.column,
      );
    };

    // Global language registration must be torn down on unmount, and so
    // must the keybindings of the editor's actions below.
    const disposables: monaco.IDisposable[] = ["mdx", "d2"].map((language) =>
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ["<", " ", '"', "'", ":", ".", ">"],
        provideCompletionItems(completionModel, position, context) {
          if (completionModel !== model || !live.current.visible)
            return { suggestions: [] };
          // A space opens suggestions inside a tag or after a key, not at
          // the start of a line (an indent, or a space on an empty line).
          if (
            context.triggerKind ===
              monaco.languages.CompletionTriggerKind.TriggerCharacter &&
            context.triggerCharacter === " " &&
            model
              .getLineContent(position.lineNumber)
              .slice(0, position.column - 1)
              .trim() === ""
          )
            return { suggestions: [] };
          const suggestions = completeSource({
            text: model.getValue(),
            offset: model.getOffsetAt(position),
            language: model.getLanguageId(),
            workspacePaths: live.current.workspacePaths,
            componentCatalog: live.current.componentCatalog,
          });
          return {
            suggestions: suggestions.map((item) => ({
              label: item.label,
              filterText:
                item.kind === "component" &&
                model
                  .getValueInRange(
                    monaco.Range.fromPositions(
                      model.getPositionAt(item.from),
                      model.getPositionAt(item.to),
                    ),
                  )
                  .startsWith("<")
                  ? "<" + item.label
                  : item.label,
              kind:
                item.kind === "file"
                  ? monaco.languages.CompletionItemKind.File
                  : item.kind === "property"
                    ? monaco.languages.CompletionItemKind.Property
                    : item.kind === "value"
                      ? monaco.languages.CompletionItemKind.EnumMember
                      : item.kind === "node"
                        ? monaco.languages.CompletionItemKind.Reference
                        : monaco.languages.CompletionItemKind.Snippet,
              detail: item.detail,
              insertText: item.insertText,
              insertTextRules: item.snippet
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              range: monaco.Range.fromPositions(
                model.getPositionAt(item.from),
                model.getPositionAt(item.to),
              ),
            })),
          };
        },
      }),
    );

    // Keys bound as actions run only in the editor that has focus. (Monaco's
    // addCommand binds a key for every editor on the page, and the last
    // editor created would take it.)
    // Explicit format (Shift+Alt+F), undoable, Prettier.
    disposables.push(
      editor.addAction({
        id: "elaborating.format-source",
        label: "Format Source (Prettier)",
        keybindings: [
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
        ],
        run() {
          void live.current.apiRef.current?.formatSource().catch(() => undefined);
        },
      }),
      // All occurrences of the selection (Shift+Cmd/Ctrl+L), guaranteed bound.
      editor.addAction({
        id: "elaborating.select-all-occurrences",
        label: "Select All Occurrences",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL,
        ],
        run() {
          void editor.getAction("editor.action.selectHighlights")?.run();
        },
      }),
      // Save from inside the editor (Ctrl/Cmd+S).
      editor.addAction({
        id: "elaborating.save",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run() {
          live.current.onSave();
        },
      }),
    );
    // Comments: commented text as decorations, which move with edits until
    // the next marks arrive; markers and the Comment button follow them.
    const markDecorations = editor.createDecorationsCollection();
    const flashDecorations = editor.createDecorationsCollection();
    let marked: { decoration: string; mark: CommentMark }[] = [];
    let flashTimer = 0;
    const canCommentKey = editor.createContextKey<boolean>("elaboratingCanComment", false);
    const onHeadingKey = editor.createContextKey<boolean>("elaboratingOnHeading", false);
    const headingAt = (lineNumber: number) => {
      // Only a line that looks like a heading, or sits over an underline, is checked in full.
      const line = model.getLineContent(lineNumber);
      const next = lineNumber < model.getLineCount() ? model.getLineContent(lineNumber + 1) : "";
      if (!/^ {0,3}#/.test(line) && !/^ {0,3}(?:=+|-+)[ \t]*$/.test(next)) return false;
      return isHeadingLine(model.getValue(), model.getOffsetAt({ lineNumber, column: 1 }));
    };
    const updateComments = () => {
      const comments = live.current.comments;
      const layout = editor.getLayoutInfo();
      const scrollTop = editor.getScrollTop();
      const lines = new Map<number, { ids: string[]; active: boolean }>();
      for (const { decoration, mark } of marked) {
        const range = model.getDecorationRange(decoration);
        if (!range || range.isEmpty() || mark.id === DRAFT_MARK) continue;
        const group = lines.get(range.startLineNumber) ?? { ids: [], active: false };
        group.ids.push(mark.id);
        group.active ||= mark.active;
        lines.set(range.startLineNumber, group);
      }
      const markers: RailMarker[] = [];
      for (const [line, group] of lines) {
        const top = editor.getTopForLineNumber(line) - scrollTop + (LINE_HEIGHT - 18) / 2;
        if (top < -LINE_HEIGHT || top > layout.height) continue;
        const count = group.ids.length;
        markers.push({ line, top, ids: group.ids, active: group.active, label: `${count} ${count === 1 ? "thread" : "threads"} on line ${line}` });
      }
      setRail((current) =>
        current.shown === lines.size > 0 && JSON.stringify(current.markers) === JSON.stringify(markers) ? current : { shown: lines.size > 0, markers },
      );
      const selection = editor.getSelection();
      let button: { top: number; left: number } | null = null;
      if (comments?.canComment && selection && !selection.isEmpty() && editor.hasTextFocus()) {
        const end = editor.getScrolledVisiblePosition(selection.getEndPosition());
        if (end && end.top >= 0 && end.top <= layout.height - end.height) {
          button = {
            top: Math.min(end.top + end.height + 4, layout.height - 40),
            left: Math.max(layout.contentLeft, Math.min(end.left - 48, layout.width - 200)),
          };
        }
      }
      setCommentButton((current) => (current?.top === button?.top && current?.left === button?.left ? current : button));
      canCommentKey.set(Boolean(comments?.canComment));
      onHeadingKey.set(Boolean(comments?.canComment && comments.sections && selection?.isEmpty() && headingAt(selection.startLineNumber)));
    };
    commentMarksRef.current = (marks, source) => {
      // Marks placed in other text (typing ran ahead) wait for the next set.
      if (source === model.getValue()) {
        const ids = markDecorations.set(
          marks.map((mark) => ({
            range: monaco.Range.fromPositions(model.getPositionAt(mark.from), model.getPositionAt(mark.to)),
            options: {
              inlineClassName: commentHighlightClass({ active: mark.active }),
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          })),
        );
        marked = ids.map((decoration, index) => ({ decoration, mark: marks[index] }));
      }
      updateComments();
    };
    const commentOn = (request: NoteCommentRequest) => live.current.comments?.onComment(request, model.getValue());
    disposables.push(
      // The comment key comments on the selection, or on the heading the
      // cursor is on. Elsewhere it is left to the page (it shows or hides
      // the comments).
      editor.addAction({
        id: "elaborating.comment",
        label: "Comment",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM],
        precondition: "elaboratingCanComment && editorHasSelection",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0,
        run() {
          const selection = editor.getSelection();
          if (!selection || selection.isEmpty()) return;
          commentOn({ kind: "text", from: model.getOffsetAt(selection.getStartPosition()), to: model.getOffsetAt(selection.getEndPosition()) });
        },
      }),
      editor.addAction({
        id: "elaborating.comment-section",
        label: "Comment on section",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM],
        precondition: "elaboratingCanComment && !editorHasSelection && elaboratingOnHeading",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0,
        run() {
          const position = editor.getPosition();
          if (position) commentOn({ kind: "section", offset: model.getOffsetAt(position) });
        },
      }),
      editor.onDidScrollChange(updateComments),
      editor.onDidLayoutChange(updateComments),
      editor.onDidChangeCursorSelection(updateComments),
      editor.onDidFocusEditorText(updateComments),
      editor.onDidBlurEditorText(updateComments),
      // Commented text opens its thread when clicked (not when a selection ends on it).
      editor.onMouseUp((event) => {
        const comments = live.current.comments;
        const position = event.target.position;
        if (!comments || !position || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
        if (!editor.getSelection()?.isEmpty()) return;
        const hit = marked
          .filter(({ decoration, mark }) => mark.id !== DRAFT_MARK && model.getDecorationRange(decoration)?.containsPosition(position))
          .sort((a, b) => a.mark.to - a.mark.from - (b.mark.to - b.mark.from))[0];
        if (hit) comments.onOpen(hit.mark.id, false);
      }),
      { dispose: () => window.clearTimeout(flashTimer) },
    );

    disposables.push(
      editor.onDidChangeModelContent(() => {
        if (!applyingRendered) renderedGroup = undefined;
        const text = model.getValue();
        documentSync.emitted(text);
        live.current.onChange(text);
        updateComments();
      }),
      editor.onDidFocusEditorText(() => {
        renderedGroup = undefined;
        editor.pushUndoStop();
      }),
      editor.onDidChangeCursorPosition((event) => {
        live.current.onCursor(event.position.lineNumber, event.position.column);
      }),
    );

    live.current.apiRef.current = {
      async formatSource() {
        const current = model.getValue();
        let formatted: string;
        try {
          formatted = await format(current, {
            parser: "markdown",
            plugins: [prettierMarkdown],
            proseWrap: "preserve",
          });
        } catch (error) {
          throw new Error(
            `Format failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (formatted === current) return false;
        const selections = editor.getSelections() ?? [];
        editor.executeEdits("elaborating.format", [
          {
            range: model.getFullModelRange(),
            text: formatted,
            forceMoveMarkers: true,
          },
        ]);
        if (selections.length > 0) editor.setSelections(selections);
        return true;
      },
      applyExternalPatches(
        patches: SourcePatch[],
        options?: RenderedPatchOptions,
      ) {
        if (patches.length === 0) return;
        const edits = patches.map((patch) => ({
          range: monaco.Range.fromPositions(
            model.getPositionAt(patch.from),
            model.getPositionAt(patch.to),
          ),
          text: patch.insert,
          forceMoveMarkers: true,
        }));
        // Natural undo boundaries: each rendered commit is its own undo
        // stop, so one Ctrl+Z reverts exactly that commit and typing stays
        // in separate stops. onDidChangeModelContent notifies the parent,
        // whose store already holds the same text, so it stays in sync.
        if (!options?.group || options.group !== renderedGroup)
          editor.pushUndoStop();
        if (options?.before) editor.setSelection(selectionAt(options.before));
        applyingRendered = true;
        try {
          editor.executeEdits(
            "elaborating.rendered-patch",
            edits,
            options?.after ? () => [selectionAt(options.after!)] : undefined,
          );
        } finally {
          applyingRendered = false;
        }
        renderedGroup = options?.group;
        if (!renderedGroup) editor.pushUndoStop();
      },
      history(direction) {
        renderedGroup = undefined;
        editor.pushUndoStop();
        // This model's own history. Monaco's "undo" command would instead
        // focus and undo whichever editor was last focused, which steals the
        // keyboard in Split and can reach another open file's editor.
        if (!editor.getOption(monaco.editor.EditorOption.readOnly))
          void (direction === "undo" ? model.undo() : model.redo());
        const selection = editor.getSelection();
        return {
          text: model.getValue(),
          selection: {
            anchor: selection
              ? model.getOffsetAt(selection.getSelectionStart())
              : 0,
            head: selection ? model.getOffsetAt(selection.getPosition()) : 0,
          },
        };
      },
      focus() {
        editor.focus();
      },
      revealRange(from, to, focus) {
        const range = monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to));
        editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
        flashDecorations.set([
          { range, options: { inlineClassName: commentHighlightClass({ active: true, flash: true }) } },
        ]);
        window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => flashDecorations.clear(), 1500);
        if (focus) {
          editor.setPosition(range.getStartPosition());
          editor.focus();
        }
      },
    };

    return () => {
      live.current.apiRef.current = null;
      commentMarksRef.current = null;
      for (const item of disposables) item.dispose();
      editorRef.current = null;
      modelRef.current = null;
      documentSyncRef.current = null;
      editor.dispose();
      model.dispose();
    };
  }, []);

  useEffect(() => {
    const tokens = getAppearanceTokens(appearance);
    // Themes are global: the conflict diff's editors follow this one.
    const name = `elaborating-${appearance.theme}-${appearance.scheme}`;
    monaco.editor.defineTheme(name, monacoTheme(getPaletteColors(appearance), appearance.scheme));
    editorRef.current?.updateOptions({
      theme: name,
      fontFamily: tokens.codeFont,
    });
    // The code font is a web font: measure again once it has loaded, so the
    // cursor lines up with the text.
    void document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
  }, [appearance]);

  // Render-error diagnostics as editor markers (best effort on position).
  const { renderError } = props;
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    if (!renderError) {
      monaco.editor.setModelMarkers(model, "elaborating-mdx", []);
      return;
    }
    const position = parseErrorPosition(renderError) ?? { line: 1, column: 1 };
    const clampedLine = Math.min(position.line, model.getLineCount());
    const maxColumn = model.getLineMaxColumn(clampedLine);
    const clampedColumn = Math.min(position.column, maxColumn);
    monaco.editor.setModelMarkers(model, "elaborating-mdx", [
      {
        severity: monaco.MarkerSeverity.Error,
        message: renderError,
        startLineNumber: clampedLine,
        startColumn: clampedColumn,
        endLineNumber: clampedLine,
        endColumn: Math.min(clampedColumn + 1, maxColumn),
      },
    ]);
  }, [renderError]);

  // Outside-model document changes (file open): replace the displayed text
  // and match the model language. The sync is keyed on document identity,
  // not only text: reopening the same bytes still resets the model, which
  // isolates the old document's undo history. Typing and rendered patches
  // emit acknowledgements which may lag newer model events. The per-model
  // synchronizer distinguishes those echoes from outside replacements.
  const { documentText, format: docFormat, documentId, editorLanguage } = props;
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    monaco.editor.setModelLanguage(
      model,
      editorLanguage ?? languageForFormat(docFormat),
    );
    documentSyncRef.current?.receive(model, { text: documentText, docId: documentId });
  }, [documentText, docFormat, documentId, editorLanguage]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: Boolean(readOnly),
      readOnlyMessage: readOnly ? { value: readOnly } : undefined,
    });
  }, [readOnly]);

  // The commented text, and whether the Comment actions are offered.
  const commentMarks = props.comments?.marks;
  const commentSource = props.comments?.source;
  const canComment = props.comments?.canComment ?? false;
  useEffect(() => {
    commentMarksRef.current?.(commentMarks ?? [], commentSource ?? "");
  }, [canComment, commentMarks, commentSource]);

  // The component stays mounted in rendered mode (history preserved);
  // relayout when it becomes visible again.
  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.layout();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  const comments = props.comments;
  return (
    <div hidden={!visible} className="relative flex h-full w-full">
      <div ref={containerRef} className="h-full min-w-0 flex-1" />
      {rail.shown && (
        // A column at the right of the pane, beside the lines it marks.
        <div className="relative h-full w-12 shrink-0 overflow-hidden">
          {rail.markers.map((marker) => (
            <CommentMarker
              key={marker.line}
              count={marker.ids.length}
              label={marker.label}
              active={marker.active}
              className="absolute left-1"
              style={{ top: marker.top }}
              onClick={() => {
                // A line with more than one thread opens the next each time.
                const current = marker.ids.findIndex((id) => id === props.comments?.marks.find((mark) => mark.active)?.id);
                props.comments?.onOpen(marker.ids[(current + 1) % marker.ids.length], true);
              }}
            />
          ))}
        </div>
      )}
      {comments?.canComment && commentButton && (
        <CommentActionButton
          shortcut={comments.shortcut}
          className="absolute z-10 pointer-coarse:h-10 pointer-coarse:px-3.5"
          style={{ top: commentButton.top, left: commentButton.left }}
          // Keep the keyboard in the editor, so the selection stays.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const editor = editorRef.current;
            const model = modelRef.current;
            const selection = editor?.getSelection();
            if (!editor || !model || !selection || selection.isEmpty()) return;
            comments.onComment(
              { kind: "text", from: model.getOffsetAt(selection.getStartPosition()), to: model.getOffsetAt(selection.getEndPosition()) },
              model.getValue(),
            );
          }}
        />
      )}
    </div>
  );
}

export { parseErrorPosition };
