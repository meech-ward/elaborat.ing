import { useEffect, useRef, useState } from "react"
import * as monaco from "monaco-editor"
import { useAppearance } from "@/features/appearance"
import { applyMonacoTheme, setupMonaco } from "@/features/source/monacoSetup"
import { cn } from "@/lib/utils"
import type { DiffBlockProps } from "./DiffBlock"

// Monaco's diff editor: heavy, so only DiffBlock imports it, dynamically.

/** Narrower than this, Monaco shows both copies in one column. */
const SIDE_BY_SIDE_MIN_WIDTH = 700

/**
 * Two versions of a text file in Monaco's diff editor, read-only: `before`
 * on the left and `after` on the right, each named over its side, or in one
 * column with −/+ marks and the legend when there is no room for two.
 */
export function TextDiff({ before, after, language, beforeLabel, afterLabel, legend, className }: DiffBlockProps) {
  const container = useRef<HTMLDivElement>(null)
  const [sideBySide, setSideBySide] = useState(true)
  // The palette's colours, also when no code editor has shown yet.
  const { appearance } = useAppearance()
  useEffect(() => applyMonacoTheme(appearance), [appearance])

  useEffect(() => {
    const element = container.current
    if (!element) return
    setupMonaco()
    const original = monaco.editor.createModel(before, language)
    const modified = monaco.editor.createModel(after, language)
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
    })
    editor.setModel({ original, modified })
    // Monaco 0.56 clears `originalAriaLabel` and `modifiedAriaLabel` each time
    // it lays the diff out, which leaves both inputs unnamed. Name the two
    // inner editors directly, and again whenever Monaco resets the name.
    const name = (inner: monaco.editor.ICodeEditor, label: string) => {
      const apply = () => {
        if (inner.getOption(monaco.editor.EditorOption.ariaLabel) !== label) inner.updateOptions({ ariaLabel: label })
      }
      apply()
      return inner.onDidChangeConfiguration((event) => {
        if (event.hasChanged(monaco.editor.EditorOption.ariaLabel)) apply()
      })
    }
    const names = [name(editor.getOriginalEditor(), beforeLabel), name(editor.getModifiedEditor(), afterLabel)]
    const observer = new ResizeObserver(([entry]) => setSideBySide(entry.contentRect.width >= SIDE_BY_SIDE_MIN_WIDTH))
    observer.observe(element)
    return () => {
      observer.disconnect()
      for (const listener of names) listener.dispose()
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [before, after, language, beforeLabel, afterLabel])

  return (
    <>
      {sideBySide ? (
        <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
          <span>{beforeLabel}</span>
          <span>{afterLabel}</span>
        </div>
      ) : (
        <p className="m-0 text-xs">{legend ?? `Lines marked − are in ${beforeLabel}, and lines marked + are in ${afterLabel}.`}</p>
      )}
      <div
        ref={container}
        data-slot="text-diff"
        className={cn("h-[min(60dvh,36rem)] min-h-48 overflow-hidden rounded-tool border border-panel-border", className)}
      />
    </>
  )
}
