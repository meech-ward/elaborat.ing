/**
 * Isolated preview bootstrap (child frame).
 *
 * This module is the ONLY place where compiled document JavaScript is
 * evaluated, via `run()` from `@mdx-js/mdx`. The build bundles it for the
 * frame's page on the sandbox domain and for the `srcdoc` frame
 * (`sandbox="allow-scripts"`, no `allow-same-origin`, either way), so it has
 * no access to the parent document, storage, or file privileges, and the CSP
 * forbids all network.
 *
 * The child never sees document source. It receives compiled code plus slot
 * metadata (source ranges), renders in-place editable `SourceText` spans and
 * literal-prop controls for supported components, and reports edits back as
 * range patches the parent checks against its own instrumentation before
 * applying.
 */
import { run } from "@mdx-js/mdx";
import * as jsxRuntime from "react/jsx-runtime";
import { trustedReact } from './trustedReact';
import {
  StrictMode,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type MouseEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { captureDraftsBeforeRender, setSourceDraftContext, finishSourceDraftRender, queueRangeEdit, queueComponentValueEdit, settleSourceDraft } from './sourceDrafts';
import { FluidEditor } from "./fluidEditor";
import { typeIn, typeInPlugin, type TypeIn } from "./typeIn";
import { TextSelection, type EditorState } from "prosemirror-state";
import { mapThroughDoc } from "../features/document/writeIn";
import { Note, Warning, Important, Instruction, SideBySide, SideBySideBlock, ExampleCard, Tabs, Tab, type SideBySideProps } from '../features/rendered/documentBlocks';
import { InlineLiteral } from './InlineLiteral';
import { isReadOnly, setReadOnly } from './readOnly';
import { CodeFence } from '../features/rendered/codeFence';
import { LAZY_CHART_COMPONENTS } from './lazyCharts';
import { loadModuleFiles, receiveFrameModule, setFrameModuleRequest } from './frameModules';
import { connectToParent, postLinkToParent, postToParent } from './parentPort';
import { pictureSize } from '../features/rendered/resourceViewer.ts';
import { scopeSvgIds } from '../features/drawings/svgMask.ts';
import { rasterImageUses } from '../features/drawings/presentation.ts';
import type { ImagePreview } from '../features/images/transport';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Columns,
  Counter,
  Separator,
} from "../features/rendered/components";
import { getAppearanceTokens } from "../features/appearance/tokens";
import { readingStyle } from "../features/appearance/reading";
import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import {
  checkParentMessage,
  encodePropLiteral,
  type CommentMarksMessage,
  type FrameRect,
  type RenderMessage,
  type SlotInfo,
} from "../features/rendered/protocol";
import {
  SourceBlock,
  SourceLeaf,
  SourceCode,
  BlockPicker,
  RestoreAuthoringFocus,
  setAuthoringContext,
  setAuthoringPaths,
  setCodeBlockHooks,
} from "./authoring";

type PendingRender = {
  session: string;
  revision: number;
  code: string;
  slots: SlotInfo[];
  modules?: RenderMessage['modules'];
  authoring?: RenderMessage["authoring"];
  fluid?: RenderMessage["fluid"];
  readOnly?: boolean;
};

let activeSession: string | null = null;
let activeRevision = -1;
let slotTable: SlotInfo[] = [];
/** Monotonic render generation: completions from a superseded generation are dropped. */
let renderSeq = 0;
/**
 * Generated pixels for Drawing/Diagram embeds, keyed by workspace path.
 * Pixels only: the frame never receives file bytes, tokens, or filesystem
 * access. Replaced wholesale on every resources message.
 */
let resourceTable: Record<string, string> = {};
const resourceListeners = new Set<() => void>();
const readResources = () => resourceTable;
function subscribeResources(listener: () => void): () => void {
  resourceListeners.add(listener);
  return () => {
    resourceListeners.delete(listener);
  };
}

let imageTable:Record<string,ImagePreview> = Object.create(null);
let originalImages:Record<string,{image?:ImagePreview;error?:string}> = Object.create(null);
const imageListeners = new Set<() => void>();
const readImages = () => imageTable;
const readOriginalImages = () => originalImages;
function subscribeImages(listener: () => void) {
  imageListeners.add(listener);
  return () => { imageListeners.delete(listener); };
}
/** Ignore every document-owned URL and event handler. Only parent-validated pixels display. */
function ProjectImage(props: {src?:string;alt?:string;__imageFrom?:number;'data-image-from'?:number|string;__imageCaption?:string;'data-image-caption'?:string}): ReactNode {
  const {src,alt = ''} = props;
  const images = useSyncExternalStore(subscribeImages,readImages);
  const originals = useSyncExternalStore(subscribeImages,readOriginalImages);
  const pixels = typeof src === 'string' && Object.hasOwn(images,src) ? images[src] : undefined;
  const original = typeof src === 'string' && Object.hasOwn(originals,src) ? originals[src] : undefined;
  const enlarged = original?.image ?? pixels;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const description = useRef<HTMLDialogElement>(null);
  const captionDialog = useRef<HTMLDialogElement>(null);
  const caption = props.__imageCaption ?? props['data-image-caption'] ?? '';
  const [captionDraft,setCaptionDraft] = useState(caption);
  const [draft,setDraft] = useState(alt);
  const from = props.__imageFrom ?? (props['data-image-from'] === undefined ? undefined : Number(props['data-image-from']));
  const edit = (action:'describe'|'replace'|'remove'|'caption',nextAlt?:string,nextCaption?:string) => {
    if (isReadOnly() || !activeSession || from === undefined || !Number.isSafeInteger(from) || !src) return;
    postToParent({kind:'image-edit',session:activeSession,revision:activeRevision,key:src,from,action,...(nextAlt === undefined ? {} : {alt:nextAlt}),...(nextCaption === undefined ? {} : {caption:nextCaption})});
  };
  return <span className="project-image" contentEditable={false}>
    {pixels ? <button ref={trigger} type="button" className="project-image-open" aria-label={alt ? `View image: ${alt}` : 'View image'} onClick={() => {
      dialog.current?.showModal();
      if (activeSession && src) postToParent({kind:'view-image',session:activeSession,revision:activeRevision,key:src});
    }}>
      <img src={pixels.dataURL} alt={alt} width={pixels.width} height={pixels.height} loading="lazy" decoding="async" />
    </button> : <span className="project-image-missing" role="img" aria-label={alt || 'Image unavailable'}>{alt || 'Image unavailable'}</span>}
    {pixels ? <dialog ref={dialog} className="project-image-viewer" aria-label={alt || 'Image'} onClose={() => {
      trigger.current?.focus({preventScroll:true});
      originalImages = Object.create(null);
      for (const listener of imageListeners) listener();
    }}>
      <button type="button" onClick={() => dialog.current?.close()}>Close image</button>
      {original?.error ? <p role="status">{original.error}</p> : null}
      <img src={enlarged!.dataURL} alt={alt} width={enlarged!.width} height={enlarged!.height} />
    </dialog> : null}
    {!isReadOnly() && from !== undefined ? <span className="project-image-actions">
      <button type="button" onClick={() => {setDraft(alt);description.current?.showModal();}}>Edit description</button>
      <button type="button" onClick={() => {setCaptionDraft(caption);captionDialog.current?.showModal();}}>Edit caption</button>
      <button type="button" onClick={() => edit('replace')}>Replace image</button>
      <button type="button" onClick={() => edit('remove')}>Remove image</button>
    </span> : null}
    <dialog ref={description} className="project-image-description" aria-label="Image description">
      <label>Image description<input value={draft} maxLength={2048} onChange={event => setDraft(event.target.value)} /></label>
      <label><input type="checkbox" checked={draft === ''} onChange={event => setDraft(event.target.checked ? '' : alt || 'Image')} />Decorative image</label>
      <button type="button" onClick={() => description.current?.close()}>Cancel</button>
      <button type="button" onClick={() => {edit('describe',draft);description.current?.close();}}>Apply description</button>
    </dialog>
    <dialog ref={captionDialog} className="project-image-description" aria-label="Image caption">
      <label>Caption (Markdown)<textarea value={captionDraft} maxLength={4096} rows={3} onChange={event => setCaptionDraft(event.target.value)} /></label>
      <p>Use bold, italics, links or code. Leave empty to remove the caption text.</p>
      <button type="button" onClick={() => captionDialog.current?.close()}>Cancel</button>
      <button type="button" onClick={() => {edit('caption',undefined,captionDraft);captionDialog.current?.close();}}>Apply caption</button>
    </dialog>
  </span>;
}

// Charts and code highlighting load the first time a note shows them
// (frameModules.ts): on the sandbox domain from files beside this page, and
// in a `srcdoc` frame (no files of its own) the parent sends their code.
if (location.protocol === "https:" || location.protocol === "http:") {
  loadModuleFiles();
} else {
  setFrameModuleRequest((name) => {
    if (activeSession == null) return false;
    postToParent({ kind: "load-module", session: activeSession, name });
    return true;
  });
}

// The app's shortcuts (save, commands, go to file, duplicate, focus, and the
// view switch) work while the keyboard is in the frame: the frame passes them
// up instead of letting the frame or the browser act on them. The comment key
// comments on the selection, or on the heading holding the caret; elsewhere it
// is passed up too (it shows or hides the comments).
window.addEventListener(
  "keydown",
  (event) => {
    if (!activeSession || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
    if (event.altKey && event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      const target = commentTarget();
      if (target) postToParent({ kind: "comment-shortcut", session: activeSession, revision: activeRevision, ...target });
      else postToParent({ kind: "shortcut", session: activeSession, key: "m", meta: event.metaKey, ctrl: event.ctrlKey, alt: true });
      return;
    }
    const digit = /^Digit([123])$/.exec(event.code)?.[1];
    const key = event.altKey ? digit : ["s", "k", "p", "d", "."].find((candidate) => candidate === event.key.toLowerCase());
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    postToParent({ kind: "shortcut", session: activeSession, key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
  },
  true,
);
// An Escape no control in the note used is passed up too: outside the frame
// it stops attaching a comment to text. The note's text (ProseMirror) marks
// every Escape as handled, so only a control's use counts, such as a field
// putting its value back. ProseMirror leaves these controls' keys to them.
window.addEventListener("keydown", (event) => {
  if (!activeSession || event.key !== "Escape") return;
  if (event.defaultPrevented && event.target instanceof Element && event.target.closest("button,input,select,textarea,[data-authoring-from]")) return;
  postToParent({ kind: "shortcut", session: activeSession, key: "Escape", meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
});
// The person's use of the note (a key, a press, the wheel) is passed up, at
// most twice a second: the page around the frame cannot see input in it,
// and in a chat's panel it does not open the agent's next file meanwhile.
const ACTIVITY_MS = 500;
let reportedActivity = -Infinity;
for (const type of ["keydown", "pointerdown", "wheel", "touchstart"]) {
  window.addEventListener(
    type,
    () => {
      const now = performance.now();
      if (!activeSession || now - reportedActivity < ACTIVITY_MS) return;
      reportedActivity = now;
      postToParent({ kind: "activity", session: activeSession });
    },
    { capture: true, passive: true },
  );
}

// The page never zooms on phones and tablets (docs/architecture.md): a pinch
// over the frame must not zoom the app's page either. iOS Safari ignores the
// viewport's maximum-scale for pinches, so its gesture events are cancelled.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

/** A component's editable properties, or none while the document is read-only. */
function slotByIndex(index: number): SlotInfo | undefined {
  if (isReadOnly()) return undefined;
  return slotTable.find((slot) => slot.index === index);
}

/**
 * One editable prose leaf, edited in place where it renders (inside its
 * heading, emphasis, list item, ...). The span stays uncontrolled while
 * typing so text and selection are never disturbed; the edit commits to
 * source on blur or Enter, Escape restores the rendered text.
 *
 * `expected` is the exact source slice for this leaf (entities and escapes
 * intact); `children` is the decoded text. Commits echo `expected` back so
 * the parent can match its own instrumentation before patching.
 */
function NumberControl(props: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
}): ReactNode {
  const [draft, setDraft] = useState(String(props.value));
  return (
    <label
      style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}
    >
      {props.label}
      <input
        aria-label={props.label}
        inputMode="numeric"
        value={draft}
        size={4}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (Number.isFinite(next) && next !== props.value)
            props.onCommit(next);
          else setDraft(String(props.value));
        }}
      />
    </label>
  );
}

function StringControl(props: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(props.value);
  return (
    <label
      style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}
    >
      {props.label}
      <input
        aria-label={props.label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== props.value) props.onCommit(draft);
        }}
      />
    </label>
  );
}

function commitProp(
  slotIndex: number,
  propName: string,
  next: string | number | boolean,
): void {
  const slot = slotByIndex(slotIndex);
  const prop = slot?.props.find((entry) => entry.name === propName);
  if (!slot || !prop || activeSession == null) return;
  let literal: string;
  try {
    literal = encodePropLiteral(prop.syntax, prop.kind, next);
  } catch {
    return;
  }
  queueRangeEdit({
    kind: "prop-edit",
    session: activeSession,
    revision: activeRevision,
    slot: slotIndex,
    prop: propName,
    literal,
    from: prop.from,
    to: prop.to,
    expected: prop.expected,
  }, String(next));
}

/** Compiler-inserted wrapper; lexical local/imported React bindings stay intact. */
function CustomControls(props: {__slot?: number; inline?: boolean; children?: ReactNode}): ReactNode {
  const slot = typeof props.__slot === 'number' ? slotByIndex(props.__slot) : undefined;
  return <span className="custom-component not-prose" data-inline={props.inline ? 'true' : undefined}>
    {props.children}
    {slot?.supported && slot.props.length ? <fieldset className="custom-component-controls not-prose">
      <legend>{slot.element} properties</legend>
      {slot.props.map(prop => {
        const label = `${slot.element} ${prop.name}`;
        const commit = (value: string | number | boolean) => commitProp(slot.index,prop.name,value);
        return <span key={prop.name+':'+prop.expected} className="custom-component-control">
          {prop.kind === 'boolean' ? <label className="custom-component-check"><input aria-label={label} type="checkbox" checked={prop.value === true} onChange={e => commit(e.target.checked)} />{prop.name}</label>
            : prop.choices ? <label>{prop.name}<select aria-label={label} value={String(prop.value ?? '')} onChange={e => commit(e.target.value)}>{prop.choices.map(choice => <option key={choice}>{choice}</option>)}</select></label>
            : prop.kind === 'number' ? <NumberControl label={label} value={Number(prop.value)} onCommit={commit} />
            : <StringControl label={label} value={String(prop.value ?? '')} onCommit={commit} />}
        </span>;
      })}
    </fieldset> : slot ? <small>{slot.reason ?? 'Edit this component in Source.'}</small> : null}
  </span>;
}

function CounterWithControls(props: {
  __slot?: number;
  initial?: number;
  step?: number;
}): ReactNode {
  const slot =
    typeof props.__slot === "number" ? slotByIndex(props.__slot) : undefined;
  const editable = slot?.supported === true;
  const initialProp = slot?.props.find((entry) => entry.name === "initial");
  const stepProp = slot?.props.find((entry) => entry.name === "step");
  return (
    <span
      className="not-prose"
      style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}
    >
      <Counter initial={props.initial} step={props.step} />
      {typeof props.__slot === "number" && !editable && !isReadOnly() ? (
        <small title={slot?.reason ?? "Computed output"}>
          Computed output: edit in source.
        </small>
      ) : null}
      {editable &&
      initialProp?.kind === "number" &&
      typeof props.__slot === "number" ? (
        <NumberControl
          label="initial"
          value={typeof props.initial === "number" ? props.initial : 0}
          onCommit={(next) =>
            commitProp(props.__slot as number, "initial", next)
          }
        />
      ) : null}
      {editable &&
      stepProp?.kind === "number" &&
      typeof props.__slot === "number" ? (
        <NumberControl
          label="step"
          value={typeof props.step === "number" ? props.step : 1}
          onCommit={(next) => commitProp(props.__slot as number, "step", next)}
        />
      ) : null}
    </span>
  );
}

const CALLOUT_TONES = ["info", "warn", "error"];

function CalloutWithControls(props: {
  __slot?: number;
  tone?: string;
  title?: string;
  children?: ReactNode;
}): ReactNode {
  const slot =
    typeof props.__slot === "number" ? slotByIndex(props.__slot) : undefined;
  const editable = slot?.supported === true;
  const titleProp = slot?.props.find((entry) => entry.name === "title");
  const toneProp = slot?.props.find((entry) => entry.name === "tone");
  const slotIndex = typeof props.__slot === "number" ? props.__slot : null;
  // The control shows the file's own tone, even one the callout draws as
  // info (such as "note"); choosing another rewrites it.
  const tone = typeof props.tone === "string" && props.tone ? props.tone : "info";
  const tones = CALLOUT_TONES.includes(tone) ? CALLOUT_TONES : [tone, ...CALLOUT_TONES];
  const titleControl = editable && titleProp?.kind === "string" && slotIndex !== null;
  const toneControl = editable && toneProp?.kind === "string" && slotIndex !== null;
  const commit = (name: string, next: string) => {
    if (slotIndex !== null) commitProp(slotIndex, name, next);
  };
  // reading.css keeps the controls out of the note until the callout is
  // pointed at or has focus, as a drawing's name and Edit.
  return (
    <span className="not-prose callout-block" style={{ display: "block" }}>
      <Callout tone={props.tone as "info" | "warn" | "error" | undefined} title={props.title}>
        {props.children}
      </Callout>
      {slotIndex !== null && !editable && !isReadOnly() ? (
        <small title={slot?.reason ?? "Computed output"}>
          Computed output: edit in source.
        </small>
      ) : null}
      {titleControl || toneControl ? (
        <span className="callout-controls">
          {titleControl ? (
            <StringControl
              label="title"
              value={typeof props.title === "string" ? props.title : ""}
              onCommit={(next) => commit("title", next)}
            />
          ) : null}
          {toneControl ? (
            <label>
              tone
              <select
                aria-label="tone"
                value={tone}
                onChange={(event) => commit("tone", event.target.value)}
              >
                {tones.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A referenced drawing or structured diagram inside the rendered document.
 * Renders only the pixels the parent delivered for this path, plus an edit
 * action that posts back the path. The parent re-validates the path against
 * the source-parsed references before opening anything, so a forged request
 * from evaluated document code cannot reach other files.
 */
let lastViewAction: { path: string; button: HTMLButtonElement } | null = null;
function focusViewAction(path: string): void {
  const button = lastViewAction?.path === path && lastViewAction.button.isConnected
    ? lastViewAction.button
    : document.querySelector(`[data-view-resource="${CSS.escape(path)}"]`);
  lastViewAction = null;
  if (button instanceof HTMLElement) button.focus({ preventScroll: true });
}

function ResourceEmbed(props: {
  kind: "drawing" | "diagram";
  src?: string;
}): ReactNode {
  const resources = useSyncExternalStore(subscribeResources, readResources);
  const src = typeof props.src === "string" ? props.src : "";
  const svg = src ? resources[src] : undefined;
  const edit = () => {
    if (!src || activeSession == null) return;
    postToParent({
      kind: "edit-resource",
      session: activeSession,
      revision: activeRevision,
      path: src,
    });
  };
  // Reading-only inspection: the SVG region is an accessible action that
  // sends only the path. The parent re-validates session, revision, the
  // source-parsed allowlist and its own pixels before opening anything.
  const view = (event: MouseEvent<HTMLButtonElement>) => {
    if (!src || !svg || activeSession == null) return;
    lastViewAction = { path: src, button: event.currentTarget };
    postToParent({
      kind: "view-resource",
      session: activeSession,
      revision: activeRevision,
      path: src,
    });
  };
  const label = props.kind === "drawing" ? "drawing" : "diagram";
  // reading.css sizes the picture from its own size (a readable size, at
  // most 480px high) and fades out what it cuts off; View shows all of it.
  const size = svg ? pictureSize(svg) : null;
  const sizing = size
    ? ({ "--picture-width": `${size.width}px`, "--picture-ratio": size.width / size.height } as CSSProperties)
    : undefined;
  const pixels = useRef<HTMLSpanElement>(null);
  // One object per picture: React writes the markup again whenever this
  // object is a new one, which would undo the ids and marks set below.
  const markup = useMemo(() => ({ __html: svg ?? "" }), [svg]);
  const [clipped, setClipped] = useState(false);
  // A note can show the same picture twice: each copy's ids are its own.
  const scope = useId().replace(/[^\w-]/g, "");
  useLayoutEffect(() => {
    if (!pixels.current) return;
    scopeSvgIds(pixels.current, scope);
    // reading.css turns these back under the dark filter, so a drawing's
    // images keep their colours as the scheme switches.
    for (const use of rasterImageUses(pixels.current)) use.setAttribute("data-raster-image", "");
  }, [svg, scope]);
  useLayoutEffect(() => {
    const box = pixels.current;
    if (!box) return;
    // A ResizeObserver reports each box once when it starts watching it.
    const observer = new ResizeObserver(() => setClipped(box.scrollHeight > box.clientHeight + 1));
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [svg]);
  // reading.css draws the box, and shows the caption over its top on hover and focus.
  return (
    <figure
      className="not-prose"
      data-resource={props.kind}
      data-src={src}
      data-pixels={svg ? "true" : "false"}
    >
      {svg ? (
        <button
          type="button"
          data-view-resource={src}
          aria-label={`View ${label} ${src}`}
          onClick={view}
          style={{
            display: "block",
            width: "100%",
            minHeight: 0,
            padding: 0,
            border: 0,
            background: "none",
            cursor: "pointer",
            textAlign: "inherit",
            color: "inherit",
          }}
        >
          <span
            ref={pixels}
            data-resource-pixels={src}
            data-clipped={clipped || undefined}
            dangerouslySetInnerHTML={markup}
            style={{ display: "block", pointerEvents: "none", ...sizing }}
          />
        </button>
      ) : (
        <p>
          <small>
            Preview unavailable{src ? ` for ${src}` : ""}: open the file to
            render it.
          </small>
        </p>
      )}
      <figcaption>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {props.kind === "drawing" ? "Drawing" : "Diagram"}:{" "}
          {src || "(missing src)"}
        </span>
        {src ? (
          <button type="button" onClick={edit}>
            Edit {label}
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Preview frame has no root element.");
const root = createRoot(rootElement);
const editorMount = document.createElement("div");
rootElement.before(editorMount);
const islandListeners = new Set<() => void>();
const subscribeIslands = (listener: () => void) => {
  islandListeners.add(listener);
  return () => {
    islandListeners.delete(listener);
  };
};
let fluidEditor: FluidEditor | null = null;
/** Resolve nested prose and component DOM to its top-level editor block. */
function blockPositionAt(event: globalThis.MouseEvent | ClipboardEvent | DragEvent): number | null {
  const view = fluidEditor?.view;
  if (!view || fluidEditor?.hasPendingEdits || !(event.target instanceof Element)) return null;
  if (!('clientY' in event) || event.button !== 2 && event.target === view.dom) {
    const selection = window.getSelection();
    if (selection?.anchorNode && view.dom.contains(selection.anchorNode)) {
      const position = view.state.doc.resolve(view.posAtDOM(selection.anchorNode, selection.anchorOffset));
      return position.depth ? position.before(1) : position.pos;
    }
  }
  let block: Element | null = event.target;
  if (!view.dom.contains(block) || block === view.dom) {
    // Right-clicks in the reading margins use the block alongside the pointer.
    block = null;
    for (const child of view.dom.children) {
      if (child.getBoundingClientRect().top > ('clientY' in event ? event.clientY : 0)) break;
      block = child;
    }
    if (!block) return -1;
  } else {
    while (block.parentElement !== view.dom) block = block.parentElement!;
  }
  const position = view.state.doc.resolve(view.posAtDOM(block, 0));
  return position.depth ? position.before(1) : position.pos;
}
/** The fluid render epoch the editor shows; -1 before its first render. */
let shownEpoch = -1;
/** What a newer saved version added, writing in (typeIn.ts). */
let typing: TypeIn | null = null;
let runtimeKey: string | null = null;
/** The commented text to mark, as the parent last sent it for a revision. */
let commentMarks: CommentMarksMessage | null = null;
let fluidContent: Awaited<ReturnType<typeof run>>["default"] | null = null;
let originalIslandOffsets = new Map<string, number>();
let currentIslandOffsets = new Map<string, number>();
const IslandOffset = createContext(0);
function FluidIsland({ id, children }: { id: string; children: ReactNode }) {
  const container = useSyncExternalStore(
    subscribeIslands,
    () => fluidEditor?.islands.get(id) ?? null,
  );
  const currentOffset = useSyncExternalStore(subscribeIslands, () => currentIslandOffsets.get(id) ?? 0);
  const delta = currentOffset - (originalIslandOffsets.get(id) ?? 0);
  return container
    ? createPortal(
        <IslandOffset value={delta}>{children}</IslandOffset>,
        container,
        id,
      )
    : null;
}
function FluidSourceLeaf(props: Parameters<typeof SourceLeaf>[0]) {
  const delta = useContext(IslandOffset);
  return (
    <SourceLeaf {...props} from={props.from + delta} to={props.to + delta} />
  );
}
function FluidSourceCode(props: Parameters<typeof SourceCode>[0]) {
  const delta = useContext(IslandOffset);
  return <SourceCode {...props} from={props.from + delta} to={props.to + delta} />;
}

function commitComponentValue(slot: number, prop: 'title' | 'ratio', value: string) {
  if (!activeSession) return;
  queueComponentValueEdit({ kind: 'component-value-edit', session: activeSession, revision: activeRevision, slot, prop, value }, prop === 'title' ? slotByIndex(slot)?.titleInsertion : undefined);
}

type TitledComponent = typeof Note;
function TitledWithControls({ Component, name, __slot, ...props }: ComponentProps<typeof Note> & {
  Component: TitledComponent; name: string; __slot?: number;
}) {
  const slot = typeof __slot === 'number' ? slotByIndex(__slot) : undefined;
  const value = typeof props.title === 'string' ? props.title
    : props.title === undefined && name !== 'ExampleCard' ? name : undefined;
  const titleProp = slot?.props.find((prop) => prop.name === 'title');
  const title = slot?.supported && slot.element === name && value !== undefined
    ? <InlineLiteral value={value} label={`${name} title`}
      sourceRegion={titleProp ? { from: titleProp.from, to: titleProp.to, expected: titleProp.expected } : slot.titleInsertion}
      onCommit={(next) => titleProp ? commitProp(slot.index, 'title', next) : commitComponentValue(slot.index, 'title', next)} />
    : props.title;
  return <Component {...props} title={title} />;
}
function SideBySideWithControls({ __slot, ...props }: SideBySideProps & { __slot?: number }) {
  const slot = typeof __slot === 'number' ? slotByIndex(__slot) : undefined;
  const editable = slot?.supported && slot.element === 'SideBySide';
  return <SideBySide {...props} readOnly={props.readOnly || !editable}
    onRatioCommit={editable ? (ratio) => commitComponentValue(slot.index, 'ratio', ratio) : undefined} />;
}
function InstructionWithControls({ __slot, ...props }: SideBySideProps & { __slot?: number }) {
  const slot = typeof __slot === 'number' ? slotByIndex(__slot) : undefined;
  const editable = slot?.supported && slot.element === 'Instruction';
  return <Instruction {...props} readOnly={props.readOnly || !editable}
    onRatioCommit={editable ? (ratio) => commitComponentValue(slot.index, 'ratio', ratio) : undefined} />;
}
function ReadingTable(props: ComponentPropsWithoutRef<"table">) {
  return (
    <div
      className="reading-table"
      tabIndex={0}
      role="region"
      aria-label="Document table"
    >
      <table {...props} />
    </div>
  );
}

/**
 * App-owned MDX components are a finite, bundled allowlist. Their classes are
 * scanned by the preview Tailwind build; workspace MDX is deliberately not.
 * Static children have separate parser-owned text mappings. Only the wrappers
 * with matching parent validators expose saved literal controls.
 */
const appOwnedComponents = {
  ...LAZY_CHART_COMPONENTS,
  pre: CodeFence,
  Note: (props: ComponentProps<typeof Note> & { __slot?: number }) => <TitledWithControls {...props} Component={Note} name="Note" />,
  Warning: (props: ComponentProps<typeof Warning> & { __slot?: number }) => <TitledWithControls {...props} Component={Warning} name="Warning" />,
  Important: (props: ComponentProps<typeof Important> & { __slot?: number }) => <TitledWithControls {...props} Component={Important} name="Important" />,
  Instruction: Object.assign(InstructionWithControls, { Action: Instruction.Action, Implementation: Instruction.Implementation }),
  SideBySide: Object.assign(SideBySideWithControls, { Block: SideBySide.Block }),
  SideBySideBlock,
  ExampleCard: (props: ComponentProps<typeof ExampleCard> & { __slot?: number }) => <TitledWithControls {...props} Component={ExampleCard} name="ExampleCard" />,
  Tabs,
  Tab,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Columns,
  Separator,
};

async function renderDocument(pending: PendingRender): Promise<void> {
  const seq = ++renderSeq;
  // Publish the newest metadata synchronously so edits made while the new
  // code still compiles attribute to the latest revision; the slow
  // completion below is dropped unless it is still the newest generation.
  if (activeSession !== pending.session || activeRevision !== pending.revision) {
    imageTable = Object.create(null);
    originalImages = Object.create(null);
    for (const listener of imageListeners) listener();
  }
  activeSession = pending.session;
  activeRevision = pending.revision;
  slotTable = pending.slots;
  setReadOnly(pending.readOnly === true);
  try {
    if (pending.fluid) {
      if (!fluidEditor) {
        const editor = (fluidEditor = new FluidEditor(
          editorMount,
          () => {
            for (const listener of islandListeners) listener();
          },
          postToParent,
          { codeFences: true, plugins: [typeInPlugin] },
        ));
        setCodeBlockHooks({
          typed: () => editor.typedForCodeBlock,
          undo: () => editor.undo(),
        });
      }
      if (!fluidContent || runtimeKey !== pending.fluid.runtimeKey) {
        const workspaceModules: Record<string, Awaited<ReturnType<typeof run>>> = Object.create(null);
        for (const module of pending.modules ?? []) {
          workspaceModules[module.path] = await run(module.code, {...jsxRuntime, workspaceModules, trustedReact, projectImage:ProjectImage} as Parameters<typeof run>[1]);
          if (seq !== renderSeq) return;
        }
        const result = await run(pending.code, { ...jsxRuntime, workspaceModules, trustedReact, projectImage:ProjectImage } as Parameters<typeof run>[1]);
        if (seq !== renderSeq) return;
        fluidContent = result.default;
        runtimeKey = pending.fluid.runtimeKey;
        originalIslandOffsets = new Map(
          pending.fluid.islands.map(({ id, from }) => [id, from]),
        );
      }
      const projection = pending.fluid;
      const editor = fluidEditor;
      const Content = fluidContent;
      const shown = editor.view.state;
      // A new document that replaces the one on screen without placing the
      // caret (such as a newer saved version an agent saved) keeps the
      // person's caret and selection where they were in it.
      const replaced =
        shownEpoch !== -1 && (projection.reset || projection.epoch !== shownEpoch) && !projection.selection
          ? shown
          : null;
      // What a newer saved version added, the first time this frame shows
      // it, writes in (typeIn.ts), from where the one before is still
      // writing, if it is. It comes into view if the reader is following
      // the note's end, or the writing.
      const writtenIn = projection.writeIn !== undefined && shownEpoch !== -1 && projection.epoch !== shownEpoch ? projection.writeIn : undefined;
      const writing = writtenIn === undefined ? null : (typing?.position ?? null);
      const follow = writtenIn !== undefined && ((writing !== null && followed !== null) || followingEnd(editor));
      shownEpoch = projection.epoch;
      flushSync(() => {
      captureDraftsBeforeRender();
      setSourceDraftContext(pending.session, pending.revision, pending.authoring?.editAck, pending.slots);
      currentIslandOffsets = new Map(
        projection.islands.map(({ id, from }) => [id, from]),
      );
      for (const listener of islandListeners) listener();
      setAuthoringContext(pending.session, pending.revision, pending.authoring);
      editor.receive({ kind: "render", ...pending });
      if (replaced) keepSelection(editor, replaced);
      applyCommentMarks();
      root.render(
        <StrictMode>
          <Content components={fluidComponents} />
          <BlockPicker blockPositionAt={blockPositionAt} />
        </StrictMode>,
      );
      });
      finishSourceDraftRender(pending.slots.flatMap(slot => [...slot.props, ...(slot.titleInsertion ? [slot.titleInsertion] : [])]));
      // Writing in stops with the document it was writing into.
      if (editor.view.state.doc !== shown.doc) {
        typing?.finish();
        typing = null;
      }
      if (writtenIn !== undefined) {
        const { doc } = editor.view.state;
        const start = writing === null ? writtenIn : Math.min(writtenIn, mapThroughDoc(shown.doc, doc)(writing));
        const $start = doc.resolve(start);
        followed = follow ? { top: document.scrollingElement?.scrollTop ?? 0, target: -Infinity } : null;
        if (follow) revealWrittenIn(editor, $start.parent.isTextblock ? $start.before() : start);
        typing = typeIn(editor.view, start, keepWritingInView);
      }
      showPlace();
      return;
    }
    // The JSX runtime stays in evaluation scope; document components arrive
    // via the `components` prop (function-body output reads them from
    // props.components, not from scope).
    const workspaceModules: Record<string, Awaited<ReturnType<typeof run>>> = Object.create(null);
    for (const module of pending.modules ?? []) {
      workspaceModules[module.path] = await run(module.code, {...jsxRuntime, workspaceModules, trustedReact, projectImage:ProjectImage} as Parameters<typeof run>[1]);
      if (seq !== renderSeq) return;
    }
    const { default: Content } = await run(pending.code, { ...jsxRuntime, workspaceModules, trustedReact, projectImage:ProjectImage } as Parameters<typeof run>[1]);
    if (seq !== renderSeq) return;
    flushSync(() => {
    captureDraftsBeforeRender();
    setSourceDraftContext(pending.session, pending.revision, pending.authoring?.editAck, pending.slots);
    setAuthoringContext(pending.session, pending.revision, pending.authoring);
    root.render(
      <StrictMode>
        <div
          className="reading-document preview-prose prose max-w-none"
          key={`${pending.session}:${pending.revision}`}
        >
          <Content
            components={{
              img: ProjectImage,
              ProjectImage,
              table: ReadingTable,
              SourceText: SourceLeaf,
              SourceCode,
              SourceBlock,
              CustomControls,
              ...appOwnedComponents,
              Counter: CounterWithControls,
              Callout: CalloutWithControls,
              Drawing: (props: { src?: string }) => (
                <ResourceEmbed kind="drawing" src={props.src} />
              ),
              Diagram: (props: { src?: string }) => (
                <ResourceEmbed kind="diagram" src={props.src} />
              ),
            }}
          />
          <RestoreAuthoringFocus />
        </div>
        <BlockPicker />
      </StrictMode>,
    );
    });
    finishSourceDraftRender(pending.slots.flatMap(slot => [...slot.props, ...(slot.titleInsertion ? [slot.titleInsertion] : [])]));
    postToParent({
      kind: "rendered",
      session: pending.session,
      revision: pending.revision,
    });
  } catch (error) {
    if (seq !== renderSeq) return;
    postToParent({
      kind: "render-error",
      session: pending.session,
      revision: pending.revision,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Everything from the app arrives on the port it gave this document
// (parentPort.ts): nothing else (sibling frames, opener, extensions) has it.
function onParentMessage(event: MessageEvent): void {
  const checked = checkParentMessage({
    data: event.data,
    source: event.currentTarget,
    activeSession,
  });
  if (!checked.ok) return;
  const message = checked.message;
  if (message.kind === 'source-draft-settled') {
    settleSourceDraft(message.draftId, message.outcome, message.reason);
    return;
  }
  if (message.kind === "module") {
    receiveFrameModule(message);
    return;
  }
  if (message.kind === "reading-preferences") {
    for (const [property, value] of Object.entries(
      readingStyle(message.preferences),
    ))
      document.documentElement.style.setProperty(property, value);
    document.documentElement.dataset.wideMedia = String(
      message.preferences.wideMedia,
    );
    document.documentElement.dataset.wideTables = String(
      message.preferences.wideTables,
    );
    return;
  }
  if (message.kind === "authoring-paths") {
    setAuthoringPaths(message.paths);
    return;
  }
  if (message.kind === "resource-focus") {
    // The parent dialog closed: return focus to the exact originating View
    // action. The path was already validated by checkParentMessage above.
    focusViewAction(message.path);
    return;
  }
  if (message.kind === "appearance") {
    const tokens = getAppearanceTokens({
      theme: message.theme,
      scheme: message.scheme,
    });
    for (const [key, value] of Object.entries(tokens))
      document.documentElement.style.setProperty(
        `--${key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}`,
        String(value),
      );
    document.documentElement.style.colorScheme = message.scheme;
    document.documentElement.dataset.scheme = message.scheme;
    return;
  }
  if (message.kind === "comments") {
    commentMarks = message;
    applyCommentMarks();
    if (!message.canComment) resetCommentReports();
    return;
  }
  if (message.kind === "comment-reveal") {
    // Ranges are for the revision on screen; one for another is dropped.
    if (fluidEditor?.shownRevision === message.revision) fluidEditor.revealCommentRange(message.from, message.to, message.focus);
    return;
  }
  if (message.kind === "place-request") {
    answerPlace();
    return;
  }
  if (message.kind === "place-show") {
    placeToShow = message;
    showPlace();
    return;
  }
  if (message.kind === "resources") {
    // Notify only the embed subscribers. Re-evaluating the document creates
    // a new Content component and unmounts focused prose/literal controls,
    // silently discarding edits that have not committed on blur yet.
    resourceTable = Object.fromEntries(
      message.resources.map((entry) => [entry.path, entry.svg]),
    );
    for (const listener of resourceListeners) listener();
    return;
  }
  if (message.kind === 'images') {
    if (message.revision !== activeRevision) return;
    imageTable = Object.assign(message.reset ? Object.create(null) : {...imageTable},
      Object.fromEntries(message.images.map(({key,...pixels}) => [key,pixels])));
    for (const listener of imageListeners) listener();
    return;
  }
  if (message.kind === 'image-original') {
    if (message.revision !== activeRevision) return;
    originalImages = {[message.key]:{image:message.image,error:message.error}};
    for (const listener of imageListeners) listener();
    return;
  }
  const render: RenderMessage = message;
  // A newer render supersedes anything still compiling: only the latest
  // generation is applied, so stale compilation cannot overwrite it.
  void renderDocument({
    session: render.session,
    revision: render.revision,
    code: render.code,
    modules: render.modules,
    slots: render.slots,
    authoring: render.authoring,
    fluid: render.fluid,
    readOnly: render.readOnly,
  });
}

const fluidComponents = {
  img: ProjectImage,
  ProjectImage,
  table: ReadingTable,
  FluidIsland,
  SourceText: FluidSourceLeaf,
  SourceCode: FluidSourceCode,
  SourceBlock,
  CustomControls,
  ...appOwnedComponents,
  Counter: CounterWithControls,
  Callout: CalloutWithControls,
  Drawing: (props: { src?: string }) => (
    <ResourceEmbed kind="drawing" src={props.src} />
  ),
  Diagram: (props: { src?: string }) => (
    <ResourceEmbed kind="diagram" src={props.src} />
  ),
};

window.addEventListener("error", (event: ErrorEvent) => {
  if (activeSession == null) return;
  postToParent({
    kind: "render-error",
    session: activeSession,
    revision: activeRevision,
    message: event.message || "Preview runtime error.",
  });
});

connectToParent(onParentMessage);
window.addEventListener("pagehide", () => fluidEditor?.destroy());

/**
 * Reading-position memory. Chromium collapses this isolated
 * document's layout while the parent hides the frame (Source mode and hidden
 * tabs use display:none): the scroll range reads 0 and scrollTop clamps to 0,
 * and nothing restores it when the frame is shown again. Firefox and WebKit
 * preserve it. The parent cannot read this opaque document, so the frame
 * remembers its own laid-out reading position and re-applies it when layout
 * returns. Same-revision only, so a re-render (source edit, reload) keeps
 * owning scroll, and a genuine top position restores as a no-op.
 */
let savedReadingTop: { revision: number; top: number } | null = null;
function noteReadingPosition(): void {
  const scroller = document.scrollingElement as HTMLElement | null;
  if (!scroller) return;
  if (scroller.scrollHeight - scroller.clientHeight <= 0) return;
  savedReadingTop = { revision: activeRevision, top: scroller.scrollTop };
}
function maybeRestoreReadingPosition(): void {
  if (!savedReadingTop || savedReadingTop.top <= 0) return;
  const scroller = document.scrollingElement as HTMLElement | null;
  if (!scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (max <= 0) return;
  if (savedReadingTop.revision !== activeRevision) return;
  if (scroller.scrollTop > 1) return;
  scroller.scrollTop = Math.min(savedReadingTop.top, max);
}
window.addEventListener("scroll", noteReadingPosition, { passive: true });
window.addEventListener("resize", maybeRestoreReadingPosition);
if (typeof IntersectionObserver !== "undefined" && document.documentElement) {
  const frameVisibility = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting))
      maybeRestoreReadingPosition();
  });
  frameVisibility.observe(document.documentElement);
}

/**
 * Following what an agent adds. When a newer saved version adds blocks at the
 * end of the note (`fluid.writeIn`), the first of them comes into view if the
 * reader was following: the end of the note was on screen, or within about a
 * line of it, before they came (always so for a note that fitted), or they
 * were following the writing in of the one before. While it writes in, the
 * writing stays in view. A reader who scrolled up to read, typed in the frame
 * in the last few seconds, or has text selected stays where they are, and one
 * who scrolls up stops it. Only this document scrolls, never the page around
 * the frame: smoothly, or at once with reduced motion.
 */
const TYPING_MS = 3000;
/** Room kept above the first new block when there is more after it than fits, and below the writing. */
const FOLLOW_MARGIN = 16;
let typedAt = -Infinity;
window.addEventListener("keydown", () => {
  typedAt = performance.now();
}, true);
/** While the reader follows what writes in: where the frame was last scrolled to, and the furthest it was sent. */
let followed: { top: number; target: number } | null = null;
window.addEventListener(
  "scroll",
  () => {
    const top = document.scrollingElement?.scrollTop ?? 0;
    if (followed && top < followed.top - 1) followed = null;
    else if (followed) followed.top = top;
  },
  { passive: true },
);

/** Whether the reader follows the note's end: its end on screen, and nothing typed or selected. */
function followingEnd(editor: FluidEditor): boolean {
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return false;
  if (document.hasFocus() && performance.now() - typedAt < TYPING_MS) return false;
  const line = parseFloat(getComputedStyle(document.body).lineHeight) || 25;
  return editor.view.dom.getBoundingClientRect().bottom <= document.documentElement.clientHeight + line;
}

/** Scroll down to `top`, as far as the note goes; never back up, nor short of where a scroll on its way goes. */
function followTo(top: number): void {
  const scroller = document.scrollingElement;
  if (!followed || !scroller) return;
  const target = Math.min(scroller.scrollHeight - scroller.clientHeight, top);
  if (target <= Math.max(scroller.scrollTop, followed.target)) return;
  followed.target = target;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: target, behavior: reduce ? "instant" : "smooth" });
}

/** Scroll the block at `from` up toward the top. */
function revealWrittenIn(editor: FluidEditor, from: number): void {
  const block = editor.view.nodeDOM(from);
  const scroller = document.scrollingElement;
  if (!(block instanceof Element) || !scroller) return;
  followTo(scroller.scrollTop + block.getBoundingClientRect().top - FOLLOW_MARGIN);
}

/** The writing, at `at` (its caret or a block coming in), comes up into view when it goes below the bottom: as much of it as fits. */
function keepWritingInView(at: Element): void {
  const scroller = document.scrollingElement;
  if (!followed || !scroller) return;
  const box = at.getBoundingClientRect();
  const below = Math.min(box.bottom + FOLLOW_MARGIN - scroller.clientHeight, box.top - FOLLOW_MARGIN);
  if (below > 0) followTo(scroller.scrollTop + below);
}

/**
 * The person's place, as the app switches between Source and the note
 * (WorkspaceSession). Asked (`place-request`), the frame says where the caret
 * or selection is, once the person has put one in the note's text (the text
 * took the keyboard, or Source gave it one), and which text is at the top.
 * Given one from Source (`place-show`), it selects it and takes the keyboard,
 * or brings the text at `top` to the top (with room above it), once it shows
 * that revision and is laid out again (hidden, the note has no layout: see the
 * reading position above). The person's own press or key before then wins.
 */
let placed = false;
let placeToShow: { revision: number; selection?: { anchor: number; head: number }; top?: number } | null = null;
document.addEventListener("focusin", (event) => {
  if (fluidEditor && event.target === fluidEditor.view.dom) placed = true;
});
for (const type of ["pointerdown", "keydown"])
  window.addEventListener(type, () => {
    placeToShow = null;
  }, { capture: true, passive: true });

function answerPlace(): void {
  placeToShow = null;
  const editor = fluidEditor;
  if (!activeSession) return;
  if (!editor) {
    postToParent({ kind: "place", session: activeSession, revision: activeRevision, selection: null, top: null });
    return;
  }
  const { view } = editor;
  const box = view.dom.getBoundingClientRect();
  const top = box.height > 0 ? (view.posAtCoords({ left: box.left + box.width / 2, top: Math.max(box.top, 0) + 1 })?.pos ?? null) : null;
  const { anchor, head } = view.state.selection;
  postToParent({ kind: "place", session: activeSession, revision: editor.shownRevision, selection: placed ? { anchor, head } : null, top });
}

function showPlace(): void {
  const place = placeToShow;
  const editor = fluidEditor;
  const scroller = document.scrollingElement;
  if (!place || !editor || !scroller || editor.shownRevision !== place.revision) return;
  const { view } = editor;
  if (view.dom.getBoundingClientRect().height === 0) return;
  placeToShow = null;
  const size = view.state.doc.content.size;
  const at = (pos: number) => view.state.doc.resolve(Math.min(pos, size));
  if (place.selection) {
    const selection = TextSelection.between(at(place.selection.anchor), at(place.selection.head));
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
    placed = true;
    // Its middle in the middle, when it is out of view.
    const caret = view.coordsAtPos(selection.head);
    const height = scroller.clientHeight;
    if (caret.top < 0 || caret.bottom > height) scroller.scrollTop += (caret.top + caret.bottom - height) / 2;
  } else if (place.top !== undefined) {
    placed = false;
    scroller.scrollTop += view.coordsAtPos(Math.min(place.top, size)).top - FOLLOW_MARGIN;
  }
  // The reading position to keep is this one now.
  savedReadingTop = { revision: activeRevision, top: scroller.scrollTop };
}
window.addEventListener("resize", showPlace);
if (typeof IntersectionObserver !== "undefined" && document.documentElement) {
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) showPlace();
  }).observe(document.documentElement);
}

/**
 * The editor took a new document in place of `shown`'s: put the person's
 * caret and selection back where they were, mapped through what changed
 * (src/features/document/writeIn.ts), instead of at the top. A selection
 * alone: focus and scroll stay as they are.
 */
function keepSelection(editor: FluidEditor, shown: EditorState): void {
  const { state } = editor.view;
  const place = mapThroughDoc(shown.doc, state.doc);
  const at = (pos: number) => state.doc.resolve(Math.max(0, Math.min(place(pos), state.doc.content.size)));
  const kept = TextSelection.between(at(shown.selection.anchor), at(shown.selection.head));
  if (!kept.eq(state.selection)) editor.view.dispatch(state.tr.setSelection(kept));
}

// Comments. The parent sends the commented text as document ranges for a
// revision; they are marked once the document on screen is that revision
// (a render still compiling marks them when it lands). The frame reports the
// selection and the heading under the pointer, as document positions and
// where they are on screen, so the parent can offer Comment by them; it maps
// the positions through its own projection.

function applyCommentMarks(): void {
  if (!fluidEditor || !commentMarks || fluidEditor.shownRevision !== commentMarks.revision) return;
  fluidEditor.setCommentMarks(commentMarks.marks);
  scheduleMarkerReport();
}

// Where the commented text is, for the parent's marker column: the middle of
// the line where each thread's marked text starts, one marker per line.
let reportedMarkers = "";
function reportMarkers(): void {
  if (!activeSession || !fluidEditor || !commentMarks || fluidEditor.shownRevision !== commentMarks.revision) return;
  const lines: { ids: string[]; middle: number; active: boolean }[] = [];
  for (const mark of commentMarks.marks) {
    if (mark.id === "draft") continue;
    const box = fluidEditor.view.dom.querySelector(`[data-comment-thread="${CSS.escape(mark.id)}"]`)?.getClientRects()[0];
    if (!box) continue;
    const middle = (box.top + box.bottom) / 2;
    const line = lines.find((entry) => Math.abs(entry.middle - middle) < 6);
    if (line) {
      line.ids.push(mark.id);
      line.active ||= mark.active;
    } else lines.push({ ids: [mark.id], middle, active: mark.active });
  }
  const markers = lines.map((line) => ({ ids: line.ids, top: Math.round(line.middle), active: line.active }));
  const key = JSON.stringify([activeRevision, markers]);
  if (key === reportedMarkers) return;
  reportedMarkers = key;
  postToParent({ kind: "comment-markers", session: activeSession, revision: activeRevision, markers });
}
let markerFrame = 0;
function scheduleMarkerReport(): void {
  cancelAnimationFrame(markerFrame);
  markerFrame = requestAnimationFrame(reportMarkers);
}
// Lines move when the frame changes size and when the document changes (a
// mutation observer: a resize observer here would trip over the frame's own).
window.addEventListener("resize", scheduleMarkerReport, { passive: true });
new MutationObserver(scheduleMarkerReport).observe(document.body, { childList: true, subtree: true, characterData: true });
void document.fonts.ready.then(scheduleMarkerReport);

const canComment = () => Boolean(activeSession && fluidEditor && commentMarks?.canComment);

/** Whether a DOM node is in the note's editable text, outside computed objects. */
function inNoteText(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element && fluidEditor?.view.dom.contains(element) && !element.closest("[data-fluid-object]"));
}

/** The frame's viewport position of a DOM rect, rounded for comparing. */
function frameRect(rect: DOMRect): FrameRect {
  return { top: Math.round(rect.top), left: Math.round(rect.left), bottom: Math.round(rect.bottom), right: Math.round(rect.right) };
}

/** The selected text as document positions and where it is on screen, or null when nothing is selected there. */
function selectedText(): { range: { from: number; to: number }; rect: FrameRect } | null {
  const selection = document.getSelection();
  const view = fluidEditor?.view;
  if (!view || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!inNoteText(selection.anchorNode) || !inNoteText(selection.focusNode)) return null;
  try {
    const anchor = view.posAtDOM(selection.anchorNode!, selection.anchorOffset);
    const head = view.posAtDOM(selection.focusNode!, selection.focusOffset);
    if (anchor === head) return null;
    // The box around all its lines: the parent offers Comment over its first line, or under its last.
    const range = selection.getRangeAt(0);
    return { range: { from: Math.min(anchor, head), to: Math.max(anchor, head) }, rect: frameRect(range.getBoundingClientRect()) };
  } catch {
    return null;
  }
}

/** The heading element holding a node, in the note's text. */
function headingOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const heading = element?.closest("h1, h2, h3, h4, h5, h6") ?? null;
  return heading && inNoteText(heading) ? heading : null;
}

/** What the comment key comments on: the selection, or the heading holding the caret (from = to). */
function commentTarget(): { from: number; to: number } | null {
  if (!canComment()) return null;
  const selected = selectedText();
  if (selected) return selected.range;
  const selection = document.getSelection();
  const heading = headingOf(selection?.anchorNode ?? null);
  if (!heading || !fluidEditor) return null;
  try {
    const pos = fluidEditor.view.posAtDOM(heading, 0);
    return { from: pos, to: pos };
  } catch {
    return null;
  }
}

let reportedSelection = "null";
function reportSelection(): void {
  if (!canComment()) return;
  const selected = selectedText();
  const key = JSON.stringify(selected);
  if (key === reportedSelection) return;
  reportedSelection = key;
  postToParent({ kind: "comment-selection", session: activeSession, revision: activeRevision, range: selected?.range ?? null, rect: selected?.rect ?? null });
}

let hoveredHeading: Element | null = null;
function reportHeading(heading: Element | null): void {
  if (!canComment() || !fluidEditor) return;
  hoveredHeading = heading;
  let pos: number | null = null;
  let rect: FrameRect | null = null;
  if (heading) {
    try {
      pos = fluidEditor.view.posAtDOM(heading, 0);
      // Beside the heading's words, not its full-width box.
      const words = document.createRange();
      words.selectNodeContents(heading);
      rect = frameRect(words.getBoundingClientRect());
    } catch {
      pos = null;
    }
  }
  postToParent({ kind: "comment-heading", session: activeSession, revision: activeRevision, pos, rect: pos === null ? null : rect });
}

/** Comments were turned off (a viewer, or offline): forget what was reported. */
function resetCommentReports(): void {
  reportedSelection = "null";
  hoveredHeading = null;
}

let selectionTimer = 0;
document.addEventListener("selectionchange", () => {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(reportSelection, 120);
});
document.addEventListener("mouseover", (event) => {
  const heading = headingOf(event.target instanceof Node ? event.target : null);
  if (heading !== hoveredHeading) reportHeading(heading);
});
document.documentElement.addEventListener("mouseleave", () => {
  if (hoveredHeading) reportHeading(null);
});
let scrollFrame = 0;
window.addEventListener(
  "scroll",
  () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      // Whatever was reported has moved: report it again where it is now.
      reportedSelection = "";
      reportSelection();
      if (hoveredHeading) reportHeading(hoveredHeading);
      reportMarkers();
    });
  },
  { passive: true },
);
// A link in the note opens through the app: a file in the project in a tab, a
// web page in a new browser tab. The frame never navigates itself, and a link
// to a heading of this note scrolls to it. Clicks a component handled itself
// (it called preventDefault) and selections that end on a link are left alone.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
  const link = event.target.closest("a[href]");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (!document.getSelection()?.isCollapsed) return;
  if (href.startsWith("#")) {
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Use the id as written.
    }
    (document.getElementById(id) ?? document.getElementsByName(id)[0])?.scrollIntoView({ block: "start" });
    return;
  }
  if (activeSession && href.trim()) postLinkToParent({ kind: "open-link", session: activeSession, revision: activeRevision, href: href.slice(0, 2048) });
});
// Commented text opens its thread when clicked (not when a selection ends on it).
document.addEventListener("click", (event) => {
  if (!activeSession || !commentMarks || !(event.target instanceof Element)) return;
  if (!document.getSelection()?.isCollapsed) return;
  const marked = event.target.closest("[data-comment-thread]");
  const id = marked && inNoteText(marked) ? marked.getAttribute("data-comment-thread") : null;
  if (id) postToParent({ kind: "comment-open", session: activeSession, revision: activeRevision, id });
});
