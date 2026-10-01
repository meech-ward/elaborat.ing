# Self-host guide

Run your own copy of elaborat.ing on a free Supabase project: the app, sync
between devices, search, sharing, and agents (Claude, ChatGPT or any MCP
client) working on your projects.

The app is a static site. Everything else is Supabase: Auth, Postgres with
row-level security, Realtime and six Edge Functions (`mcp-server`, `embed`,
`search`, `share`, `delete-account`, `send-events`). There is no other server. [Architecture](architecture.md)
explains the design; this page is the steps.

Placeholders used below:

- `<ref>`: your Supabase project ref, the `<ref>` in `https://<ref>.supabase.co`.
- `<site>`: the origin that serves the app, such as
  `https://elaborating.<your-subdomain>.workers.dev` or your own domain.

## What you need

- A GitHub account and a fork of this repository (a plain clone works if you
  deploy from your machine).
- A Supabase account. The free plan allows two active projects.
- [Bun](https://bun.sh) 1.4 (CI uses 1.4.2). The Supabase CLI runs through
  `bunx` at the version this repository pins, 2.118.0, so there is nothing to
  install. Every command below spells it `bunx supabase@2.118.0`.
- To host on Cloudflare: a Cloudflare account. Wrangler is a dev dependency of
  this repository and runs on Node.js.
- Optional: an email provider with SMTP and a verified sending domain (see
  [Email](#email-smtp-is-optional)).
- Docker only if you change the database schema, to generate migrations.

## 1. Create the Supabase project

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a new
   project. Choose a region near you and keep the database password: the CLI
   asks for it as `SUPABASE_DB_PASSWORD`.
2. Note the project ref (Project Settings > General, or the URL).
3. Under Project Settings > API Keys:
   - copy the **publishable key** (`sb_publishable_...`). It is public; the
     app is built with it.
   - create a **secret key** for the database (the hosted instance names it
     `embed_worker`). The database uses it to call the `embed` function. Keep
     it secret.
4. Check that the project signs tokens with an asymmetric key. New projects
   do; an older project switches under JWT Keys in the dashboard. The MCP
   server refuses tokens signed the legacy way.
5. Create a personal access token (Account > Access Tokens) and sign the CLI
   in with it:

   ```sh
   bunx supabase@2.118.0 login
   ```

## 2. Make the repository yours

A few files hold the hosted instance's values. Change them before you deploy.

| File | Setting | Change to |
| --- | --- | --- |
| `supabase/config.toml` | `[auth]` `site_url` | `<site>`. Auth builds email links from it, and sends agents to `<site>/oauth/consent` for consent. |
| `supabase/config.toml` | `[auth]` `additional_redirect_urls` | `["<site>/**", "http://localhost:5173/**"]` (the second is `bun run dev`) |
| `supabase/config.toml` | `[auth.webauthn]` `rp_id`, `rp_origins` | `<site>`'s host name, and `["<site>"]`. Passkeys work only on that domain, and changing it later makes every passkey stop working. `config push` does not send these: turn passkeys on in the dashboard (Authentication, Passkeys) with the same values, or leave them off. |
| `supabase/config.toml` | `[auth.email.smtp]` `host`, `port`, `admin_email`, `sender_name` | Your provider's values, or `enabled = false` (see [Email](#email-smtp-is-optional)) |
| `supabase/config.toml` | `[db.pooler]` `default_pool_size`, `max_client_conn` | `config push` sets these on your pooler. They hold the hosted project's values; if `config diff` shows a change, set them to your project's current values. |
| `wrangler.jsonc` | `vars.MCP_UPSTREAM` | `https://<ref>.supabase.co/functions/v1/mcp-server` |
| `wrangler.jsonc` | `routes` | Your domain, or remove it to serve from `workers.dev`. You may rename `name` too. |
| `supabase/functions/mcp-server/tools/fileView.ts` | `APP_ORIGIN` | `<site>`. The chat card's "Open in elaborat.ing" links go here, and its view's policy lets it load its editor, previews and fonts from here. |
| `src/chat-card/toolResult.ts` | `APP_ORIGIN` | `<site>/`, then `bun run build:chat-card`. The chat card follows only links to this origin. |
| `scripts/build-chat-card.ts` | `MODULES_URL` | `<site>/chat-card/`, then `bun run build:chat-card`. Where the chat card loads its editor, previews and fonts from (`public/chat-card`). |
| `supabase/functions/share/index.ts` | `redirectTo` | `<site>/`. Where an invitation email's link lands. (Auth sends a link it does not allow to `site_url` instead, so leaving it does no harm once the hosted origin is out of your redirect list.) |

Optional: the email subjects in `config.toml` and the templates in
`supabase/templates/` name elaborat.ing.

The support, privacy and terms pages (`/support`, `/privacy` and `/terms`, in `src/features/legal/`) are generic text, not legal advice: whoever runs a copy, the hosted one included, should review them and change what does not fit, `SOURCE_REPOSITORY` too.

If you don't know `<site>` yet (a `workers.dev` address is shown on the first
deploy), deploy the app first (steps 4 and 5), then set `site_url` and push the
config again.

### The environment values in config.toml

`config.toml` reads secrets from the environment with `env(...)`. Every one of
them:

| Variable | Setting | What to put there |
| --- | --- | --- |
| `ELABORATING_PROJECT_URL` | `[db.vault]` `project_url` | `https://<ref>.supabase.co` |
| `ELABORATING_EMBED_SECRET_KEY` | `[db.vault]` `embed_secret_key` | The secret key from step 1 |
| `SES_SMTP_USER`, `SES_SMTP_PASSWORD` | `[auth.email.smtp]` `user`, `pass` | Your SMTP user name and password. Any provider works; the names are the hosted instance's. Unused when SMTP is off. |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | `[auth.external.github]`, off | Only if you turn GitHub sign-in on (see below) |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` | `[auth.external.google]`, off | Only if you turn Google sign-in on |
| `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` | `[auth.external.apple]`, off | Leave unset |
| `SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN` | `[auth.sms.twilio]`, off | Leave unset |
| `OPENAI_API_KEY` | `[studio]` | Leave unset. Only a local Studio reads it. |
| `S3_HOST`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `[experimental]` | Leave unset. The app doesn't use OrioleDB. |

A value in a section that is off is never sent, so leaving those unset is fine.

**GitHub and Google sign-in** are off. To turn one on, create an OAuth app at
the provider with the callback URL `https://<ref>.supabase.co/auth/v1/callback`,
set `enabled = true` in its section, and supply its client id and secret in the
variables above. The sign-in page shows a provider's button only while Auth
reports it on.

### Email (SMTP is optional)

Supabase Auth sends the sign-in, sign-up and invitation emails.

**With SMTP** (the hosted instance uses AWS SES; Resend, Postmark and others
work the same way): set the four literal values in `[auth.email.smtp]` and the
two variables above. `[auth.rate_limit]` `email_sent = 30` caps Auth at 30
emails an hour for the whole project, the value Supabase sets when custom SMTP
is first saved; raise it within your provider's quota.

**Without SMTP**: set `enabled = false` under `[auth.email.smtp]`. Supabase's
built-in sender then takes over, which is meant for trying things out:

- It delivers only to the addresses of your Supabase organization's team
  members, so nobody else can sign up or sign in by email. Other addresses fail
  with "Email address not authorized".
- It sends only a few emails an hour, and `email_sent` is not applied.
- Inviting someone by email who has no account fails: the `share` function
  answers "The invitation email could not be sent". Sharing with someone who
  already has an account sends no email, so it still works.

That is fine for a copy only you use, signed in with your Supabase account's
email. See [Supabase's SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp).

## 3. Deploy the backend

Run these from the repository root, in this order. They are the same commands
`.github/workflows/deploy-supabase.yml` runs. Each `read -rs` line waits for
you to paste a value without showing it.

```sh
export SUPABASE_PROJECT_ID=<ref>

# Edge Functions first, so `embed` exists before the database gets its key.
bunx supabase@2.118.0 functions deploy --use-api --yes --project-ref "$SUPABASE_PROJECT_ID"

# The database, and the Vault secrets for search.
read -rs SUPABASE_DB_PASSWORD && export SUPABASE_DB_PASSWORD
read -rs ELABORATING_EMBED_SECRET_KEY && export ELABORATING_EMBED_SECRET_KEY
export ELABORATING_PROJECT_URL="https://$SUPABASE_PROJECT_ID.supabase.co"
bunx supabase@2.118.0 db push --yes --project-ref "$SUPABASE_PROJECT_ID"

# Auth, email, API and storage settings. Read the diff before pushing.
read -rs SES_SMTP_USER && export SES_SMTP_USER          # skip both without SMTP
read -rs SES_SMTP_PASSWORD && export SES_SMTP_PASSWORD
bunx supabase@2.118.0 config diff --project-ref "$SUPABASE_PROJECT_ID"
bunx supabase@2.118.0 config push --yes --project-ref "$SUPABASE_PROJECT_ID"
```

**Edge Functions.** `functions deploy` deploys every function in
`supabase/functions/` with its `verify_jwt` setting from `config.toml`, and
`--use-api` bundles them on Supabase's side, so Docker is not needed. The MCP
server calls itself `elaborat.ing` unless you give it another name. To set
your own name and description, edit them in
`supabase/functions/mcp-server/.env.example`, then:

```sh
cp supabase/functions/mcp-server/.env.example supabase/functions/.env
bunx supabase@2.118.0 secrets set --project-ref "$SUPABASE_PROJECT_ID" --env-file supabase/functions/.env
```

`supabase/functions/.env` is ignored by git.

**The database.** `db push` applies `supabase/migrations/` (generated from the
declarative schema in `supabase/schemas/`): tables, row-level security,
grants, functions, per-user limits, the search index and its queue, and a
`pg_cron` job. When it applies migrations it first writes `[db.vault]` to Vault
from the two `ELABORATING_*` variables. It writes them **only when it applies
a migration**, so on a project that is already up to date, add or change them
in the dashboard's SQL editor instead:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<the secret key>', 'embed_secret_key');
-- To change one that exists:
select vault.update_secret((select id from vault.secrets where name = 'embed_secret_key'), '<new key>');
```

**Config.** `config push` writes the Auth settings (site URL, redirect URLs,
email, templates, rate limits, the OAuth server), API, database and storage
settings from `config.toml`. It leaves anything the file doesn't declare as it
is, and it is not atomic, which is why `config diff` comes first. Run it again
whenever you change `config.toml`.

### Search and embeddings

Saving a note, diagram or drawing queues it. Every 10 seconds the `pg_cron` job
reads `project_url` and `embed_secret_key` from Vault and sends waiting files
to the `embed` function, which splits them into passages and embeds them with
Supabase's built-in `gte-small` model: no API key and no extra service. It
calls the function only when files are waiting. Until both Vault secrets exist,
files wait in the queue and search finds nothing; they are indexed once the
secrets are there.

### Agents: the OAuth server

`[auth.oauth_server]` in `config.toml` turns on Supabase Auth's OAuth 2.1
server, with its consent page at `<site>/oauth/consent` (the app's) and dynamic
client registration on. MCP clients register themselves, so you create nothing
for Claude or ChatGPT, and their redirect URLs don't go in your redirect list.
The MCP server (`mcp-server`) checks each token itself and runs every tool as
the signed-in person, so row-level security applies to agents exactly as it
does to the app.

Check that it is up. An unauthenticated call is refused with a pointer to the
OAuth metadata:

```sh
curl -s -o /dev/null -D - -X POST https://<ref>.supabase.co/functions/v1/mcp-server | grep -i '^www-authenticate'
curl -s https://<ref>.supabase.co/auth/v1/.well-known/oauth-authorization-server
```

The first prints `Bearer resource_metadata="..."`. The second shows a
`registration_endpoint` when dynamic registration is on. Once the app is
hosted on Cloudflare (step 5), the same first check against `<site>/mcp` names
`<site>/mcp/oauth-protected-resource`.

## 4. Build the app

The build needs only two public values, which Vite inlines:

```sh
cp .env.example .env.local
# VITE_SUPABASE_URL=https://<ref>.supabase.co
# VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
bun install --frozen-lockfile
bun run build
```

The app is in `dist/`. A build without these values opens with "This copy of
elaborat.ing is not connected to a Supabase project yet."

## 5. Host it

### On Cloudflare Workers

This is how the hosted instance runs. `wrangler.jsonc` serves `dist/` as static
assets, with unknown paths falling back to `index.html` so the app's URLs work,
and headers from `public/_headers`. A small Worker (`worker/index.ts`) runs
first for `/mcp`: it passes those requests to the function in `MCP_UPSTREAM`
and rewrites the OAuth resource address, so agents connect to
`<site>/mcp`. Without `MCP_UPSTREAM` there is no `/mcp` and the Worker only
serves the app.

```sh
bunx wrangler login
bun run deploy        # bun run build, then wrangler deploy
```

Your MCP URL is `<site>/mcp`. Static asset requests are free and unlimited;
requests to `/mcp` run the Worker.

To list your copy as a ChatGPT plugin, OpenAI checks that you own the domain:
put the token it gives you in `vars.OPENAI_APPS_CHALLENGE` in `wrangler.jsonc`
(it is public) and deploy. The Worker serves it as plain text at
`<site>/.well-known/openai-apps-challenge`; without it, that path is not found.
The whole submission is in [submitting the plugin](submission.md).

### On any static host

Upload `dist/` to any host that can:

- serve `index.html` for paths that don't match a file (the app routes in the
  browser, for example `/projects/<id>/notes/today.mdx`);
- send `Cache-Control: no-cache` for `/sw.js` and `/manifest.webmanifest`, as
  `public/_headers` asks, so updates reach people.

Your MCP URL is then the function's own:
`https://<ref>.supabase.co/functions/v1/mcp-server`.

Either way, once you know `<site>`, make sure `site_url` and
`additional_redirect_urls` in `config.toml` name it, and push the config.

## 6. Deploy from GitHub Actions (optional)

A fork can deploy itself the way the hosted instance does. GitHub turns
workflows off in a new fork: enable them on the fork's Actions tab. Both deploy
workflows skip until `SUPABASE_PROJECT_ID` is set.

In the fork's Settings > Secrets and variables > Actions:

| Name | Kind | Value | Read by |
| --- | --- | --- | --- |
| `SUPABASE_PROJECT_ID` | Repository variable | `<ref>` | both deploy workflows |
| `SUPABASE_PUBLISHABLE_KEY` | Repository variable (or repository secret) | The publishable key | Deploy app |
| `SUPABASE_DEPLOY_TOKEN` | Repository secret | An access token (see below) | Deploy Supabase, `deploy` job |
| `SUPABASE_DB_PASSWORD` | Repository secret | The database password | Deploy Supabase, `deploy` job |
| `EMBED_SECRET_KEY` | Repository secret | The secret key from step 1 | Deploy Supabase, `deploy` job |
| `CLOUDFLARE_API_TOKEN` | Repository secret | A token from Cloudflare's "Edit Cloudflare Workers" template, limited to your account (and zone, with a custom domain) | Deploy app |
| `CLOUDFLARE_ACCOUNT_ID` | Repository secret | Your Cloudflare account id | Deploy app |

Then, under Settings > Environments, create an environment named
`supabase-config`, limit its deployment branches to `main`, and add these
environment secrets. Only the `config` job uses this environment.

| Name | Value |
| --- | --- |
| `SUPABASE_CONFIG_TOKEN` | An access token (see below) |
| `SES_SMTP_USER` | Your SMTP user name |
| `SES_SMTP_PASSWORD` | Your SMTP password |

**Access tokens.** The simplest is one personal access token in both
`SUPABASE_DEPLOY_TOKEN` and `SUPABASE_CONFIG_TOKEN`. The hosted instance uses
two scoped tokens instead, so the job that runs migrations cannot change
settings or pause the project: the deploy token has Edge Functions Read-write
and Connection Pooling Read; the config token has Project Settings and Auth
Config Read-write, Add-ons Read, and Read on Database Config, Database, SSL
Enforcement, Network Restrictions, Data API Config, Realtime Config and Storage
Config. Scoped tokens expire within a year.

**Without SMTP**, the `config` job stops at "Check that the secrets are set".
Delete its two `SES_SMTP_*` lines in `.github/workflows/deploy-supabase.yml`.

**GitHub or Google sign-in**: the `config` job passes only the SMTP secrets to
`config push` today. Add the provider's two variables to that job's `env`,
from secrets in the `supabase-config` environment.

What runs when:

- **CI** (`ci.yml`) on every push: build, typecheck, lint, unit tests, browser
  tests, the migrations check and the Edge Function checks.
- **Deploy Supabase** (`deploy-supabase.yml`) on a push to `main` that changes
  `supabase/` or the workflow: functions, `db push`, then `config diff` and
  `config push`. Run it by hand from the Actions tab for the first deploy; a
  hand run pushes the config only when you tick "Push config.toml after
  showing the diff".
- **Deploy app** (`deploy-app.yml`) after CI passes on `main`, or by hand:
  builds with `VITE_SUPABASE_URL=https://<ref>.supabase.co` and your
  publishable key, then runs `wrangler deploy`.

A Vault secret changes only when `db push` applies a migration. To rotate
`EMBED_SECRET_KEY`, update the secret and either commit an empty migration or
use the SQL in step 3.

## 7. Connect Claude and ChatGPT

Use your MCP URL: `<site>/mcp` on Cloudflare, or
`https://<ref>.supabase.co/functions/v1/mcp-server` on another host. Claude and
ChatGPT reach it from their own servers, so it must be public HTTPS; a copy on
your own machine can't be connected to them.

- **Claude:** add a custom connector with the URL (Customize > Connectors,
  then "+" and "Add custom connector"; on Team and Enterprise, an owner adds it
  under Organization settings > Connectors). Leave the OAuth client id and
  secret empty: Claude registers itself. See
  [Anthropic's guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).
- **ChatGPT:** turn on Developer mode (Settings > Security and login), then add
  an app with the URL, as
  [OpenAI's guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
  describes.

Either one then opens your sign-in page, and after you sign in, your consent
page, where you choose "Allow access". The agent works as you, on your
projects. The app's Connected agents page (`/agents`) lists the agents you
allowed and revokes them.

## 8. The free plan: what to expect

- **Pausing.** Supabase pauses a free project after a week of low activity. It
  emails the owner about a week before, and again when it pauses. While it is
  paused, signing in, syncing, search and agents stop. Nothing is deleted:
  resume it from the dashboard within 90 days. Supabase says a few requests a
  day over the week is typically enough to keep a project awake; a paid plan
  never pauses.
  [Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- **Quotas**, per organization: 500 MB of database per project, 1 GB of file
  storage, 5 GB of egress, 500,000 Edge Function invocations and 50,000 monthly
  active users. Here, all content lives in Postgres, and every saved version of
  every file is kept (history is never trimmed), so database size is the one to
  watch. Each request an agent makes, and each search, is a function
  invocation. Over a quota, the free plan warns you and gives a grace period.
  [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase)
- **Two free projects** per account; a paused project doesn't count.
- **Backups** are not downloadable on the free plan.
- **The app's own limits** apply to everyone, you included: per-user saves,
  searches and agent calls a minute, new projects a day, and sizes per file and
  project, all listed under [Limits](architecture.md#limits). The per-user
  numbers are in `supabase/schemas/limits.sql`.
- **Email without SMTP** is limited to your team's addresses and a few messages
  an hour (see [Email](#email-smtp-is-optional)).

## Changing the database

Edit `supabase/schemas/`, then generate a migration (this step needs Docker)
and commit both:

```sh
bunx supabase@2.118.0 db schema declarative sync
```

CI's `migrations` job fails when the committed migrations are out of date with
the schema. `db push` (or the deploy workflow) applies new migrations.
