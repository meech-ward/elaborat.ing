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
  └─ Edge Functions ....... mcp (agents), embed (search indexing), search (query embedding)

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
  `config.toml` under `[db.vault]` with `env()` values. **To verify on the first
  deploy:** that `env()` values reach the hosted Vault, and how to rotate a
  secret when no migration is pending (`db push` only syncs Vault when it
  applies migrations; the fallback is a documented `vault.update_secret` step).
- **`config.toml` holds the hosted project's values.** There is no local stack,
  so the file describes the real project: site URL, redirect URLs, email
  confirmation and so on. Self-hosters change these for their own copy.
- **Generating migrations needs a throwaway Postgres.** The sync command builds
  shadow databases locally, which needs Docker (an experimental Docker-free
  runtime exists but is undocumented and unverified). That happens on a
  developer machine or in CI. The cloud project is where changes are applied
  and tested, never where they are generated.

## Deploys

**Decision:** GitHub Actions run the Supabase CLI against the hosted project on
merge to `main`: `supabase link --project-ref`, `supabase config push`,
`supabase db push`, then `supabase functions deploy --use-api`. This extends
Supabase's documented link-and-push pattern for environments with config and
functions, works on every plan, and self-hosters can run the same steps from
their own fork. The access token, database password and project ref are GitHub
repository secrets. The workflow shows `supabase config diff` before pushing
config.

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
invitation) themselves.

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

(The prototype stored a full snapshot of the whole project as each revision.
That was simple for one person, but it duplicates everything on every save and
makes edits to different files conflict. It is not carried forward.)

**Decision:** agents archive, people delete. Archive and unarchive are available
to any editor, including agents. Permanent delete is for the project owner
only, in a normal user session: the database refuses it when the token came
from an OAuth client (the JWT carries a `client_id` claim). Changing a password
requires recent sign-in (`secure_password_change`), so an OAuth client token
cannot be turned into a normal session that way. Phase 1 confirms on real
clients that Auth refuses account changes from OAuth client tokens.

**Decision: change signals use Realtime Broadcast from the database.** Clients
learn that a project changed from a private Broadcast channel per project,
authorized by RLS on `realtime.messages`, which is Supabase's recommended
approach. Postgres Changes is not used: it delivers DELETE events to every
subscriber regardless of RLS. This is built with the client sync in phase 2.

## Search

**Decision:** hybrid search, following Supabase's documented pattern.

- **Chunks, not whole files.** Each Markdown/MDX/D2 file is split into passages
  by heading. The built-in embedding model (`gte-small`) reads English only and
  truncates at 512 tokens, so long sections are split further.
- **Keyword half:** a generated `tsvector` column with a GIN index.
- **Semantic half:** a `vector(384)` column (gte-small, normalized, inner
  product) with an HNSW index.
- **Fusion:** the documented `hybrid_search` SQL function, Reciprocal Rank
  Fusion over both result lists, returning passages grouped back to files.
  It runs as the caller, so RLS limits results to projects the user can read:
  their own and those shared with them.
- **Automatic embeddings:** Supabase's documented pattern. A trigger queues
  changed chunks in a pgmq queue, a pg_cron job sends batches to the `embed`
  Edge Function, which writes embeddings and deletes the jobs. Failed jobs
  retry automatically.
- **Embedding model:** Supabase's built-in `gte-small`, run inside Edge
  Functions with no API key and no extra cost, on any Supabase Cloud project.
- **Function auth:** `embed` is called by the database, not a user, so it sets
  `verify_jwt = false` and checks a secret key itself (the documented pattern
  for cron-called functions). The key and the project URL live in Vault,
  declared in `config.toml`.
- **Query embedding:** a `search` Edge Function embeds the query with the same
  model and calls `hybrid_search` as the user.

**Open:** check that RLS filtering doesn't hurt HNSW recall for small per-user
result sets; pgvector's iterative index scans are the documented fix.

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
- A section comment quotes its heading. A document comment has no selector.
- A drawing comment uses the Excalidraw element ID, which is stable.
- A comment that can no longer be found is shown as detached, at document
  level, with its original quote. Nothing is ever written into the source.

## Accounts

**Decision:** Supabase Auth with these sign-in methods, configured in
`config.toml` wherever the CLI supports it.

- **Email:** password, magic link and one-time code. Production needs custom
  SMTP; Supabase's built-in sender is for testing only.
- **Social:** GitHub and Google.
- **Passkeys:** Supabase's passkey sign-in (experimental; the API may change).
  A person signs up another way first, then adds a passkey.
- **Phone codes:** only with an SMS provider, rate limits and CAPTCHA, because
  SMS costs money per message and attracts abuse.
- **CAPTCHA:** Cloudflare Turnstile on sign-up, sign-in and password reset.
- **Not possible today:** "Sign in with ChatGPT" is a partner-only beta, and
  there is no "Sign in with Claude"; Anthropic doesn't allow apps to offer
  Claude.ai login. If OpenAI opens its sign-in to all apps, it can be added as a
  custom OIDC provider. None of this affects agents: Claude and ChatGPT connect
  through the OAuth server below, where elaborat.ing is the one issuing access.

**Decision:** hosted limits are generous and exist only to stop abuse.
Numbers are set when accounts ship.

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
- **MCP Apps:** read-only views inside the client: a rendered document with its
  drawings, a single drawing, or a draft component preview, each with a link
  into the app.
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
- **Previews are compiled before they reach the client.** An MCP Apps server
  can declare origins but not CSP keywords, so it cannot ask for
  `'unsafe-eval'`. The spec's default policy leaves it out, Claude's
  documentation never mentions it, and a host may always restrict further. So
  a view never runs code through `eval` or `new Function`: component code is
  compiled to JavaScript before the view gets it, and the view runs it as an
  ordinary script, inline or from an origin it declares in `resourceDomains`.
  Details in [platform notes](platform-notes.md#mcp-apps-hosts).

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

**Decision:** before components are offered publicly, the frame is served from
a separate registrable domain (a "sandbox domain", Google's documented pattern
for untrusted content, like `googleusercontent.com`). Chrome's Site Isolation
groups processes by site, and subdomains of elaborat.ing are the same site, so
only a separate domain gets the frame its own process. That protects against
Spectre-style and renderer attacks, and keeps a runaway component from freezing
the app where the browser isolates cross-site frames (fully on desktop Chrome,
partly on Android).

What the domain does not fix: a component can still navigate its own frame
(carrying out whatever the frame displays) and can draw a fake login prompt
inside its own rectangle. The mitigations are what the frame is given (only
the document's compiled code and rendered images, never tokens or other files)
and a notice on shared projects that they run custom code.

**Open:** the sandbox domain name, and whether to add it to the Public Suffix
List so each document's subdomain is isolated from every other.

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

**Decision: Excalidraw's fonts are served from this site.** Left alone,
Excalidraw fetches fonts from a public CDN. The build copies the pinned
package's fonts to `/excalidraw-assets/` and the app points Excalidraw there at
startup, so drawings work offline and no font request leaves the site. The
font-subset worker is built as its own worker graph; bundled as app code it
imports the DOM entry and fails.

## Manual steps

Settings with no file-based home yet. Each is a one-time step, to be written up
in the self-host guide (phase 3), until the platform supports it as code.
(SMTP and SMS providers are not on this list: they go in `config.toml`, with
secrets supplied through `env()` from GitHub repository secrets.)

- **JWT signing keys:** the project must sign with an asymmetric key. New
  projects already do (the hosted project publishes an ES256 key); older
  projects switch in the dashboard.
- **Passkey and WebAuthn settings:** `config push` doesn't send them yet.
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
