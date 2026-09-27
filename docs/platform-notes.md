# Platform notes

Facts about Supabase, Cloudflare and MCP Apps hosts that shape the
architecture, checked against primary sources on 2026-09-25 with Supabase CLI
2.118.0 (MCP Apps hosts on 2026-09-26). Platforms change: re-check a fact
before relying on it for something new, and update this page when it moves.

## Supabase: schema and config as code

- **Declarative schemas use pg-delta**, the default diff engine for projects
  created by a recent `supabase init` (still under `[experimental.pgdelta]`,
  pre-1.0). Migrations are generated with `supabase db schema declarative sync`,
  which compares `supabase/schemas/` against the migration history, not the
  live database. Changes made in the dashboard are invisible to it.
  [Declarative schemas](https://supabase.com/docs/guides/local-development/declarative-database-schemas),
  [diff engines](https://supabase.com/docs/guides/local-development/diff-engines)
- **pg-delta models** tables, views, functions, triggers, RLS policies, grants,
  comments, domains, partitions and publications. Unsupported kinds (casts,
  operators, text search configurations and a few others) go in
  `supabase/schemas/_custom/` and ship through a versioned migration.
- **pg-delta compares constraints as `pg_get_constraintdef` text**, so a
  definition must store the same way from the schema and from its generated
  migration. A check that puts `between` next to another `and` does not:
  Postgres stores it nested, but the generated migration spells it out and is
  stored flat, so every sync reports a change. Write such checks with `>=` and
  `<=`.
  [Constraint facts](https://github.com/supabase/pg-delta/blob/main/packages/pg-delta/src/extract/relations.ts)
- **The schema directory is the full desired state.** Undeclared objects,
  including extensions, are planned as removals.
- **DML is never part of the schema.** It is an error inside a declarative
  file. The exception is extension intent: `select pgmq.create(...)` and
  `select cron.schedule(...)` belong in the schema file. Checked on CLI
  2.118.0: pg-delta generates them (the cron job as
  `cron.schedule_in_database`), a second sync finds no changes, and a queue or
  job created only in a migration is planned for removal.
- **Branch deploys run each migration in one transaction** and ignore pg-delta's
  `transaction=false` marker, so `create index concurrently` fails there.
  [Branching with GitHub](https://supabase.com/docs/guides/deployment/branching/github-integration)
- **`supabase db push` does not run as a superuser.** A function that sets an
  extension's parameter (`set hnsw.iterative_scan`) fails there with "permission
  denied to set parameter" unless the extension is loaded in that session:
  until then the parameter is an unknown placeholder, which only a superuser may
  set. pg-delta does not add the load, so a generated migration that creates
  such a function needs `select '[0]'::extensions.vector;` before it, by hand.
  Checked on CLI 2.118.0.
- **Tables are no longer exposed to the Data API automatically.** New projects
  since 2026-05-30, all projects from 2026-10-30. Grant explicitly.
  [Changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- **`supabase config push`** writes API, database settings, network
  restrictions, SSL enforcement, Auth and Storage settings. It is not a full
  reconciler: undeclared remote values are left alone. It never sets JWT signing
  keys, and it does not push passkey or WebAuthn settings in 2.118.0.
  `[auth.oauth_server]` is pushed.
- **Storage buckets** in `config.toml` are applied by `supabase seed buckets`,
  not `config push`.
- **Vault secrets** declared under `[db.vault]` are synced by `supabase db push`
  when it applies migrations (unless `--skip-vault`). Confirm how `env()` values
  are handled on first use.
- **Edge Function settings** (`verify_jwt`, `import_map`, `entrypoint`) live under
  `[functions.<name>]` and apply on `supabase functions deploy`. `--use-api`
  bundles on Supabase's side, with no Docker needed.
  [Deploy functions](https://supabase.com/docs/guides/functions/deploy)
- **Generating migrations needs shadow Postgres databases** locally, via Docker.
  A newer Docker-free runtime exists in the CLI source, but its docs aren't
  published and it is unverified. The cloud applies migrations but does not
  generate them.
- **`auto_expose_new_tables`** in `[api]` controls whether the local and shadow
  databases grant Data API access to new tables automatically. Set it to
  `false` to match new hosted projects. The CLI template notes the field is due
  to be removed on 2026-10-30; re-check then.

## Supabase: environments and testing

- **Branching** (preview and persistent branches) needs the Pro plan and bills
  branch compute hourly outside the spend cap. CLI deploys (`link`, `db push`,
  `config push`, `functions deploy`) work on every plan.
  [Branching](https://supabase.com/docs/guides/deployment/branching),
  [managing environments](https://supabase.com/docs/guides/deployment/managing-environments)
- **Branches don't get `schemas/`**, only committed migrations. Seed runs once at
  branch creation. With the GitHub integration, `config.toml` applies to
  preview branches by default and to persistent ones only through a
  `[remotes.<name>]` block. Branches created from the CLI or dashboard don't get
  it automatically: run `config push --project-ref <branch>`.
- **Free projects** pause after a week of inactivity, and a free account can
  have two active projects. [Pricing](https://supabase.com/pricing)

## Supabase: Realtime

Checked on 2026-09-26 against the docs' source in `supabase/supabase` and
Realtime's own source in `supabase/realtime`.

- **Broadcast from the database** is `realtime.send(payload, event, topic,
  private)`, which inserts into `realtime.messages`; Realtime streams the
  inserts to the topic's subscribers. A private message reaches only private
  channels and a public one only public channels, so the "Allow public access"
  setting does not affect private messages.
  [Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- **`realtime.send` never raises.** A failed insert becomes a
  `WarnSendingBroadcastMessage` warning and the caller's transaction carries
  on. It also adds a message `id` to the payload.
- **Messages go in daily partitions that only a connecting client creates.**
  When a client joins a channel, Realtime creates partitions from yesterday to
  three days ahead, and a janitor moves the window along while clients keep
  connecting. With no partition for today, `realtime.send` drops the message
  with that warning; nobody was listening anyway. A database test that counts
  queued messages needs today's partition.
  [WarnSendingBroadcastMessage](https://supabase.com/docs/guides/troubleshooting/realtime-warn-sending-broadcast-message)
- **Private channels are authorized by RLS on `realtime.messages`.** When a
  client joins, Realtime inserts a probe message on the topic, sets `role`,
  `request.jwt.claims` and `realtime.topic` as that client, checks whether it
  can select the probe, and rolls back. A select policy lets clients receive;
  an insert policy would let them send. The answer holds for the connection
  until the client sends a new token, so someone who loses access keeps
  receiving until their token expires.
  [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization),
  [authorization.ex](https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/authorization.ex)
- **Policies on `realtime.messages` are declared in `supabase/schemas/`**, and
  pg-delta generates them. The table's RLS is already on:
  `alter table realtime.messages enable row level security` fails with
  `must be owner of table messages` and aborts the migration.

## Supabase: search and embeddings

- **Hybrid search** runs full-text and pgvector searches separately and fuses
  them with Reciprocal Rank Fusion. The documented function caps results at 30.
  [Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search)
- **Automatic embeddings** use pgvector, pgmq, pg_net, pg_cron (hstore is
  optional), a queueing trigger, a cron job every 10 seconds and an `embed` Edge
  Function. The guide assumes an integer `id` key; adapt the payload for uuids.
  [Automatic embeddings](https://supabase.com/docs/guides/ai/automatic-embeddings)
- **The guide's function call has an auth gap** when pg_cron is the caller. The
  current guidance for database-called functions is `verify_jwt = false` plus a
  secret key checked in the function, with the key stored in Vault.
  [Function auth](https://supabase.com/docs/guides/functions/auth),
  [scheduling functions](https://supabase.com/docs/guides/functions/schedule-functions)
- **Built-in embeddings:** `Supabase.ai.Session('gte-small')`, 384 dimensions,
  English only, 512-token input, no API key, no extra cost. Normalized output
  makes inner product equal to cosine.
  [AI models](https://supabase.com/docs/guides/functions/ai-models),
  [semantic search example](https://supabase.com/docs/guides/functions/examples/semantic-search)
- **Hosted function limits:** 2 s CPU per request, 256 MB memory, 150 s wall
  clock on Free. [Limits](https://supabase.com/docs/guides/functions/limits)
- **Self-hosted Supabase (Docker)** is a different setup from running your own
  copy on Supabase Cloud, and elaborat.ing doesn't target it yet. There,
  functions default to 150 MB and 60 s with one global `verify_jwt` setting,
  gte-small downloads its model on first use, and nobody has checked that it
  fits in 150 MB.

## Supabase: auth

- **Passkeys** are an experimental first-factor sign-in ("the API may change
  without notice"), needing supabase-js 2.105.0 or later. A user must sign in
  another way before registering one. Changing the relying-party ID invalidates every
  passkey, so choose it before users enroll.
  [Passkeys](https://supabase.com/docs/guides/auth/passkeys)
- **Custom OAuth/OIDC providers:** any provider with an issuer URL, up to 3 on
  Free, set up in the dashboard or the Auth Admin API only.
  [Custom providers](https://supabase.com/docs/guides/auth/custom-oauth-providers)
- **Sign in with ChatGPT** is a partner-only beta. Supabase's own announcement is
  about signing in to supabase.com.
  [Blog](https://supabase.com/blog/sign-in-with-chatgpt-beta)
- **There is no Sign in with Claude** for third-party apps, and Anthropic's terms
  don't allow apps to offer Claude.ai login.
  [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- **Email:** the built-in sender is for testing only; production needs custom
  SMTP. [SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- **CAPTCHA:** hCaptcha or Cloudflare Turnstile, declared in `[auth.captcha]`.
  [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha)
- **OAuth 2.1 server:** beta, all plans, no extra charge. OIDC ID tokens need
  asymmetric signing keys, and the MCP server helper (`withSupabase`) rejects
  legacy HS256 tokens. Client redirect URIs must match exactly. Supabase's
  BYO-MCP guide enables dynamic client registration.
  [Getting started](https://supabase.com/docs/guides/auth/oauth-server/getting-started),
  [MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication),
  [BYO MCP](https://supabase.com/docs/guides/ai-tools/byo-mcp)
- **UI Library blocks** install with the shadcn CLI from the `@supabase`
  registry (`components.json` maps it to `https://supabase.com/ui/r/{name}.json`).
  Checked 2026-09-26 with shadcn 4.21.0 on this repo: the CLI wrote
  `import { cn } from "cn"` in new primitives and added a `cn` npm package,
  and it replaced the pinned `@supabase/supabase-js` with a `^latest` range.
  Fix the imports to `@/lib/utils`, and restore `package.json` and `bun.lock`.
  It also writes an `.env.local` with empty `VITE_SUPABASE_*` entries.
  [Supabase UI Library](https://supabase.com/ui)
- **Redirect URLs** in `additional_redirect_urls` are matched as globs, so
  `https://elaborat.ing/**` allows any path on the site.
  [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

## Cloudflare

- **Workers with static assets** is Cloudflare's recommended home for new
  projects, over Pages. SPA fallback must be set explicitly with
  `not_found_handling = "single-page-application"`.
  [Pages](https://developers.cloudflare.com/pages/),
  [React + Vite on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- **`wrangler.jsonc`** is the recommended config file and should be treated as
  the source of truth. Custom domains are routes with `custom_domain = true`
  and need the domain's DNS on Cloudflare.
  [Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
  [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- **Headers** come from `public/_headers` for static assets. Check after deploy
  that the SPA fallback page gets them too.
  [Headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- **Workers Builds** deploys from GitHub on push, keeps its own token, and posts
  preview URLs on pull requests.
  [Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- **Static asset requests are free and unlimited.**
  [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

## MCP Apps hosts

OpenAI's Apps SDK documentation could not be reached when this section was
checked, so the ChatGPT entry rests on the spec and OpenAI's example code.
Re-check it against OpenAI's pages linked below.

- **A server declares a view's CSP as lists of origins.** `_meta.ui.csp` goes on
  the `ui://` resource's content in the `resources/read` result (the draft spec
  also reads it from the `resources/list` entry, and the content wins). The
  lists are `connectDomains` (`connect-src`), `resourceDomains` (`script-src`,
  `style-src`, `img-src`, `font-src`, `media-src`), `frameDomains`
  (`frame-src`) and `baseUriDomains` (`base-uri`). There is no field for CSP
  keywords, so a server cannot ask for `'unsafe-eval'`. Hosts must not allow
  undeclared origins, may restrict further, and tell the view what they
  approved in `HostCapabilities.sandbox.csp` when it initializes.
  [Spec, stable 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
  [draft](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- **The spec's default policy has no `'unsafe-eval'`.** Without `ui.csp`, a host
  must apply `default-src 'none'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:;
  connect-src 'none'` (the draft adds `object-src 'none'`). That runs inline
  scripts, but not `eval` or `new Function`, which need `'unsafe-eval'`.
- **The official SDK assumes views cannot use `eval`.** Its `App` class says
  views "typically run under a strict CSP without `unsafe-eval`", puts Zod in
  jitless mode by default for that reason, and offers `allowUnsafeEval` only
  for hosts known to permit it. The change that added it names VS Code as a
  host enforcing the default policy. The repository's example host allows
  `'unsafe-eval'`, but the repository has no supported host implementation.
  [`AppOptions`](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/app.ts),
  [the change](https://github.com/modelcontextprotocol/ext-apps/commit/9d68315720d021c448f55b57eac1f4395b3472ad),
  [example host](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/serve.ts)
- **Claude** renders each view in a sandboxed iframe (a native WebView on iOS
  and Android) from a `*.claudemcpcontent.com` origin, under "strict Content
  Security Policies". Views declare origins with `_meta.ui.csp`, except that
  `frameDomains` is restricted pending security review. By default the frame
  runs only inline scripts and scripts from its own origin, and
  `resourceDomains` adds origins to `script-src`. Anthropic's documentation
  never mentions `'unsafe-eval'`, so a view cannot count on `eval` or
  `new Function`.
  [Design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines),
  [quickstart](https://claude.com/docs/connectors/building/mcp-apps/quickstart),
  [theming](https://claude.com/docs/connectors/building/mcp-apps/transparent-theming),
  [interactive connectors](https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude)
- **ChatGPT links a tool to its view with the standard `_meta.ui.resourceUri`**
  and the `ui/*` bridge; `_meta["openai/outputTemplate"]` is only a
  compatibility alias. OpenAI recommends putting the view on a separate render
  tool rather than on every data tool, since a view on every call re-renders
  too often. (Checked 2026-09-26.)
  [MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt.md),
  [reference](https://developers.openai.com/plugins/reference.md)
- **ChatGPT** takes the standard `_meta.ui.csp`, which OpenAI's current
  examples declare. Its original Apps SDK format declared the same lists in
  `_meta["openai/widgetCSP"]` (`connect_domains`, `resource_domains`,
  `frame_domains`, and the OpenAI-only `redirect_domains`). Whether ChatGPT's
  frame allows `'unsafe-eval'` is unchecked.
  [OpenAI example](https://github.com/openai/openai-apps-sdk-examples/blob/main/cards_against_ai_server_node/src/server.ts),
  [field mapping](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md),
  [MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt/),
  [security and privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)

- **A view calls the server's tools with `tools/call`** through the host,
  which proxies it when it lists `serverTools` in its capabilities. A tool's
  `_meta.ui.visibility` says who may call it (default `["model", "app"]`;
  hosts must refuse app calls to a tool without `"app"`). ChatGPT also reads
  its older `_meta["openai/widgetAccessible"]` and offers
  `window.openai.callTool`. `ui/update-model-context` gives the model context
  for its next turn without starting one; `ui/message` posts a user message
  and does start one. (Checked 2026-09-27.)
  [Spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
  [Apps SDK reference](https://developers.openai.com/apps-sdk/reference),
  [MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt.md)
- **Data only for the view goes in the tool result's `_meta`.** The spec passes
  `content`, `structuredContent` and `_meta` to the view in
  `ui/notifications/tool-result` and says only `content` is for the model, but
  ChatGPT shows `structuredContent` to the model too and keeps `_meta` from it.
  ChatGPT dropped `_meta` from that notification until a fix in May 2026; it
  also hands it to the view as `window.openai.toolResponseMetadata`. Hosts cache
  a view by its `ui://` URI, so a changed view gets a new URI. (Checked
  2026-09-27.)
  [Spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
  [Apps SDK reference](https://developers.openai.com/apps-sdk/reference),
  [the `_meta` fix](https://community.openai.com/t/mcp-apps-ui-notifications-tool-result-missing-meta-in-chatgpt/1375226)

## Browser isolation

- **Chrome's Site Isolation groups processes by site** (scheme plus registrable
  domain), not origin, so subdomains can share a process. Coverage is full on
  desktop Chrome and partial on Android. Google's guidance puts untrusted
  active content on a separate registrable domain.
  [Same-site and same-origin](https://web.dev/articles/same-site-same-origin),
  [securely hosting user data](https://web.dev/articles/securely-hosting-user-data)
