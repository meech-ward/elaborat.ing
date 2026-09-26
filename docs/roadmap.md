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
   `supabase config diff` printed before the config push. Test it from a fork
   against your own project. (The pull request check that fails when committed
   migrations are out of date with `supabase/schemas/` is done: the
   `migrations` job in `ci.yml`.)
3. **Sign-in and consent.** Email sign-in, the OAuth 2.1 server enabled in
   `config.toml`, asymmetric signing keys, and the app's sign-in and consent
   pages using Supabase's React consent block. The app deploys to
   https://elaborat.ing.
4. **MCP server (deployed).** The `mcp-server` Edge Function from Supabase's
   MCP Server block, with tools that wrap the core database functions, tested
   live with a signed-in session. Connecting real clients waits for step 3.
5. **Prove it with real clients.** Connect Claude and ChatGPT, run a
   read-edit-read loop, and confirm with a real OAuth token that it carries
   `client_id` and that Auth refuses account changes made with it.
6. **Hybrid search (built).** Passages per heading, the documented
   `hybrid_search` function, automatic embeddings with the built-in `gte-small`
   model, a `search` function for query embeddings, and an MCP search tool.
   pgTAP tests prove results come only from the caller's projects. It runs on
   the hosted project once its Vault holds the embed key and the functions are
   deployed (see "Search" in architecture.md).

## Phase 2: the editor moves in

The full editor from the original prototype, working on per-file storage.
About half of the prototype's code moves over unchanged, a fifth is adapted to
per-file storage, and its server and single-folder storage mode are not
ported. Steps, in order; **(open for contributors)** marks steps that need only
this repository once the steps before them have landed.

1. **The pure editor, drawing and diagram code lands in the repo (done)**, not yet
   mounted: source editor, rendered view and frame, document model, component
   catalog, Excalidraw drawings, D2 diagrams, workbench pieces, appearance and
   UI primitives, with their unit tests.
2. **Drawing tests use a synthetic Obsidian-format drawing (open for
   contributors).**
3. **The build ships Excalidraw's fonts and font worker, proven in a real
   browser (done)** with a Playwright and axe harness: fonts, the font
   worker, SVG export, and drawing fidelity (a no-op open is byte-exact,
   delete and undo, editing a text by its id, image pixels, PNG and SVG
   export) on the synthetic demo scene and on step 2's compressed Obsidian
   drawing.
4. **Notes render and edit in the sandboxed frame, built by the normal Vite
   build (done)**, so the license notices cover the frame's code too. Browser
   journeys on a test page cover typing, selections, split and join, lists,
   protected MDX, edits in flight and arriving diagram previews.
5. **Projects are stored per file on the device, behind one storage
   interface (done)**: IndexedDB keeps each file's draft, saved copy and
   server copy, plus the one batch in flight. Code in
   `src/features/project-storage/`.
6. **Saves sync through `save_files` with per-file conflict recovery (done)**:
   keep mine, keep theirs, or keep both. Tested against an in-memory server
   that follows the database's rules; the first run against the hosted
   project comes with sign-in (step 8).
7. **Open projects hear about remote changes over Realtime Broadcast (done).**
   The database side is live on the hosted project; the app joins the channel
   once it opens projects (step 9).
8. **People sign in with Supabase Auth, and signing out never loses drafts
   (done).** Sign-out runs every registered guard first (the workbench
   registers one that keeps unsaved edits, step 10), and projects stay on the
   device under their account.
9. **The app opens a user's projects at real URLs, online or offline (done).**
   `/projects/<id>/<file path>`; projects download on first open, sync in the
   background and on Realtime change signals, and wait on the device while
   offline. Guarding navigation away from unsaved edits comes with the editor
   (step 10). On the projects home, owners and editors archive and unarchive
   a project, and archived projects are listed in their own section and refuse
   changes. The owner can delete a project permanently after typing its title,
   which removes it from the server and from the device. A viewer or
   commenter, and everyone in an archived project, sees it read-only: the page
   says why (with Unarchive for owners and editors), every editor shows its
   files without changing them or keeping drafts, and nothing offers to
   create, import, rename, move or delete files.
10. **Notes open in tabs, edit in source and rendered views, and save (done)**
    with drafts and conflict recovery (keep mine, keep theirs, keep both), and
    leaving a project or signing out keeps unsaved edits first. Drawings and
    diagrams got their views in steps 13 and 14, and renaming and moving came
    with step 12. The rendered view keeps its place and focus across a Source
    round trip, a touch scroll never focuses it while a tap does, one undo
    history serves both views, and undoing back to the saved text clears
    "Unsaved changes".
11. **Custom MDX components load from project files (done).** A note imports
    named components from other MDX files with `workspace:` specifiers.
    Modules load from their saved copies and run only in the frame, and a
    module saved in another tab or brought in by sync updates the open notes
    that use it. Browser journeys in `tests/browser/components.spec.ts`.
12. **Files and folders can be renamed, moved and deleted, and folders
    created (done).** A rename or move rewrites references in the same save.
    A D2 diagram's generated files go with it, and a folder goes with
    everything in it, its empty folders included, as one save. A delete first
    confirms what goes and lists the files that still refer to it; their
    references are left as they are. Open tabs follow moved files and close
    for deleted ones, and unsaved edits or a sync conflict stop a move or a
    delete until they are settled. Files of kinds the app does not edit (for
    example, ones an agent wrote) are listed and open as text, and can be
    deleted, but are not renamed or moved, and a folder holding one does not
    move.
13. **Drawings edit, save and export on per-file storage (done).** Excalidraw
    and Obsidian `.excalidraw.md` drawings open on the canvas without being
    rewritten, save on the device, keep unsaved edits across reloads, take a
    newer saved copy when untouched, and export SVG, PNG and Excalidraw files.
    A file that does not parse opens as text with the error. New drawings come
    from the workbench menu. Drawings embedded in notes arrive with step 14.
14. **D2 diagrams compile in the browser, save as one three-file batch, and
    embed in notes (done).** The diagram view has code and a generated canvas;
    Regenerate keeps freehand additions and moved shapes, a syntax error keeps
    the last valid canvas, and renaming a node on the canvas updates the code.
    Notes show pictures of the drawings and diagrams they embed, with a zoomable
    viewer. New diagrams come from the workbench menu.
15. **The app restarts offline (done)**, using vite-plugin-pwa. Once a
    project has opened on a device, the app, its projects and unsaved edits
    come back with no network, and a new version waits until the person
    chooses "Update ready".
16. **Projects exported from the prototype import into elaborat.ing (done).**
    "Import a project" on the projects home reads the prototype's one-file
    JSON export, creates the project on this device in saves of at most 500
    files and 8 MiB, and lists any path this app cannot store with the reason.

Also done in this phase: the comment anchoring library (see the task below).

## Phase 3: public v1

- **All sign-in methods** that exist today: email and password, magic link and
  one-time code (custom SMTP), passkeys, GitHub, Google, and phone codes with
  Turnstile. (Done in the app: the one-time code, and GitHub and Google
  buttons that show once their OAuth apps are set up and turned on in
  `config.toml`.)
- **Generous abuse limits** per user.
- **Component isolation on a sandbox domain**, with a custom-code notice on
  shared projects.
- **MCP Apps views:** a read-only document with its drawings, a single drawing,
  and draft component previews inside Claude and ChatGPT.
- **Connected agents page** to see and revoke agent access (done: `/agents`,
  linked from the account header and menu; it lists grants once the OAuth
  server is on).
- **Self-host guide:** from a new free Supabase project to a running copy.
- **Hosted launch** at https://elaborat.ing on a paid Supabase plan, so the
  project never pauses.

## Phase 4: sharing and comments

- Share by email, including people without an account yet.
- Accepting invitations and leaving a shared project in the app (done:
  invitations are listed on the projects home, and a shared project's menu
  there has "Leave project"; leaving is refused while this device holds
  changes to it that have not synced).
- Member list (done: a project's menu on the projects home has "Members",
  listing its owner and members with their email and role; the owner changes
  a role or removes a member or an invitation there, and agents can read the
  list with the `list_members` tool), and a warning before sharing as editor.
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
