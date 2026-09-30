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
                            share (invite by email), delete-account

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
- **Test against the cloud.** Database, auth and function changes are verified
  on a hosted Supabase project. There is no local `supabase start` stack in the
  workflow.
- **An app, not a page; the shell first.** The app is separate from the data:
  no server-side rendering, and it should feel like a desktop or mobile app.
  The first download is only the shell: the page frame, its CSS and its
  loading states, so something appears as fast as possible. Everything heavy
  (Monaco, the drawing engine, the D2 engine, charts, code highlighting, the
  MDX compiler) is a dynamic import, fetched only when the screen needs it,
  behind a placeholder or loading state. A slow download after first paint is
  fine; a slow first paint is not. `bun run report:bundle` measures it and CI
  holds each page's first paint to a budget. Every change is judged by this.
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
- **`config.toml` holds the hosted project's values.** There is no local stack,
  so the file describes the real project: site URL, redirect URLs, email
  confirmation and so on. Self-hosters change these for their own copy.
- **Generating migrations needs a throwaway Postgres.** The sync command builds
  shadow databases locally, which needs Docker (an experimental Docker-free
  runtime exists but is undocumented and unverified). That happens on a
  developer machine or in CI. The cloud project is where changes are applied
  and tested, never where they are generated.

## Deploys

**Decision:** GitHub Actions run the pinned Supabase CLI against the hosted
project (`.github/workflows/deploy-supabase.yml`): `supabase functions deploy
--use-api`, then `supabase db push`, then `supabase config diff` and `supabase
config push`. It works on every plan, and self-hosters can run the same steps
from their own fork.

- **No `supabase link`.** Linking reads the project's API keys, which needs a
  token that can see every secret key. Each command takes `--project-ref`
  instead, which also makes `db push` connect through the IPv4 pooler.
- **Two scoped access tokens**, one per job. The deploy token has Edge
  Functions Read-write and Connection Pooling Read. The config token has
  Project Settings and Auth Config Read-write, Add-ons Read, and Read on
  Database Config, Database, SSL Enforcement, Network Restrictions, Data API
  Config, Realtime Config and Storage Config. Project Settings Read-write can
  also delete or pause the project, so it stays out of the deploy job.
- **Where the values live.** The config token and the SMTP credentials are
  secrets of a `supabase-config` environment limited to `main`, which only the
  config job uses. The deploy token, database password and embed secret key are
  repository secrets, and the project ref is the `SUPABASE_PROJECT_ID`
  repository variable.
- **Not Supabase's GitHub integration.** On production it ignores Auth config
  unless the project ref is written into `config.toml`.
- **When it runs:** on every push to `main` that changes `supabase/` or the
  workflow, and by hand. `config push` is not atomic (Auth is written before
  Storage), so a hand run shows the diff and pushes only when asked. Every
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
  their visibility timeout ends, so they retry.
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
  quote, context and closeness to the stored position.
- A section comment quotes its heading line. A document comment has no selector.
- A drawing comment uses the Excalidraw element ID, which is stable.
- A comment that can no longer be found is shown as detached, at document
  level, with its original quote. Nothing is ever written into the source.

**Decision: the database and agent side** (`supabase/schemas/comments.sql`,
`src/features/comments/`, the MCP comment tools). The comment panel in the
editor is not built yet.

- **Two tables.** `comment_threads` holds a thread's anchor, its file and
  whether it is resolved; `comments` holds the opening comment and every
  reply. The client chooses thread and reply ids, so sending one again returns
  what the first send made instead of posting twice. A thread sent again after
  it was deleted answers that it was deleted, and does not come back.
- **Anchors** are stored once, in the app's shape (`placement.ts`), and never
  rewritten; "detached" is worked out by each reader, never stored.
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
  OAuth client id from the token; reads show only `via_agent`, and readers
  cannot select the client id column.
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
  sign-in page accepts either.
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
- **CAPTCHA:** Cloudflare Turnstile on sign-up, sign-in and password reset.
- **Not possible today:** "Sign in with ChatGPT" is a partner-only beta, and
  there is no "Sign in with Claude"; Anthropic doesn't allow apps to offer
  Claude.ai login. If OpenAI opens its sign-in to all apps, it can be added as a
  custom OIDC provider. None of this affects agents: Claude and ChatGPT connect
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
  placeholders included. A comment is 1 to 5,000 characters, a quoted
  selection at most 5,000, with 32 characters of context on each side, and an
  element's label at most 200.
- **Per API read:** at most 1,000 rows (`max_rows` in `config.toml`).
- **MCP Apps card:** 8 drawings per note, 200,000 characters of SVG each and
  600,000 per result, 3,000 elements per scene.
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
uses. Tools live in `tools/projects.ts`; the server's name and description
come from the `MCP_SERVER_NAME` and `MCP_SERVER_DESCRIPTION` function
secrets.

- **Tools mirror the app's operations:** list projects and invitations, list
  and read files, write one file or a batch with the expected versions, move,
  delete (history keeps the content), create projects and folders, rename,
  archive and unarchive, share, and leave. Share, archive, leave, delete and
  batch saves carry the MCP destructive annotation. There is no tool to
  permanently delete a project or accept an invitation; the database refuses
  both for agents anyway. Search is added with hybrid search.
- **Comment tools** (`tools/comments.ts`): `list_comments` (counts per file,
  or one file's threads found again in the saved file), `add_comment` (on a
  quote copied from the source, a note's heading, a drawing element, or the
  whole file; the tool turns that into the app's anchor), `reply_comment` and
  `resolve_comment` (which also reopens). There are no tools to edit or delete
  a comment, and the database refuses agents' deletes anyway.
- **MCP Apps:** views inside the client: a rendered document with its
  drawings, a single drawing, or a draft component preview, each with a link
  into the app. The `show_file` tool (`tools/fileView.ts`) and the
  `preview_component` tool (`tools/componentPreview.ts`) share one
  `ui://` view. `show_file` renders a note's Markdown (raw HTML
  and other MDX shown as text, except a `<Callout>` written as one block,
  which becomes a callout; sanitized) and draws drawings and diagrams, shown on
  their own or embedded in a note with `<Drawing>` and `<Diagram>`, each with an
  "Open in elaborat.ing" link; an MDX note with other components is then
  previewed with them (below). The server draws them as SVG from the saved
  scene (a diagram from its `.excalidraw` companion) with roughjs, the library
  Excalidraw uses (`tools/drawingSvg.ts`), and sends the SVG in the result's
  `_meta`, which reaches the view but not the model. Limits: 8 different files
  drawn per note, 200,000 characters of SVG each and 600,000 per result, 3,000
  elements per scene. The view is on its own tool, not on `read_file`, so
  agents can read files without filling the chat with views.
- **Notes are edited in the card.** Where the host lets views call tools, a
  note's card has Edit: it runs the app's own rendered editor
  (`FluidEditor` and `prepareFluidTransaction`, so each edit is an exact
  source patch and every other byte stays), with embeds and other MDX as
  islands that cannot be edited. The note's source reaches the view in the
  result's `_meta`. Save calls `write_file` through the bridge with the
  version the card showed, so a note changed since is a conflict, never
  overwritten; the card then reloads with `show_file` and tells the model
  with `ui/update-model-context`.
- **The card is built from the component library.** `src/chat-card` is a
  small React app on the library's components and the Supabase Green
  palette, light or dark as the host says; its states are on `/style-guide`.
  `bun run build:chat-card` builds it into `tools/cardEditorScript.ts`, a
  script and stylesheet the view inlines, committed because the functions
  deploy without building the app. Rebuild it after changing the card or the
  modules it uses, and give the view a new `ui://` URI. Zod runs jitless.
- **Decision: the view is a small shell, and the rest loads when it is
  needed.** The inline script (about 330 kB, 100 kB gzip) shows the file
  from the server's HTML and drawings with no network requests. The same
  build writes the rest to `public/chat-card/`, which every app deploy
  serves at `https://elaborat.ing/chat-card/` with CORS
  (`public/_headers`): the app's fonts (Space Grotesk, JetBrains Mono and
  Excalifont's Latin subset), added once the host has answered; the note
  editor as an ES module the card imports when Edit is pressed; the
  component compiler and the preview frame's runtime, for a note with
  components or a component file; and the charts' library, which the frame
  imports only for a note with a chart. The view declares that origin in
  `_meta.ui.csp.resourceDomains` (and ChatGPT's `openai/widgetCSP`), which
  adds it to `script-src`, `style-src` and `font-src`. A host that does not
  allow it blocks them (or says so in `hostCapabilities.sandbox.csp`, and the
  card does not try): the card then shows the server's HTML, read-only, in
  the host's or the system's fonts, with a line that says the editor or the
  preview could not load. The files have content-hashed names and are
  committed too, since the functions and the app deploy separately;
  `builds.json` keeps the committed build's files next to a new one's, for
  a view whose function deploys before the app or that a host cached.
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

## Component isolation

MDX compiles to JavaScript, and user components run in the browser. They must
never run with the app's privileges.

**Decision:** components render in a sandboxed iframe with no network access,
and the app accepts only a fixed set of validated messages from it. The frame
never receives tokens or files, only compiled code and rendered images.

**Decision: until then, the frame is a `srcdoc` document built into the app.**
`src/preview/preview-entry.tsx` is built by Vite as one script
(`vite-plugins/preview-frame.ts`), so its npm packages are listed in the site's
license notices, and inlined with the frame's styles and fonts into the
`srcdoc`. The iframe has `sandbox="allow-scripts"` only (an opaque origin), and
the frame document carries its own Content Security Policy
(`PREVIEW_CHILD_CSP`): no network, inline script and style only, fonts from
`data:` URLs. MDX's `run()` evaluates compiled code with `new Function`, so the
frame's policy allows `'unsafe-eval'`. A `srcdoc` document also inherits the
parent page's CSP, so any CSP added to `public/_headers` must allow the frame's
inline script, `'unsafe-eval'` and `data:` fonts, or the frame goes blank.
Messages use `postMessage` with target `*` and are checked by `event.source`;
the sandbox domain replaces this with pinned origins.

**Decision: the frame's heavy parts load the first time a note shows them.**
Charts (Recharts) and code highlighting (Shiki and its grammars) are most of
the frame's code, so each is built on its own (`src/preview/modules/`) and
left out of the `srcdoc`. The frame has no network and cannot `import()` a
file, so a chart or code block that renders asks the app for its part by name
(`load-module`); the app imports that file, a chunk precached like any other,
and posts its code back, and the frame runs it with its own React
(`src/preview/frameModules.ts`). Until then a chart keeps its place with an
empty box and code shows as plain text. With the sandbox domain the frame can
import these files itself.

**Decision:** before components are offered publicly, the frame is served from
a separate registrable domain (a "sandbox domain", Google's documented pattern
for untrusted content, like `googleusercontent.com`). Chrome's Site Isolation
groups processes by site, and subdomains of elaborat.ing are the same site, so
only a separate domain gets the frame its own process. That protects against
Spectre-style and renderer attacks, and keeps a runaway component from freezing
the app where the browser isolates cross-site frames (fully on desktop Chrome,
partly on Android).

The chat card previews components the same way, in a frame nested in the
card (see "Agents (MCP)").

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

**Open:** the sandbox domain name, and whether to add it to the Public Suffix
List so each document's subdomain is isolated from every other.

## Rendered editing

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
`elaborat.ing` custom domain, and headers in `public/_headers`. The hosted
instance deploys with `wrangler deploy`, using a Cloudflare API token from the
"Edit Cloudflare Workers" template, restricted to one account and the
`elaborat.ing` zone. Static asset requests are free and unlimited.

The build only needs public values (the Supabase URL and publishable key).
Self-hosters can deploy the same static build to any host.
`.github/workflows/deploy-app.yml` deploys it after CI passes on `main`, with
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
them (react, router, supabase, ui, zod on first paint; monaco, prettier,
prosemirror, mdx and the preview frame later), and the app code every page
starts with goes in `app`, so a deploy that changes only the app's code leaves
those files and their hashes alone and an update downloads only what changed.
A group never moves lazy code into an earlier load: first-paint groups take
only what the entry imports, the others split by what loads them. `bun run
build:visualize` and `bun run report:bundle` show the result.

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
  preview frame (a chunk of its own), the D2 compiler, `.wasm` files and the
  license texts. That is about 44 MB, about 13 MB over the network. The worker registers once the page
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
  `embed_worker`) for the embed pipeline. The platform creates keys; the CLI
  can only list them.
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
rules. They run against the hosted project inside a transaction that is rolled
back. The canonical runner is `supabase test db` pointed at the project; until
CI runs them, the maintainer runs them before each schema change lands.

**Decision:** browser tests use Playwright with axe, in Chromium and Firefox,
against production builds: the app, and a test-only harness page
(`tests/browser/harness/`) that mounts real components built with the app's
plugins. Each accessibility check has a positive control that plants a known
violation, so a check that can no longer fail is caught. CI runs them on every
pull request.

Database, auth and function changes are verified on a hosted project.
