import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useAppearance } from "@/features/appearance";
import { applyMonacoTheme, setupMonaco } from "@/features/source/monacoSetup";

/** Narrower than this, Monaco shows both copies in one column. */
const SIDE_BY_SIDE_MIN_WIDTH = 700;

/**
 * Both copies of a conflicted text file in Monaco's diff editor, read-only:
 * the server's on the left and this device's on the right, or in one column
 * with −/+ marks when there is no room for two.
 */
export function ConflictDiff({ theirs, mine, language }: {
  theirs: string;
  mine: string;
  /** A Monaco language id: markdown, mdx, d2, json or plaintext. */
  language: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(true);
  // The palette's colours, also when no code editor has shown yet.
  const { appearance } = useAppearance();
  useEffect(() => applyMonacoTheme(appearance), [appearance]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setupMonaco();
    const original = monaco.editor.createModel(theirs, language);
    const modified = monaco.editor.createModel(mine, language);
    const editor = monaco.editor.createDiffEditor(element, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: SIDE_BY_SIDE_MIN_WIDTH,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      diffWordWrap: "on",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
    });
    editor.setModel({ original, modified });
    // Monaco 0.56 clears `originalAriaLabel` and `modifiedAriaLabel` each time
    // it lays the diff out, which leaves both inputs unnamed. Name the two
    // inner editors directly, and again whenever Monaco resets the name.
    const name = (inner: monaco.editor.ICodeEditor, label: string) => {
      const apply = () => {
        if (inner.getOption(monaco.editor.EditorOption.ariaLabel) !== label) inner.updateOptions({ ariaLabel: label });
      };
      apply();
      return inner.onDidChangeConfiguration((event) => {
        if (event.hasChanged(monaco.editor.EditorOption.ariaLabel)) apply();
      });
    };
    const names = [name(editor.getOriginalEditor(), "On the server"), name(editor.getModifiedEditor(), "On this device")];
    const observer = new ResizeObserver(([entry]) => setSideBySide(entry.contentRect.width >= SIDE_BY_SIDE_MIN_WIDTH));
    observer.observe(element);
    return () => {
      observer.disconnect();
      for (const listener of names) listener.dispose();
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [theirs, mine, language]);

  return (
    <>
      {sideBySide ? (
        <div className="wb-compare-sides">
          <span>On the server</span>
          <span>On this device</span>
        </div>
      ) : (
        <p className="wb-compare-legend">Lines marked − are on the server, and lines marked + are on this device.</p>
      )}
      <div ref={container} className="wb-compare-diff" />
    </>
  );
}
