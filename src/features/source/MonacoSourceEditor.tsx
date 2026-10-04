import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { applyMonacoTheme, setupMonaco } from "./monacoSetup";
import { getAppearanceTokens, useAppearance } from "@/features/appearance";
import { completeSource } from "./completions";
import { formatMarkdown } from "./formatMarkdown";
import { DRAFT_MARK, isHeadingLine, type CommentMark, type NoteCommentRequest } from "@/features/comments";
import { CommentActionButton, CommentMarker, commentHighlightClass } from "@/features/design-system";
import { parseErrorPosition, type SourceEditorProps } from "./SourceEditor";
import type { SourceEditorApi, SourceHandoff } from "./sourceBuffer";
import type { RenderedPatchOptions, SourceSelection } from "./renderedHistory";
import type { SourcePatch } from "@/features/document";
import { languageForFormat } from "./modelSync";

/**
 * VS Code-like Markdown/MDX source editor (Monaco, workers bundled locally).
 * It loads in its own chunk when a Source, Split or Code view first shows
 * (see `SourceEditor`), and takes over the text and undo history the
 * shell kept until then.
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

/** The comment markers beside the lines, one per line with commented text. */
type RailMarker = { line: number; top: number; ids: string[]; active: boolean; label: string };

const LINE_HEIGHT = 22;

// A model keeps a file's byte order mark out of its text and offsets
// (`getValue()` leaves it off) and gives it back when asked. The app's text
// and offsets are the file's, mark included, so every exchange converts.
const bomLength = (model: monaco.editor.ITextModel) => model.getValueLength(undefined, true) - model.getValueLength();
/** The file's text, byte order mark included. */
const fileText = (model: monaco.editor.ITextModel) => model.getValue(undefined, true);
const positionAt = (model: monaco.editor.ITextModel, offset: number) => model.getPositionAt(offset - bomLength(model));
const offsetAt = (model: monaco.editor.ITextModel, position: monaco.IPosition) => model.getOffsetAt(position) + bomLength(model);
/** The model as the document sync reads and replaces it: the file's text. */
const fileModel = (model: monaco.editor.ITextModel) => ({ getValue: () => fileText(model), setValue: (value: string) => model.setValue(value) });

export type MonacoSourceEditorProps = Omit<SourceEditorProps, "apiRef" | "initialText"> & { handoff: SourceHandoff };

export function MonacoSourceEditor(props: MonacoSourceEditorProps) {
  const { appearance } = useAppearance();
  const { visible, readOnly } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const documentSyncRef = useRef<SourceHandoff["documentSync"] | null>(null);
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

    // The text the shell's buffer started from; its steps are replayed below.
    const { handoff } = live.current;
    const model = monaco.editor.createModel(
      handoff.buffer.base(),
      "mdx",
      monaco.Uri.parse(
        `inmemory://elaborating/${crypto.randomUUID()}.mdx`,
      ),
    );
    modelRef.current = model;
    // The shell's sync, which already knows the text the parent has heard.
    const documentSync = handoff.documentSync;
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
    // Replaying the shell's steps: the parent already has their text.
    let replaying = false;
    const selectionAt = (selection: SourceSelection) => {
      const anchor = positionAt(model, selection.anchor);
      const head = positionAt(model, selection.head);
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
          void api.formatSource().catch(() => undefined);
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
      if ((comments?.canComment || comments?.offline) && selection && !selection.isEmpty() && editor.hasTextFocus()) {
        // Beside the selection's end, on its line, where there is room for
        // it; else over the selection, at its start, so the lines after it
        // stay in view; else under it, when it starts at the top.
        const start = editor.getScrolledVisiblePosition(selection.getStartPosition());
        const end = editor.getScrolledVisiblePosition(selection.getEndPosition());
        const left = (at: { left: number }) => Math.max(layout.contentLeft, Math.min(at.left, layout.width - 200));
        const shown = (at: { top: number; height: number } | null) => at !== null && at.top >= 0 && at.top <= layout.height - at.height;
        if (end && shown(end) && end.left + 12 + 180 <= layout.width - layout.verticalScrollbarWidth) {
          button = { top: Math.max(0, Math.min(end.top + end.height / 2 - 16, layout.height - 40)), left: end.left + 12 };
        } else if (start && shown(start) && start.top - 44 >= 0) {
          button = { top: start.top - 44, left: left(start) };
        } else if (end && shown(end)) {
          button = { top: Math.min(end.top + end.height + 4, layout.height - 40), left: left({ left: end.left - 48 }) };
        }
      }
      setCommentButton((current) => (current?.top === button?.top && current?.left === button?.left ? current : button));
      canCommentKey.set(Boolean(comments?.canComment));
      onHeadingKey.set(Boolean(comments?.canComment && comments.sections && selection?.isEmpty() && headingAt(selection.startLineNumber)));
    };
    commentMarksRef.current = (marks, source) => {
      // Marks placed in other text (typing ran ahead) wait for the next set.
      if (source === fileText(model)) {
        const ids = markDecorations.set(
          marks.map((mark) => ({
            range: monaco.Range.fromPositions(positionAt(model, mark.from), positionAt(model, mark.to)),
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
    const commentOn = (request: NoteCommentRequest) => live.current.comments?.onComment(request, fileText(model));
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
          commentOn({ kind: "text", from: offsetAt(model, selection.getStartPosition()), to: offsetAt(model, selection.getEndPosition()) });
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
          if (position) commentOn({ kind: "section", offset: offsetAt(model, position) });
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
        if (replaying) return;
        const text = fileText(model);
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

    // The formatted text as one undo step of its own.
    const applyFormatted = (formatted: string) => {
      const selections = editor.getSelections() ?? [];
      editor.pushUndoStop();
      editor.executeEdits("elaborating.format", [
        {
          range: model.getFullModelRange(),
          text: formatted,
          forceMoveMarkers: true,
        },
      ]);
      editor.pushUndoStop();
      if (selections.length > 0) editor.setSelections(selections);
    };
    const api: SourceEditorApi = {
      async formatSource() {
        const current = model.getValue();
        // Prettier loads on the first Format.
        const formatted = await formatMarkdown(current);
        if (model.isDisposed()) return false;
        if (model.getValue() !== current) throw new Error("Format failed: the text changed while formatting. Try again.");
        if (formatted === current) return false;
        applyFormatted(formatted);
        return true;
      },
      applyExternalPatches(
        patches: SourcePatch[],
        options?: RenderedPatchOptions,
      ) {
        if (patches.length === 0) return;
        const edits = patches.map((patch) => ({
          range: monaco.Range.fromPositions(
            positionAt(model, patch.from),
            positionAt(model, patch.to),
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
        let changes: monaco.editor.IModelContentChange[] = [];
        const heard = model.onDidChangeContent((event) => {
          changes = event.changes;
        });
        try {
          if (!editor.getOption(monaco.editor.EditorOption.readOnly))
            void (direction === "undo" ? model.undo() : model.redo());
        } finally {
          heard.dispose();
        }
        // The editor moves its cursor to the undone edit only when it has
        // focus. Without it (undo from Rendered), the cursor goes after the
        // first changed text, where the edit was.
        if (changes.length > 0 && !editor.hasTextFocus()) {
          const first = changes.reduce((a, b) => (b.rangeOffset < a.rangeOffset ? b : a));
          editor.setPosition(model.getPositionAt(first.rangeOffset + first.text.length));
        }
        const selection = editor.getSelection();
        return {
          text: fileText(model),
          selection: {
            anchor: selection
              ? offsetAt(model, selection.getSelectionStart())
              : 0,
            head: selection ? offsetAt(model, selection.getPosition()) : 0,
          },
        };
      },
      focus() {
        editor.focus();
      },
      revealRange(from, to, focus) {
        const range = monaco.Range.fromPositions(positionAt(model, from), positionAt(model, to));
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

    // The shell's steps, so this model's undo history is the file's.
    replaying = true;
    try {
      for (const step of handoff.buffer.steps()) {
        if (step.kind === "patches") api.applyExternalPatches([...step.patches], step.options);
        else if (step.kind === "history") api.history(step.direction);
        // The step is the whole file; the model keeps its byte order mark apart.
        else applyFormatted(step.text.slice(bomLength(model)));
      }
    } finally {
      replaying = false;
    }
    // Never show other text than the parent has (Monaco can change line
    // endings); that costs the history, which only mixed line endings meet.
    if (fileText(model) !== handoff.buffer.getValue()) model.setValue(handoff.buffer.getValue());
    handoff.attach(api);

    return () => {
      handoff.detach();
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
    applyMonacoTheme(appearance);
    editorRef.current?.updateOptions({ fontFamily: tokens.codeFont });
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
    documentSyncRef.current?.receive(fileModel(model), { text: documentText, docId: documentId });
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
  const commentsOffline = props.comments?.offline ?? false;
  useEffect(() => {
    commentMarksRef.current?.(commentMarks ?? [], commentSource ?? "");
  }, [canComment, commentsOffline, commentMarks, commentSource]);

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
      {comments?.offline && !comments.canComment && commentButton && (
        <CommentActionButton
          disabled
          className="absolute z-10 pointer-coarse:h-10 pointer-coarse:px-3.5 disabled:text-dim disabled:opacity-100"
          style={{ top: commentButton.top, left: commentButton.left }}
        >
          Comments need a connection
        </CommentActionButton>
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
              { kind: "text", from: offsetAt(model, selection.getStartPosition()), to: offsetAt(model, selection.getEndPosition()) },
              fileText(model),
            );
          }}
        />
      )}
    </div>
  );
}

