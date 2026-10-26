import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { COMPONENT_CATALOG } from "../features/document/componentCatalog";
import { isDocumentPath } from '../features/document/documentPaths';
import type { RenderMessage } from "../features/rendered/protocol";
import { EditableCodeFence } from '../features/rendered/codeFence';
import { captureSourceDraft, getSourceDraft, queueRangeEdit, restoreSourceDraft, startSourceDraft } from './sourceDrafts';
import { isReadOnly } from './readOnly';
import { postToParent as post } from './parentPort';
import { imageFilePayloads } from '../features/images/transport';

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
/**
 * What the rendered editor gives a code block made from a typed fence: the
 * text typed while it was being made, and undo in the note's history.
 */
let codeBlockHooks = { typed: () => "", undo: () => {} };
export function setCodeBlockHooks(hooks: typeof codeBlockHooks) {
  codeBlockHooks = hooks;
}
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
  const { session, revision, metadata } = useSyncExternalStore(subscribe, getAuthoringContext);
  // An empty code block the parent put the caret in was just made from a
  // typed fence: it opens for typing, with anything typed meanwhile, and
  // Ctrl+Z before anything else undoes making it.
  const [made] = useState(() => {
    const focus = metadata?.focus;
    if (props.value !== '' || focus == null || focus <= props.from || focus >= props.to) return false;
    startSourceDraft(props, codeBlockHooks.typed(), props.value);
    return true;
  });
  return <EditableCodeFence value={props.value} language={props.language} sourceRegion={props} readOnly={isReadOnly()}
    onUndo={made ? codeBlockHooks.undo : undefined}
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

const ordinary = ["Paragraph", "Heading", "Bullet list", "Quote", "Divider", "Image"];
export function BlockPicker({ blockPositionAt }: {
  /** The clicked top-level editor block, or -1 for space before the note. */
  blockPositionAt?: (event: MouseEvent | ClipboardEvent | DragEvent) => number | null;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const menuBoundary = useRef("start");
  const [element, setElement] = useState("Paragraph");
  const [path, setPath] = useState("");
  const [boundary, setBoundary] = useState(
    context.metadata?.boundaries.at(-1)?.id ?? "start",
  );
  const paths = useSyncExternalStore(subscribe, getPaths);
  const { session, revision, metadata } = useSyncExternalStore(subscribe, getAuthoringContext);
  const readOnly = isReadOnly();
  useEffect(() => {
    const ingest = (event: ClipboardEvent | DragEvent) => {
      const files = [...(event instanceof ClipboardEvent ? event.clipboardData?.files ?? [] : event.dataTransfer?.files ?? [])];
      if (!files.length || !files.some(file => file.type.startsWith('image/'))) return;
      event.preventDefault();
      event.stopPropagation();
      if (readOnly || !blockPositionAt || !metadata) return;
      const position = blockPositionAt(event);
      const at = position === null ? null : position < 0 ? 'start' : metadata.blockBoundaries?.find(entry => entry.position === position)?.boundary;
      if (!at) return;
      void imageFilePayloads(files).then(payloads => {
        post({kind:'insert-image',session,revision,boundary:at,files:payloads});
      }).catch(error => post({kind:'edit-rejected',session,revision,message:error instanceof Error ? error.message : String(error)}));
    };
    const drag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    document.addEventListener('paste',ingest,true);
    document.addEventListener('drop',ingest,true);
    document.addEventListener('dragover',drag,true);
    return () => {
      document.removeEventListener('paste',ingest,true);
      document.removeEventListener('drop',ingest,true);
      document.removeEventListener('dragover',drag,true);
    };
  }, [blockPositionAt,metadata,readOnly,revision,session]);
  useEffect(() => {
    const popup = menu.current;
    if (readOnly || !popup || !blockPositionAt || !metadata?.blockBoundaries) return;
    const open = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("input,textarea,select,dialog,[role=menu]")) return;
      const position = blockPositionAt(event);
      if (position === null) return;
      const boundary = position < 0 ? "start" : metadata.blockBoundaries?.find(entry => entry.position === position)?.boundary;
      if (!boundary) return;
      event.preventDefault();
      menuBoundary.current = boundary;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      popup.showPopover();
      const box = popup.getBoundingClientRect();
      const selection = window.getSelection();
      const caret = event.button !== 2 && selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      popup.style.left = `${Math.max(10, Math.min(caret?.left ?? event.clientX, innerWidth - box.width - 10))}px`;
      popup.style.top = `${Math.max(10, Math.min(caret?.bottom ?? event.clientY, innerHeight - box.height - 10))}px`;
      popup.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
    };
    const dismiss = () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.contains(event.target)) dismiss();
    };
    document.addEventListener("contextmenu", open);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
      // A newer render invalidates the menu's captured source boundary.
      dismiss();
    };
  }, [blockPositionAt, metadata, readOnly, revision, session]);
  const selectedBoundary = metadata?.boundaries.some(
    (entry) => entry.id === boundary,
  )
    ? boundary
    : (metadata?.boundaries.at(-1)?.id ?? "start");
  if (readOnly) return null;
  const components = metadata?.components ?? COMPONENT_CATALOG;
  const names = [...ordinary, ...(metadata?.format === "mdx" ? components.map(entry => entry.name) : [])];
  const resource = element === "Drawing" || element === "Diagram" || element === 'Document';
  const choices = paths.filter((entry) =>
    element === "Drawing"
      ? /\.excalidraw(?:\.md)?$/.test(entry)
      : element === 'Document' ? isDocumentPath(entry) : /\.d2$/.test(entry),
  );
  const insert = (name: string, at: string, resourcePath?: string) => name === 'Image' ? post({kind:'insert-image',session,revision,boundary:at}) : post({
    kind: "insert-block",
    session,
    revision,
    boundary: at,
    element: name,
    ...(resourcePath !== undefined ? { path: resourcePath } : {}),
  });
  return (
    <div className="authoring-insert">
      <div
        ref={menu}
        // Auto popovers light-dismiss on the right-button release that opened
        // this menu. Manual mode keeps it open; the listeners above dismiss it.
        popover="manual"
        role="menu"
        aria-label="Insert block"
        className="authoring-block-menu"
        onFocusCapture={event => {
          const focused: HTMLElement = event.target;
          for (const item of event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"))
            item.tabIndex = item === focused ? 0 : -1;
        }}
        onKeyDown={event => {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          let next: number;
          if (event.key === "ArrowDown") next = (current + 1) % items.length;
          else if (event.key === "ArrowUp") next = (current + items.length - 1) % items.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = items.length - 1;
          else if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            menu.current?.hidePopover();
            returnFocus.current?.focus({ preventScroll: true });
            return;
          } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Native buttons supply Enter/Space; menu items also support typeahead.
            next = items.findIndex((_, index) => index > current && names[index].toLowerCase().startsWith(event.key.toLowerCase()));
            if (next < 0) next = names.findIndex(name => name.toLowerCase().startsWith(event.key.toLowerCase()));
            if (next < 0) return;
          } else return;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        <div className="authoring-menu-label" aria-hidden="true">Insert block</div>
        {names.map((name, index) => (
          <button
            key={name}
            type="button"
            role="menuitem"
            tabIndex={index === 0 ? 0 : -1}
            className={index === ordinary.length ? "authoring-menu-components" : undefined}
            title={components.find(entry => entry.name === name)?.description}
            onPointerMove={event => event.currentTarget.focus({ preventScroll: true })}
            onClick={() => {
              menu.current?.hidePopover();
              if (name === "Drawing" || name === "Diagram" || name === 'Document') {
                setElement(name);
                setPath("");
                setBoundary(menuBoundary.current);
                dialog.current?.showModal();
              } else insert(name, menuBoundary.current);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          returnFocus.current = trigger.current;
          dialog.current?.showModal();
        }}
      >
        + Insert block
      </button>
      <dialog
        ref={dialog}
        aria-label="Insert block"
        onClose={() => returnFocus.current?.focus({ preventScroll: true })}
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
                insert(element, selectedBoundary, resource ? path : undefined);
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
