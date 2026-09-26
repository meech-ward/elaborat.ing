# Platform notes

Facts about Supabase and Cloudflare that shape the architecture, checked
against primary sources on 2026-09-25 with Supabase CLI 2.118.0. Platforms
change: re-check a fact before relying on it for something new, and update this
page when it moves.

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
- **The schema directory is the full desired state.** Undeclared objects,
  including extensions, are planned as removals.
- **DML is never part of the schema.** It is an error inside a declarative
  file. pgmq queues and pg_cron jobs are handled by pg-delta as "extension
  intent" in recent versions, but the public guide only documents pgmq; test the
  round-trip on the pinned CLI before relying on it for cron.
- **Branch deploys run each migration in one transaction** and ignore pg-delta's
  `transaction=false` marker, so `create index concurrently` fails there.
  [Branching with GitHub](https://supabase.com/docs/guides/deployment/branching/github-integration)
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

## Browser isolation

- **Chrome's Site Isolation groups processes by site** (scheme plus registrable
  domain), not origin, so subdomains can share a process. Coverage is full on
  desktop Chrome and partial on Android. Google's guidance puts untrusted
  active content on a separate registrable domain.
  [Same-site and same-origin](https://web.dev/articles/same-site-same-origin),
  [securely hosting user data](https://web.dev/articles/securely-hosting-user-data)
