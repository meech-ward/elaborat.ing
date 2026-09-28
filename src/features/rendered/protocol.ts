/**
 * Parent/child frame protocol for the isolated MDX preview.
 *
 * Child runs in an opaque-origin iframe with `sandbox="allow-scripts"` only,
 * fed a self-contained `srcdoc` document (inline bootstrap, no network).
 * Every message is checked for sender (event.source), session, revision and
 * Zod shape. Stale revisions are rejected visibly, never applied.
 *
 * This module also owns the small context-aware prop-literal codec shared by
 * the parent validator and the child editors. It stays free of the MDX
 * compiler so the child bundle (which imports this file) does not drag the
 * parser into the frame.
 */
import { z } from "zod";
import { PALETTE_IDS } from "../appearance/palettes";
import { readingPreferencesSchema } from "../appearance/reading";

/** Sandbox attribute for the preview iframe. allow-scripts ONLY. */
export const PREVIEW_SANDBOX = "allow-scripts";

/**
 * Restrictive child content-security-policy for the self-contained srcdoc
 * frame. The bootstrap is an inline classic script and `run()` from
 * `@mdx-js/mdx` compiles document code with `new Function`, so inline
 * scripts and eval are allowed; everything else (including `'self'` and any
 * remote host, which are meaningless without network) is denied.
 */
export const PREVIEW_CHILD_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  "font-src data:; " +
  "img-src 'none'; " +
  "media-src 'none'; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none';";

/**
 * Where a literal prop value sits in source. Quoted attributes
 * (`title="..."`, `title='...'`) decode HTML entities and never JSON
 * escapes; braced attributes (`title={...}`) hold a JS expression literal
 * with JSON-style escaping. The encoder must know which one it rewrites.
 */
export const propSyntaxSchema = z.enum([
  "quoted-double",
  "quoted-single",
  "braced",
]);

export type PropSyntax = z.infer<typeof propSyntaxSchema>;

export type LiteralPropKind = "number" | "string" | "boolean";

/** Parse the inside of a braced `{...}` attribute to a plain literal. */
export function parseExpressionLiteral(
  raw: string,
): { kind: LiteralPropKind; value: number | string | boolean } | null {
  const text = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(text))
    return { kind: "number", value: Number(text) };
  if (text === "true") return { kind: "boolean", value: true };
  if (text === "false") return { kind: "boolean", value: false };
  // Double-quoted strings must be exactly one JSON string: concatenation,
  // member access or trailing garbage fails the parse instead of matching
  // a greedy outer-quote pair. The value keeps the raw inner literal
  // (escapes intact); the JS engine decodes it at render time.
  if (text.startsWith('"')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof value !== "string") return null;
    return { kind: "string", value: text.slice(1, -1) };
  }
  // Single-quoted strings must be exactly one string literal with only
  // backslash escapes inside; anything else (concatenation, code) is out.
  const single = /^'(?:[^'\\\n\r]|\\.)*'$/.exec(text);
  if (single) return { kind: "string", value: text.slice(1, -1) };
  return null;
}

function escapeQuotedAttrText(value: string, quote: '"' | "'"): string {
  return [...value]
    .map((ch) => {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return quote === '"' ? "&quot;" : '"';
      if (ch === "'") return quote === "'" ? "&#39;" : "'";
      if (ch === "\n") return "&#10;";
      if (ch === "\r") return "&#13;";
      return ch;
    })
    .join("");
}

/**
 * Literal source text replacing a prop's `[from, to)` range for a new value.
 * Quoted attributes keep their quote style and use HTML entities (never
 * backslash escapes); braced attributes use JSON literal escaping. Only the
 * prop's own range is rewritten, never the surrounding tag.
 */
export function encodePropLiteral(
  syntax: PropSyntax,
  kind: LiteralPropKind,
  next: string | number | boolean,
): string {
  if (kind === "number") {
    if (typeof next !== "number" || !Number.isFinite(next)) {
      throw new Error("Prop value must be a finite number.");
    }
    return String(next);
  }
  if (kind === "boolean") {
    if (typeof next !== "boolean")
      throw new Error("Prop value must be a boolean.");
    return next ? "true" : "false";
  }
  if (typeof next !== "string") throw new Error("Prop value must be a string.");
  if (syntax === "braced") return JSON.stringify(next);
  const quote = syntax === "quoted-double" ? '"' : "'";
  return `${quote}${escapeQuotedAttrText(next, quote)}${quote}`;
}

/**
 * Strict entity decoding for quoted attribute values. Only the entities the
 * encoder emits are recognised; anything else survives verbatim so the
 * re-encode comparison below rejects it.
 */
const QUOTED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#34;": '"',
  "&#10;": "\n",
  "&#13;": "\r",
  "&#xA;": "\n",
  "&#xa;": "\n",
  "&#xD;": "\r",
  "&#xd;": "\r",
};

function decodeQuotedAttrText(inner: string): string {
  return inner.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|#34|#10|#13|#xA|#xa|#xD|#xd);/g,
    (entity) => {
      return QUOTED_ENTITIES[entity] ?? entity;
    },
  );
}

/**
 * Whether a child-supplied `literal` is a well-formed literal of the
 * declared kind in its source context. A quoted literal must be exactly one
 * literal in context: the matching surrounding quotes plus a body that
 * re-encodes byte-identically (so `"safe" other={x} title="again"`, stray
 * raw quotes, backslash-escaped quotes and raw markup are all refused).
 * Braced literals must parse to the same kind. Anything else (arbitrary JS,
 * a string where a number belongs) is rejected.
 */
export function literalMatchesKind(
  syntax: PropSyntax,
  kind: LiteralPropKind,
  literal: string,
): boolean {
  if (syntax === "quoted-double" || syntax === "quoted-single") {
    if (kind !== "string") return false;
    const quote = syntax === "quoted-double" ? '"' : "'";
    if (
      literal.length < 2 ||
      !literal.startsWith(quote) ||
      !literal.endsWith(quote)
    )
      return false;
    const inner = literal.slice(1, -1);
    // The delimiter may never appear raw inside: it would terminate the
    // value when the patch is parsed again (a backslash is literal text in
    // a quoted attribute, not an escape).
    if (inner.includes(quote)) return false;
    return (
      encodePropLiteral(syntax, "string", decodeQuotedAttrText(inner)) ===
      literal
    );
  }
  const parsed = parseExpressionLiteral(literal);
  return parsed != null && parsed.kind === kind;
}

/** A component slot lookup entry sent alongside compiled code. */
export const slotSchema = z.object({
  index: z.number().int().nonnegative(),
  element: z.string(),
  supported: z.boolean(),
  reason: z.string().optional(),
  titleInsertion: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), expected: z.literal('') }).optional(),
  props: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["number", "string", "boolean"]),
      syntax: propSyntaxSchema,
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      expected: z.string(),
      value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
      choices: z.array(z.string().max(256)).max(32).optional(),
    }),
  ),
});

export type SlotInfo = z.infer<typeof slotSchema>;

// The frame may propose vendor steps, never source ranges or executable code.
// The parent reparses them against its own schema and source projection.
const fluidJsonObject = z.record(z.string(), z.json());
const fluidSelection = z.object({
  anchor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
});
export const fluidSyntaxHintSchema = z.union([
  z.object({ delimiter: z.enum(["*", "_", "**", "__"]) }).strict(),
  z.object({ marker: z.enum(["-", "*", "+"]) }).strict(),
]);
export type FluidSyntaxHint = z.infer<typeof fluidSyntaxHintSchema>;
export const fluidRenderSchema = z.object({
  epoch: z.number().int().nonnegative(),
  operation: z.number().int().nonnegative(),
  reset: z.boolean(),
  runtimeKey: z.string(),
  islands: z.array(
    z.object({ id: z.string(), from: z.number().int().nonnegative() }),
  ),
  doc: fluidJsonObject,
  selection: fluidSelection.optional(),
});

/** Parent -> child: render this compiled document. */
export const renderMessageSchema = z.object({
  kind: z.literal("render"),
  session: z.string().min(8),
  revision: z.number().int().nonnegative(),
  /** JS from `compile(..., { outputFormat: 'function-body' })`. Never evaluated in the parent. */
  code: z.string().min(1),
  modules: z.array(z.object({path:z.string().max(512),code:z.string().max(4*1024*1024)})).max(32).optional(),
  slots: z.array(slotSchema),
  fluid: fluidRenderSchema.optional(),
  /** The person can read the document but not change it (a viewer, or an archived project). */
  readOnly: z.boolean().optional(),
  authoring: z
    .object({
      format: z.enum(["md", "mdx"]),
      boundaries: z.array(
        z.object({ id: z.string(), offset: z.number().int().nonnegative() }),
      ),
      availableResourcePaths: z.array(z.string().max(512)),
      components: z.array(z.object({name:z.string().max(128).regex(/^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)?$/),description:z.string().max(1024)})).max(128).optional(),
      focus: z.number().int().nonnegative().optional(),
      /** Rebase permission for this exact accepted local rendered edit only. */
      editAck: z.object({
        fromRevision: z.number().int().nonnegative(),
        draftId: z.number().int().nonnegative().optional(),
        patches: z.array(z.object({
          from: z.number().int().nonnegative(),
          to: z.number().int().nonnegative(),
          insertLength: z.number().int().nonnegative(),
        }).strict()).max(256),
      }).strict().optional(),
    })
    .optional(),
});

export type RenderMessage = z.infer<typeof renderMessageSchema>;

/**
 * Parent -> child: generated pixels for `<Drawing>`/`<Diagram>` embeds.
 * Only locally generated SVG for paths the parent parsed from the
 * authoritative source travels here — never tokens, filesystem handles, or
 * file bytes. The child renders them and can request an edit, which the
 * parent re-validates against the source refs before opening anything.
 */
export const resourcePayloadSchema = z.object({
  path: z.string().min(1).max(512),
  svg: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
});

export const resourcesMessageSchema = z.object({
  kind: z.literal("resources"),
  session: z.string().min(1),
  revision: z.number().int().nonnegative(),
  resources: z.array(resourcePayloadSchema),
});

export type ResourcesMessage = z.infer<typeof resourcesMessageSchema>;

/** Presentation-only message: no CSS, URLs, document bytes or executable input. */
export const appearanceMessageSchema = z.object({
  kind: z.literal("appearance"),
  session: z.string().min(8),
  theme: z.enum(PALETTE_IDS),
  scheme: z.enum(["light", "dark"]),
});
export type AppearanceMessage = z.infer<typeof appearanceMessageSchema>;

/**
 * Parent -> child: the commented text to mark, as ranges of the rendered
 * document (ProseMirror positions) for this revision, which the parent works
 * out from the source. Ids are the threads' (or "draft"), echoed back when
 * one is clicked. `canComment` turns on the selection and heading reports.
 */
export const commentMarksMessageSchema = z.object({
  kind: z.literal("comments"),
  session: z.string().min(8),
  revision: z.number().int().nonnegative(),
  canComment: z.boolean(),
  marks: z.array(z.object({
    id: z.string().min(1).max(64),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    active: z.boolean(),
  }).strict()).max(1000),
}).strict();
export type CommentMarksMessage = z.infer<typeof commentMarksMessageSchema>;

export const parentMessageSchema = z.union([
  z.object({
    kind: z.literal('source-draft-settled'),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    draftId: z.number().int().nonnegative(),
    outcome: z.enum(['noop', 'rejected']),
    reason: z.string().max(2000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("reading-preferences"),
    session: z.string().min(8),
    preferences: readingPreferencesSchema,
  }),
  z.object({
    kind: z.literal("authoring-paths"),
    session: z.string().min(8),
    paths: z.array(z.string().max(512)),
  }),
  z.object({
    kind: z.literal("resource-focus"),
    session: z.string().min(8),
    /** Workspace path whose View action should regain focus in the frame. */
    path: z.string().min(1).max(512),
  }),
  renderMessageSchema,
  resourcesMessageSchema,
  appearanceMessageSchema,
  commentMarksMessageSchema,
  // Show commented text (a document range): scroll to it, flash it, and take the keyboard if asked.
  z.object({
    kind: z.literal("comment-reveal"),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    focus: z.boolean(),
  }).strict(),
]);

export type ParentMessage = z.infer<typeof parentMessageSchema>;

/** Where something is in the frame's viewport, in CSS pixels, for the parent to place a control by it. */
const frameRectSchema = z.object({
  top: z.number().finite(),
  left: z.number().finite(),
  bottom: z.number().finite(),
  right: z.number().finite(),
}).strict();
export type FrameRect = z.infer<typeof frameRectSchema>;

/** Child -> parent: result or edit messages. */
export const childMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal('source-draft-pending'),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    pending: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("fluid-pending"),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    pending: z.boolean(),
  }),
  z.object({
    kind: z.literal("fluid-transaction"),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    operation: z.number().int().positive(),
    steps: z.array(fluidJsonObject).min(1).max(100),
    before: fluidSelection,
    after: fluidSelection,
    group: z.string().max(100),
    syntax: fluidSyntaxHintSchema.optional(),
  }),
  z.object({
    kind: z.literal("fluid-history"),
    session: z.string().min(8),
    revision: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    direction: z.enum(["undo", "redo"]),
  }),
  z.object({
    kind: z.literal("prose-enter"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    expected: z.string(),
    value: z.string().max(100000),
    caret: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("block-edit"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    block: z.string().max(100),
    action: z.enum(["commit", "enter", "shortcut"]),
    value: z.string().max(100000),
    caret: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("insert-block"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    boundary: z.string().max(100),
    // The authoritative parent catalog, not this transport shape, grants insertion.
    element: z.string().min(1).max(100),
    path: z.string().max(512).optional(),
  }),
  z.object({
    kind: z.literal("ready"),
    session: z.string().min(1),
  }),
  // An app shortcut pressed inside the frame, passed up so it works there too.
  z.object({
    kind: z.literal("shortcut"),
    session: z.string().min(1),
    key: z.enum(["s", "k", "p", "d", ".", "1", "2", "3", "m"]),
    meta: z.boolean(),
    ctrl: z.boolean(),
    alt: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("rendered"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
  }),
  // The selected text (document positions) and where its end is, or none.
  // Positions are proposals: the parent maps them through its own projection.
  z.object({
    kind: z.literal("comment-selection"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    range: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict().nullable(),
    rect: frameRectSchema.nullable(),
  }).strict(),
  // The heading under the pointer (a position in it) and where its words are, or none.
  z.object({
    kind: z.literal("comment-heading"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    pos: z.number().int().nonnegative().nullable(),
    rect: frameRectSchema.nullable(),
  }).strict(),
  // Commented text was clicked: open its thread (an id the parent sent).
  z.object({
    kind: z.literal("comment-open"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    id: z.string().min(1).max(64),
  }).strict(),
  // The comment key in the frame: comment on the selection, or on the heading holding the caret (from = to).
  z.object({
    kind: z.literal("comment-shortcut"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("render-error"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("edit-rejected"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    message: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("prose-edit"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    draftId: z.number().int().nonnegative().optional(),
    /** Source range the child was told the leaf occupies. */
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    /** Exact source slice for the leaf (`SourceText expected` prop). */
    expected: z.string(),
    /** Raw edited text; the parent encodes it via the document module's encodeProseText. */
    value: z.string(),
    shortcut: z.boolean().optional(),
    caret: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("prop-edit"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    draftId: z.number().int().nonnegative().optional(),
    slot: z.number().int().nonnegative(),
    prop: z.string(),
    /** Literal source text for the new value, e.g. `4` or `"New title"`. */
    literal: z.string(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    expected: z.string(),
  }),
  z.object({
    kind: z.literal('component-value-edit'),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    draftId: z.number().int().nonnegative().optional(),
    slot: z.number().int().nonnegative(),
    prop: z.enum(['title', 'ratio']),
    value: z.string().max(32_000),
  }).strict(),
  z.object({
    kind: z.literal("edit-resource"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    /** Workspace path the child wants to edit (always re-checked by the parent). */
    path: z.string().min(1).max(512),
  }),
  z.object({
    kind: z.literal("view-resource"),
    session: z.string().min(1),
    revision: z.number().int().nonnegative(),
    /** Workspace path the child wants to inspect (always re-checked by the parent). */
    path: z.string().min(1).max(512),
  }),
]);

export type ChildMessage = z.infer<typeof childMessageSchema>;

/**
 * What the parent does with a frame message about an older revision of the
 * note. That is routine while the source changes under the frame, so it is
 * never a render error:
 * - `status`: a pending flag, informational, applied as it is;
 * - `drop`: an acknowledgement or render error, which the newer render
 *   replaces, or a request to open or view a file, which can be made again;
 * - `refusal`: the frame refused a command, and its message still says why;
 * - `lost-edit`: an edit made against the older revision, which is lost.
 */
export function staleChildMessage(kind: ChildMessage["kind"]): "status" | "drop" | "refusal" | "lost-edit" {
  switch (kind) {
    case "source-draft-pending":
    case "fluid-pending":
      return "status";
    case "ready":
    case "rendered":
    case "render-error":
    case "edit-resource":
    case "view-resource":
    case "shortcut":
    case "comment-selection":
    case "comment-heading":
    case "comment-open":
    case "comment-shortcut":
      return "drop";
    case "edit-rejected":
      return "refusal";
    default:
      return "lost-edit";
  }
}

export type CheckResult =
  { ok: true; message: ChildMessage } | { ok: false; error: string };

/**
 * Validate a child message in the parent: sender must be the known frame,
 * session must match, revision must equal the current document revision
 * (stale renders can never overwrite a newer document), and the shape must
 * validate. Returns the parsed message or a visible error string.
 */
export function checkChildMessage(args: {
  data: unknown;
  source: unknown;
  expectedSource: unknown;
  session: string;
  revision: number;
}): CheckResult {
  if (args.source !== args.expectedSource || args.expectedSource == null) {
    return {
      ok: false,
      error: "Rejected frame message from an unknown sender.",
    };
  }
  const parsed = childMessageSchema.safeParse(args.data);
  if (!parsed.success) {
    return { ok: false, error: "Rejected malformed frame message." };
  }
  const message = parsed.data;
  // `ready` fires before the child has seen a session; the sender check
  // above is its only gate. Every other kind must match the session.
  if (message.kind !== "ready" && message.session !== args.session) {
    return { ok: false, error: "Rejected frame message for a stale session." };
  }
  // A shortcut is a key press, not an edit: it has no revision to be stale.
  if (message.kind !== "ready" && message.kind !== "shortcut" && message.revision !== args.revision) {
    return {
      ok: false,
      error: `Rejected stale frame message (revision ${message.revision}, current ${args.revision}).`,
    };
  }
  return { ok: true, message };
}

/**
 * Validate a parent message in the child: it must come from the embedding
 * window, match the active session once initialised, and validate by shape.
 * The first accepted render message initialises the session. A resources
 * message never initialises a session: pixels without a document render
 * are ignored.
 */
export function checkParentMessage(args: {
  data: unknown;
  source: unknown;
  activeSession: string | null;
}): { ok: true; message: ParentMessage } | { ok: false; error: string } {
  if (args.source == null) {
    return { ok: false, error: "Rejected message with no source." };
  }
  const parsed = parentMessageSchema.safeParse(args.data);
  if (!parsed.success) {
    return { ok: false, error: "Rejected malformed parent message." };
  }
  if (
    args.activeSession != null &&
    parsed.data.session !== args.activeSession
  ) {
    return { ok: false, error: "Rejected parent message for a stale session." };
  }
  if (parsed.data.kind !== "render" && args.activeSession == null) {
    return { ok: false, error: "Rejected resources before a document render." };
  }
  return { ok: true, message: parsed.data };
}

/**
 * An edit-resource request names a path the parent parsed from the
 * authoritative source. Anything else (absolute, external, unlisted) is
 * refused even when it comes from the known frame.
 */
export function checkEditResource(
  allowedPaths: readonly string[],
  path: string,
): boolean {
  return allowedPaths.includes(path);
}

/**
 * A view-resource request additionally needs parent-owned pixels for the
 * path: the parent never fetches a path based solely on a frame message,
 * so a listed path with no generated SVG opens nothing (no broken View
 * action) instead of reaching for file bytes.
 */
export function checkViewResource(
  allowedPaths: readonly string[],
  resources: Record<string, string> | undefined,
  path: string,
): boolean {
  if (!allowedPaths.includes(path)) return false;
  const svg = resources?.[path];
  return typeof svg === "string" && svg.length > 0;
}

/** Minimal leaf shape the parent checks prose edits against. */
export type LeafRange = { from: number; to: number; expected: string };

/** Minimal slot shape the parent checks prop edits against. */
export type SlotRange = {
  index: number;
  supported: boolean;
  props: Array<{
    name: string;
    kind: LiteralPropKind;
    syntax: PropSyntax;
    from: number;
    to: number;
    expected: string;
  }>;
};

/**
 * A prose edit is allowed only when its range matches a leaf the parent
 * exposed for the current revision byte-for-byte. Ranges or `expected`
 * text forged by evaluated document code never match.
 */
export function checkProseEdit(
  leaves: readonly LeafRange[],
  message: { from: number; to: number; expected: string },
): boolean {
  return leaves.some(
    (leaf) =>
      leaf.from === message.from &&
      leaf.to === message.to &&
      leaf.expected === message.expected,
  );
}

/**
 * A prop edit is allowed only for a supported slot's documented literal
 * prop with exact range/`expected` match, and the new literal must be the
 * same literal kind in the same source context (no arbitrary JS where a
 * number belongs, no context switch).
 */
export function checkPropEdit(
  slots: readonly SlotRange[],
  message: {
    slot: number;
    prop: string;
    literal: string;
    from: number;
    to: number;
    expected: string;
  },
): boolean {
  const slot = slots.find((entry) => entry.index === message.slot);
  if (!slot || !slot.supported) return false;
  const prop = slot.props.find((entry) => entry.name === message.prop);
  if (
    !prop ||
    prop.from !== message.from ||
    prop.to !== message.to ||
    prop.expected !== message.expected
  ) {
    return false;
  }
  return literalMatchesKind(prop.syntax, prop.kind, message.literal);
}
