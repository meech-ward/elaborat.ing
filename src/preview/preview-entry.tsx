/**
 * Isolated preview bootstrap (child frame).
 *
 * This module is the ONLY place where compiled document JavaScript is
 * evaluated, via `run()` from `@mdx-js/mdx`. The build bundles it for the
 * parent's self-contained `srcdoc` frame (roadmap phase 2 step 4) (`sandbox="allow-scripts"`,
 * no `allow-same-origin`), so it has no access to the parent document,
 * storage, or file privileges, and the CSP forbids all network.
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
  useLayoutEffect,
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
import { Note, Warning, Important, Instruction, SideBySide, SideBySideBlock, ExampleCard, Tabs, Tab, type SideBySideProps } from '../features/rendered/documentBlocks';
import { InlineLiteral } from './InlineLiteral';
import { isReadOnly, setReadOnly } from './readOnly';
import { CodeFence } from '../features/rendered/codeFence';
import { DOCUMENT_CHART_COMPONENTS } from '../features/rendered/documentCharts';
import { pictureSize } from '../features/rendered/resourceViewer.ts';
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

function postToParent(message: unknown): void {
  window.parent.postMessage(message, "*");
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
  const [clipped, setClipped] = useState(false);
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
            dangerouslySetInnerHTML={{ __html: svg }}
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
  ...DOCUMENT_CHART_COMPONENTS,
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
  activeSession = pending.session;
  activeRevision = pending.revision;
  slotTable = pending.slots;
  setReadOnly(pending.readOnly === true);
  try {
    if (pending.fluid) {
      if (!fluidEditor)
        fluidEditor = new FluidEditor(editorMount, () => {
          for (const listener of islandListeners) listener();
        });
      if (!fluidContent || runtimeKey !== pending.fluid.runtimeKey) {
        const workspaceModules: Record<string, Awaited<ReturnType<typeof run>>> = Object.create(null);
        for (const module of pending.modules ?? []) {
          workspaceModules[module.path] = await run(module.code, {...jsxRuntime, workspaceModules, trustedReact} as Parameters<typeof run>[1]);
          if (seq !== renderSeq) return;
        }
        const result = await run(pending.code, { ...jsxRuntime, workspaceModules, trustedReact } as Parameters<typeof run>[1]);
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
      flushSync(() => {
      captureDraftsBeforeRender();
      setSourceDraftContext(pending.session, pending.revision, pending.authoring?.editAck, pending.slots);
      currentIslandOffsets = new Map(
        projection.islands.map(({ id, from }) => [id, from]),
      );
      for (const listener of islandListeners) listener();
      setAuthoringContext(pending.session, pending.revision, pending.authoring);
      editor.receive({ kind: "render", ...pending });
      applyCommentMarks();
      root.render(
        <StrictMode>
          <Content components={fluidComponents} />
          <BlockPicker />
        </StrictMode>,
      );
      });
      finishSourceDraftRender(pending.slots.flatMap(slot => [...slot.props, ...(slot.titleInsertion ? [slot.titleInsertion] : [])]));
      return;
    }
    // The JSX runtime stays in evaluation scope; document components arrive
    // via the `components` prop (function-body output reads them from
    // props.components, not from scope).
    const workspaceModules: Record<string, Awaited<ReturnType<typeof run>>> = Object.create(null);
    for (const module of pending.modules ?? []) {
      workspaceModules[module.path] = await run(module.code, {...jsxRuntime, workspaceModules, trustedReact} as Parameters<typeof run>[1]);
      if (seq !== renderSeq) return;
    }
    const { default: Content } = await run(pending.code, { ...jsxRuntime, workspaceModules, trustedReact } as Parameters<typeof run>[1]);
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

window.addEventListener("message", (event: MessageEvent) => {
  // The embedder is the only window that may hold a reference to this frame.
  // Anything else (sibling frames, opener, extensions) is ignored.
  if (event.source !== window.parent) return;
  const checked = checkParentMessage({
    data: event.data,
    source: event.source,
    activeSession,
  });
  if (!checked.ok) return;
  const message = checked.message;
  if (message.kind === 'source-draft-settled') {
    settleSourceDraft(message.draftId, message.outcome, message.reason);
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
    fluidEditor?.revealCommentMark(message.id, message.focus);
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
});

const fluidComponents = {
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

postToParent({ kind: "ready", session: "pending" });
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

// Comments. The parent sends the commented text as document ranges for a
// revision; they are marked once the document on screen is that revision
// (a render still compiling marks them when it lands). The frame reports the
// selection and the heading under the pointer, as document positions and
// where they are on screen, so the parent can offer Comment by them; it maps
// the positions through its own projection.

function applyCommentMarks(): void {
  if (!fluidEditor || !commentMarks || fluidEditor.shownRevision !== commentMarks.revision) return;
  fluidEditor.setCommentMarks(commentMarks.marks);
}

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

/** The selected text as document positions and where its end is, or null when nothing is selected there. */
function selectedText(): { range: { from: number; to: number }; rect: FrameRect } | null {
  const selection = document.getSelection();
  const view = fluidEditor?.view;
  if (!view || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!inNoteText(selection.anchorNode) || !inNoteText(selection.focusNode)) return null;
  try {
    const anchor = view.posAtDOM(selection.anchorNode!, selection.anchorOffset);
    const head = view.posAtDOM(selection.focusNode!, selection.focusOffset);
    if (anchor === head) return null;
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const end = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { range: { from: Math.min(anchor, head), to: Math.max(anchor, head) }, rect: frameRect(end) };
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
    });
  },
  { passive: true },
);
// Commented text opens its thread when clicked (not when a selection ends on it).
document.addEventListener("click", (event) => {
  if (!activeSession || !commentMarks || !(event.target instanceof Element)) return;
  if (!document.getSelection()?.isCollapsed) return;
  const marked = event.target.closest("[data-comment-thread]");
  const id = marked && inNoteText(marked) ? marked.getAttribute("data-comment-thread") : null;
  if (id) postToParent({ kind: "comment-open", session: activeSession, revision: activeRevision, id });
});
