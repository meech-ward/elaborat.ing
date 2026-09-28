import { isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useModule } from '../../lib/moduleLoader';
import { frameModules } from '../../preview/frameModules';

/**
 * A code block's highlighted HTML (codeHighlight.ts), or null: plain text, or
 * until the highlighter has loaded. It loads in the preview frame the first
 * time a code block with a language shows.
 */
function useHighlightedCode(code: string, language: string): string | null {
  const { module } = useModule(frameModules.highlighter, language !== '');
  return module && language ? module.highlightCode(code, language) : null;
}

/** Two-space indent/outdent, with selection offsets retained for native input. */
export function indentCode(value: string, start: number, end: number, outdent: boolean) {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = value.indexOf('\n', last);
  const to = lineEnd < 0 ? value.length : lineEnd;
  let delta = 0;
  let firstDelta = 0;
  const insert = value.slice(from, to).split('\n').map((line, index) => {
    const removed = outdent ? /^(?:\t| {1,2})/.exec(line)?.[0].length ?? 0 : 0;
    const change = outdent ? -removed : 2;
    delta += change;
    if (index === 0) firstDelta = change;
    return outdent ? line.slice(removed) : `  ${line}`;
  }).join('\n');
  return {
    value: value.slice(0, from) + insert + value.slice(to),
    start: Math.max(from, start + firstDelta), end: Math.max(from, end + delta),
  };
}

/** Fallback for generated/unmapped code. Parser-backed fences use EditableCodeFence. */
export function CodeFence({ children, ...props }: ComponentPropsWithoutRef<'pre'>): ReactNode {
  const fence = isValidElement<{ children?: unknown; className?: string }>(children)
    && typeof children.props.children === 'string' ? children.props : null;
  const code = typeof fence?.children === 'string' ? fence.children : '';
  const language = fence ? /(?:^|\s)language-([^\s]+)/.exec(fence.className ?? '')?.[1] ?? '' : '';
  const highlighted = useHighlightedCode(code, language);
  if (!fence) return <pre {...props}>{children}</pre>;
  return (
    <div className="not-prose document-code" data-code-language={language || 'text'}>
      <div className="document-code-label">{language || 'text'} <span>Code · edit in Source</span></div>
      {highlighted === null
        ? <pre {...props} tabIndex={0} aria-label={`${language || 'Plain text'} code`}><code>{code}</code></pre>
        // Only escaped HTML from the fixed Shiki pipeline (codeHighlight.ts), never raw MDX.
        : <div role="group" aria-label={`${language} code`} className="document-code-highlight" dangerouslySetInnerHTML={{ __html: highlighted }} />}
    </div>
  );
}

/** An uncontrolled textarea keeps rapid typing and multiline input in one draft. */
export function EditableCodeFence({ value, language, onCommit, sourceRegion, draft, onEditorInput, onEditorMount, readOnly = false }: {
  value: string;
  language: string;
  /** Show the code without an Edit code button (a read-only document). */
  readOnly?: boolean;
  onCommit: (value: string) => void;
  sourceRegion?: { from: number; to: number; expected: string };
  draft?: { value: string; focused: boolean };
  onEditorInput?: (element: HTMLTextAreaElement) => void;
  onEditorMount?: (element: HTMLTextAreaElement) => void;
}): ReactNode {
  const [editing, setEditing] = useState(!!draft);
  const highlighted = useHighlightedCode(value, language);
  return (
    <div className="not-prose document-code" data-code-language={language || 'text'}>
      <div className="document-code-label">
        {language || 'text'}
        {readOnly ? null : editing ? <span>Editing code</span> : <button type="button" onClick={() => setEditing(true)}>Edit code</button>}
      </div>
      {editing && !readOnly ? (
        <textarea
          autoFocus={!draft || draft.focused}
          className="document-code-editor"
          aria-label={`Edit ${language || 'plain text'} code`}
          data-authoring-from={sourceRegion?.from}
          data-authoring-to={sourceRegion?.to}
          data-authoring-expected={sourceRegion?.expected}
          data-authoring-value={value}
          defaultValue={draft?.value ?? value}
          ref={element => { if (element) onEditorMount?.(element); }}
          onInput={event => onEditorInput?.(event.currentTarget)}
          spellCheck={false}
          rows={Math.max(3, Math.min(24, value.split('\n').length + 1))}
          onBlur={event => {
            onEditorInput?.(event.currentTarget);
            onCommit(event.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Tab') {
              event.preventDefault();
              const input = event.currentTarget;
              const next = indentCode(input.value, input.selectionStart, input.selectionEnd, event.shiftKey);
              input.value = next.value;
              input.setSelectionRange(next.start, next.end);
              onEditorInput?.(input);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.value = value;
              onEditorInput?.(event.currentTarget);
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div onClick={() => setEditing(true)}>
          {highlighted === null
            ? <pre aria-label={`${language || 'Plain text'} code`}><code>{value}</code></pre>
            : <div role="group" aria-label={`${language} code`} className="document-code-highlight" dangerouslySetInnerHTML={{ __html: highlighted }} />}
        </div>
      )}
    </div>
  );
}
