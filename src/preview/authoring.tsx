import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { COMPONENT_CATALOG } from "../features/document/componentCatalog";
import type { RenderMessage } from "../features/rendered/protocol";
import { EditableCodeFence } from '../features/rendered/codeFence';
import { captureSourceDraft, getSourceDraft, queueRangeEdit, restoreSourceDraft } from './sourceDrafts';
import { isReadOnly } from './readOnly';

let context: {
  session: string;
  revision: number;
  metadata: RenderMessage["authoring"];
} = { session: "", revision: 0, metadata: undefined };
let resourcePaths: readonly string[] = [];
let pendingDraft: {
  element: HTMLElement;
  value: string;
  revision: number;
} | null = null;
let continuedText = "";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getPaths = () => resourcePaths;
const getAuthoringContext = () => context;
export function setAuthoringPaths(paths: readonly string[]) {
  resourcePaths = paths;
  for (const listener of listeners) listener();
}
export function setAuthoringContext(
  session: string,
  revision: number,
  metadata: RenderMessage["authoring"],
) {
  // Compilation is asynchronous. Preserve characters typed after a submitted
  // shortcut instead of replacing the DOM draft with its older submitted value.
  continuedText = "";
  if (
    metadata?.focus != null &&
    pendingDraft &&
    revision === pendingDraft.revision + 1
  ) {
    const current = pendingDraft.element.textContent ?? "";
    if (current.startsWith(pendingDraft.value))
      continuedText = current.slice(pendingDraft.value.length);
  }
  pendingDraft = null;
  context = { session, revision, metadata };
  for (const listener of listeners) listener();
}
const post = (message: unknown) => window.parent.postMessage(message, "*");

function caretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode))
    return element.textContent?.length ?? 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return range.toString().length;
}

export function RestoreAuthoringFocus(): ReactNode {
  const focus = context.metadata?.focus;
  useLayoutEffect(() => {
    if (focus == null) return;
    const entries = [
      ...document.querySelectorAll<HTMLElement>("[data-authoring-from]"),
    ];
    const distance = (element: HTMLElement) => {
      const from = Number(element.dataset.authoringFrom);
      const to = from + (element.textContent?.length ?? 0);
      return focus >= from && focus <= to
        ? 0
        : Math.min(Math.abs(from - focus), Math.abs(to - focus));
    };
    const element = entries.sort(
      (a, b) =>
        distance(a) - distance(b) ||
        Number(b.dataset.authoringFrom) - Number(a.dataset.authoringFrom),
    )[0];
    if (!element) return;
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const offset = Math.max(0, focus - Number(element.dataset.authoringFrom));
    if (element.firstChild?.nodeType === Node.TEXT_NODE)
      range.setStart(
        element.firstChild,
        Math.min(offset, element.firstChild.textContent?.length ?? 0),
      );
    else range.collapse(true);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (continuedText) {
      const text = document.createTextNode(continuedText);
      continuedText = "";
      range.insertNode(text);
      range.setStartAfter(text);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [focus]);
  return null;
}

/** Uncontrolled DOM draft. Only plain text and finite intents leave the frame. */
export function SourceBlock(props: {
  blockId: string;
  value: string;
  from: number;
}): ReactNode {
  return (
    <EditableText value={props.value} from={props.from} block={props.blockId} />
  );
}
export function SourceLeaf(props: {
  from: number;
  to: number;
  expected: string;
  children?: ReactNode;
  literal?: boolean;
}): ReactNode {
  return (
    <EditableText
      value={typeof props.children === "string" ? props.children : ""}
      from={props.from}
      leaf={{ to: props.to, expected: props.expected }}
      literal={props.literal}
    />
  );
}
/** Compiler-only component: source ownership is revalidated in the parent. */
export function SourceCode(props: { from: number; to: number; expected: string; value: string; language: string }): ReactNode {
  const { session, revision } = useSyncExternalStore(subscribe, getAuthoringContext);
  return <EditableCodeFence value={props.value} language={props.language} sourceRegion={props} readOnly={isReadOnly()}
    draft={getSourceDraft(props)} onEditorInput={captureSourceDraft} onEditorMount={restoreSourceDraft} onCommit={value => {
    if (value === props.value) return;
    queueRangeEdit({ kind: 'prose-edit', session, revision, from: props.from, to: props.to, expected: props.expected, value });
  }} />;
}
function EditableText(props: {
  value: string;
  from: number;
  block?: string;
  leaf?: { to: number; expected: string };
  literal?: boolean;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const composing = useRef(false);
  const sent = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { session, revision } = useSyncExternalStore(subscribe, getAuthoringContext);
  useEffect(() => { sent.current = false; }, [revision, props.from, props.leaf?.expected]);
  useLayoutEffect(() => {
    if (props.literal && ref.current) restoreSourceDraft(ref.current);
  }, [revision, props.from, props.leaf?.expected, props.literal]);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const submit = (action: "commit" | "enter" | "shortcut") => {
    clear();
    const element = ref.current;
    if (!element || composing.current || sent.current) return;
    const value = element.textContent ?? "";
    if (action === "commit" && value === props.value) return;
    const caret = caretOffset(element);
    sent.current = true;
    pendingDraft = { element, value, revision };
    if (props.block)
      post({
        kind: "block-edit",
        session,
        revision,
        block: props.block,
        action,
        value,
        caret,
      });
    else if (props.leaf) {
      const message = {
        session,
        revision,
        from: props.from,
        to: props.leaf.to,
        expected: props.leaf.expected,
        value,
        shortcut: action === "shortcut",
        caret,
      };
      if (props.literal && action === 'commit') queueRangeEdit({ kind: 'prose-edit', ...message });
      else post({ kind: action === 'enter' ? 'prose-enter' : 'prose-edit', ...message });
    }
  };
  if (isReadOnly())
    return <span data-source-text={`${props.from}:${props.leaf?.to ?? props.from + props.value.length}`}>{props.value}</span>;
  return (
    <span
      ref={ref}
      data-source-text={`${props.from}:${props.leaf?.to ?? props.from + props.value.length}`}
      data-authoring-from={props.from}
      data-authoring-to={props.leaf?.to}
      data-authoring-expected={props.leaf?.expected}
      data-authoring-value={props.value}
      data-authoring-block={props.block}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={props.literal ? 'Edit component text' : 'Edit prose in source'}
      aria-multiline="true"
      data-placeholder={props.block ? "Write a paragraph…" : props.literal ? 'Write text…' : undefined}
      spellCheck={false}
      onPointerDown={(event) => {
        // Firefox can place a selection in a sandboxed editable without
        // activating it. Focus first, then let the native pointer default
        // place the caret; do not preventDefault or replace the selection.
        event.currentTarget.focus();
      }}
      onCompositionStart={() => {
        composing.current = true;
        clear();
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onBlur={event => {
        if (props.literal) captureSourceDraft(event.currentTarget);
        submit('commit');
      }}
      onInput={(event) => {
        if (props.literal) captureSourceDraft(event.currentTarget);
        if (composing.current) return;
        clear();
        if (props.literal) return;
        const input = event.nativeEvent as InputEvent;
        if (input.inputType !== "insertText") return;
        const text = event.currentTarget.textContent ?? "";
        if (
          (props.block && /^(#{1,6} |[-+*] |1\. |> )/.test(text)) ||
          /(?:\*\*.+\*\*|__.+__|~~.+~~|`.+`|\*[^*]+\*|_[^_]+_)/.test(text)
        )
          timer.current = setTimeout(() => submit("shortcut"), 250);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || composing.current) return;
        if (event.key === "Enter" && (!event.shiftKey || props.literal)) {
          event.preventDefault();
          if (props.literal) {
            const selection = window.getSelection();
            if (selection?.rangeCount) {
              const range = selection.getRangeAt(0);
              const newline = document.createTextNode('\n');
              range.deleteContents();
              range.insertNode(newline);
              range.setStartAfter(newline);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
              captureSourceDraft(event.currentTarget);
            }
          } else submit("enter");
        }
        if (event.key === "Escape") {
          event.preventDefault();
          clear();
          if (ref.current) {
            ref.current.textContent = props.value;
            if (props.literal) captureSourceDraft(ref.current);
          }
          ref.current?.blur();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        clear();
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const text = event.clipboardData.getData("text/plain");
        const node = document.createTextNode(text);
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        if (props.literal) captureSourceDraft(event.currentTarget);
      }}
      style={{
        cursor: "text",
        minHeight: "1.85em",
        display: props.block
          ? "block"
          : props.value === ""
            ? "inline-block"
            : undefined,
        minWidth: props.value === "" ? "1ch" : undefined,
        whiteSpace: "pre-wrap",
      }}
    >
      {props.value}
    </span>
  );
}

const ordinary = ["Paragraph", "Heading", "Bullet list", "Quote", "Divider"];
export function BlockPicker(): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [element, setElement] = useState("Paragraph");
  const [path, setPath] = useState("");
  const [boundary, setBoundary] = useState(
    context.metadata?.boundaries.at(-1)?.id ?? "start",
  );
  const paths = useSyncExternalStore(subscribe, getPaths);
  const { session, revision, metadata } = useSyncExternalStore(subscribe, getAuthoringContext);
  const selectedBoundary = metadata?.boundaries.some(
    (entry) => entry.id === boundary,
  )
    ? boundary
    : (metadata?.boundaries.at(-1)?.id ?? "start");
  if (isReadOnly()) return null;
  const resource = element === "Drawing" || element === "Diagram";
  const choices = paths.filter((entry) =>
    element === "Drawing"
      ? /\.excalidraw(?:\.md)?$/.test(entry)
      : /\.d2$/.test(entry),
  );
  return (
    <div className="authoring-insert">
      <button
        ref={trigger}
        type="button"
        onClick={() => dialog.current?.showModal()}
      >
        + Insert block
      </button>
      <dialog
        ref={dialog}
        aria-label="Insert block"
        onClose={() => trigger.current?.focus()}
      >
        <div>
          <h2>Insert block</h2>
          <label>
            Block type
            <select
              aria-label="Block type"
              value={element}
              onChange={(event) => {
                setElement(event.target.value);
                setPath("");
              }}
            >
              {ordinary.map((name) => (
                <option key={name}>{name}</option>
              ))}
              {metadata?.format === "mdx"
                ? (context.metadata?.components ?? COMPONENT_CATALOG).map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))
                : null}
            </select>
          </label>
          <p>
            {(context.metadata?.components ?? COMPONENT_CATALOG).find((entry) => entry.name === element)
              ?.description ?? "Add an ordinary document block."}
          </p>
          <label>
            Position
            <select
              aria-label="Insert position"
              value={selectedBoundary}
              onChange={(event) => setBoundary(event.target.value)}
            >
              {metadata?.boundaries.map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {index === 0 ? "Document start" : `After block ${index}`}
                </option>
              ))}
            </select>
          </label>
          {resource ? (
            <label>
              Resource file
              <select
                aria-label="Resource file"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              >
                <option value="">Choose an existing file</option>
                {choices.map((entry) => (
                  <option key={entry}>{entry}</option>
                ))}
              </select>
            </label>
          ) : null}
          {resource && !choices.length ? (
            <p role="status">
              No matching workspace files. Create one in the explorer first.
            </p>
          ) : null}
          <div className="authoring-actions">
            <button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={resource && !choices.includes(path)}
              onClick={() => {
                // Forms are intentionally forbidden by the preview sandbox.
                // A native button still supports Enter/Space activation without
                // requiring a browser submission or expanding iframe authority.
                post({
                  kind: "insert-block",
                  session,
                  revision,
                  boundary: selectedBoundary,
                  element,
                  ...(resource ? { path } : {}),
                });
                dialog.current?.close();
              }}
            >
              Insert
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
