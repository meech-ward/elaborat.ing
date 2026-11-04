# Staging

Staging has its own backend and public address:

| Environment | App | Supabase |
| --- | --- | --- |
| Production | https://elaborat.ing | `njxjkmtvconypwujbiur` |
| Staging | https://elaborating-staging.sam-da1.workers.dev | `diehkqivgxcqhhexzcwa` |

`elaborating-staging` is in the Free **DevRel** organization, not DevRel Pro.
It starts with an empty database, using the repository's migrations and private
image bucket. Accounts and documents are separate from production. Create a
staging account with an email and password to test.

## Local testing

```bash
bun install --frozen-lockfile
bun run dev:staging
```

Open http://localhost:5174. This uses the public connection in
`env/staging/.env.staging`. The launcher prevents inherited root dotenv values
from selecting the production backend and writes builds to `dist-staging/`.
`bun run build:staging` and `bun run preview:staging` test the built site.

The ordinary `bun run dev` command uses root `.env.local` on port 5173.
This workspace's ignored `.env.local` is connected to production as requested,
so that local app can open your existing work. Saves there affect your real
documents. Both local servers can run together on their different ports.

The suggesting experiment is enabled in staging. Pending suggestions remain
in that browser's local storage and are not shared between devices or users.
Accepting and saving a suggestion writes the accepted note to the selected
backend. Production users do not get the prototype until it is merged and
deployed there.

## GitHub deployment

Push the `staging` branch to deploy that exact commit. The workflow builds the
app and runs typecheck, lint, unit and deployment guard tests before changing
hosted resources. Backend deployment applies committed migrations, configures
the private image bucket and staging Auth, then publishes a separate Worker.
There is no automatic merge or promotion to `main`. Merge a reviewed change
into `main` when ready to use the existing production release process.

The GitHub `staging` environment permits deployments from the `staging`
branch only. Its public variables are:

- `STAGING_SUPABASE_PROJECT_ID`
- `STAGING_SUPABASE_PUBLISHABLE_KEY`
- `STAGING_APP_ORIGIN`

Its secrets are:

- `STAGING_SUPABASE_ACCESS_TOKEN`: a personal access token scoped to this
  staging project.
- `STAGING_SUPABASE_DB_PASSWORD`: the staging database password.
- `STAGING_SUPABASE_SECRET_KEY`: the staging secret API key used for Vault
  workers and bucket provisioning.

The workflow reuses the repository's Cloudflare account and Workers deployment
token. `wrangler.jsonc` explicitly selects a separate Worker, output directory
and empty custom domain routes for `--env staging`.

Create the Supabase access token in
[account token settings](https://supabase.com/dashboard/account/tokens), limited
to project `diehkqivgxcqhhexzcwa`. It needs Edge Functions and Edge Function
Secrets read/write, Connection Pooling read, Project Settings and Auth Config
read/write, Add-ons read, and read access to Database Config, Database, SSL
Enforcement, Network Restrictions, Data API Config, Realtime Config and Storage
Config. Store its value directly as `STAGING_SUPABASE_ACCESS_TOKEN` in the
[GitHub staging environment](https://github.com/meech-ward/elaborat.ing/settings/environments).
No token belongs in a dotenv file or a commit. The combined staging token is
scoped to one disposable environment; production retains its separate tokens.

For a manual deployment from an authenticated shell, supply the same six
`STAGING_*` values through the process environment and run
`bun run deploy:staging`. The helper rejects missing credentials, production
targets and destinations that differ from committed staging configuration
before any hosted writes. It never runs `supabase link`.

GitHub's manual workflow button becomes available once the workflow exists
on the default branch. Pushes to `staging` work before that merge.

## Current limits

Staging tests browser notes, drawings, MDX, comments, files, images and search.
It uses the supported inline component preview frame rather than the production
sandbox domain. MCP, chat cards, agent callbacks and event webhook delivery are
not deployed here yet.

Password signup skips email confirmation. Production SMTP, social sign-in and
passkeys are not configured in staging. Email invitations, magic links and
password reset depend on Supabase's [default sender restrictions](https://supabase.com/docs/guides/auth/auth-smtp). Use password
sign-in for this testing environment.

Free projects can [pause when inactive](https://supabase.com/docs/guides/platform/free-project-pausing). Resume the staging project from its
[Supabase dashboard](https://supabase.com/dashboard/project/diehkqivgxcqhhexzcwa)
if it has paused. Staging data is independent and is not copied or promoted to
production during a code release.
