# Roadmap

Tasks ready for contributors and coding agents are in the [task queue](tasks.md).

Four phases, in order. Each phase ends with something that works end to end.
Tasks marked **(open for contributors)** need only this repository, plus your
own free Supabase project for anything that touches the database. They need no
access to the hosted project. Everything else needs the hosted project or the
original prototype.

## Phase 1: agents can work on your projects

Claude and ChatGPT connect to an account over OAuth and read and edit that
user's files through MCP, on the hosted Supabase project.

1. **Core database (done).** Declarative schema for projects, folders, files,
   file versions and members. Functions to read, list, save a batch of files
   with base versions and an idempotency key, create projects and folders,
   archive and unarchive, permanently delete (people only, never OAuth
   clients), invite, accept (people only) and leave. RLS, explicit grants and
   70 pgTAP tests, passing on the hosted project.
2. **Deploys from GitHub (open for contributors).** A GitHub Actions workflow
   that, on merge to `main`, runs `supabase config push`, `supabase db push` and
   `supabase functions deploy --use-api` against the project named in repository
   secrets, using Supabase CLI 2.118.0, after `supabase link` and with
   `supabase config diff` printed before the config push. Plus a pull request
   check that regenerates migrations from `supabase/schemas/` and fails if the
   committed migrations are out of date. Test it from a fork against your own
   project.
3. **Sign-in and consent.** Email sign-in, the OAuth 2.1 server enabled in
   `config.toml`, asymmetric signing keys, and the app's sign-in and consent
   pages using Supabase's React consent block. The app deploys to
   https://elaborat.ing.
4. **MCP server.** The `mcp` Edge Function from Supabase's MCP server block, with
   tools that wrap the core database functions. Sharing and archiving are
   marked destructive.
5. **Prove it with real clients.** Connect Claude and ChatGPT, run a
   read-edit-read loop, and record the answers to the open questions: whether
   dynamic client registration is needed, and whether the clients' MCP Apps
   frames allow runtime-compiled components.
6. **Hybrid search (open for contributors once step 1 lands).** Passage chunks
   per heading, the documented `hybrid_search` function, automatic embeddings
   with the built-in `gte-small` model, a `search` function for query
   embeddings, and an MCP search tool.

## Phase 2: the editor moves in

The full editor from the original prototype, working on per-file storage.

- **Port the editor.** Notes with source and rendered editing, custom MDX
  components in the sandboxed frame, Excalidraw drawings, D2 diagrams with
  their native canvases, offline drafts and conflict recovery.
- **Comment anchoring library (done).** A pure TypeScript module implementing
  W3C Web Annotation text-quote and text-position selectors and approximate
  re-anchoring the way Hypothesis does it. See the task below.
- **Import tool** for projects exported from the prototype.

## Phase 3: public v1

- **All sign-in methods** that exist today: email and password, magic link and
  one-time code (custom SMTP), passkeys, GitHub, Google, and phone codes with
  Turnstile.
- **Generous abuse limits** per user.
- **Component isolation on a sandbox domain**, with a custom-code notice on
  shared projects.
- **MCP Apps views:** a read-only document with its drawings, a single drawing,
  and draft component previews inside Claude and ChatGPT.
- **Connected agents page** to see and revoke agent access.
- **Self-host guide:** from a new free Supabase project to a running copy.
- **Hosted launch** at https://elaborat.ing on a paid Supabase plan, so the
  project never pauses.

## Phase 4: sharing and comments

- Share by email, including people without an account yet.
- Member list, leaving a project and accepting invitations in the app (the
  database already supports them), and a warning before sharing as editor.
- The commenter role, and comments on documents, sections, text selections and
  drawing elements.

## Task: comment anchoring library

Done: `src/features/comments/anchoring.ts`, tested in
`src/features/comments/anchoring.test.ts`.

**Goal.** A pure module at `src/features/comments/anchoring.ts` (no React, no
Supabase) that describes a range of text with selectors and finds that range
again after the text changes. It uses the selectors of the
[W3C Web Annotation data model](https://www.w3.org/TR/annotation-model/#selectors)
and the matching approach of Hypothesis's
[match-quote.ts](https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/match-quote.ts).

**API.** Export exactly these:

```ts
export type TextQuoteSelector = {
  type: "TextQuoteSelector"
  exact: string
  prefix: string
  suffix: string
}

export type TextPositionSelector = {
  type: "TextPositionSelector"
  start: number
  end: number
}

export type TextRange = { start: number; end: number }

/** Selectors for text.slice(start, end). Throws RangeError if start >= end or out of bounds. */
export function describeRange(
  text: string,
  start: number,
  end: number,
): [TextQuoteSelector, TextPositionSelector]

/** The best match for the selectors in (possibly changed) text, or null. */
export function anchorRange(
  text: string,
  quote: TextQuoteSelector,
  position: TextPositionSelector,
): TextRange | null
```

**Offsets.** All offsets are UTF-16 code units (JavaScript string indices),
matching editor offsets. This is a deliberate departure from the W3C model,
which counts code points.

**describeRange.** `exact` is `text.slice(start, end)`. `prefix` is up to 32
code units immediately before `start`, and `suffix` up to 32 immediately after
`end`, both clipped at the document edges. If a context boundary would split a
surrogate pair, shorten that context by one unit so it never does.

**anchorRange.** Port Hypothesis's `matchQuote` logic:

1. Find candidates: every exact occurrence of `quote.exact` in `text`
   (`indexOf`). Only if there are none, use `approx-string-match`'s `search`
   with `maxErrors = Math.min(256, Math.floor(quote.exact.length / 2))`. Each
   candidate gives a start and end.
2. Score each candidate from 0 to 1 as a weighted average: quote similarity
   (weight 50, `1 - errors / quote.exact.length`), prefix similarity (20),
   suffix similarity (20), and closeness to `position.start` (2,
   `1 - |candidate.start - position.start| / text.length`). Prefix and suffix
   similarity compare the stored context with the text immediately before and
   after the candidate, the same way Hypothesis's `textMatchScore` does; an
   empty stored context scores 1.
3. Return the highest-scoring candidate. Break exact ties by the smaller
   distance to `position.start`, then the smaller start, then the larger end.
   (Approximate matches that share a start tie at the end of the document,
   where there is no suffix to compare; the longest is the edited quote.)
   Return `null` when there are no candidates.

**Tests** in `src/features/comments/anchoring.test.ts` (Bun; import the
functions by name, and note `describeRange` avoids clashing with `bun:test`'s
`describe`). Each case gives the expected range exactly:

- unchanged text returns the original range;
- text inserted before the range shifts it;
- text inserted inside the range returns the range around the edited quote;
- a quote longer than 32 characters with a few characters changed still anchors;
- a quote that appears twice picks the occurrence whose context matches;
- a quote whose text was deleted entirely (a sentence of 20 or more
  characters) returns `null`;
- ranges at the very start and very end of the document;
- text containing emoji (surrogate pairs) before, inside and after the range;
- `describeRange` throws for an empty or out-of-bounds range;
- the same inputs always return the same result.

**Dependencies.** Add `approx-string-match` at an exact version. Nothing else.

**Done when** `bun run build`, `bun run typecheck`, `bun run lint` and
`bun run test` pass, and the module imports nothing except
`approx-string-match`.
