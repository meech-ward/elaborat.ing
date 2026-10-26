# Architecture

Target architecture for elaborat.ing. Sections marked **Decision** are settled.
Sections marked **Open** are still being decided; don't build past them without
recording a decision here. Platform facts behind these choices, with sources,
are in [platform notes](platform-notes.md).

## Shape

```
browser: static Vite + React SPA on Cloudflare Workers (static assets)
  ├─ Supabase Auth ........ sign-in, and the OAuth 2.1 server agents connect through
  ├─ Postgres + RLS ....... projects, files, versions, members, comments, search
  ├─ Realtime ............. "something changed" signals, then authoritative re-reads
  └─ Edge Functions ....... mcp (agents), embed (search indexing), search (query embedding),
                            share (invite by email), delete-account,
                            send-events (MCP Events delivery to agents)

MCP clients (Claude, ChatGPT, ...) ── OAuth ──> mcp Edge Function ──> same database functions, as the user

component frame (separate site) ... runs user MDX components with no access to the app
```

There is no application server. The browser talks to Supabase with the user's
own session, so row-level security is the whole permission model. Agents use
exactly the same database functions, as the user.

## Principles

- **Canonical over clever.** Use the standard, current, common way for every
  piece: Supabase's documented patterns and library blocks, the official MCP
  SDK, standard OAuth. No unusual code in this repository. If something needs
  a workaround, write down why first.
- **Infrastructure as code.** Every setting that has a file-based home lives in
  a file in this repo. The few that don't are listed under
  [manual steps](#manual-steps) until the platform adds one.
- **Test on a throwaway stack, then the cloud.** Database tests run on a
  throwaway local stack built from the migrations, so they never touch real
  data. Auth and function changes are then checked on the hosted project once
  the deploy workflow has applied them.
- **An app, not a page; the shell first.** The app is separate from the data:
  no server-side rendering, and it should feel like a desktop or mobile app.
  The first download is only the shell: the page frame, its CSS and its
  loading states, so something appears as fast as possible. Everything heavy
  (Monaco, the drawing engine, the D2 engine, charts, code highlighting, the
  MDX compiler) is a dynamic import, fetched only when the screen needs it,
  behind a placeholder or loading state. A slow download after first paint is
  fine; a slow first paint is not. `bun run report:bundle` measures it and CI
  holds each page's first paint to a budget (`bun run check:bundle`). Every
  change is judged by this.
- **Source is authoritative.** For notes, the Markdown/MDX text is the
  document; rendered edits are checked, precise source edits. For drawings, the
  native Excalidraw scene is authoritative.

## Supabase as code

**Decision:** the standard Supabase CLI layout, pinned to one CLI version.

```
supabase/
  config.toml        project settings (API, Auth, Storage, functions, Vault secrets by env())
  schemas/           declarative SQL: the desired database, one file per concern
  migrations/        mostly generated from schemas/ and committed; see below
  functions/         Edge Functions (mcp, embed, search, ...)
  seed.sql           test data for dev projects only
```

- **Schema changes:** edit `supabase/schemas/`, then run
  `supabase db schema declarative sync` (the pg-delta engine, the default for
  new projects) to generate a migration, and commit both. Branch and production
  deploys apply `migrations/`, never `schemas/` directly.
- **Everything must be declared.** The schema directory is the complete
  desired state: extensions, tables, functions, triggers, policies and grants.
  Anything missing is planned as a removal.
- **Explicit grants for tables.** New Supabase projects no longer expose
  `public` tables to the Data API automatically. Every table needs explicit
  `grant` statements for the roles that use it, next to its RLS policies.
  `config.toml` sets `auto_expose_new_tables = false` so the shadow databases
  used for diffing behave the same way.
- **Functions are open by default, so revoke first.** Postgres lets everyone
  execute a new function. Every function file revokes `execute` from `public`
  and `anon`, then grants it only to the roles that should call it.
- **Writes go through functions.** Clients get `select` on tables, filtered by
  RLS, and nothing else. Every write is a `security definer` function in the
  `private` schema, which the Data API does not expose, called from a thin
  `security invoker` wrapper in `public`. This keeps definer functions out of
  the exposed schema, as Supabase's RLS guide recommends. Signed-in users can
  still execute everything in `private`, so every private function checks the
  caller itself and never trusts an argument to say who the caller is.
- **RLS policies use `project_id in (select private.readable_project_ids())`**,
  which Postgres evaluates once per query, following Supabase's RLS
  performance guidance.
- **RLS on every table.** No table ships without row-level security and a
  policy test.
- **Generated migrations are never hand-edited.** A few things need a
  hand-written migration instead: objects pg-delta doesn't model (kept in
  `schemas/_custom/`), and queues or cron jobs if the pinned CLI can't
  round-trip them from `schemas/`. Each hand-written migration starts with a
  comment saying why.
- **Data is not schema.** DML never goes in `schemas/`. Vault secrets (such as
  the key the database uses to call Edge Functions) are declared in
  `config.toml` under `[db.vault]` with `env()` values. `db push` writes them
  to Vault only when it applies a migration, so rotating one means updating
  its GitHub secret and committing an empty migration.
- **`config.toml` holds the hosted project's values.** The file describes the
  real project: site URL, redirect URLs, email confirmation and so on. The
  throwaway test stack starts from the same file. Self-hosters change these for
  their own copy.
- **Generating migrations needs a throwaway Postgres.** The sync command builds
  shadow databases locally, which needs Docker (an experimental Docker-free
  runtime exists but is undocumented and unverified). That happens on a
  developer machine or in CI. The cloud project is where changes are applied
  and tested, never where they are generated.

## Deploys

**Decision:** one GitHub Actions workflow (`.github/workflows/deploy.yml`)
deploys the hosted project with the pinned Supabase CLI, and the app. Its jobs
run in this order, each once the one before it has passed:

1. `supabase`: every Edge Function but `mcp-server` (`supabase functions
   deploy --use-api`), then `supabase db push`. The functions are named from
   the folders with an `index.ts`, the way the CLI finds them itself, so a new
   one is never left out. Functions first, so `embed` exists before Vault
   gives the database its key.
2. `app`: the sandbox domain, then the app's Worker (Frontend hosting). After
   the migrations, so new app code never runs before the schema it needs.
3. `mcp-server`, last. The chat card it sends (under Agents (MCP)) names files
   of its build in `public/chat-card`, which the app's Worker serves, so the
   function goes live only once the site serves them.

Bucket provisioning uses the official Storage API through
`scripts/provision-image-bucket.ts`, reading only the `project-images`
declaration in `config.toml`. It creates or updates that one bucket with the
existing database secret API key. It never lists or deletes other buckets.
The pinned CLI's `seed buckets` has no bucket selection flag: its
[2.118.0 seeding implementation](https://github.com/supabase/cli/blob/v2.118.0/apps/cli/src/command-internal/seed-buckets.ts)
also processes analytics buckets when enabled and `--yes` confirms pruning
undeclared buckets. Its linked credential resolver also reads all API keys
unless a service key override is supplied. The direct
[create](https://supabase.com/docs/reference/javascript/storage-createbucket)
and [update](https://supabase.com/docs/reference/javascript/storage-updatebucket)
operations keep deployment limited to this declared private bucket and retain
the deploy token's existing permissions.

The `config` job (`supabase config diff` and `supabase config push`) runs
after the `supabase` job, beside the app. The CLI works on every plan, and
self-hosters can run the same workflow from their own fork. The workflow runs
only after CI passes on `main`, and deploys the newest commit CI has passed
there, not the one that triggered it: CI runs can finish out of order, so
whichever deploy runs last ships the newest green commit and an older one
never replaces it. Every job deploys the commit the first one found. A failing
build never ships half a release; every step is safe to repeat.

- **No `supabase link`.** Linking reads the project's API keys, which needs a
  token that can see every secret key. Each command takes `--project-ref`
  instead, which also makes `db push` connect through the IPv4 pooler.
- **Two scoped access tokens.** The deploy token, which the `supabase` and
  `mcp-server` jobs use, has Edge Functions Read-write and Connection Pooling
  Read. The config token has Project Settings and Auth Config Read-write,
  Add-ons Read, and Read on Database Config, Database, SSL Enforcement,
  Network Restrictions, Data API Config, Realtime Config and Storage Config.
  Project Settings Read-write can also delete or pause the project, so only
  the `config` job has it.
- **Where the values live.** The config token and the SMTP credentials are
  secrets of a `supabase-config` environment limited to `main`, which only the
  config job uses. The deploy token, database password and embed secret key are
  repository secrets, and the project ref is the `SUPABASE_PROJECT_ID`
  repository variable.
- **Not Supabase's GitHub integration.** On production it ignores Auth config
  unless the project ref is written into `config.toml`.
- **When it runs:** after every CI pass on `main`, and by hand (a hand run
  deploys the newest green commit too). `config push` is not atomic (Auth is
  written before Storage), so a hand run shows the diff and pushes only when asked. Every
  push checks that no credential was left out.
- **Known diff line:** `auth.sms.twilio.enabled` stays in the diff, because
  `config push` cannot turn off the active SMS provider. Phone sign-in is off,
  so nothing uses it.

**Decision:** pull requests get a CI check that regenerates migrations from
`schemas/` and fails if the committed migrations are out of date.

**Open: a separate test project.** Today there is one hosted project, and
changes are tested there before real users exist. Once the hosted instance has
users, changes need somewhere else to land first. The options: a project in a
separate free organization (free, but pauses when idle and uses one of two free
slots), a second project in the paid organization (about $10 a month, under the
spend cap), or a persistent branch (about $10 a month, outside the spend cap).

## Data

**Decision:** a user's space is their projects. A project holds files and
folders, has an owner and members, and every save is version-checked.

**Decision:** the project is the unit of sharing. Roles are `viewer`,
`commenter`, `editor`, plus the owner. RLS enforces isolation.

**Decision: one row per file.** Each file has its own row with its current
content. History stores only the files that changed. A save is one database
call (`save_files`) carrying a list of changes, each with the version it was
based on, so multi-file changes (a D2 source plus its generated canvas and
sidecar) stay atomic. Edits to different files never conflict; two edits to the
same file get conflict recovery. A move can carry new content, so moving a file
and rewriting its own references is one change. Every save carries an
idempotency key, so a
retried save returns its original result instead of saving twice, even if the
project was archived in between.

**Decision: a file's version is the project revision at which it last
changed.** Every successful write raises the project revision by one, and every
file it touches takes that revision as its version. A revision is never reused,
so a path and version pair identifies one exact write: an edit based on a file
that was moved away can never land on a different file that later took its
path.

**Decision: sharing is an invitation.** Sharing a project with someone creates
an invitation that grants nothing until they accept it, and only a signed-in
person can accept, never an agent. Members can leave a project (or decline an
invitation) themselves. The owner and accepted members can see who a project
is shared with, each person's email included (`list_members`); only the owner
sees invitations not yet accepted, and only the owner changes them.

**Decision: the owner can hand a project to a member.** `transfer_project`
makes a member who has accepted the project its owner, whatever their role,
and keeps the old owner on as an editor, in one step that raises the
revision, so every device with the project open hears of it. From then on the
new owner has the owner's rights, sharing and permanent delete included. Only
the owner can do it, and only a signed-in person: agents' tokens are refused,
as for permanent deletes, since the new owner can delete. An invitation not
yet accepted is not enough. Archived projects can be handed over too:
archiving stops changes to the files, not to who has access, and someone
deleting their account may want to keep an archived project going. The
project counts against the new owner's project limit. In the app, the owner
picks "Make owner" next to a member in the Members dialog, or "Transfer
first" next to a shared project when deleting their account, and confirms in
a dialog naming the new owner.

**Decision: sharing by email goes through one Edge Function.** The owner
invites an email with the `share` Edge Function, which refuses agents' tokens
(people share, agents don't) and checks, as the caller, that they own the
project. An email that has an account gets the usual invitation
(`share_project`, as the caller), and no email. For an email without one, the
function calls Auth's admin invite with its own service key, which creates the
account and sends the invite email (`supabase/templates/invite.html`, naming
who invited them and the project), then records the invitation for the new
account. The function answers the same either way. Looking an account up by
email, counting the owner's invitations against their daily limit (see
Limits) and recording that invitation are database functions only the service
role may execute (`supabase/schemas/email_invitations.sql`), so the Data API
never says whether an email has an account. The invited person follows the
link, or signs in later with the same email, and finds the invitation waiting
on the projects home.

**Decision: project ids are chosen by the client**, so projects can be created
offline. If `create_project` answers "Project unavailable", the id already
belongs to someone else: the client gives its local project a fresh id and
never saves to the refused one.

**Decision: projects live on the device and sync per file.** The browser keeps
every file in IndexedDB with three layers: the server's copy as last seen (id,
path, version, content), the saved copy, and unsaved edits kept only for
recovery. What to send is the difference between the saved copy and the
server's copy, so there is no change log to replay. Files saved together, and a
D2 source with its companions, go in one `save_files` call; everything else
goes file by file, so one stale file never blocks the rest. The batch in
flight is stored with its mutation id before it is sent, so a lost answer is
retried without saving twice. A project's local revision is the highest server
revision this device has fully taken in: a pull reads files changed and
deleted after it, leaves files with local changes alone, and holds the
revision below anything it left, so the next pull looks again. A save that
conflicts marks the file with the server's copy, and the person keeps theirs,
keeps mine, or keeps both. Two known gaps: swapping two files' paths offline
cannot sync (the server takes each path once per save), and a pulled file can
briefly sit under a local file of the same name until the push marks the path
as taken.

Stopped sync keeps a bounded, known-safe validation explanation alongside
its category in the application's project state. The explanation is
best-effort UI metadata in versioned localStorage scoped to the account and
project. It stays outside IndexedDB's legacy flat project row: already-open
older tabs validate that row strictly and must keep saving after another tab
updates. A database version bump would close those tabs' connections without
giving their old code a compatible reopen path. Sidecar updates follow a
successful database commit; unavailable browser storage leaves the category's
fallback message and does not block saved work. Older records keep that
fallback too. Retry clears both before waiting for the
project lock; saved files and newer unsaved drafts stay intact. Running and
queued sync requests have an in-memory progress state, cleared after the
final state reload or a thrown error. The account panel shows Syncing and
disables another manual retry while work is pending. Stopped explanations
come from the refreshed project, and older requests cannot restore stale
transient errors after a newer retry succeeds.

**Decision: a rename or move is one save on the device.** The workbench plans
it from the files on the device: the file moves (a D2 source takes its
generated canvas and sidecar along), and every note, drawing and diagram that
refers to it is rewritten. The moves and rewrites are saved together, so sync
sends them as one `save_files` call and no one ever sees a moved file with
stale references to it. A file with unsaved edits or a sync conflict that the
move would touch stops it until that is settled, and so does a reference the
planner cannot rewrite safely (a document-relative link, or a computed embed).
The move is planned again just before saving, and if anything changed since
the preview the person sees the new preview first. There is no move journal on
the server: the device's save is atomic, and the mutation id covers a lost
answer. The planner is `src/features/workbench/movePlan.ts`.

**Decision: D2 compiles in the browser.** D2 runs in a worker from
`@terrastruct/d2`'s own files, loaded the first time a diagram compiles: its
22 MB `.wasm`, fetched as a file of its own and compiled while it downloads,
and the ELK layout script (`vite-plugins/d2-engine.ts` makes `@terrastruct/d2`
resolve to `src/features/structured/d2Engine.ts` in the app's build). The
package's browser build carries the same two files brotli-compressed as base64
in one 8.2 MB module and unpacks them with a JavaScript decoder on the page's
main thread: the page froze for 0.9 s before the first diagram on a fast
desktop (3.5 s with the main thread slowed 4x), and the first compile took
about 2 s instead of 1.1 s. The cost: the host compresses less than the
package did, so the first diagram downloads about 7.2 MB instead of 6.0 MB
(zstd 3 or brotli 4 against brotli 11), and the offline cache holds 25.8 MB of
engine instead of 8.2 MB. One shared worker serves every compile, through a
queue, because the package's own build answers requests without ids. A diagram is three
files: the `.d2` source, the generated `.excalidraw` canvas that holds freehand
additions and moved shapes, and the `.d2.json` sidecar with the generation
baseline. They save on the device as one change, so a file that changed
elsewhere stops the whole save rather than leaving the source ahead of its
canvas.

(The prototype stored a full snapshot of the whole project as each revision.
That was simple for one person, but it duplicates everything on every save and
makes edits to different files conflict. It is not carried forward.)

**Decision: every saved version records the agent that saved it.**
`file_versions.agent_client_id` is the OAuth client id from the saving
token, null for the app, and, as for comments, readers cannot select it.
`list_file_authors` returns who saved each file's current version and the
agent's name, and the MCP `list_files` tool shows it ("Claude for Ada").

**Decision: Agent changes, per project and per person.** `list_agent_changes`
returns the versions agents saved, newest first and a page of whole saves at
a time (up to 20 saves and 100 changes, or one larger save on its own), each
with the file's previous version and the thread whose reply links it, to
anyone who can read the project. The list has sizes but no contents:
`get_agent_change` returns one change's content and its previous version's
when its diff shows, refusing a pair over 1 MiB ("Too large to show here"),
or only the previous version's for Revert. A D2 diagram's generated canvas
and layout files are left out, as the file tree hides them.
`agent_changes_seen` holds each person's marker (a project revision; only
they read it, and only `mark_agent_changes_seen` moves it, forward, as a
person, never an agent), and `count_agent_changes` counts the changes above
it for the project's button. Opening the view marks everything up to then
seen; a comment's "Changed in version n" opens it at that change, loading
the page that starts there rather than every page before it. Revert saves the previous
version's content as a new version through the app's normal save, and moves
a file the agent moved back to its previous path (a move, with the old text
when the agent changed that too), only over
the agent's version: it waits until this device has that version, stops once
the file changed again, and a change on the server not yet on the device
stops at the usual conflict. The view is
a chunk of its own; the button and its count are not.

**Decision:** agents archive, people delete. Archive and unarchive are available
to any editor, including agents. Permanent delete is for the project owner
only, in a normal user session: the database refuses it when the token came
from an OAuth client (the JWT carries a `client_id` claim). Deleting a project
leaves a row in `deleted_projects` for each person who had accepted it (kept
90 days, readable only by them), so their devices say the owner deleted it,
offer a .zip of their unsaved changes, and remove it.

Account settings are for people. The database refuses a password change
made by an OAuth session: a deferred trigger on `auth.users`
(`supabase/schemas/auth_guards.sql`) checks at commit whether only OAuth
sessions are left. People, the admin API and recovery links still change
passwords. TOTP is off in `config.toml`, since the app has no MFA screens.

**Decision: change signals use Realtime Broadcast from the database.** Clients
learn that a project changed from a private Broadcast channel per project,
authorized by RLS on `realtime.messages`, which is Supabase's recommended
approach. Postgres Changes is not used: it delivers DELETE events to every
subscriber regardless of RLS. When a project's revision goes up, a trigger
sends `{ "revision": n }` as the event `changed` on `project:<id>`. Anyone who
can read the project may receive it, and no client may send. Devices then
fetch the changes through reads that check access every time.

The signal carries nothing else because a channel's access is checked when a
client joins it and again when the client sends a refreshed token, not for
each message. The app keeps that window short itself: removing a member raises
the revision, so the signal makes their open page sync, and when the server no
longer lists the project for them, the sync stops and the page leaves the
channel (`src/features/projects/ProjectPage.tsx`). A client that stays joined
anyway receives only revision numbers, and only until its session's token is
refreshed or expires, within `jwt_expiry` (one hour).

## Image assets

**Decision:** images are binary project files backed by immutable private
Storage objects. Current files, history and local copies carry a verified
asset snapshot; text files retain their existing representation. Notes use
ordinary relative Markdown image paths in both formats. The trusted parent
supplies bounded bytes without changing `img-src data:` or exposing tokens.

The `project-images` bucket stores originals and separate raster thumbnails.
Reservations precede upload and the existing revision-checked `save_files`
batch commits ready references atomically with note changes. Historical
lookup resolves image paths at a saved project revision. Cleanup uses a
durable queue and Storage API deletion, preserving committed history until
a person permanently deletes its project or owning account.

Originals are at most 5 MiB and 8 million pixels. A 25 MP Photon decode exceeded
the Edge memory budget in the runtime proof. Photon WASM decodes raster
formats; resvg WASM generates bounded SVG thumbnails. Previews are at most
480 pixels and 32 KiB. GIF/APNG/WebP animation is capped at 120 frames and
24 million total frame pixels. SVG has structural and complexity validation;
it never becomes document HTML. Its server thumbnails embed the existing OFL
Space Grotesk Latin font as a deterministic text fallback, without system
fonts or network reads; the original SVG retains its own typography.
The font is a statically imported, generated TypeScript module. The pinned
CLI's API deploy collector skips dynamic imports with import attributes,
which can make a JSON font work locally but disappear from a deployed bundle
([CLI 2.118 source](https://github.com/supabase/cli/blob/v2.118.0/apps/cli/src/shared/functions/deploy.ts#L65-L66)).
CI captures the real CLI's multipart source upload against a refusing
loopback API and checks that images and MCP include the exact font module.
Renderable text is capped at 4,000 UTF-16 characters per text node and 8,000
overall, including expanded references, before font layout. Separate XML
text limits remain 16,000 per node and 100,000 overall.
Retained and reserved bytes charge the
project owner, capped at 256 MiB across projects, with atomic transfer checks.

The image release refreshes the bundle baselines after measuring first paint.
The project page grows from 321.9 to about 339 kB gzip for binary asset
metadata, durable drafts, upload recovery and sync. Image viewers, comparisons,
pickers and decoders load on demand; no heavy library enters first paint.
The recorded budgets retain the standard five percent margin.

Crop and resize create new PNG copies and retain originals. Captions use
portable figure syntax with inline Markdown. Description generation belongs
to the person's MCP client, only on request: `get_image_preview` supplies a
bounded raster as standard MCP image content, and the client's own model
proposes alt text. Saving it uses the existing revision-checked note edits.
This feature has no app-owned model connection, inference endpoint or
separate OpenAI approval requirement. The image picker accepts manual alt
text and an explicit Decorative choice.
URL import is explicit, pins a public HTTPS connection at each redirect and
stores a project copy. Document rendering never starts a remote import.

[Image support](images.md) records contracts, limits and runtime evidence.
[T43 through T50](tasks.md#t43-prove-the-image-asset-contract-and-validation)
track implementation and verification.

## Search

**Decision:** hybrid search, following Supabase's documented pattern. The
schema is `supabase/schemas/search.sql`.

- **Passages, not whole files.** Each note is split into passages by heading,
  each D2 diagram into blocks, and each drawing (`.excalidraw`, or Obsidian's
  `.excalidraw.md`) into the text of its text elements in reading order, by
  `supabase/functions/_shared/passages.ts`. A drawing's text sits inside JSON,
  so its passages' offsets span the whole file.
  The built-in embedding model (`gte-small`) reads English only and truncates at
  512 tokens, so passages stop at 1,500 characters. They live in
  `public.file_passages` with their headings and their offsets in the file.
- **Keyword half:** a generated `tsvector` column (English) over the headings
  and text, with a GIN index.
- **Semantic half:** a `vector(384)` column (gte-small, normalized, inner
  product) with an HNSW index. `hybrid_search` turns on pgvector's iterative
  index scans, so when RLS filters out the nearest passages (other people's),
  the scan keeps going instead of coming back short.
- **Fusion:** the documented `hybrid_search` SQL function, Reciprocal Rank
  Fusion over both result lists, up to 30 passages with their file paths. It
  runs as the caller, so RLS limits results to projects the user can read:
  their own and those shared with them. The join to the file for its path is a
  second RLS check. Given a project, both halves search only that project
  before they are cut to size, so the files panel's search finds a project's
  matches however many other projects the person has.
- **Automatic embeddings:** Supabase's documented pattern. A trigger on
  `project_files` queues a note, diagram or drawing in the `file_passages` pgmq
  queue when it is saved or renamed. A pg_cron job every 10 seconds sends batches to
  the `embed` Edge Function, which reads each file through a direct database
  connection, embeds its passages, and in one transaction replaces the file's
  passages and deletes the job. If the file changed after it was read, it writes
  nothing, because a newer job is already queued. Jobs that fail come back when
  their visibility timeout ends, so they retry. Each new embedding is kept as
  soon as it is made (`private.passage_embeddings`, cleared when the passages
  are written), and a passage whose input the file already has an embedding
  for, in its current passages or kept, is not embedded again. So an edit
  embeds only the passages it changed, and a long file that needs more than
  one request's 2 s of CPU finishes over several tries instead of starting over.
  When the runtime is about to stop a request (`beforeunload`, reason "cpu"),
  the request starts no more embeddings, and if it kept a new one it makes its
  unfinished jobs visible again after 2 seconds (`pgmq.set_vt`), so the next
  try comes within seconds. A stop that kept nothing new, a job that failed on
  its own, a worker killed outright at the hard CPU limit and a failed
  `set_vt` all leave jobs to the 5-minute visibility timeout.
- **Embedding model:** Supabase's built-in `gte-small`, run inside Edge
  Functions with no API key and no extra cost, on any Supabase Cloud project.
- **Function auth:** `embed` is called by the database, not a user, so it sets
  `verify_jwt = false` and accepts only a secret API key on `apikey`
  (`withSupabase({ auth: 'secret:*' })`, the documented pattern for
  cron-called functions, accepting any of the project's secret keys so the
  database gets its own). The cron job reads the key and the project URL from
  Vault.
- **Query embedding:** the `search` Edge Function (and the MCP `search` tool)
  embeds the query with the same model and calls `hybrid_search` as the user.
- **Turning it on for a project:** create a secret API key for the database
  and store it as the `EMBED_SECRET_KEY` repository secret. The deploy workflow
  deploys `embed` and `search`, and `db push` writes the key and the project's
  API URL to Vault (`[db.vault]` in `config.toml`). Until then, saved files
  wait in the queue and nothing is sent.

## Comments

**Decision:** comments use the W3C Web Annotation model and the anchoring
approach Hypothesis uses, rather than anything custom.

- A text comment stores a text-quote selector (the exact text plus some context
  before and after) and a text-position selector, against the file version it
  was made on. Positions are UTF-16 offsets, matching editor offsets, where the
  W3C model counts code points.
- On read, it is re-anchored with approximate string matching
  (`approx-string-match`, the library Hypothesis uses), scoring candidates by
  quote, context and closeness to the stored position. Unlike Hypothesis, a
  match that is not exact must keep 80% of the quote, or 80% of the stored
  context must still match around it, so a deleted quote detaches rather than
  moving onto text that looks a little like it.
- A section comment quotes its heading line. A document comment has no selector.
- A drawing comment uses the Excalidraw element ID, which is stable.
- A comment that can no longer be found is shown as detached, at document
  level, with its original quote. Nothing is ever written into the source.

**Decision: the database and agent side** (`supabase/schemas/comments.sql`,
`src/features/comments/`, the MCP comment tools). The editor's comment panel
(`src/features/comments/ui/`) shows a file's threads beside a note, drawing or
diagram, with pins on the canvas for drawing and diagram elements. A comment
longer than 12 lines shows folded, with Show more.

- **Two tables.** `comment_threads` holds a thread's anchor, its file and
  whether it is resolved; `comments` holds the opening comment and every
  reply. The client chooses thread and reply ids, so sending one again returns
  what the first send made instead of posting twice. A thread sent again after
  it was deleted answers that it was deleted, and does not come back.
- **Anchors** are stored in the app's shape (`placement.ts`), and readers
  never rewrite them; "detached" is worked out by each reader, never stored.
  A person moves one with `move_comment_anchor` (Attach to text, on a detached
  thread): the thread's creator, an editor or the owner, never an agent, with
  the anchor checked as `add_comment` checks it, against the version selected in.
  - `{ kind: "document" }`: the whole file. Any file.
  - `{ kind: "text", quote, position }`: a selection in the source, as
    `describeRange` describes it, at most 5,000 characters. Any text file
    except drawings.
  - `{ kind: "section", quote, position }`: a note's heading line (for a
    setext heading, its text line). It stays attached only while the match
    still starts a heading line, so a heading turned into prose never latches
    onto nearby text.
  - `{ kind: "element", element_id, label, point? }`: an element of a drawing.
    `label` (its text, the text bound to it, or its type, at most 200
    characters) is what shows once it is gone; `point` is a spot on it, as
    fractions of its width and height. A D2 diagram's element comments are on
    its generated `.excalidraw` canvas.
- **Threads hang off the file id, not the path.** A rename or move keeps the
  id, so its threads follow it. There is no foreign key to the file: deleting
  a file (any editor or agent can, and history can undo it) keeps its threads,
  listed under its last path as `file_deleted`; they still take replies and
  resolves, but a deleted file takes no new threads. A new file at the old path
  has a new id and none of them.
- **Who may do what.** Viewers read comments; commenters, editors and the owner
  write them. Anyone who can comment resolves or reopens any thread. Only a
  comment's author edits it (no history is kept; `edited_at` shows it). The
  author or the owner deletes a comment; the owner deletes any thread, and a
  thread's creator deletes it while every live comment in it is theirs. Every
  write needs comment access at the time, and an archived project refuses
  them all (55000) while still listing. Reads are `list_comments`, which
  returns each author's email and name the way `list_members` does, and RLS
  on `readable_project_ids()`.
- **Names.** A person is named by the name they set in Settings (Auth user
  metadata `display_name`, written with `updateUser` from their own
  session), else the one their sign-in provider gave (`full_name`, then
  `name`), else their email: `private.person_name`, trimmed and cut to 80
  characters, since metadata is the person's own to change. Comments and
  `list_members` return it, and agents read it too.
- **Agents read, add, reply, resolve and reopen, and never edit or delete a
  comment**, their user's own included: both remove someone's words for good
  (an edit keeps no history, and would show the agent's words as the
  person's), and only a person does that. The database refuses edits and both
  deletes from an OAuth-client session. A comment an agent wrote records its
  OAuth client id from the token; reads show `via_agent` and the agent's name
  (`agent`, the OAuth client's name as Connected agents shows it, read by
  `private.agent_name`), and readers cannot select the client id column. The
  app and the MCP tools name such a comment for the agent and its person
  ("Claude for Ada").
- **Ask an agent.** A thread's creator can ask their own agents to deal with
  it: the switch in the new comment's composer, or beside Reply on their open
  thread (`set_comment_ask_agent`, and `ask_agent` on `add_comment`). Only the
  creator, and only as a person, turns it on or off; everyone else sees a
  badge. `comment_threads.ask_agent_revision` records the project revision at
  which they last asked: when they turned it on, and again whenever they
  reply to it or reopen it as a person. `list_comments` with `ask_agent`
  returns only the caller's own open asked threads, and with `since` (a
  revision it returned before) only those asked after it, so one person's
  request never reaches another person's agent. The agent changes the file
  and replies with `reply_comment`'s `file_version`, a saved version of the
  thread's file, which the reply shows as "Changed in version n"; the person
  resolves the thread.
  The MCP `list_comments` tool and the plugin's comment-loop skill describe
  that loop.
- **Deleting leaves a placeholder.** A deleted comment keeps its row, author
  and time, without its body, while its thread has live comments, so replies
  keep their context. When the last live comment goes, the thread goes too.
  A deleted account's comments stay, with no author.
- **Signals.** Every comment write that changes something raises the project
  revision, so the existing change signal announces it on `project:<id>` and
  open projects reload their comments with no new Realtime code. The signal
  carries nothing about the comment. Each write returns the new revision, so
  the writer marks it as seen.
- **Comments need a connection.** Nothing is queued or kept on the device, as
  with search: a queued comment could land in a thread resolved or deleted
  meanwhile. The app shows the last list it loaded in this session, and none
  after a reload while offline. The no-account local project, a project not
  yet created on the server and a file not yet synced have no comments.
- **One anchoring code for the app and the MCP server.** `anchoring.ts` and
  `placement.ts` are copied into `supabase/functions/_shared/comments/`, since
  the functions deploy without building the app; `sharedCopies.test.ts` fails
  when a copy drifts.

## Accounts

**Decision:** Supabase Auth with these sign-in methods, configured in
`config.toml` wherever the CLI supports it.

- **Email:** password, magic link and one-time code. Production needs custom
  SMTP; Supabase's built-in sender is for testing only. The magic link email
  (`supabase/templates/magic_link.html`) carries the code as well, and the
  sign-in page accepts either. A password needs 10 characters, with letters
  and digits (Auth's rules in `config.toml`; the forms say so). Sign-up
  confirms the email with a link or code that signs in. A forgotten password
  gets a reset link that signs in on a page that sets a new one. Settings >
  Account sets or changes a password; from a session older than a day, Auth
  first emails a code (`secure_password_change`). After any change, Auth
  emails the account to say so
  (`supabase/templates/password_changed_notification.html`).
- **Social:** GitHub and Google, declared in `config.toml` and off. Turning one
  on takes an OAuth app at the provider (callback
  `https://<project-ref>.supabase.co/auth/v1/callback`), its client id and
  secret in `SUPABASE_AUTH_EXTERNAL_<PROVIDER>_CLIENT_ID` and `_SECRET` for
  `config push`, and `enabled = true`. The sign-in page reads Auth's public
  settings and shows a button only for providers that are on.
- **Passkeys:** Supabase's passkey sign-in (experimental; the API may change,
  and the client opts in). A person signs up another way first, then adds a
  passkey in Settings, where they can also remove one; "Sign in with a
  passkey" needs no email. Both show only while Auth reports passkeys on.
  `[auth.webauthn]` names `elaborat.ing` as the relying party; changing it
  makes every existing passkey stop working.
- **Phone codes:** only with an SMS provider, rate limits and CAPTCHA, because
  SMS costs money per message and attracts abuse.
- **CAPTCHA:** planned and off. The plan is Cloudflare Turnstile on sign-up,
  sign-in and password reset; nothing turns it on yet (`[auth.captcha]` in
  `config.toml` is commented out, and the sign-in pages send no CAPTCHA
  token). Phone codes wait for it.
- **Not possible today:** signing in to elaborat.ing with ChatGPT. "Sign in
  with ChatGPT" on a website is a limited trial OpenAI opens to selected
  partners, with an issued client; once elaborat.ing has one, it can be added
  as a custom OIDC provider. Using a person's ChatGPT plan is separate, and
  works on a local run today (see [the assistant](#the-assistant-chatgpt-plan)).
  There is no "Sign in with Claude"; Anthropic doesn't allow apps to offer
  Claude.ai login. None of this affects agents: Claude and ChatGPT connect
  through the OAuth server below, where elaborat.ing is the one issuing access.

**Decision:** the sign-in, sign-up, password reset and OAuth consent pages
are the Supabase UI Library's React blocks, installed with the shadcn CLI, plus
a small form for emailed sign-in links. A page that needs a signed-in person
sends them to `/sign-in?next=<path>` and they come back to it, including from
an emailed link, which is why Auth's redirect list allows any path on the site.

**Decision: signing out keeps work on the device.** Projects on the device
belong to one backend and account, so signing out hides them without deleting
anything, and signing back in finds them. Before signing out, every registered
guard runs (such as keeping unsaved edits), and any guard can refuse. The
device remembers the last account signed in, so its projects can open offline;
this marker selects local data only and is never a credential. Someone signed
in stays signed in while the Auth server cannot be reached.

**Decision: a person deletes their own account with one Edge Function.**
Settings > Account first shows what happens, from `account_deletion_summary`
(read as the person): the projects they own, each with how many people have
accepted it, and how many shared projects they would leave. They type their
email to confirm. The `delete-account` function refuses agents' tokens and
tokens from a session that has signed out (it asks Auth whether the session
is still live), checks the typed email against the account's (read with its
service key), then, as
the person, calls `begin_account_deletion` (which refuses OAuth sessions too
and counts the daily limit) and `delete_project` for each project they own,
so those go for everyone through the same path as the project page. Only then
does it delete the account with Auth's admin API, which ends its sessions and
agent connections; the foreign keys remove its memberships and counters and
leave its comments, file versions and threads with no author ("Deleted
account"). A failure part way keeps the account, and trying again carries on.
Each owned project someone has accepted offers "Transfer first", which hands
it to one of them (`transfer_project`, above) so it is kept, and the page
points to Download project for keeping a copy.
The app runs the sign-out guards first (a refusal offers "Delete anyway"),
then removes this device's copies of the account's projects and drafts, and
signs out. `supabase/schemas/account_deletion.sql`,
`supabase/functions/delete-account/`, `src/features/settings/`.

**Decision: without an account, one local project.** "Start writing" opens a
project kept in its own partition (`local`) of the same on-device store, at a
fixed id, that never syncs; what needs an account is shown locked. After
sign-in, the home page moves it, if it has files, into the account's partition
as a new, not yet created project named "Local project" and opens it, so the
usual sync (`create_project`, then `save_files`) uploads it. The move runs once
under a cross-tab lock; `src/features/project-storage/localProject.ts`.

**Decision:** hosted limits are generous and exist only to stop abuse. See
Limits below.

## Limits

**Decision:** per-user limits that normal use never reaches but that stop a
runaway script or agent, enforced in the database so the app, the MCP server
and direct API calls all get them. `supabase/schemas/limits.sql` holds the
numbers (`private.limits()`) and one counter mechanism:
`private.count_use(user, name, limit, window, wording)` counts one use in a
fixed window (a minute, or a UTC day) in `private.limit_counters`, one row per
user and limit. Its upsert locks that row until the transaction ends, so
concurrent uses by one person are counted one after another and never slip
past the limit together, and a refused use rolls back and does not count.
`private.check_limit(name)` counts a limit from the list for the signed-in
caller. A new limit is one row in `private.limits()` and one
`check_limit` call in the function that does the work.

Every refusal is errcode `PT429`, which the Data API answers as HTTP 429, with
a plain message that says which limit was reached and when it resets ("You
have reached the limit of 300 saves a minute. Try again in 42 seconds.") and
the limit's name as the detail. The app's sync keeps the refused batch, with
its mutation id, shows the message and sends it again on the next sync; the
files panel's search shows it; the MCP server returns it to the agent as is.

| Limit | Number | Where it is counted |
| --- | --- | --- |
| New projects | 100 a day | `create_project`, only when it creates one (a repeated call does not count) |
| Projects owned, archived included | 1,000 | `create_project`; permanently deleting one makes room |
| Saves | 300 a minute | `save_files` (every call, retries included; the app's save, every MCP write tool) |
| Searches | 120 a minute | `hybrid_search` (the `search` function, which answers 429, and the MCP `search` tool) |
| Agent tool calls | 300 a minute | the MCP server calls `count_tool_call()` before every tool runs |
| Invitations by email | 50 a day | `prepare_email_invitation`, which the `share` function calls for every invitation, for the owner |
| Comment changes | 120 a minute | every comment write: new threads, replies, edits, resolves, reopens and deletes (retries included) |
| Account deletion attempts | 5 a day | `begin_account_deletion`, which the `delete-account` function calls once the typed email matches |
| Event subscriptions | 20 live a person | `save_event_subscription`; each `events/subscribe` also counts as an agent tool call |

Limits that were there already, kept as they are:

- **Per project** (`save_files`, errcode `54000`; the app stops syncing the
  batch, since sending it again cannot succeed): at most 4,096 files and 4,096
  folders, and 64 MiB of file content (`projects.content_bytes`).
- **Per file:** at most 2 MiB of content (a check constraint). Paths are 1 to
  1,024 bytes; project titles 1 to 160 characters.
- **Per save:** 1 to 4,096 changes (`save_files`). The app's import saves at
  most 500 files and 8 MiB at a time.
- **Per search:** a query of 1 to 500 characters and at most 30 passages.
- **Comments** (errcode `54000` for the caps): at most 1,000 threads a file
  and 10,000 comments a project, resolved threads, deleted files' threads and
  placeholders included. A comment is 1 to 100,000 characters, a quoted
  selection at most 5,000, with 32 characters of context on each side, and an
  element's label at most 200.
- **Per API read:** at most 1,000 rows (`max_rows` in `config.toml`).
- **MCP Apps card:** 8 drawings per note, 110,000 characters of SVG each and
  120,000 characters of `_meta` per result, 3,000 elements per scene.
- **Auth** (`[auth.rate_limit]` in `config.toml`): 30 emails an hour for the
  project; per IP address, 30 sign-ups and sign-ins, 30 code and link checks
  and 150 session refreshes every 5 minutes. A person can ask for another
  confirmation or reset email after 60 seconds. SMS limits apply once phone
  codes are on.

## Agents (MCP)

**Decision:** the `mcp-server` Edge Function is Supabase's MCP Server block
(`supabase/functions/mcp-server/`), protected by Supabase Auth's OAuth 2.1
server (`[auth.oauth_server]` in `config.toml`). The consent page uses
Supabase's React OAuth consent block. Each tool gets a Supabase client scoped
to the user, so RLS applies, and calls the same database functions the app
uses. Tools live in `tools/projects.ts`; the server is named and described as
elaborat.ing unless the `MCP_SERVER_NAME` and `MCP_SERVER_DESCRIPTION`
function secrets say otherwise.

**Temporary: a host capability probe, removed after testing.** A separate
MCP server (`supabase/functions/mcp-probe/`, at `/mcp-probe` through the
Worker) with no sign-in and no data: one tool, `probe_host`, with global and
thread entrypoints, whose view reports what a chat host allows, and one MCP
Events event, `comment.created`, whose subscribe verifies the callback with
the signed challenge and sends one sample event. Each step writes one JSON log
line. The view declares the panel's widget domain (`openai/widgetDomain`
`https://elaborat.ing`) and shows its own origin at the top, to check whether
another server claiming that domain gets the panel's origin (a page on the
view's own origin can drive a live view and take its passes, whatever
`frame-ancestors` says; Frontend hosting). `/embed-probe`
reports its ancestors, storage, service worker and session, and offers
sign-in with an emailed code. Its framing test is done: like every other page
it now sends `X-Frame-Options: DENY`, and it posts nothing to other windows.
The production server's tools are unchanged.

- **Tools mirror the app's operations:** list projects and invitations, list
  and read files, write one file or a batch with the expected versions, move,
  delete (history keeps the content), create projects and folders, rename,
  archive and unarchive, share, and leave. There is no tool to
  permanently delete a project or accept an invitation; the database refuses
  both for agents anyway. Search is added with hybrid search.
- **Every tool states its three hints** (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`), as a plugin directory requires. A tool that changes or
  removes anything (a file, a title, a thread's state, who has access) is
  destructive, even when history or another tool can undo it; only tools that
  just add (a project, a folder, a comment, a reply) are not. No tool reaches
  past the person's own account, so `openWorldHint` is always false.
  `tools/annotations.test.ts` holds the list and fails for a tool without
  all three.
- **`whoami` is the account's profile** (`_meta["openai/profile"]`), which
  ChatGPT reads to tell connected accounts apart: exactly `id` (the account's
  id), and `name` and `email` where the account has them, as structured
  content and JSON text. A local change to the block's tool, which returned
  the role and the OAuth client id too.
- **Comment tools** (`tools/comments.ts`): `list_comments` (counts per file,
  or one file's threads found again in the saved file), `add_comment` (on a
  quote copied from the source, a note's heading, a drawing element, or the
  whole file; the tool turns that into the app's anchor), `reply_comment` and
  `resolve_comment` (which also reopens). There are no tools to edit or delete
  a comment, and the database refuses agents' deletes anyway.
- **Decision: MCP Events, so an agent can watch instead of polling**
  (`mcp-server/events.ts`, `supabase/schemas/events.sql`,
  `supabase/functions/send-events/`). The server declares `events` in its
  capabilities and answers `events/list`, `events/subscribe` and
  `events/unsubscribe` on the same signed-in endpoint as the tools, as
  custom handlers on the SDK's `Server`; the tool list is unchanged. One
  event, `comment.created`, takes a `project_id` and an optional `path` and
  sends the thread's ids, its file's path and link, a quote of what it is on
  (200 characters) and the start of the comment (500), well under the 256 KiB
  limit; the agent reads the rest with its tools.
  - **Who gets what.** A subscription belongs to the person and the agent
    (OAuth client) that made it; a person's own session cannot subscribe. A
    comment wakes only its author's own agents, and only when the author
    asked: their new thread with Ask an agent on, or their own reply, as a
    person, on their own open thread that has it on (the rule of
    `list_comments` with `ask_agent`). Another person's comment never
    matches, and a comment an agent wrote never does, so an agent's reply
    cannot wake anything. Turning Ask an agent on for an existing open
    thread asks too, and so does its creator reopening it, as a person,
    while it is on: neither writes a comment, so the event carries the
    author's latest comment on the thread written as a person. Anyone else
    reopening it, their agents included, sends nothing, and neither does
    turning it off.
  - **Subscribing.** The server checks the event, its arguments and the
    `whsec_` secret (24 to 64 bytes), checks the callback URL, then asks the
    database whether the person can read the project, the file exists and
    they have room (20 live subscriptions a person). It sends the signed
    verification challenge and needs the challenge echoed in a 2xx answer
    (else JSON-RPC `-32015` with a reason), unless this agent verified the
    same callback in the last 10 minutes; at most two challenges run at once
    per function instance, and each subscribe counts as an agent tool call.
    Only then is it saved, by service-only functions that check it all again
    (a local change to the block's server: it calls them with the
    service role client). The id is a hash of the person, the agent, the
    callback, the event and its arguments (canonical JSON), so subscribing
    again refreshes the same one. A watched file is found by its path only
    the first time and kept by its id, so a refresh after a rename still
    works and stays on that file. It lives what the agent asked (`ttlMs`),
    at least 10 minutes and at most 7 days, and 7 days when it asked for no
    expiry; `refreshBefore` is that time. A new secret on refresh replaces the
    old one, which is still signed with for 15 minutes. Events have no
    replay: `cursor` is always null.
  - **Storage.** `event_subscriptions` under RLS: people and their agents
    select their own, without the callback or secrets; nobody writes it
    through the API. Signing secrets are in Vault and leave it with their
    subscription. Expired subscriptions are removed by the sweep below.
  - **Delivery.** Triggers on `comments` and on `comment_threads` (Ask an
    agent turned on) queue one message per matching live subscription in the
    `comment_events` pgmq queue and, only when they queued one, wake
    `send-events` with pg_net (with the database's secret
    key from Vault, as `embed` is called). The function checks each event
    again (`private.comment_event_delivery`: the subscription is live, the
    agent is still connected, the person can still read the project, the
    comment still matches) and drops it otherwise, removing a subscription
    whose person lost the project or disconnected the agent. It signs the
    body once with Standard Webhooks (`webhook-id` is the event id) and
    posts it with `X-MCP-Subscription-Id`. A failure is tried again with the
    same event id and a fresh signature after 1, 5, 30 and 120 minutes; after
    the fifth attempt the event is dropped and the subscription gets nothing
    more until its agent subscribes again. 410 ends the subscription and 413
    drops the event, neither retried. A pg_cron job once a minute wakes the
    function only when a retry is due, so on the Free plan the function runs
    only when there is something to send.
  - **The sender** (`_shared/callbacks.ts`) posts only to `https` on port
    443, to a host name (never an IP address, a local name, elaborat.ing or
    this Supabase project). On every delivery and challenge it resolves the
    name and refuses it if any address is not public (IPv4 outside the
    special-purpose ranges; IPv6 only in global unicast), then connects to
    the checked address itself with `Deno.connect` and `Deno.startTls` for
    the host name, since `fetch` cannot pin an address. One HTTP/1.1 POST,
    no redirects (a 3xx is a failure), one 10 second deadline for the whole
    exchange, at most 64 KiB of the answer read, and only a failed connection
    moves on to the next address.
  - **Kill switch.** The `MCP_EVENTS_CALLBACK_HOSTS` function secret, when
    set, is the list of callback hosts allowed (comma-separated; `*.` covers
    subdomains); `none` stops every challenge and delivery.
  - **Tests.** pgTAP for who sees and changes subscriptions, the matching
    rule and what delivery checks again (`events.test.sql`); Deno tests for
    the sender, the events methods and delivery with a fake receiver that
    checks signatures with the Standard Webhooks library.
- **MCP Apps:** views inside the client: a rendered document with its
  drawings, a single drawing, or a draft component preview, each with a link
  into the app. The `show_file` tool (`tools/fileView.ts`), the
  `preview_component` tool (`tools/componentPreview.ts`), `create_and_show`
  and `update_and_show` (below) share one `ui://` view. `show_file` renders a note's Markdown (raw HTML
  and other MDX shown as text, except a `<Callout>` written as one block,
  which becomes a callout; sanitized) and draws drawings and diagrams, shown on
  their own or embedded in a note with `<Drawing>` and `<Diagram>`, each with an
  "Open in elaborat.ing" link; an MDX note with other components is then
  previewed with them (below). The server draws them as SVG from the saved
  scene (a diagram from its `.excalidraw` companion) with roughjs, the library
  Excalidraw uses (`tools/drawingSvg.ts`), and sends the SVG in the result's
  `_meta`, which reaches the view but not the model. A diagram the app has not
  drawn from its source yet is drawn by the card (below). Limits: 8 different
  files drawn per note, 110,000 characters of SVG each, and 120,000
  characters of `_meta` per result, as JSON: the note's HTML (of its first
  20,000 characters), its source and its component files, then the SVG, then
  what the card draws a diagram from in what that leaves. A note whose HTML,
  source and component files would pass that goes without its component
  files: the card shows the server's HTML, which then starts with a callout
  that says why. Where code
  execution is on, Claude keeps a result of more than about 150,000
  characters as a file, and the view then gets no result to show (its MCP
  Apps troubleshooting page). A drawing or diagram that does not fit in what
  is left, but would in a result of its own, is `deferred`: the card loads
  each with `card_embed`, one at a time, where the host lets it call tools,
  and draws it where its link was. `card_embed` is the view's own tool
  (`ui.visibility: ["app"]`), so the model never reads its result: it reads
  and draws one drawing or diagram as `show_file` does shown on its own, as
  the user and with the same limits and errors, and sends its SVG, or what
  the card draws a diagram from, in `structuredContent`, since a host may
  leave `_meta` out of the result of a call the view makes. A call that
  fails, or that the host has not answered in 20 s, leaves the link, and
  once the host has not answered one, the rest leave theirs at once. 3,000
  elements per scene. The view is on its own tool, not on `read_file`, so
  agents can read files without filling the chat with views.
- **Decision: the card draws a D2 diagram the app has not drawn from its
  source yet.** A diagram's canvas is saved by the app when someone opens it,
  so a new diagram has none (`not_drawn`), and one whose source changed since
  is out of date (`stale`). For each such diagram, `show_file` (and so
  `create_and_show` and `update_and_show`) sends its source, with the canvas
  and layout record the app saved if it did, in `_meta["elaborat.ing/d2"]`,
  only for those diagrams and only in what the 120,000 characters leave once
  the SVG is in. The card (`src/chat-card/cardDiagrams.ts`) then loads its
  `diagram` module, which lays the diagram out with the app's own code, as the
  app does when it opens it (`compileD2Diagram` and `projectDiagramArtifact`,
  so shapes moved by hand and drawings added on the canvas stay), and draws
  the scene with the server's `drawingSvg`, as the server draws the canvas the
  app saves: the same hand-drawn picture in the chat and in the app. It never
  saves. D2's engine runs in a worker the card starts from a `blob:` URL, from
  two classic scripts on elaborat.ing (`importScripts`): the package's own
  files (Go's `wasm_exec.js`, ELK and its setup, run as the package runs them)
  with the 22 MB wasm brotli-compressed at quality 11 as base64, and the
  worker's code, which unpacks it with brotli.js and compiles it there, off
  the card's page; it answers the same compile requests as the app's worker
  (`d2EngineClient.ts`, `d2EngineServe.ts`). The first diagram in a chat
  downloads about 6 MB (cached after that), only when a card has a diagram to
  draw, or as a `.d2` file is written live, so the engine is ready when the
  result comes, and the drawing then takes the source's place (the live card
  waits for it up to 4 s, its footer saying the diagram is being laid out).
  The worker holds about 165 MB of the page's memory once the engine runs,
  and a phone's host can kill a page that takes too much (two cards' engines
  took about 1 GB in WebKit), so the card stops it once it has had nothing to
  lay out for 10 s, while a `.d2` being written keeps it running; a later
  diagram starts it again and is drawn in about 1.8 s instead of 0.2 s
  (WebKit as an iPhone).
  **The view's CSP is unchanged:** everything comes
  as scripts from the origin it already declares for them (`resourceDomains`,
  no connect or frame domains), since a fetch of the wasm (the app's way since
  it got its own file) would need `connect-src`. D2's engine is WebAssembly,
  and it runs ELK's JavaScript from strings, so the card draws diagrams where
  the host's policy allows blob: workers, WebAssembly and code from strings,
  as ChatGPT's view does; where it does not (Claude's view is untested), or
  the engine does not load or a source does not compile, the card shows the
  diagram as the server sent it: a new one says to open it in elaborat.ing,
  and one out of date shows its last drawing with a line that says so. The
  card then tells the model, once for each such diagram, with
  `ui/update-model-context`: for a source that does not compile, D2's errors
  and to fix it with `update_and_show`; where the engine does not run (a
  diagram that surely lays out fails too), that the chat does not let the
  card run D2's engine, what the user sees instead, and that it can offer to
  make it as an Excalidraw drawing with `create_and_show`. A host keeps only
  the latest context a view gives it, so the card keeps one context with all
  it has to tell the model (a save made in it, a component preview that
  failed, each diagram it could not draw), the latest on each, and sends all
  of it each time (`tellModel` in `src/chat-card/bridge.ts`).
- **Notes are edited in the card.** Where the host lets views call tools, a
  note's card has Edit: it runs the app's own rendered editor
  (`FluidEditor` and `prepareFluidTransaction`, so each edit is an exact
  source patch and every other byte stays), with embeds and other MDX as
  islands that cannot be edited. The note's source reaches the view in the
  result's `_meta`. Save calls `write_file` through the bridge with the
  version the card showed, so a note changed since is a conflict, never
  overwritten; the card then reloads with `show_file` and tells the model
  with `ui/update-model-context`. Edit asks the host to show the card full
  screen where it offers that (`ui/request-display-mode`, or ChatGPT's
  `window.openai.requestDisplayMode`); the card offers inline and full
  screen, and asks to go back inline when editing ends.
- **Decision: a new file is shown as it is written.** `create_and_show`
  (`tools/fileView.ts`) creates a new note, drawing or diagram and returns
  show_file's result. It saves with no version, which the database refuses
  where a file exists, so it only adds and is not destructive; any other
  file type is refused. It carries the card, so while the agent is still
  writing the call the host can send the card the input so far
  (`ui/notifications/tool-input-partial`; Claude does, ChatGPT's docs do not
  mention it), at most one a frame. The card goes live and loads its `live`
  module, which reads the content as it comes, with the server's own
  renderers (`drawElement` and `renderNote`, imported from the function's
  files; the card build resolves their `npm:` imports to the app's packages
  and stops if package.json pins another version): a drawing's elements
  drawn in one after another, each line along its length, hachure scribbled
  in, solid fills faded in and text written left to right, in a fixed-height
  view that eases out to hold them; a note rendered at most ten times a
  second, new blocks fading in under a caret; a diagram's D2 source as text,
  whose drawing takes its place once the result comes (above).
  When the result comes, what is left draws within 400 ms and the saved
  card takes its place; an error leaves nothing of the unsaved file, only
  the problem. A host that sends no partial input gets the same drawing in
  from the final input within 1.2 s, only while the tool runs: an input
  that comes with its result (a conversation opened again) shows the saved
  card at once. Where the module does not load, the card shows its
  skeleton; with reduced motion nothing animates. `write_file` and
  `save_files` keep no view, so ordinary saves stay plain, and the app and
  the panel update when the save lands, as for any save.
- **Decision: a drawing grows in small saves the person can watch
  (`draw`).** Nothing can show while a model writes one tool call, and
  ChatGPT sends no partial input, so a drawing written in one `write_file`
  appears all at once. `draw` (`tools/draw.ts`) adds 1 to 50 elements to a
  `.excalidraw` drawing, the labels it makes included, creating it if there
  is none, and saves through `save_files` with the version it read, as
  `write_file` does. Each call costs a model about 5 to 8 s however many
  elements it adds, and the canvas sketches each new element in turn, so the
  server's instructions, the tool's description, the panel's model context
  and the drawings skill tell agents to add several shapes per call, a row
  or a group of related shapes with their arrows, about 4 to 10 elements,
  and not one shape per call. Like Excalidraw's element skeletons
  (`convertToExcalidrawElements`), it takes two shortcuts, so a model writes
  less and works out no coordinates: a rectangle, ellipse, diamond or arrow
  may take `label`, which adds a text bound to it, right after it, with the
  id `<id>-label`, centred; a labelled shape sent without a width or height
  is sized to fit: the label's estimated box with 20 px each side and 10
  above and below, inside the largest box the shape holds (all of a
  rectangle, 1/√2 of an ellipse, half of a diamond), at least 140 by 70.
  The estimate adds up Excalifont's advance widths by kind of character,
  measured in a browser as Excalidraw measures text and set a little above
  each kind's average: at 20 px, 8 for a space, 6 for i, j, l and narrow
  punctuation, 14 for m and w, 11.5 for other lowercase letters, 15 for
  capitals, 13 for digits, 12 for other ASCII symbols and 20 for anything
  else, such as Chinese or an emoji.
  The label wraps at its spaces, as Excalidraw wraps a label to its shape,
  to the width the shape was sent or else to keep it at most 240 px wide
  (wider only for a word longer than a line), so shapes 300 apart leave
  room for an arrow: its text holds the lines, and `originalText` the label
  as given, which Excalidraw wraps again when the shape is resized. A shape
  sent with both a width and a height keeps them, but grows taller when the
  wrapped label needs it, with the same room. An arrow's label wraps too,
  once the arrow is placed: as Excalidraw wraps one, to 70% of the arrow's
  width and at least 220 px, but for an arrow that runs more across than
  down at least 100 px, so the label of an arrow between two 140 px shapes
  300 apart stays between them. An
  arrow may take `from` and `to`, the ids of two shapes in the drawing or
  the same call, instead of `x`, `y` and points: it runs straight along the
  line between their middles, clipped to each outline (a rectangle, ellipse
  or diamond, turned with the shape; any other shape as its box, and a
  rounded rectangle as a square-cornered one) and 8 px short of it,
  Excalidraw's gap, with both bindings set (focus 0). Each shortcut becomes
  the full elements a call could send, and full elements still work as
  before. A label on a text or line, an empty label, a label id already
  used, an end that is not in the drawing, is a label or is the arrow's
  other end, points or bindings given with `from` and `to`, and shapes too
  close for an arrow are refused, saving nothing. It only adds, so it is not
  destructive: every id must be new, and an existing element changes only to
  list a new label or arrow in its `boundElements`. Fields left out get
  Excalidraw 0.18.1's defaults, but for the seed and version nonce, which
  come from the element's id (below), and indices continue after the scene's
  last with `fractional-indexing`, Excalidraw's own library, so the app and
  `drawingSvg.ts` draw the result.
  A save that conflicts is read again and applied once more; with
  `base_version`, a drawing changed since is a conflict. An Obsidian
  `.excalidraw.md` is refused (`write_file` changes it). In the app, and so
  in the panel, a drawing open on its canvas sketches in the elements new in
  a version saved elsewhere, by any tool (`DrawingCanvas`'s `drawIn`,
  `src/features/drawings/sketchIn.ts`), one after another as the chat card's
  live view draws them, with the step logic and pencil sound it shares
  (`src/features/sketch`): each line along its length, hachure scribbled in,
  solid fills faded in after their outline, text written left to right, at
  the card's pace, faster for a big addition so the whole sketch takes about
  6 s at most. The canvas keeps them hidden while an SVG layer over it,
  following its scroll and zoom (and its dark filter), draws them from
  Excalidraw's own `exportToSvg` of each element: the same seeds, strokes and
  text layout as the canvas (the server's `drawElement` lays out text and
  arrow labels its own way, so it would move at the hand-over). As each one
  is drawn, the canvas shows it before the next paint (a synchronous React
  update, since Excalidraw draws in an effect) and its sketch fades over it
  in 150 ms: the canvas puts its own copy of each element on whole pixels, a
  fraction of a pixel from the sketch's. It is all outside undo and never
  marks the file changed; with reduced motion, or on a canvas that is not
  showing, they appear at once, in silence. Once the person presses, turns
  the wheel or types on the canvas, the rest shows at once. When any of them
  is out of sight (outside the visible part of the canvas, clear of its
  islands), the view first follows them with Excalidraw's `scrollToContent`:
  they go to the middle at the same zoom, zooming out only as far as it takes
  to fit them (not below the readable zoom a drawing opens at), over 500 ms
  or at once with reduced motion. When the first element is due, the same
  `scrollToContent` without animation puts the view where the move ends and
  cancels the rest of it (React commits each step of the move in a later
  task, so on a busy page a frame can show no step while it still goes on),
  and the sketch starts once the view holds still. It stays put while the
  person draws a shape or line or edits text, and for 3 s after they last
  pressed, scrolled or typed on the canvas.
- **Decision: writes take draw's short form.** A drawing written whole is
  mostly what `draw` works out: a 15-shape flow with its labels and arrows
  is about 13,100 characters as full elements, which a model takes about a
  minute to write while the person watches, and about 2,900 in the short
  form. So `create_and_show`, `update_and_show` and `write_file` (and the
  in-app assistant's `write_file`) save a `.excalidraw` drawing with its
  elements in the short form completed: one with a `label`, `from` or `to`,
  fields no Excalidraw element has, becomes the full elements `draw` would
  make. One function does it (`tools/drawingCompletion.ts`), for `draw`,
  the writes and the chat card's live view. In a write, full elements stay
  as they are, but for a shape listing a label or arrow newly bound to it,
  and a `label` replaces the label text its shape or arrow had, so a change
  can give an element a new label in the short form. A file with no
  short-form element, or not JSON, is saved byte for byte, and an Obsidian
  `.excalidraw.md` always is. An element that cannot be completed gets
  `draw`'s message and nothing is saved. A seed and version nonce left out
  come from the element's id (FNV-1a), not at random, in `draw` too, and an
  element a write completes gets no order index or update time (Excalidraw
  gives it those when it opens the drawing), so the same text always saves
  the same file, which a save retried with its `mutation_id` must. The live
  view completes the elements as they come with the same function, and so
  draws the sizes and strokes the saved card shows: an arrow named by
  `from` and `to` draws once both its shapes have come, and one whose shape
  never comes is not drawn.
- **Decision: a note grows in sections the person can watch
  (`append_to_note`).** As with a drawing, a note written in one
  `write_file` appears all at once. `append_to_note` (`tools/appendToNote.ts`,
  titled Add to note) adds up to 4,000 characters to the end of a `.md` or
  `.mdx` note, creating it if there is none, and saves through `save_files`
  with the version it read, as `write_file` does; the server's instructions
  and the notes skill tell agents to call it several times, a section each (a
  heading and its paragraphs). It only adds, so it is not destructive: the
  note's trailing whitespace is trimmed, then come one blank line, the text
  without blank lines before it, and one line break at the end. A save that
  conflicts is read again and added once more, since an addition at the end
  goes on top of any other change; with `base_version`, a note changed since
  is a conflict. A `mutation_id` that already saved this text gets that save
  back (its version in `file_versions`), so a retry never adds it twice. A
  drawing, diagram or other file is refused with the tool that changes it. In
  the app, and so in the panel, an open note that takes a newer version saved
  elsewhere whose text extends the one on screen (its trailing whitespace
  aside) writes the added part in (`src/features/document/writeIn.ts`) as a
  model streams an answer: in Rendered (the frame's `src/preview/typeIn.ts`,
  told where the added blocks start by the render's `fluid.writeIn`) and in
  Source (`src/features/source/sourceTypeIn.ts`) the added text has its
  final layout from the start, hidden by decorations, and shows a word or a
  few characters at a time behind the chat card's blinking caret: about 80
  characters a second for a short addition, so a line takes about a second,
  faster as it grows, and never more than 4 s (`writeInMs`). In Rendered a
  code block, an embed or any other island, and a rule, fades up as the
  writing reaches it. Both are display only, outside undo, and never mark
  the file changed. A key or a click in that view shows the rest at once, as
  does any other change to its text; a newer version that comes while one is
  still writing in carries on from where it is. With reduced motion nothing
  animates. A reader following the end of the note (it was on screen, within
  about a line, before the new version came), or the writing of the one
  before, sees the first new block or line come into view, smoothly or at
  once with reduced motion: in Rendered the frame scrolls only its own
  document, and in Source the line comes near the top, where Monaco's
  reveal near top puts it; then the writing stays in view as it goes down.
  A reader who scrolled up, has text selected, or typed in that view in the
  last 3 s stays put, and one who scrolls up while it writes stops it
  following.
  Whatever a newer version changes, the person's caret and selection stay
  where they were in both views, mapped through the change (`writeIn.ts`):
  kept before it, moved with the text after it, and from replaced text to
  the nearer end of what replaced it. Whole lines or blocks added count from
  where they start, so a paragraph added above one that begins with the same
  words leaves the caret in its own paragraph. Focus stays where it was.
  Source still replaces the model's value, which clears its undo history as
  before (Monaco has no public way to clear it after applying edits), then
  sets the selections back; the frame maps its selection whenever a render
  replaces its document without placing the caret. A note with unsaved edits
  says it changed elsewhere, as before, and writes nothing in.
- **Decision: a change the person watches is shown as it is written.**
  `update_and_show` (titled Change and show) changes a note, drawing or
  diagram that exists, with the version the agent read, and returns
  show_file's result. It saves as `write_file` does, so it is destructive;
  a stale version gets `write_file`'s conflict result after one line the
  card shows, and a path with no file, or another file type, is refused.
  The server's instructions and the plugin's skills send agents to it when
  the person should watch a change happen in the chat, and to `write_file`
  for quiet changes and files nobody is watching. Its card goes live as
  `create_and_show`'s does, and where the host lets views call tools, the
  first partial input that names the file has the card read it as saved
  (`read_file`, which the view may call): a drawing's elements show at
  once, those the new content keeps as they were (the same apart from
  Excalidraw's bookkeeping: version, nonce, update time, order index and
  bound elements) stay, changed and new ones draw in as they come, and those
  it leaves out fade once the whole input is in; a note shows as saved while
  the new text is still its start, and from where they differ the new text
  writes in; a diagram's source writes in as text. A host that sends no
  partial input gets `create_and_show`'s fallback.
- **Decision: a pencil sound while a drawing draws in.** Each element makes
  a short, quiet pencil stroke as it draws in, in the live card and on the
  app's canvas, made with Web Audio from noise
  (`src/features/sketch/pencil.ts`; no file is fetched); the variation of
  each stroke follows the Excalidraw MCP app's (MIT, credited in the file).
  It is on by default, and a button mutes it, remembered for the viewer in
  the page's storage where the host gives it one (`pencilSetting.ts`): in
  the live card's footer, and on the canvas, at the bottom right (the top
  right on a phone), while elements are sketched in. It is silent with
  reduced motion, and where the browser keeps the audio held back.
- **A live card says how it went.** When a live card settles, it calls
  `card_report` once, a view-only tool (`ui.visibility: ["app"]`) that
  validates the host's name (at most 40 characters), the tool, how many
  partial inputs the host sent and when the first came and when the card
  settled (ms after it started), writes one log line of the function,
  `{"event":"card_live","user":<caller>,...}`, and stores nothing, as
  `panel_origins` does. It shows which hosts send the input as it is
  written.
- **The card is built from the component library.** `src/chat-card` is a
  small React app on the library's components and the Supabase Green
  palette, light or dark as the host says; its states are on `/style-guide`.
  A note reads as in the app's rendered view: the card's stylesheet carries
  the view's reading styles (`src/preview/noteType.css`, Typography's prose
  in the app's tokens), and the server's HTML is put in the view's markup
  for list items, task items, code blocks and tables
  (`src/chat-card/readingMarkup.ts`). Its text is in the app's fonts,
  except in ChatGPT, whose guidelines ask plugins for the system's fonts: there it uses the host's font variables,
  or the system's, and loads only Excalifont, which drawings are written in.
  `bun run build:chat-card` builds it into `tools/cardEditorScript.ts`, a
  script and stylesheet the view inlines, committed because the functions
  deploy without building the app. Rebuild it after changing the card or the
  modules it uses, and give the view a new `ui://` URI. Zod runs jitless.
- **Decision: the view is a small shell, and the rest loads when it is
  needed.** The inline script (about 360 kB, 108 kB gzip) shows the file
  from the server's HTML and drawings with no network requests. The same
  build writes the rest to `public/chat-card/`, which every app deploy
  serves at `https://elaborat.ing/chat-card/` with CORS
  (`public/_headers`): the app's fonts (Space Grotesk, JetBrains Mono and
  Excalifont's Latin subset), added once the host has answered; the note
  editor as an ES module the card imports when Edit is pressed; the app's
  code highlighter, after a note with a code block shows (where it does not
  load, the code stays plain); the
  component compiler and the preview frame's runtime, for a note with
  components or a component file; the charts' library, which the frame
  imports only for a note with a chart; and the diagram module with D2's
  engine, for a diagram the card draws (above). The build keeps the engine's
  script it finds there while its wasm is the package's, byte for byte,
  since compressing it again takes about a minute. The view declares that
  origin in `_meta.ui.csp.resourceDomains` (and ChatGPT's
  `openai/widgetCSP`), which adds it to `script-src`, `style-src` and
  `font-src`. It also names
  `openai/widgetDomain`, the dedicated origin ChatGPT serves the view from,
  which a listed plugin needs. That is ChatGPT's name for the spec's
  `ui.domain`, used instead of it because each host has its own format for
  that field and Claude refuses to show a view whose `ui.domain` is not the
  one it derives from the server's URL. A host that does not
  allow it blocks them (or says so in `hostCapabilities.sandbox.csp`, and the
  card does not try): the card then shows the server's HTML, read-only, in
  the system's fonts, with a line that says the editor or the
  preview could not load. The files have content-hashed names and are
  committed too, since the functions and the app deploy separately. The
  folder keeps the files of the last ten builds, listed newest first in
  `builds.json`, for a view whose function is not deployed yet (it goes live
  after the app, under Deploys) or that a host cached (ChatGPT for up to
  about an hour, through several rebuilds in a busy hour); a file the builds
  share is stored once.
- **Decision: the app itself beside the chat, framed from `/embed`.** The
  `open_panel` tool (`tools/panel.ts`, titled Projects) opens from ChatGPT's
  sidebar (global entrypoint), a conversation's side panel (thread
  entrypoint), or a model's call with a project and file; `{}` opens the
  projects list. Its view (`ui://elaborating/panel-v5.html`, earlier names still answering) is a small
  hand-written page, not the card's build: it declares
  `https://elaborat.ing` in `frameDomains` (and `frame_domains` and
  `redirect_domains` in `openai/widgetCSP`), uses the card's widget domain so
  a chat has one view origin to allow, and frames
  `https://elaborat.ing/embed[/projects/<id>[/<path>]]?theme=<host theme>`:
  the tool's page first, then the host's deep link (only `/` or
  `/projects/<uuid>/...`), then the projects list. It fills the view (inline
  at the host's maximum height), forwards theme changes to the frame, takes
  messages only from that frame and from the app's origin, and opens only
  `https://elaborat.ing/...` links through `ui/open-link`. When the host's
  `sandbox.csp.frameDomains` lacks the app's origin (Claude restricts frame
  domains), or the app has not said it is ready within 10 seconds, the view
  says "elaborat.ing isn't switched on for this panel yet." with Open in
  elaborat.ing and, under Details, its own origin and its ancestors: what
  `EMBED_FRAME_ANCESTORS` must cover (Frontend hosting). It also sends that
  line to `panel_origins` once (and once more, with `ok: true`, when the app
  did open), with what the host reported about the view's place (`host`: its
  display mode, the safe area's insets from the host context and from
  `window.openai.safeArea`, the container's dimensions and the window's size,
  numbers and short strings only), a view-only tool that validates it (https
  origins, one space apart, at most ten) and writes one log line of the
  function,
  `{"event":"panel_origins"|"panel_ok","user":<caller>,"origins":...,"host":{...}}`,
  and stores nothing, so the line can be read from the function's logs
  instead of copied from the panel. The app in the panel keeps a
  sign-in of its own (the host partitions its storage under the chat's site)
  and updates through the app's own Realtime sync when an agent saves. It
  tells the view what the person has open whenever that changes
  (`elaborating-embed:location`: the project's id and name and the open
  file's path and kind, or nothing), and the view checks it and, once it has
  settled for 300 ms and differs from the last, gives the chat's model one
  short text with `ui/update-model-context`: the project and file, that
  "this" means that file, how to add to it so the person can watch (`draw`
  for a drawing, several shapes a call; `append_to_note` for a note), that
  adding needs no `read_file` first (both only add, and a read costs the
  chat a tool call before anything shows; a drawing may be read once to see
  where things are), and that changes and removals are read first and go
  through `write_file` with `base_version`; with nothing open, an empty list. Each
  page the view frames carries a one-time pass in its fragment
  (`#pass=<64 hex characters>`, never the query string): `open_panel`'s
  result has one in `_meta` (`elaborat.ing/pass`, which reaches the view and
  not the model; never in `structuredContent` or the text), and the view asks
  `panel_pass` for a new one for each page after that, or once when the app
  says its pass did not work (a view shown again holds a used pass). The view
  waits up to 2 seconds for the result before it frames anything, so the
  first page uses the result's pass. `panel_pass` is for the view only
  (`ui.visibility: ["app"]`) and has no view of its own; it adds a short-lived
  row, so it is not read-only, and changes nothing of the person's, so it is
  not destructive. `open_panel` stays read-only: it only opens the app, and a
  host may ask before it runs a tool that is not. The
  `EMBED_VIEW_ENABLED` function secret set to `false` removes both tools and
  the view, leaving the tool list and resources as they were; it is on
  otherwise. `show_file` and every other tool are unchanged.
- **Pin versions.** Keep the block's code as Supabase ships it (a `pipeline`
  of `withOAuthProtectedResource` and `withSupabase`), pin exact versions, and
  keep the MCP layer a thin wrapper around the database functions. Local
  changes to block files stay minimal and are commented.
- **Requirements from the platform:** asymmetric JWT signing keys (the MCP
  function's `withSupabase` rejects legacy HS256 tokens, and OIDC ID tokens
  need them too), `verify_jwt = false` on the `mcp` function (it verifies
  tokens itself), Auth Site URL set to the origin serving the consent page,
  exact redirect URIs (no wildcards), and dynamic client registration enabled,
  as Supabase's BYO-MCP guide requires. Registered clients show in the
  dashboard and can be revoked.
- **No code runs from strings in a view.** An MCP Apps server can declare
  origins but not CSP keywords, so it cannot ask for `'unsafe-eval'`. The
  spec's default policy leaves it out, Claude's documentation never mentions
  it, and a host may always restrict further. So a view never runs code
  through `eval` or `new Function`: component code is compiled to JavaScript
  text first and runs as ordinary inline scripts. Details in
  [platform notes](platform-notes.md#mcp-apps-hosts).
- **Decision: components are previewed in the card, compiled there and run
  in a frame nested in it.** For an MDX note shown whole whose MDX the HTML
  shows as text (imports, other components, HTML, expressions), `show_file`
  also sends the sources of the component files it imports (`workspace:`
  specifiers, followed level by level as the user, within the app's limits of
  8 levels, 32 files and 2 MiB; `tools/componentSources.ts`) in the result's
  `_meta`. `preview_component` sends a component file's source, or a draft
  the agent passes that is never saved, with the files it imports, and which
  component to show with what sample props (by default each exported one,
  with its `componentMeta` defaults). The card (`src/chat-card/preview/`)
  compiles them with the app's own pipeline (`componentModules.ts` and MDX's
  compiler, which the editor loads too), so a preview fails where the app
  would, with the same message. The server only reads:
  compiling there would spend the Edge Function's 2 s of CPU and keep a
  second copy of the module rules.
  - **The frame:** the card builds a document with one inline script per
    compiled file and an import of the preview runtime (`runtime.tsx`:
    React, the app's built-in components as the app's preview frame gives
    them, and the card's note type and embeds), and shows it in an iframe
    with `sandbox="allow-scripts"` and nothing else. That is an opaque
    origin: it cannot reach the card's page, storage or bridge, so it cannot
    call tools, and as a `srcdoc` document it inherits the view's policy, so
    it runs no code from strings and loads nothing but scripts, styles and
    fonts from the view's declared origin. The card sends it only data (what
    to show, the server's drawings, props, colours, fonts) and reads back
    only its height, that it drew (with the components that threw), that it
    failed, and a clicked link, which the card offers to open and opens
    through the host only when the person presses Open. The note shows in
    the note's type with its drawings, as the rest of the card. Charts are
    the app's: the frame imports their library (about 0.65 MB) only for a
    note with a chart, and shows a box with the chart's description where it
    does not load.
  - **Failures:** the compiler wraps each outermost element of a note in an
    error boundary, so a component that throws shows its error in its place
    and the rest of the note shows. A note whose preview cannot be made (a
    missing file, invalid MDX, a module that throws when it loads, a frame
    that does not load within 15 s) keeps the server's HTML, with the reason
    in a banner; editing is unchanged, since the editor shows MDX as islands.
    For `preview_component`, the card tells the model with
    `ui/update-model-context` when the preview failed or a component threw,
    so an agent drafting a component hears about it on its next turn.
  - **Limits:** a runaway component can still freeze the card, as in the
    app.

## The assistant (ChatGPT plan)

**Decision:** the app pays for no inference; the assistant uses the person's
own ChatGPT plan (Plus or Pro), through OpenAI's Sign in with ChatGPT plan
usage. For now it is a local-run feature: a build with `VITE_CHATGPT_PLAN` set
shows it, and the hosted site leaves the variable unset, so nothing of it is
in its bundle. A hosted version waits for OpenAI's approval and an issued
client.

- **Where it runs.** The agent loop runs in the browser, as the person: it
  POSTs `{ model, input }` to `/chatgpt/responses`, reads the server-sent
  events with a small reader (no OpenAI SDK), runs each function call through
  the workbench's own operations with the person's session, and sends every
  output item back (its encrypted reasoning too) until the model answers
  without a call. At most 25 calls a turn; Stop aborts it. The chat lives in
  memory per project; New chat clears it.
- **Four tools, in one `elaborating` namespace**
  (`supabase/functions/_shared/chatgpt/tools.ts`): `list_files`, `read_file`
  (what the editor holds, unsaved edits included), `write_file` (the complete
  content; a new path is created the way New file does) and `list_comments`
  (read only). Any other name is refused and does nothing. The instructions
  reuse the MCP server's file-format text (`_shared/fileFormats.ts`).
- **The assistant never saves.** A write lands in the file's tab as an
  unsaved edit, the same as typing; the person saves or discards it, which is
  the confirmation, and the saves are theirs (no agent marker). Over the
  person's own unsaved edits it asks first. While a write streams, the chat
  card's live view (`src/chat-card/live/mount.ts`, unchanged) covers the
  editor: a note renders, a drawing sketches in, a diagram's code writes in.
- **The browser never holds an OpenAI token.** A token keeper does:
  `supabase/functions/_shared/chatgpt/` is the shared core (plain TypeScript
  with fetch and Web Crypto): the sign-in transaction (state, PKCE S256 and
  nonce, used once, ten minutes), the code exchange with the ID token checked
  (signature, issuer, audience, expiry, nonce), the plan-scope check (no
  request goes to OpenAI without it), refreshes made one at a time with the
  rotated token saved, revoke on disconnect (a refresh still running then
  revokes its new token instead of saving it), and the Responses request
  (`store: false`, `stream: true`, the app's instructions and tools pinned;
  only `model` from the person's list and `input` come from the browser,
  within a size limit).
- **The local keeper** is a dev-only Vite plugin
  (`vite-plugins/chatgpt-keeper.ts`, `apply: "serve"`) on 127.0.0.1. It serves
  `/chatgpt/{start,status,responses,disconnect}` and `/auth/callback`, with
  OpenAI's open-source flow: `dynamic_agent_client`, the app's name as
  `agent_name_hint`, a kept `ext_agent_host_id` and the exact loopback
  redirect. It keeps the issued client id, the host id and the tokens in
  `$XDG_CONFIG_HOME/elaborating/chatgpt.json` (0600, in a 0700 folder),
  outside the repository, and refuses requests from any other origin and any
  POST that is not JSON. It answers this computer only (a loopback peer, with
  the Host `127.0.0.1:<port>`), and is off when the dev server is open to other
  devices (`--host`). Locally, ChatGPT is a plan connection only, never the
  sign-in.
- **Loading rule:** the button and Settings' "Use your ChatGPT plan" card are
  the only parts in existing chunks; the panel, the loop and the readers load
  when it first opens, and the live view's renderers when a write starts.

## Component isolation

MDX compiles to JavaScript, and user components run in the browser. They must
never run with the app's privileges.

**Decision:** components render in a sandboxed iframe with no network access,
and the app accepts only a fixed set of validated messages from it. The frame
never receives tokens or files, only compiled code and rendered images.

**Decision: the frame is a page on a sandbox domain, `elaboratingusercontent.com`.**
A registrable domain of its own (Google's documented pattern for untrusted
content, like `googleusercontent.com`): a subdomain of elaborat.ing would be
the same site. `src/preview/preview-entry.tsx` is built by Vite as one script
(`vite-plugins/preview-frame.ts`), so its npm packages are listed in the site's
license notices, and the build writes the frame's page to
`dist-sandbox/frame/<hash>/`: `index.html` (`src/preview/frameHtml.ts`, with
the frame's styles and fonts inline), that script as `frame.js`, and a file for
each heavy part (below). The hash is of the files' contents, so a page never
mixes versions and every file is cached for a year; the app's build names the
folder. A second Worker (`wrangler.sandbox.jsonc`, `worker/sandbox.ts`, see
Frontend hosting) serves that folder, and the last few before it, on the
sandbox domain, and every other path there is not found. The page's Content
Security Policy is a response header: scripts only from the page's own
folder, plus `'unsafe-eval'`, since MDX's `run()` evaluates compiled code
with `new Function`; no network
(`connect-src 'none'`); images and fonts from `data:` only; inline styles; and
`frame-ancestors https://elaborat.ing`, nothing else. Its files are sent with
`X-Content-Type-Options: nosniff`, no cookies, and
`Access-Control-Allow-Origin: *`: the page loads its scripts with CORS from an
opaque origin, so an error in them reports its message.

The iframe has `sandbox="allow-scripts"` only, so the page's origin is opaque:
nothing it stores is shared with another note or project. The frame says it
is ready with `postMessage` (target `*`: an opaque origin cannot be named as
a target), and the app, checking `event.source`, answers that first ready,
once, with a window post carrying one `MessageChannel` port and nothing else.
Every message after that handshake, both ways, goes over the channel, so it
is bound to the frame's first document: a port stays with the document it
was transferred to, and a page the frame navigates to has the frame's window
but not its port, so it is sent nothing and the app hears nothing from it,
even when it never finishes loading. Links, Copy code, Document actions and
the native Save shortcut come as window posts instead: WebKit runs the app's handler
for a window post as part of the click, but not its handler for a port
message, so Safari blocked the new tab the app opened. The app takes those
posts only from the frame's window and with the editor's session, which only
the frame's first document was sent. Document actions and Save additionally
require the current source revision and active user activation; port messages
cannot authorize them. The frame is given nothing a component
in it could not already see. A frame that loads a second time has navigated
itself (a note's code, or a link): the app closes its port and puts a new
frame in its place, or stops the preview, with a notice, when it happens
again within seconds.

The app's build names the domain in `VITE_SANDBOX_ORIGIN` (set in
`deploy.yml`). Without it (local dev, the browser tests, a self-host that
sets none) the frame is the `srcdoc` below, as before.

**Decision: when the sandbox domain's page cannot load, the frame is a
`srcdoc` document.** This is the model the app used before the sandbox
domain, still sandboxed: the same document with its script inline, as the
iframe's `srcdoc`, with `sandbox="allow-scripts"` only and the same policy in
a meta tag (`PREVIEW_CHILD_CSP`: inline script in place of the folder's). The
app uses it when the browser is offline as the note opens, or when the page
does not say it is ready within 2 seconds of loading (an error page: offline,
blocked, or a version the domain no longer serves) or within 10 seconds at
all; the frame stays hidden behind a loading line until then, and later notes
in that tab start with the `srcdoc`. The app is offline-first and its service
worker cannot serve another origin's page, so this keeps notes rendering
offline: the `srcdoc` and the parts it asks for are precached. A deploy
keeps the last five versions of the frame's page (Frontend hosting), so a tab
on an older version than that uses the `srcdoc` until it updates. A `srcdoc`
document inherits the parent page's CSP, so any CSP added to
`public/_headers` must allow the frame's inline script, `'unsafe-eval'` and
`data:` fonts, or that frame goes blank.

**Decision: the frame's heavy parts load the first time a note shows them.**
Charts (Recharts) and code highlighting (Shiki and its grammars) are most of
the frame's code, so each is built on its own (`src/preview/modules/`) and
left out of `frame.js` and the `srcdoc`. On the sandbox domain the frame loads
a part's file from beside its page (`charts.js`, `highlighter.js`), which
registers the part with the frame. The `srcdoc` frame has no files of its own,
so it asks the app for a part by name (`load-module`); the app imports that
file, a chunk precached like any other, and posts its code back. Either way the
frame runs it with its own React (`src/preview/frameModules.ts`). Until then a
chart keeps its place with an empty box and code shows as plain text.

Code fences in notes and chat cards share `codeHighlight.ts`. Its fine-grained
Shiki imports cover 72 common programming, shell, markup and configuration
languages, including C, C++, C#, Java, Go, Rust, Ruby, PHP, Swift, Kotlin,
scientific and functional languages, web templates, SQL, YAML, TOML, Docker,
Make and Terraform. Lookup is case-insensitive and accepts Shiki's aliases,
such as `cpp`/`c++`, `csharp`/`c#`/`cs`, `rs`, `py`, `sh` and `yml`, plus
common spellings such as `cxx`, `python3`, `golang` and `svg`. The language
label and source remain unchanged. Grammar data ships inside the lazy
highlighter and is registered together on first use, so optional embedded
languages inside Markdown/MDX are available before output is cached. This
follows Shiki's [fine-grained bundle guidance](https://shiki.style/guide/best-performance),
without document-time imports, network access or WebAssembly. Unknown and
unlabelled languages, and code over 32,000 characters, keep the escaped
plain-text fallback and the existing bounded highlight cache. The per-line
tokenization budget is two seconds: Shiki's 500 ms default can cut a normal
cold C++ or embedded-language line short in Firefox before caching it.

Code blocks also offer **Copy code**, including plain/unknown languages,
read-only notes, live chat cards and nested component previews. Copy takes
the original code, including indentation and highlighting annotations, or
the current textarea draft while code is being edited. It never serializes
Shiki's HTML or adds a streaming caret. Success is announced as "Copied";
a refused clipboard write keeps the button available to retry and offers
manual selection instead. Copy does not change document source or save it.
The app and chat card perform clipboard writes on a person's activated
click, checking the current frame/session/revision or preview run. Opaque
document frames send a bounded request and receive only success/failure;
their sandbox and network policy stay unchanged. The outer MCP card declares
the standard write-only [`clipboardWrite` permission](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourcePermissions.html),
which hosts may grant; no clipboard reads are requested.

**What the domain adds.** Browsers with site isolation put a cross-site frame
in a process of its own, which protects against Spectre-style and renderer
attacks and keeps a runaway component from freezing the app: with the sandbox
domain, Firefox moves the frame out of the app's process, as it does not for a
`srcdoc` frame; desktop Chrome has given a frame sandboxed like this one a
process of its own since Chrome 127, `srcdoc` included, and Chrome on Android
does when the app's page is isolated ([Chromium's process
model](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)).
The frame also loads its own script and parts, so the app no longer downloads
them to pass them in, and its document no longer inherits the app's CSP.

The chat card previews components the same way, in a frame nested in the
card (see "Agents (MCP)"). It keeps `srcdoc` frames: a ChatGPT view can embed
only the MCP server's own registrable domain without extra review, and the
host already gives the card a frame of its own.

What the domain does not fix: a component can still navigate its own frame
(carrying out whatever the frame displays) and can draw a fake login prompt
inside its own rectangle. The mitigations are what the frame is given (only
the document's compiled code and rendered images, never tokens or other files)
and a notice on shared projects that they run custom code.

**Decision: in a project shared with the person, a note that runs custom
code asks first.** A note that imports component files (`workspace:`
specifiers), exports code itself, or has an expression in its text that does
more than state a value shows a notice in place of its rendered view
(`src/features/custom-code/`). Comments and literal values such as `{2}` or
`<Chart data={[1, 2]} />` are not code; `{fetch(...)}` or `{(() => ...)()}`
is, since a member who wanted to run code without asking would otherwise
write it there. The notice lists the files the code comes from and who last
changed each (`project_files.updated_by`, named from the member list when the
server can say), says that the code runs in an isolated frame with no network
and no access to their account, and offers Run code or Show as text (the
Source view). The choice is kept on the device, per person and project, as a
SHA-256 of each file's path and its code as written (imports, exports, and
for the note its code-running expressions), so code someone else changed asks
again and edits to a note's prose do not. The person's own edits to code that
is running here (a note's code, or a component file open in its own tab) are
theirs and keep it running; their edits on another device ask again. The
rendered view is only given components whose code was checked. Owners, the
local project and built-in components never ask. The chat card asks the same
way, with the files and who last changed them, before its nested frame runs a
shared note's code or a shared component file (`show_file` and
`preview_component` send `shared`, and the names beside the component files);
an agent's draft is its own, so only the saved files it imports ask. The card
does not remember the choice, since its storage belongs to the host. The
notice is a mitigation: the frame is the boundary.

**Open:** per-document subdomains of the sandbox domain, and adding it to the
Public Suffix List, so each document's frame is a site of its own. Today one
page serves every note: its origin is opaque, so notes share no storage, but
where a browser groups frames by site they can share a process.

## Rendered editing

**Decision: an embedded document keeps a separate editing session and source.**
The MDX built-in `<Document src="notes/details.mdx" />` references a same-project
Markdown or MDX file. Each file has one session shared by standalone tabs and
inline views; collapse retains its draft and undo history. The workbench owns
the session and saves changed loaded descendants through ordinary per-file
revision checks. Inline previews reuse the isolated editor in nested opaque
`srcdoc` frames, bound directly to that session through a validated private
channel. This avoids combining different source files inside one prose
editor. The sandbox permits only local `about:` child frames; hosted children
reuse the parent's permitted versioned bootstrap script and inherit its
policy. No network or same-origin capability is added. The implementation
plan and release status are in [embedded documents](embedded-documents.md).

**Decision: displayed code keeps the browser's text selection.** Code blocks
are object islands outside the prose editor, so code pointer and keyboard
events do not focus prose or select its containing atom. Dragging or
double-clicking code preserves the selected text and reading position in
editable and read-only notes. Editing starts with **Edit code**; selecting
the displayed code never replaces it with an autofocus textarea or saves it.

**Decision: right-clicking an editable rendered note offers its block picker
at the pointer.** Ordinary blocks and components insert after the clicked
top-level block; drawings and diagrams first ask for an existing file. The
parent supplies the parsed insertion boundary for each rendered root, so
hidden imports and exports and nested list items cannot shift the target.
The frame uses a manual native popover with menu keyboard navigation and
outside-click dismissal, alongside the existing Insert block dialog. Auto
popovers close on the right-button release that opens the menu in Chromium
and Firefox. The menu waits for typed edits to reach the source before using
its boundary map. Read-only notes offer neither control.

**Decision: the rendered view's editor takes the browser's caret before it acts
on a key.** The frame edits prose with ProseMirror. In Chromium, a caret moved
by a native key (an arrow, Home, End) reaches ProseMirror through a
`selectionchange` event that can arrive after the next key. So a key command,
such as Enter's split, could act where the caret was before. And ProseMirror's
check 20 ms after the editor gains focus could put that old caret back.
`src/preview/fluidEditor.ts` reads the DOM caret into ProseMirror on every
keydown, through its public `handleKeyDown` and `posAtDOM`. It also does this
at the start of that focus check, by wrapping the one timer the check sets.
The wrapper is unusual, but ProseMirror has no option for the check, and a
separate timer of our own can run too late, after key events that slip in
between. If ProseMirror fixes this upstream, both can go; the browser test
"Enter straight after arrow keys splits at the caret, every time" shows
whether they are still needed.

**Decision: an edit Markdown cannot store exactly is taken in its nearest
form, a document that differs from the editor's only by whitespace Markdown
cannot hold.** The frame proposes each edit as ProseMirror steps; the app
writes each step into the note's source and reads the source back
(`prepareFluidTransaction`, `src/features/rendered/fluidProjection.ts`). The
first way of writing a step whose source reads back as exactly the proposed
document wins, so an edit Markdown can hold is written as it always was. When
none does, a way whose document equals the proposal after one small
normalization, applied to both, is taken (`markdownForm`,
`src/features/rendered/nearestForm.ts`): spaces and tabs at the start of a
paragraph or heading are dropped, and spaces and tabs at the start or end of
bold, italics or strikethrough move just outside them. Everything else must
match: every other character, including a space between words or at the end
of a paragraph and a line break, the formatting on it, a link's text, and
every block. So a lost letter or word is still refused, with the plain
"Edit not applied" notice. A step that only adds such whitespace, such as a
space typed at the start of a paragraph, changes nothing. Enter right before
a space writes the new paragraph without it (`One.\n\nTwo.`), and a delete
or a format change that leaves italics or bold ending in a space before a
letter writes the space just outside them (`*a* b`).

Rendered Enter preserves the `.` or `)` delimiter of an ordered list when it
generates an item. Neighbouring items keep their original source numbering
and spacing, including in nested and loose lists.

The editor then takes the document the source makes in place of its own. The
app's acknowledgement of that edit carries the document and `nearest`; the
frame moves to it through the normalization's own steps, so the caret keeps
its place, and redoes on it the edits typed meanwhile, which the app has not
been sent yet, with their positions mapped (`rebaseSteps`, as
prosemirror-collab rebases steps not yet confirmed). The reset a refusal uses
would drop those keys. Ignoring whitespace altogether would accept a lost
space between words; and only the app can say what the source holds (a space
kept as `&#32;` reads back exactly), so the frame does not normalize its own
document.

**Decision: the code editor and the rendered note load when they first show.**
Monaco (about 1 MB gzip) loads with the first Source, Split or Code view, and
the rendered note with its frame (about 0.6 MB) with the first Rendered or
Split; pointing at the view switch starts both. Until Monaco loads, the note's
text and undo history live in `src/features/source/sourceBuffer.ts`, grouped
as Monaco groups rendered edits, and Monaco replays them when it mounts, so
Ctrl+Z in Source still undoes an edit made earlier in Rendered. Both stay
precached for offline use.

**Decision: canvases load when a drawing or diagram first opens.** The drawing
and diagram views, with Excalidraw's styles, load with the first file of their
kind; Excalidraw itself when a canvas first shows; D2 and the font it measures
text with (`src/features/structured/native-font-ttf.json`, 220 kB) with the
first compile; and the code that pictures a diagram in a note with the first
such embed. All of it stays precached for offline use.

## Frontend hosting

**Decision:** Cloudflare Workers with static assets, which Cloudflare now
recommends over Pages for new projects. `wrangler.jsonc` is the config file:
SPA fallback (`not_found_handling = "single-page-application"`), the
`elaborat.ing` custom domain, and headers in `public/_headers`. The Worker
also answers `/.well-known/openai-apps-challenge` with the token in
`OPENAI_APPS_CHALLENGE` (a public value, set in `vars` once OpenAI gives one
for a plugin listing), and with not found while it is unset. The hosted
instance deploys with `wrangler deploy`, using a Cloudflare API token from the
"Edit Cloudflare Workers" template, restricted to one account and the
`elaborat.ing` and `elaboratingusercontent.com` zones. Static asset requests
are free and unlimited.

**Decision: the sandbox domain is a second Worker.** `wrangler.sandbox.jsonc`
deploys `worker/sandbox.ts` with `dist-sandbox/` as its assets on the
`elaboratingusercontent.com` custom domain (Component isolation). Asset rules
match paths, not hosts, so a Worker that answered only frame files on one of
its domains would have to run first for every request on all of them, and
those requests are billed (on the free plan, refused past its limit). As a
Worker of its own it runs first for every request on the sandbox domain only,
and the app's files stay plain static assets. `deploy.yml` deploys it
before the app, so the page the new app names is there when it goes live.

**Decision: the sandbox domain keeps the last five frame versions.** A
Workers deploy serves only the assets it uploads, so a tab still on the
previous app version would find its frame folder gone. The build lists its
folder and files in `dist-sandbox/frame/versions.json`, which the Worker
serves. Before deploying, `scripts/keep-frame-versions.ts`
(`vite-plugins/frame-versions.ts`) reads that list from the live domain and
copies up to four earlier folders back into `dist-sandbox/`, newest first,
each only when its files still hash to its folder's name (they are cached as
never changing), then lists them after this build's. Five versions bound the
assets. A version it cannot copy is left out with a warning, and the deploy
goes ahead: those tabs use the `srcdoc` frame.

The build only needs public values (the Supabase URL and publishable key, and
the sandbox domain's origin).
Self-hosters can deploy the same static build to any host.
`.github/workflows/deploy.yml` deploys it after CI passes on `main`, once the
migrations are applied (the newest commit CI has passed there, as under
Deploys), with
the `SUPABASE_PROJECT_ID` and `SUPABASE_PUBLISHABLE_KEY` repository variables
and the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

**Decision: Excalidraw's fonts are served from this site.** Left alone,
Excalidraw fetches fonts from a public CDN. The build copies the pinned
package's fonts to `/excalidraw-assets/` and the app points Excalidraw there at
startup, so drawings work offline and no font request leaves the site. The
font-subset worker starts from the chunk Excalidraw imports for it, and the
page imports the same subsetting code (1.8 MB) for the rest, so everything the
worker imports gets chunks of its own
(`vite-plugins/excalidraw-subset-worker.ts`): one file serves both, and the
worker loads nothing that needs the DOM.

**Decision: chunks follow what loads together, and libraries keep their own.**
`vite.config.ts` declares the app's own modules free of side effects (except
the entry), so a page that imports one thing from a feature's `index.ts` does
not download the rest of that feature. Libraries go in chunks named after
them (react, router, ui, zod on first paint; supabase, monaco, prettier,
prosemirror, mdx and the preview frame later), and the app code every page
starts with goes in `app`, so a deploy that changes only the app's code leaves
those files and their hashes alone and an update downloads only what changed.
A group never moves lazy code into an earlier load: first-paint groups take
only what the entry imports, the others split by what loads them. `bun run
build:visualize` and `bun run report:bundle` show the result.

**Decision: the shell paints before any script runs.** `index.html` holds the
shell: the dotted page and the app's mark, in the saved palette and light or
dark (a few lines of inline script read the saved appearance before the first
paint, and `palettes.css` colours it). `src/main.tsx` renders the app only
once the first route's code has loaded, so the shell gives way to that page,
never to a blank one. Each page's code is a chunk of its own. A link to a page
whose code has not loaded makes the page being left take no input at once,
and if the code takes longer than 100 ms the router's pending component
(`PageLoading`, the shell's dotted page and mark) replaces it for at least
300 ms, so a page whose code has loaded never flashes it. supabase-js loads
after the first paint too: the session check starts it (`loadClient` in
`src/lib/supabase/client.ts`), and code that runs only once someone is signed
in uses `loadedClient`. Settings' sections,
the command palette's list, the comments panel, the members and move dialogs,
the zip code, the home page's picture of the app and the style guide's
component sections each load in chunks of their own, behind a loading line or
a placeholder of their size. The app validates with `zod/mini`, which bundles
only the parts of Zod it uses. Code that loads later uses it too: full Zod
anywhere in the app shares Zod's core with the first paint, which then carries
the parts only full Zod uses. Where people see Zod's messages, the code passes
Zod's English messages itself, since `zod/mini` has none of its own.
`bun run check:bundle` fails if full Zod reaches a first paint.

**Decision: the app in a chat's panel is `/embed`, framed only by origins
the Worker names.** `/embed`, `/embed/` and `/embed/projects/<anything>` (GET
and HEAD) run the Worker first, which sends the page with
`Content-Security-Policy: frame-ancestors <EMBED_FRAME_ANCESTORS>` in place of
`X-Frame-Options: DENY`, and `X-Robots-Tag: noindex`. Every other path keeps
DENY, including other `/embed/` pages. `EMBED_FRAME_ANCESTORS` (a public
value in `vars`) is origins separated by spaces, or `https://*.` and a domain
of at least two labels, checked as the sandbox domain's `FRAME_ANCESTORS` is
(`worker/frameAncestors.ts`); unset, or with a bare wildcard, a path or
anything else, the policy is `'none'`. frame-ancestors checks every ancestor.
ChatGPT serves each plugin's view from its own subdomain of
`web-sandbox.oaiusercontent.com`, nested in a frame of the same origin inside
`https://chatgpt.com`, so the hosted value is
`https://*.web-sandbox.oaiusercontent.com https://chatgpt.com`. That lets any
plugin's view frame `/embed`; the pass (below) is what keeps an account out of
every frame but this site's own view, and naming the panel's exact origin
would not cover the case the pass leaves open, a server that gets the panel's
own origin. The panel's view shows its origins when it cannot open, and
reports them to `panel_origins`, so the list can be narrowed or extended for
another host. The service worker
never answers `/embed` (it is in `navigateFallbackDenylist`), and in the
panel none registers.

**Decision: the app in a panel also needs a pass only this site's server
issues.** `frame-ancestors` is the first line of defence. It trusts the
panel's origin, which comes from the widget domain the server declares.
Inside a chat, the browser keeps this site's storage under the chat's site,
so a session made in the panel is there for any frame of `/embed` under that
site. So the app shows nothing of an account until it has a pass, the second
line. The pass holds off another server that gets the panel's origin only
while no view of this site is open in the same tab: a page on the view's
origin can script a live view, take the pass in its result or ask
`panel_pass` for one, and frame `/embed` with it. That case is the same
whether `EMBED_FRAME_ANCESTORS` names the exact origin or the host's sandbox
domain, so it rests on the host keeping each plugin's view origin to that
plugin, as ChatGPT documents. The MCP server mints a pass with the
person's own token (`mint_panel_pass`, `supabase/schemas/panel_passes.sql`):
32 random bytes, kept only as a SHA-256 hash, good for 5 minutes and one use,
at most 10 per person (minting drops expired and used ones, and the oldest
past 10). The app reads `#pass=` when it starts and removes it from the
address at once (`src/features/embed/mode.ts`). Signed in, it redeems the
pass (`redeem_panel_pass`) before it reads any project: the database says
true only for a pass that exists, has not expired or been used, and belongs
to the caller, and only for the person's own session, not an agent's token,
and marks it used; every other case is the same false. Without a pass that
works, the panel shows only "Open this from elaborat.ing in your ChatGPT
sidebar." with Open in elaborat.ing, never the projects or a workbench, and
asks the view, once, for a new pass. Signed out, it shows the sign-in form
(what is typed there never reaches the page around it) and redeems the pass
right after sign-in. A pass is good for one page load: reloaded without one,
the page shows the placeholder, and the view mints a new one when it shows
the page again. Minting needs the person's token for this site, and a pass
goes only to this server's own view, in `_meta`. A pass is for the account
the chat connected, so a panel signed in to another account shows the
placeholder. Any of the person's own sessions or connected agents can mint a
pass for them, which opens nothing they cannot already read. Offline, a pass
cannot be redeemed, so the panel shows no saved projects there.

In the app, embed mode is decided once at start (`src/features/embed/mode.ts`):
opened on its own, `/embed/...` goes to the same page on the site; framed,
the router runs with `basepath: "/embed"`, so routes, links and project URLs
are the same as on the site. Only the projects and a project's workbench show;
any other page offers Open in elaborat.ing. The embed's chrome, sign-in and
messages to the view load in a chunk of their own (`EmbedRoot`): a compact
top bar with back to Projects, Open in elaborat.ing (sent to the view as
`elaborating-embed:open`, which opens it through the host, as it does a web
link tapped in a note) and Sign out; no
Settings, no legal footer, and project management (members, transfer,
archive, delete, leave, download, import) and Copy path left to the site.
Sign-in in the panel is the emailed code or a password (passkeys and GitHub
or Google need permissions or top-level redirects a frame does not get).
Light or dark comes from `?theme=` before the first paint and then from the
view's `elaborating-embed:theme` messages, and is not saved; the interface
uses the device's fonts (`html[data-embed]`). Questions before losing work go
through `confirmAction`, which shows the library's dialog in the panel, where
the frame may block `window.confirm`. Notes render in the `srcdoc` frame from
the start there, since the sandbox domain lets only the app's own site frame
its page.

**Decision: the panel follows the agent.** The panel is there to watch the
agent work, so when one of the person's agents saves a note, drawing or
diagram other than the one on screen, the workbench opens it, or brings its
tab forward, once the save has synced. After each change signal the project
page lists the project's agent changes (`AgentFollow`,
`src/features/agent-changes/follow.ts`) and takes the newest save made after
its first look by an agent of this person's: their own saves are never agent
changes, and another person's agent in a shared project is not followed.
Several saves in a row: the latest. It does not switch while the person is
in the middle of something in the panel: unsaved edits, or an edit still
finishing, in the file on screen; a key, press or wheel there in the last
3 s (the note's frame reports its own, as the page cannot see input in it);
a menu or dialog open; a comment being written or attached; a new file being
named. Nothing else shows then: the Agent changes count and the files panel
already show the save. A note or drawing opened this way starts empty, and
once its view shows that (the editors and the canvas load on first use; 10 s
at most) it takes its saved version as a newer one, so it is sketched in or
writes in by the paths above, all at once with reduced motion. That empty
start is never kept as a draft, and a file with edits kept on the device, or
a sync conflict, opens as it is. The site's own tab never follows. In the
panel a note or drawing takes a newer saved version only while it is on
screen, and once its views there have shown what they hold, so one behind
another tab sketches or writes in what an agent saved when it comes forward,
whoever brings it forward. Until then its older text, untouched, is never
kept as a draft, which would undo the save.

**Decision: the page never zooms on phones and tablets.** Page zoom is off on
purpose in the editor app (`maximum-scale=1`, `touch-action: manipulation`,
16px text controls on touch screens and iOS pinch gestures cancelled, in the
app and the preview frame), so the browser specs turn off axe's
`meta-viewport` rule; the drawing and diagram canvases keep their own pinch
zoom, and text size is adjustable in Settings > Reading.

## Offline start

**Decision: once a project has opened on a device, the app starts again with
no network**: a reload, a new tab or a browser restart. A service worker from
[vite-plugin-pwa](https://vite-pwa-org.netlify.app/), using Workbox's
generated worker (`generateSW`), configured in `vite.config.ts`:

- **It precaches every file the build writes** except Cloudflare's `_headers`,
  Excalidraw's CJK drawing font, and Excalidraw's translations other than
  English (the app never sets its language, so they never load): every chunk
  including lazy ones, styles, workers, the fonts of the app's own interface
  and of drawings (Excalifont, the default for new text, among them), the
  preview frame (a chunk of its own, the `srcdoc` fallback: the sandbox
  domain's page is another origin's, which the worker never sees), the D2
  compiler, `.wasm` files and the license texts. That is about 44 MB, about 13 MB over the network. The worker registers once the page
  has loaded, so this download does not compete with the page's own files,
  and it finds those in the browser's cache. The largest chunks are over Workbox's 2 MiB default, so
  `maximumFileSizeToCacheInBytes` is 32 MiB, and `tests/browser/offline.spec.ts`
  fails if any other shipped file is missing from the precache list.
  Navigations fall back to the cached `index.html`.
- **Excalidraw's CJK drawing font is cached when first used.** Xiaolai is
  about 13 MB in 209 subsets, which few drawings need. A cache-first route
  keeps each same-origin font file the first time it loads, so CJK text works
  offline in the subsets this device has already shown; other characters fall
  back to a system font until the next visit online.
- **No other runtime caching.** Requests to Supabase, or to any other origin,
  never pass through a cache, so no credentialed response is stored.
- **Monaco's TypeScript, CSS and HTML language services are left out of the
  build** (`vite-plugins/monaco-language-services.ts`). Monaco's entry
  registers them, and their workers (about 8 MB) are built even though the
  editors, which use Markdown, MDX, JSON, plain text and D2, never start them.
  The plugin removes their imports from the entry, as the `features` option of
  Monaco's webpack plugin does, and stops the build if the entry changes shape.
- **Updates wait for the person** (`registerType: "prompt"`). A new version
  installs in the background and `src/features/updates/UpdateReady.tsx` shows
  "Update ready". The tab where it is chosen reloads into the new version;
  other tabs keep running until it is chosen there too, so the app never
  reloads by itself. Workbox removes the old version's files from the cache
  only once the new worker activates. The first version takes over the page
  that installed it (`clientsClaim`), so lazy chunks come from the cache if the
  connection drops later in that visit.
- `public/_headers` serves `/sw.js` and `/manifest.webmanifest` with
  `Cache-Control: no-cache`, and the hashed files under `/assets/` as
  `immutable` for a year.

**Decision: Babel stays on 7.** Workbox bundles its generated worker with
`@rollup/plugin-babel`, which works only with Babel 7. The React Compiler's
Babel plugin is built on Babel 7 too: under Babel 8 it skipped every component
with a default in its destructured props, silently.

Browser tests block service workers (`playwright.config.ts`) except in
`offline.spec.ts`, because `page.route` does not see requests a worker answers
and each test would otherwise download the whole app. The harness's rendered
specs allow them: Playwright's blocking script throws inside the sandboxed
preview frame, and the harness registers no worker.

**Not yet:** icons in the web manifest (browsers will not offer to install the
app without them), and update checks while a page stays open (a new version is
found when a page loads).

## Manual steps

Settings with no file-based home yet. Each is a one-time step until the
platform supports it as code; the [self-host guide](self-host.md) walks through
the ones a new copy needs.
(SMTP and SMS providers are not on this list: they go in `config.toml`, with
secrets supplied through `env()` from GitHub secrets.)

- **Access tokens:** create the two scoped tokens described under Deploys, for
  this project only. Scoped tokens expire after at most a year, so recreate
  them before then.
- **Secret API key for the database:** create one (the hosted project names it
  `embed_worker`) for the embed pipeline; event delivery (`send-events`)
  uses the same one. The platform creates keys; the CLI can only list them.
- **Email provider:** an account with a verified sending domain and SMTP
  credentials. The hosted instance uses AWS SES, which sends only to verified
  addresses until AWS grants production access.
- **JWT signing keys:** the project must sign with an asymmetric key. New
  projects already do (the hosted project publishes an ES256 key); older
  projects switch in the dashboard.
- **Passkey and WebAuthn settings:** `config push` doesn't send them yet.
  Turn passkeys on in the dashboard (Authentication, Passkeys) with the
  relying party values from `[auth.passkey]` and `[auth.webauthn]`.
- **Custom OIDC providers:** dashboard or Auth Admin API only.
- **Cloudflare API token:** create one from the "Edit Cloudflare Workers"
  template, limited to your account and zone. The deploy build needs
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in its environment;
  they are public, but supplying them at deploy time rather than committing
  them keeps forks from building against the hosted project.

## Testing

**Decision:** unit tests cover pure logic (the editor, anchoring, sync) and
run with `bun run test`. Edge Function tests run on Deno with `deno test` in
each function's folder, against a fake Supabase client; the MCP server's tools
are called through a real MCP client, so input validation is tested too.

**Decision:** database tests use pgTAP, Supabase's documented approach, in
`supabase/tests/`. They set the role and JWT claims to act as different users,
and prove grants, isolation between users, the save protocol and the agent
rules. They run on a throwaway local stack built from the migrations:
`supabase db start`, then `supabase test db`. Until CI runs them, whoever
changes the schema runs them before the change lands.

**Decision:** browser tests use Playwright with axe, in Chromium and Firefox,
against production builds: the app, and a test-only harness page
(`tests/browser/harness/`) that mounts real components built with the app's
plugins. Each accessibility check has a positive control that plants a known
violation, so a check that can no longer fail is caught. CI runs them on every
pull request.

Every spec takes `test` and `expect` from `tests/browser/fixtures.ts`, so a
test fails when the app shows an error it did not expect, even one gone by the
time the test ends: an uncaught exception in any page or frame, or an alert or
a failed save or sync status on screen. A test that shows an error on purpose
says so with `appErrors.expect("<part of its text>")`. Console errors are not
checked: failed requests log them, and offline journeys make those on purpose.

Database changes are verified on that throwaway stack, then auth and function
changes on the hosted project after they deploy.
