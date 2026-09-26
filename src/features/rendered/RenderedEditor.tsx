/**
 * RenderedEditor: the editable rendered view of a note.
 *
 * Contract (`src/features/rendered/index.ts`):
 *
 * ```ts
 * function RenderedEditor(props: {
 *   document: DocumentSnapshot;
 *   onPatch: (revision: number, patches: SourcePatch[]) => void;
 *   onError?: (message: string | null) => void;
 * }): React.ReactNode;
 * ```
 *
 * Rules this component follows:
 * - Both `.md` and `.mdx` render through one pipeline: the official
 *   compiler (with `format: 'md'` for plain markdown, so braces never
 *   evaluate as expressions) runs in the parent, and the emitted code is
 *   evaluated exclusively inside a self-contained opaque-origin `srcdoc`
 *   iframe (`sandbox="allow-scripts"`). The parent never calls `eval`/`run`
 *   on document code and never loads a second preview page over the
 *   network.
 * - Ordinary prose uses one persistent source-derived ProseMirror view.
 *   Vendor transactions are proposals, validated against parent-owned source
 *   mappings in full before one exact source/Monaco commit. Monaco owns undo.
 *   Literal controls inside protected MDX islands keep the finite
 *   range-patch protocol. No evaluated code supplies authoritative mappings.
 * - Child edit messages are validated against the parent's own
 *   instrumentation for the shown revision (exact range plus `expected`
 *   slice, same literal kind in the same quoted/braced context), never
 *   trusted on the evaluated document's word.
 * - Syntax or runtime errors leave the source recoverable: the last good
 *   render stays on screen and the message goes to `onError`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildPreviewSrcdoc } from "../../preview/frame";
import {
  projectFluidSource,
  prepareFluidTransaction,
  fluidPositionForSourceOffset,
  fluidSourceOffsetForPosition,
  type FluidProjection,
} from "./fluidProjection";
import type {
  RenderedPatchOptions,
  SourceHistoryResult,
} from "../source/renderedHistory";
import { acceptSourceTransaction } from "./sourceTransaction";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  checkChildMessage,
  childMessageSchema,
  checkEditResource,
  checkPropEdit,
  checkProseEdit,
  checkViewResource,
  PREVIEW_SANDBOX,
  staleChildMessage,
  type RenderMessage,
  type ResourcesMessage,
} from "./protocol";
import { ResourceViewer } from "./ResourceViewer";
import type { DocumentSnapshot, SourcePatch } from "./types";
import { useAppearance } from "../appearance";
import {
  editBlock,
  encodeInlineInput,
  splitRichLeaf,
} from "../document/structural";
import { insertBlock } from "./insertBlock";
import type { ComponentEnvironment } from '../document/componentModules';
import { encodeTextLeaf } from './instrumentation';
import { componentValuePatch } from './componentValueEdit';
import { applySourcePatches } from '../document';

export type RenderedEditorProps = {
  document: DocumentSnapshot;
  /** Mounted frames in hidden tabs/Source mode cannot own a viewer portal. */
  active?: boolean;
  documentId?: number;
  componentEnvironment?: ComponentEnvironment;
  componentError?: string;
  componentPending?: boolean;
  onPatch: (
    revision: number,
    patches: SourcePatch[],
    options?: RenderedPatchOptions,
  ) => boolean | void;
  onHistory?: (direction: "undo" | "redo") => SourceHistoryResult;
  onPendingChange?: (pending: boolean) => void;
  onError?: (message: string | null) => void;
  /**
   * Generated pixels for Drawing/Diagram embeds (path -> SVG), produced by
   * the parent from workspace files. The frame receives pixels only.
   */
  resources?: Record<string, string>;
  /**
   * Source-parsed reference paths the child may request to edit. Requests
   * for anything else are rejected visibly.
   */
  allowedResourcePaths?: readonly string[];
  /** Listing metadata for insertion, not authority to open/edit a resource. */
  availableResourcePaths?: readonly string[];
  onEditResource?: (path: string) => void;
  /** Show the note without editing in the frame; `onPatch` should refuse edits too. */
  readOnly?: boolean;
};

/** Shown after "Edit not applied:" when an edit in the frame was made against an older revision of the note. */
const LOST_EDIT = "the note changed at the same time. Make the edit again.";

/** Session token binding one mounted editor to its frame. Never the source. */
function newSessionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Everything the frame was told, kept atomic: compiled code plus the exact
 * revision, leaves and slots it describes. Child messages validate against
 * this object, so a newer document can never be patched with an older
 * frame's ranges.
 */
type Exposed = FluidProjection & {
  identity?: number;
  revision: number;
  epoch: number;
  operation: number;
  reset: boolean;
  focus?: number;
  selection?: { anchor: number; head: number };
  editAck?: NonNullable<RenderMessage['authoring']>['editAck'];
};

export function RenderedEditor(props: RenderedEditorProps): React.ReactNode {
  const { appearance, reading } = useAppearance();
  const {
    document,
    active = true,
    documentId,
    componentEnvironment,
    componentError,
    componentPending,
    onHistory,
    onPendingChange: onPendingChangeProp,
    onPatch,
    onError,
    resources,
    allowedResourcePaths,
    availableResourcePaths,
    onEditResource,
    readOnly = false,
  } = props;
  const pendingOwners = useRef({ fluid: false, draft: false });
  const onPendingChange = useCallback((pending: boolean) => {
    pendingOwners.current.fluid = pending;
    onPendingChangeProp?.(pending || pendingOwners.current.draft);
  }, [onPendingChangeProp]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const session = useMemo(() => newSessionToken(), []);
  // Stable for the mount lifetime: the frame loads once and every later
  // render arrives via postMessage (reposted when the frame says ready).
  const srcdoc = useMemo(() => buildPreviewSrcdoc(), []);
  const [exposed, setExposed] = useState<Exposed | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  // Reading-only viewer: a snapshot of parent-generated pixels. Opening or
  // closing it never touches the projection, draft, or history above.
  const [viewer, setViewer] = useState<{ path: string; svg: string } | null>(
    null,
  );
  // Forget the inspection on hide without remounting the document frame.
  if (!active && viewer !== null) setViewer(null);
  const viewerActive = useRef(active);
  useLayoutEffect(() => {
    viewerActive.current = active;
  }, [active]);
  const closeViewer = useCallback(
    (path: string) => {
      setViewer(null);
      // The parent cannot read the opaque frame DOM, so it asks the frame
      // to return focus to the exact originating View action.
      if (viewerActive.current) {
        frameRef.current?.contentWindow?.postMessage(
          { kind: "resource-focus", session, path },
          "*",
        );
      }
    },
    [session],
  );
  const errorId = useId();
  const pendingFocus = useRef<{ revision: number; offset: number } | null>(
    null,
  );
  const hasExposed = exposed !== null;
  const authority = useRef<Exposed | null>(null);
  const epoch = useRef(0);
  const latestDocument = useRef(document);
  const pendingLocalEdit = useRef<{
    identity?: number; revision: number; text: string;
    ack: NonNullable<NonNullable<RenderMessage['authoring']>['editAck']>;
  } | null>(null);
  const rejectPendingDraft = useCallback((reason: string) => {
    const draftId = pendingLocalEdit.current?.ack.draftId;
    if (draftId !== undefined)
      frameRef.current?.contentWindow?.postMessage({ kind: 'source-draft-settled', session, revision: latestDocument.current.revision, draftId, outcome: 'rejected', reason: reason.slice(0, 2000) }, '*');
    pendingLocalEdit.current = null;
    pendingOwners.current.draft = false;
    onPendingChangeProp?.(pendingOwners.current.fluid);
  }, [onPendingChangeProp, session]);
  useEffect(() => () => {
    ++epoch.current;
    authority.current = null;
    pendingOwners.current = { fluid: false, draft: false };
    onPendingChangeProp?.(false);
  }, [onPendingChangeProp]);
  useLayoutEffect(() => {
    latestDocument.current = document;
    if (componentPending || componentError) {
      authority.current = null;
      ++epoch.current;
      return;
    }
    const current = authority.current;
    if (
      current &&
      (current.identity !== documentId ||
        current.text !== document.text ||
        current.revision !== document.revision ||
        current.format !== document.format ||
        current.components.key !== (componentEnvironment?.key ?? ''))
    )
      ++epoch.current;
  }, [document, documentId, componentEnvironment, componentPending, componentError]);

  // Decide whether source needs a new projection in the same commit phase as
  // latestDocument above. A passive effect for revision N can run after the
  // next frame transaction has committed authority N+1, mistake it for an
  // external change, and reset the live caret/queued input to old source N.
  useLayoutEffect(() => {
    if (componentPending) return;
    if (componentError) {
      ++epoch.current;
      rejectPendingDraft(componentError);
      onPendingChange?.(false);
      onError?.(componentError);
      return;
    }
    if (componentEnvironment && componentEnvironment.source !== document.text) return;
    const own = authority.current;
    if (
      own &&
      own.identity === documentId &&
      own.text === document.text &&
      own.revision === document.revision &&
      own.format === document.format &&
      own.components.key === (componentEnvironment?.key ?? '')
    )
      return;
    let cancelled = false;
    const generation = ++epoch.current;
    projectFluidSource(document.text, document.format, componentEnvironment).then(
      (projection) => {
        if (cancelled) return;
        try {
          if (generation !== epoch.current) return;
          const focus =
            pendingFocus.current?.revision === document.revision
              ? pendingFocus.current.offset
              : undefined;
          const position =
            focus === undefined
              ? null
              : fluidPositionForSourceOffset(projection, focus);
          const next: Exposed = {
            ...projection,
            identity: documentId,
            revision: document.revision,
            epoch: generation,
            operation: 0,
            reset: true,
            focus,
            selection:
              position == null
                ? undefined
                : { anchor: position, head: position },
            editAck: pendingLocalEdit.current?.identity === documentId &&
              pendingLocalEdit.current?.revision === document.revision &&
              pendingLocalEdit.current?.text === document.text
              ? pendingLocalEdit.current.ack : undefined,
          };
          pendingLocalEdit.current = null;
          authority.current = next;
          setExposed(next);
          setCompileError(null);
          setEditNotice(null);
          onError?.(null);
        } catch (error: unknown) {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : String(error);
          setCompileError(message);
          rejectPendingDraft(message);
          onPendingChange?.(false);
          onError?.(message);
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setCompileError(message);
        rejectPendingDraft(message);
        onPendingChange?.(false);
        onError?.(message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [document.text, document.revision, document.format, documentId, componentEnvironment, componentError, componentPending, onError, onPendingChange, rejectPendingDraft]);

  // Post compiled code to the child frame. The render message carries the
  // revision it was built from; the child echoes it back so stale output
  // can never overwrite a newer document. Reposted whenever the frame
  // announces readiness, so a post that raced frame load is never lost.
  useEffect(() => {
    if (!exposed) return;
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    const message: RenderMessage = {
      kind: "render",
      session,
      revision: exposed.revision,
      code: exposed.code,
      modules: exposed.components.modules,
      fluid: {
        epoch: exposed.epoch,
        operation: exposed.operation,
        reset: exposed.reset,
        runtimeKey: exposed.runtimeKey,
        doc: exposed.doc.toJSON(),
        selection: exposed.selection,
        islands: exposed.islands.map(({ id, from }) => ({ id, from })),
      },
      readOnly: readOnly || undefined,
      slots: exposed.slots.map((slot) => ({
        index: slot.index,
        element: slot.element,
        supported: slot.supported,
        reason: slot.reason,
        titleInsertion: slot.supported && ['Note', 'Warning', 'Important', 'ExampleCard'].includes(slot.element) && !slot.props.some(prop => prop.name === 'title')
          ? { from: slot.from + slot.element.length + 1, to: slot.from + slot.element.length + 1, expected: '' as const } : undefined,
        props: slot.props.map((prop) => ({
          name: prop.name,
          kind: prop.kind,
          syntax: prop.syntax,
          from: prop.from,
          to: prop.to,
          expected: prop.expected,
          value: prop.value,
          choices: exposed.components.catalog.find(c => c.name === slot.element)?.props.find(p => p.name === prop.name)?.choices?.slice(),
        })),
      })),
      authoring: {
        format: exposed.format,
        boundaries: exposed.instrumentation.boundaries,
        availableResourcePaths: [],
        components: exposed.components.catalog.map(({name,description}) => ({name,description})),
        focus: exposed.focus,
        editAck: exposed.editAck,
      },
    };
    frame.postMessage(message, "*");
  }, [exposed, readOnly, readyTick, session]);

  useEffect(() => {
    if (exposed)
      frameRef.current?.contentWindow?.postMessage(
        {
          kind: "authoring-paths",
          session,
          paths: availableResourcePaths ?? [],
        },
        "*",
      );
  }, [availableResourcePaths, exposed, readyTick, session]);

  // Resources follow the render (and every repost): the child keeps the
  // latest pixels for the current session/revision. The parent passes a
  // stable table identity (state, not a fresh literal per render), so this
  // posts only when the pixels actually change.
  useEffect(() => {
    if (!hasExposed || !resources || !authority.current) return;
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    const message: ResourcesMessage = {
      kind: "resources",
      session,
      revision: authority.current.revision,
      resources: Object.entries(resources).map(([path, svg]) => ({
        path,
        svg,
      })),
    };
    frame.postMessage(message, "*");
  }, [hasExposed, readyTick, session, resources]);

  // Presentation updates do not re-evaluate MDX or replace in-progress edits.
  useEffect(() => {
    if (exposed)
      frameRef.current?.contentWindow?.postMessage(
        { kind: "appearance", session, ...appearance },
        "*",
      );
  }, [appearance, exposed, readyTick, session]);
  useEffect(() => {
    if (exposed)
      frameRef.current?.contentWindow?.postMessage(
        { kind: "reading-preferences", session, preferences: reading },
        "*",
      );
  }, [reading, exposed, readyTick, session]);

  useEffect(() => {
    const commitLocalEdit = (revision: number, patches: SourcePatch[], draftId?: number) => {
      // Keep a rebase lease only for the exact source result of this local
      // rendered edit. External Source/Undo/Reload receives no such lease.
      const next = applySourcePatches(document, revision, patches);
      pendingLocalEdit.current = {
        identity: documentId, revision: next.revision, text: next.text,
        ack: { fromRevision: revision, draftId, patches: patches.map(({ from, to, insert }) => ({ from, to, insertLength: insert.length })) },
      };
      if (onPatch(revision, patches) === false) {
        pendingLocalEdit.current = null;
        throw new Error('Source rejected the rendered edit.');
      }
    };
    const onMessage = (event: MessageEvent) => {
      // Unrelated windows (extensions, sibling frames, the opener) are
      // ignored silently: a phantom "rejected frame" error for traffic that
      // was never ours would be noise. Forged edits from the KNOWN frame
      // still fail the checks below and are rejected visibly.
      const expectedSource = frameRef.current?.contentWindow;
      if (event.source !== expectedSource || expectedSource == null) return;
      const settle = (draftId: number | undefined, outcome: 'noop' | 'rejected', reason?: string) => {
        if (draftId === undefined) return;
        expectedSource.postMessage({ kind: 'source-draft-settled', session, revision: document.revision, draftId, outcome, reason }, '*');
      };
      const checked = checkChildMessage({
        data: event.data,
        source: event.source,
        expectedSource,
        session,
        revision: authority.current?.revision ?? -1,
      });
      if (!checked.ok) {
        const parsed = childMessageSchema.safeParse(event.data);
        const stale = checked.error.startsWith("Rejected stale frame message");
        // A rejected rendered transaction resets the frame to the current document.
        const resetFrame = () => {
          const current = authority.current;
          if (!current) return;
          const reset = { ...current, epoch: ++epoch.current, operation: 0, reset: true };
          authority.current = reset;
          setExposed(reset);
          onPendingChange?.(false);
        };
        // Queue status is informational, not write authority. Old-revision
        // settlement can clear it before the next compiled render arrives.
        if (parsed.success && parsed.data.session === session && parsed.data.kind === 'source-draft-pending') {
          pendingOwners.current.draft = parsed.data.pending;
          onPendingChangeProp?.(parsed.data.pending || pendingOwners.current.fluid);
          return;
        }
        if (parsed.success && parsed.data.session === session && 'draftId' in parsed.data) {
          settle(parsed.data.draftId, 'rejected', checked.error);
          setEditNotice(stale ? LOST_EDIT : checked.error);
          return;
        }
        // The frame spoke about an older revision of the note, which is
        // routine while the source changes under it: never a render error.
        if (parsed.success && parsed.data.session === session && stale) {
          const message = parsed.data;
          const outcome = staleChildMessage(message.kind);
          if (outcome === "status" && message.kind === "fluid-pending") onPendingChange?.(message.pending);
          if (outcome === "refusal" && message.kind === "edit-rejected") setEditNotice(message.message);
          if (outcome === "lost-edit") {
            setEditNotice(LOST_EDIT);
            if (message.kind === "fluid-transaction") resetFrame();
          }
          return;
        }
        onError?.(checked.error);
        if ((event.data as { kind?: unknown } | null)?.kind === "fluid-transaction") resetFrame();
        return;
      }
      const message = checked.message;
      // The frame announcing readiness gets the current render reposted so
      // no compiled document is lost to the load race.
      if (message.kind === "ready") {
        setReadyTick((tick) => tick + 1);
        return;
      }
      if (message.kind === "rendered") return;
      if (message.kind === 'source-draft-pending') {
        pendingOwners.current.draft = message.pending;
        onPendingChangeProp?.(message.pending || pendingOwners.current.fluid);
        return;
      }
      if (message.kind === "fluid-pending") {
        onPendingChange?.(message.pending);
        return;
      }
      if (message.kind === "fluid-transaction") {
        const before = authority.current;
        const snapshot = latestDocument.current;
        if (
          !before ||
          message.epoch !== epoch.current ||
          message.epoch !== before.epoch ||
          message.operation !== before.operation + 1 ||
          snapshot.text !== before.text ||
          snapshot.revision !== before.revision
        ) {
          onError?.("Rejected stale rendered transaction; source has changed.");
          return;
        }
        void acceptSourceTransaction({
          snapshot,
          epoch: before.epoch,
          current: () => ({
            snapshot: latestDocument.current,
            epoch: epoch.current,
          }),
          prepare: () =>
            prepareFluidTransaction(
              snapshot,
              before,
              message.steps,
              message.syntax,
            ),
          commit: (result) => {
            if (
              authority.current !== before ||
              epoch.current !== before.epoch ||
              latestDocument.current.text !== snapshot.text ||
              latestDocument.current.revision !== snapshot.revision
            )
              return;
            const sourceSelection = (
              projection: FluidProjection,
              selection: { anchor: number; head: number },
            ) => {
              const anchor = fluidSourceOffsetForPosition(
                projection,
                selection.anchor,
              );
              const head = fluidSourceOffsetForPosition(
                projection,
                selection.head,
              );
              return anchor == null || head == null
                ? undefined
                : { anchor, head };
            };
            const next: Exposed = {
              ...result.projection,
              identity: before.identity,
              revision: before.revision + (result.text === before.text ? 0 : 1),
              epoch: before.epoch,
              operation: message.operation,
              reset: false,
            };
            authority.current = next;
            if (
              onPatch(before.revision, result.patches, {
                group: `${session}:${message.group}`,
                before: sourceSelection(before, message.before),
                after: sourceSelection(result.projection, message.after),
              }) === false
            ) {
              authority.current = before;
              throw new Error("Source rejected the rendered transaction.");
            }
            setExposed(next);
            setEditNotice(null);
            onError?.(null);
          },
        }).catch((error: unknown) => {
          if (authority.current !== before) return;
          const reset = {
            ...before,
            epoch: ++epoch.current,
            operation: 0,
            reset: true,
            selection: message.before,
          };
          authority.current = reset;
          setExposed(reset);
          setEditNotice(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (message.kind === "fluid-history") {
        const before = authority.current;
        if (
          !before ||
          before.epoch !== message.epoch ||
          before.epoch !== epoch.current
        )
          return;
        try {
          if (!onHistory) throw new Error("Source history is unavailable.");
          const result = onHistory(message.direction);
          setEditNotice(null);
          if (result.text === before.text) {
            const anchor =
              fluidPositionForSourceOffset(before, result.selection.anchor) ??
              1;
            const head =
              fluidPositionForSourceOffset(before, result.selection.head) ??
              anchor;
            const reset = {
              ...before,
              epoch: ++epoch.current,
              operation: 0,
              reset: true,
              selection: { anchor, head },
            };
            authority.current = reset;
            setExposed(reset);
          } else {
            ++epoch.current;
            pendingFocus.current = {
              revision: before.revision + 1,
              offset: result.selection.head,
            };
          }
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (message.kind === "edit-rejected") {
        // Refusing a command leaves the current projection and any queued
        // valid edits intact. Only runtime/compilation errors hide the frame.
        setEditNotice(message.message);
        return;
      }
      if (message.kind === "render-error") {
        setEditNotice(null);
        const error = `Preview failed: ${message.message}`;
        authority.current = null;
        ++epoch.current;
        setCompileError(error);
        onPendingChange?.(false);
        onError?.(error);
        return;
      }
      if (message.kind === "edit-resource") {
        // The path was parsed from evaluated document output: allow only a
        // reference the parent itself parsed from the authoritative source.
        if (!checkEditResource(allowedResourcePaths ?? [], message.path)) {
          onError?.(
            `Rejected edit request outside the document references: ${message.path}`,
          );
          return;
        }
        onEditResource?.(message.path);
        return;
      }
      if (message.kind === "view-resource") {
        // Reading-only inspection: same sender/session checks as edits
        // (via checkChildMessage above) plus an explicit current-revision
        // check, the source-parsed allowlist, and the parent-owned pixels.
        // The parent never fetches a path on a frame's word and never
        // inserts resource SVG as executable parent DOM.
        if (!viewerActive.current) return;
        if (message.revision !== document.revision) {
          onError?.("Rejected stale view request; source has changed.");
          return;
        }
        if (
          !checkViewResource(allowedResourcePaths ?? [], resources, message.path)
        ) {
          onError?.(
            `Rejected view request outside the document references: ${message.path}`,
          );
          return;
        }
        const svg = resources?.[message.path];
        if (typeof svg !== "string" || svg.length === 0) {
          onError?.(
            `Preview unavailable for ${message.path}: open the file to render it.`,
          );
          return;
        }
        setViewer({ path: message.path, svg });
        return;
      }
      if (!exposed) {
        onError?.("Rejected frame edit with no rendered document.");
        return;
      }
      if (message.revision !== document.revision) {
        onError?.("Rejected stale rendered edit; source has changed.");
        return;
      }
      if (
        message.kind === "block-edit" ||
        message.kind === "insert-block" ||
        message.kind === "prose-enter"
      ) {
        try {
          const result =
            message.kind === "block-edit"
              ? editBlock(
                  document,
                  message.revision,
                  exposed.instrumentation.blocks,
                  message,
                )
              : message.kind === "prose-enter"
                ? splitRichLeaf(
                    document,
                    message.revision,
                    exposed.instrumentation.richLeaves,
                    message,
                  )
                : insertBlock(
                    document,
                    message.revision,
                    exposed.instrumentation.boundaries,
                    message,
                    availableResourcePaths ?? [],
                    exposed.components.catalog,
                  );
          if (result.patch.insert === result.patch.expected) return;
          pendingFocus.current =
            message.kind === "block-edit" && message.action === "commit"
              ? null
              : {
                  revision: document.revision + 1,
                  // Appending a paragraph keeps the existing terminal-editor
                  // behavior: type after the inserted trailing blank lines.
                  // Mid-document insertions still target their interior gap.
                  offset: message.kind === "insert-block" && message.element === "Paragraph" && result.patch.from === document.text.length
                    ? result.patch.from + result.patch.insert.length
                    : result.focus,
                };
          onPatch(message.revision, [result.patch]);
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (message.kind === 'component-value-edit') {
        try {
          const patch = componentValuePatch(document.text, exposed.slots, message);
          setEditNotice(null);
          if (patch) commitLocalEdit(message.revision, [patch], message.draftId);
          else settle(message.draftId, 'noop');
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          setEditNotice(reason);
          settle(message.draftId, 'rejected', reason);
        }
        return;
      }
      if (message.kind === "prose-edit") {
        try {
        // Ranges and `expected` come from evaluated document code: allow
        // only a leaf the parent exposed for this revision, byte-for-byte.
        if (!checkProseEdit(exposed.instrumentation.leaves, message)) {
          throw new Error("Rejected prose edit outside the exposed source ranges.");
        }
        // The child only knows raw text; Markdown/MDX escaping happens here
        // through core's encoder before the patch is emitted.
        const leaf = exposed.instrumentation.leaves.find(
          (entry) => entry.from === message.from && entry.to === message.to,
        );
        if (!leaf) throw new Error('The editable source region is no longer available.');
        const insert = message.shortcut && !leaf.code
          ? encodeInlineInput(message.value, document.format)
          : encodeTextLeaf(leaf, message.value, document.format);
        if (insert === leaf.expected) { settle(message.draftId, 'noop'); return; }
        if (message.shortcut)
          pendingFocus.current = {
            revision: document.revision + 1,
            offset: message.from + insert.length,
          };
        commitLocalEdit(message.revision, [
          {
            from: message.from,
            to: message.to,
            insert,
            expected: message.expected,
          },
        ], message.draftId);
        setEditNotice(null);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          setEditNotice(reason);
          settle(message.draftId, 'rejected', reason);
        }
        return;
      }
      try {
      if (!checkPropEdit(exposed.slots, message)) {
        throw new Error("Rejected prop edit outside the exposed literal ranges.");
      }
      if (message.literal === message.expected) { settle(message.draftId, 'noop'); return; }
      commitLocalEdit(message.revision, [
        {
          from: message.from,
          to: message.to,
          insert: message.literal,
          expected: message.expected,
        },
      ], message.draftId);
      setEditNotice(null);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setEditNotice(reason);
        settle(message.draftId, 'rejected', reason);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    allowedResourcePaths,
    availableResourcePaths,
    closeViewer,
    document,
    documentId,
    document.format,
    exposed,
    onEditResource,
    onError,
    onPatch,
    onHistory,
    onPendingChange,
    onPendingChangeProp,
    resources,
    session,
  ]);

  const displayedError = componentError ?? compileError;
  return (
    <div data-rendered-editor={document.format} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {editNotice ? <p role="status">Edit not applied: {editNotice}</p> : null}
      {componentPending ? <p role="status">Loading components…</p> : null}
      {displayedError ? (
        <p role="alert" id={errorId}>
          {displayedError} Source is unchanged and remains editable.
        </p>
      ) : null}
      <iframe
        ref={frameRef}
        title="Isolated document preview"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcdoc}
        aria-describedby={displayedError ? errorId : undefined}
        // The frame fills the space its container gives the editor; the
        // document scrolls inside it. The sandbox stays allow-scripts only,
        // so the frame cannot be styled from here.
        style={{
          width: "100%",
          flex: "1 1 auto",
          minHeight: 320,
          border: 0,
          display: componentPending || displayedError ? 'none' : "block",
        }}
      />
      <Dialog
        open={active && viewer !== null}
        onOpenChange={(next) => {
          // Opening and closing the viewer posts no prose mutations and
          // never remounts the document editor above. Closing returns
          // focus to the originating View action inside the frame.
          if (!next && viewer) closeViewer(viewer.path);
        }}
      >
          <DialogContent className="rv-dialog translate-x-0 translate-y-0" finalFocus={false} showCloseButton={false}>
            {viewer ? (
              <ResourceViewer key={viewer.path} path={viewer.path} svg={viewer.svg} />
            ) : null}
          </DialogContent>
      </Dialog>
    </div>
  );
}
