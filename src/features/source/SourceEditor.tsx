import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { format } from "prettier/standalone";
import * as prettierMarkdown from "prettier/plugins/markdown";
import type { DocumentSnapshot, SourcePatch } from "@/features/document";
import { createModelDocumentSync, languageForFormat } from "./modelSync";
import { setupMonaco } from "./monacoSetup";
import { getAppearanceTokens, useAppearance } from "@/features/appearance";
import { completeSource } from "./completions";
import type { ComponentDefinition } from '../document/componentCatalog';
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
}

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
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      wordWrap: "on",
      padding: { top: 12 },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderWhitespace: "selection",
      stickyScroll: { enabled: false },
      fixedOverflowWidgets: true,
      // Keep word suggestions local to this model, like our own providers.
      wordBasedSuggestions: "currentDocument",
      quickSuggestions: { other: true, comments: false, strings: true },
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
    syncTheme();

    // Global language registration must be torn down on unmount, and so
    // must the keybindings of the editor's actions below.
    const disposables: monaco.IDisposable[] = ["mdx", "d2"].map((language) =>
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ["<", " ", '"', "'", ":", ".", ">"],
        provideCompletionItems(completionModel, position) {
          if (completionModel !== model || !live.current.visible)
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
    disposables.push(
      editor.onDidChangeModelContent(() => {
        if (!applyingRendered) renderedGroup = undefined;
        const text = model.getValue();
        documentSync.emitted(text);
        live.current.onChange(text);
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
        editor.trigger("elaborating.rendered-history", direction, null);
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
    };

    function syncTheme() {
      editor.updateOptions({
        theme: window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "vs-dark"
          : "vs",
      });
    }

    return () => {
      live.current.apiRef.current = null;
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
    const name = `elaborating-${appearance.theme}-${appearance.scheme}`;
    // Monaco token rules take hex without `#`; expand 3-digit to 6 digits.
    const tokenForeground = (value: string) =>
      value
        .replace(/^#/, "")
        .replace(/^([\da-f])([\da-f])([\da-f])$/i, "$1$1$2$2$3$3");
    monaco.editor.defineTheme(name, {
      base: appearance.scheme === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules:
        appearance.scheme === "dark"
          ? []
          : [
              {
                token: "type.identifier.mdx",
                foreground: tokenForeground(tokens.accent),
              },
              {
                token: "attribute.name",
                foreground: tokenForeground(tokens.text),
              },
            ],
      colors: {
        // CSS accepts #fff, but Monaco's token color map requires six digits.
        "editor.background": tokens.bg.replace(
          /^#([\da-f])([\da-f])([\da-f])$/i,
          "#$1$1$2$2$3$3",
        ),
        "editor.foreground": tokens.text,
        "editorLineNumber.foreground": tokens.muted,
        "editor.selectionBackground": tokens.selection,
        "editorCursor.foreground": tokens.accent,
        "editorWidget.background": tokens.raised,
        "editorWidget.border": tokens.line,
        "editorSuggestWidget.background": tokens.raised,
        "editorSuggestWidget.foreground": tokens.text,
        "editorSuggestWidget.selectedBackground": tokens.selection,
        "editor.lineHighlightBackground": tokens.chrome,
      },
    });
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

  // The component stays mounted in rendered mode (history preserved);
  // relayout when it becomes visible again.
  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.layout();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  return <div ref={containerRef} hidden={!visible} className="h-full w-full" />;
}

export { parseErrorPosition };
