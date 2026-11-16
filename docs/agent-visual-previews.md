# Agent visual previews

**Status: deployed and hosted save-to-preview replacement verified, 2026-11-15. Host-specific MCP image delivery checks remain separate.**
The stored background pipeline replaces request-time browser rendering. Its
schema, processor, stored-image reads and crops are implemented. Local database
integration, native rendering and the hosted cron-to-function-to-renderer path
are verified below. The hosted image observation used an owner SQL read of the
synthetic fixture's stored PNG, not this chat's cached MCP tool inventory.

`get_file_preview` returns a previously prepared PNG for `.excalidraw`,
`.excalidraw.md` and `.d2` files. `read_file` continues to read source;
`show_file` continues to present a card to the person. An MCP preview read
never launches a browser, enqueues a render or waits for one to finish. Full
Markdown/MDX page capture remains outside this scope.

## Commit, prepare, read

Every committed change to a drawing or a D2 dependency invalidates the old PNG
and advances its pending generation in the same database transaction as the
save. This covers app edits, MCP-only writes and D2 companion-only updates.
Offline drafts participate when synchronization commits them to the server.
Preparation does not depend on opening the file or having an app session.

The background `drawing-previews` Edge Function claims eligible generations
and sends frozen saved inputs to the existing native browser renderer. A
five-second quiet period coalesces successive saves. Starts for one file are
at least ten seconds apart. Renaming the same file to an unsupported type
removes its preview but preserves the prior start time and cancellation
reservation, so renaming it back cannot reset that spacing. Each file has one
lease, and superseded generations
do not accumulate as a queue of historical renders.

During rendering, the function checks the job approximately once a second and
cancels work after a newer generation, deletion or lost lease. Publication is
a database compare-and-swap against the leased generation and token. Every
relevant input commit advances that generation. Cancellation reduces wasted
work; the publish check prevents an older job from replacing current pixels.

Saves do not wait for rendering. The resulting preparation window is explicit:
a read returns `preparing` while no exact current artifact is ready. It never
substitutes a previous revision's PNG. Browser failure or an exhausted retry
budget remains visible as an unavailable/error state. There is no request-time
browser fallback.

## Stored artifact and access

`public.drawing_previews` holds at most one current PNG per file, plus a small
bounded metadata record. PNG bytes use PostgreSQL `bytea` with a 96 KiB cap.
Old preview bytes are invalidated on a relevant commit and replaced atomically
only after the current generation finishes. No historical preview artifacts
are retained by this feature; normal source version history is unchanged.

This bounded derived artifact belongs in the same database transaction as its
identity and readiness state. A separate Storage bucket would add an upload
followed by a database commit, with orphan cleanup and stale-upload races for
an image of at most 96 KiB. Atomic row replacement avoids that extra protocol.
This decision does not move ordinary project image assets out of Storage.

The artifact carries the complete saved-input manifest, snapshot digest,
renderer build and presentation profile. D2 identity includes its source,
canonical `.excalidraw` companion and `.d2.json` sidecar, including explicit
missing companions. Changes to any saved dependency make an earlier artifact
ineligible. A valid artifact from an older renderer build remains readable,
with its actual build tag, until the saved inputs change. Automatic bulk
refresh on renderer upgrades is a separate follow-up.

Every MCP read uses the caller's existing project access and RLS. The public
table has explicit grants and policies; normal clients cannot publish images
or manipulate private jobs. A digest is a consistency assertion, not a bearer
credential. Revoked access, a deleted root or replacement at the same path must
withhold the previous root's pixels. Archived projects retain their existing
read permissions. A client-uploaded thumbnail cannot become the
canonical verification image.

## Tool and snapshot contract

```ts
get_file_preview({
  project_id,
  path,
  expected_version?,
  expected_snapshot?,
  region?: { x, y, width, height }
})
```

`expected_version` asserts the current root file version, not a historical
version or project-head revision. Omit `region` to read the stored overview.
A region is normalized to that complete image: finite nonnegative coordinates,
positive dimensions and a rectangle within `[0, 1]` on each axis. It requires
the `expected_snapshot` returned with the overview. A companion-only D2 save
invalidates this assertion even when the root version has not changed.

A crop decodes and crops the stored PNG with Photon. It cannot recover detail
beyond the stored resolution and does not invoke native export or Cloudflare.
Metadata reports the stored image dimensions and crop dimensions so an agent
can judge whether text is readable. High-resolution native detail rendering
is a separate future decision.

Success contains one standard MCP `image/png` block, concise text and metadata:
root identity/version, full input manifest, snapshot/build/profile,
`saved_scene` or `projected_diagram`, regeneration status, diagnostics,
native SVG viewBox, region, dimensions, scale and app link. Pixels are not
duplicated in JSON or `_meta`; no MCP App view is required.
[MCP image content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content)
does not establish that every host/model can inspect it.

Preparing, assertion conflicts, inaccessible inputs, unsupported content,
resource limits and failed preparation have distinct results. Provider
failures are bounded and redacted. Failed D2 compilation or regeneration
conflicts must not label an old saved canvas as successful current output.

## Native rendering

The standalone renderer shares the app's parser, pinned Excalidraw 0.18.1 SVG
exporter, fonts and arrow-label mask repair. D2 shares
`projectDiagramArtifact` and its manual-edit merge behavior. Missing or stale
artifacts compile without being saved; malformed companions and merge
conflicts remain explicit failures.

The `light-v1` profile uses the app's D2 palette. Native content is exported
in light mode, with scene embedding disabled, then rasterized on a white
backing. It represents committed saved content, not an editor's theme, zoom,
selection or unsaved draft.

Native SVG provides the actual viewBox and avoids native PNG export's separate
intermediate canvases for labeled arrows. The adapter repairs incorrectly
SVG-namespaced `clip-path` attributes from the pinned exporter, preserving
frame and image clipping during XML image decoding. It does not rewrite saved
geometry. The background job renders only the bounded overview.

Compressed Obsidian payloads use the bounded, MIT-credited lz-string 1.5.0
adaptation in `src/agent-preview/boundedLz.ts`. Expanded strings and retained
dictionary entries are bounded before concatenation, then JSON and scene
validation run before native restoration. Referenced image headers are checked
before decoding; static rasters also receive actual pixel decode and dimension
checks. Supported vectors and animations become validated static pixels.
Missing/corrupt image bytes fail. External embedded pages use native
placeholders with a diagnostic and are never fetched.

## Background limits and failures

Database claims enforce at most two active leased background jobs globally,
500 render attempts per UTC day globally and 100 per UTC day per project.
These are attempt budgets, including failures and retries, not a guaranteed
monetary spend ceiling.
Provider pricing, other browser use and operations outside this queue remain
separate. Cancelling a request can finish before Cloudflare closes its browser,
so brief cleanup overlap is possible; provider account limits govern actual
browser concurrency. A generation receives at most five attempts with backoff;
a newer generation supersedes its remaining attempts. Budget exhaustion defers
eligible work rather than making saves or MCP reads launch a browser.

The Worker retains its separate per-isolate concurrency and per-location rate
limits as additional guardrails. They are not substitutes for the shared
database budgets. Missing service configuration or failed limiting must fail
closed. Lease expiry permits recovery after a crashed worker without allowing
an expired job to publish.

If the background function has no render secret or its endpoint is invalid,
it requests a 300-second database dispatch cooldown before returning
unavailable. It does not claim a generation or spend a render attempt. Cron
checks that cooldown before dispatching again, so an unconfigured installation
does not call the function every five seconds. After configuration, automatic
preparation can wait for the remaining cooldown to expire.

| Rendering boundary | Limit |
| --- | --- |
| Saved source/canvas/layout | 2 MiB UTF-8 each; 7 MiB serialized job |
| Expanded drawing JSON | 2 MiB, including compressed Obsidian payloads |
| D2 source | 64 KiB UTF-8 before compilation |
| Scene | 3,000 elements; 100,000 points; 200,000 rendered text characters |
| JSON structure | Depth 48; 300,000 visited/pending values; unsafe prototype keys rejected |
| Geometry | Numeric magnitudes bounded at 10,000,000; stroke/font/roughness and patterned-fill work checked |
| Images | 32 distinct; 2 MiB input bytes; 24 million aggregate pixels; 16 MiB validated raster bytes |
| Native SVG | 8,388,608 characters before rasterization |
| Stored overview | At most 1,600-pixel longest edge, 1.6 million pixels and 96 KiB PNG bytes |
| Browser transport | 128 KiB base64 characters; 140,000 complete-result characters |
| Diagnostics | Ten bounded code/message entries |
| Browser deadline | 42 seconds, followed by cleanup |

Output resolution may be reduced further to fit the PNG byte budget, with a
diagnostic. A stored-PNG crop has the same available detail. Dimensions are
checked before raster allocation. The scene-element check follows D2
compilation/emission and does not prove a bound on compiler intermediate
allocations; source caps, isolation and deadlines limit that path.

## Worker boundary and credentials

The database dispatch follows the existing embedding/event pattern: Vault's
`embed_secret_key` authenticates the request to `drawing-previews` through the
`apikey` header. The private claim and publication operations are unavailable
to ordinary project clients. The existing database dispatch credential is
never passed to Cloudflare or a browser.

Only the background function posts render jobs to the fixed HTTPS
`AGENT_PREVIEW_ENDPOINT`, normally `/_agent-preview`. Its separate
`AGENT_PREVIEW_SECRET` authenticates that transport. It is not a user JWT or
Supabase database key, and MCP reads do not need it. The browser receives frozen
source and public renderer assets without account sessions, authorization
headers, signed Storage URLs or service credentials.

The Worker uses its `BROWSER` binding and pinned `@cloudflare/puppeteer`, with
a fresh isolated context per job. Recording, cache and service workers are
disabled. Host guardrails, exact renderer/font/worker asset rules, GET-only
requests, CSP and image validation restrict network access. Callers cannot
choose URLs, scripts, HTML or browser options. Bounded replies are validated
across renderer, Worker and background-function boundaries. Context/browser
cleanup runs on success, failure, cancellation, deadline and late acquisition.

Cloudflare processes private drawing inputs during background preparation.
Supabase retains the current bounded PNG and metadata. This is an additional
processing path and a derived-data retention decision to disclose to
self-hosters. Provider operational retention is separate from application
storage. See Cloudflare's
[Puppeteer guide](https://developers.cloudflare.com/browser-run/puppeteer/),
[browser binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)
and [data-handling FAQ](https://developers.cloudflare.com/browser-run/faq/).

## Build, deployment and app loading

Each job records the exact immutable renderer build it uses. Retained assets
support in-flight jobs during deployment; a missing exact build fails
explicitly. Deploying a newer renderer does not invalidate an otherwise current
stored PNG or silently relabel its build.
Deployment and credential setup are described in the
[self-host guide](self-host.md#optional-visual-previews-for-agents).

The app helper deploys code and its optional credential atomically through
`wrangler deploy --secrets-file`, using a temporary owner-readable file and
removing it afterward. It also deploys without a credential override. This
avoids a separate secret update that refuses newer unpromoted test versions.

This pipeline adds no app UI or first-paint work. Saving performs bounded
database invalidation/enqueue work, not browser rendering. The standalone
renderer remains outside ordinary view imports and service-worker precaching.
Preserve existing bundle budgets and the
[progressive loading](progressive-loading.md) contracts. Core source tools and
the app remain usable when preview preparation is disabled or unavailable.

## Earlier native-renderer verification

Before the stored-pipeline decision, the production-browser suite passed eight
tests across Chromium and Firefox, covering native frames, normalized viewport
alignment, fonts and the emitted native subset worker, embedded images,
compressed Obsidian and live D2 projection with manual additions. Corrupt
images, native syntax errors and merge conflicts had explicit failure checks.

An unpromoted Cloudflare Worker version also returned validated PNGs through
the real browser binding for native and compressed fixtures, a native detail
crop and freshly compiled D2. These were synthetic renderer checks, not a
release of the stored pipeline. The new MCP crop uses stored PNG pixels instead
of that earlier native viewport path.

## Local verification

The generated migrations `20261116005912_declarative_sync.sql`,
`20261116010733_declarative_sync.sql` and `20261116011558_declarative_sync.sql` were applied only to the throwaway
`elaborating-preview-test` database at local port 56322. The second preserves
the start gap through an unsupported-type rename and back; the third gives
daily-budget exhaustion a distinct `daily_limit` code from transient provider
rate limits. A final declarative sync found no schema changes. The final full
pgTAP rerun passed 22 files and 1,196 assertions; local database security
advisors reported "No issues found." Hosted Supabase was not migrated or
configured by these checks.

Other local checks passed:

- The frozen MCP Deno suite: 205 tests, including 16 stored-preview tests.
- Bun: 1,749 passed, 13 skipped and two TODOs, 1,764 tests in total.
- Typecheck, lint and the unchanged bundle budgets.
- The following production-build browser command: 12 checks passed across
  Chromium and Firefox. This includes the native-preview and legal suites.

```sh
ELABORATING_BROWSER_TEST_PORT_OFFSET=230 npx playwright test \
  tests/browser/agent-preview.spec.ts tests/browser/legal.spec.ts
```

`bun scripts/check-function-assets.ts` exercised the pinned Supabase CLI's
real `--use-api` source collector against a loopback API that deliberately
refused deployment. It verified the expected rendering dependencies in
`images` (10 source files), `mcp-server` (44), `drawing-previews` (10) and
`file-share` (11). No hosted deployment occurred. Normal Node/Vite builds kept
the renderer manifest at `7048a6cabb090b4b`.

A temporary verifier at
`/private/tmp/elaborating-preview-background-integration.ts` used the actual
`processNextDrawingPreview` and `postgresPreviewStore`, real authenticated
`save_files` calls and real authenticated RLS SELECTs through an SQL-backed
MCP adapter. The final local run passed 43 assertions in 1.93 seconds with
three controlled renderer calls and no staged call. It proved:

- Five quiet seconds, the ten-second start gap and one live lease per file.
- Source-update bursts cancel an in-flight controlled renderer through the
  default one-second poll, coalesce to generation four, reject the old publish
  and store exact saved version four after one current-generation attempt.
- Preparing/ready reads and snapshot-bound crops do no browser work; the
  right-half crop of a known RGBA fixture contains only the expected green
  pixels. Another authenticated user cannot read the private pixels.
- One current artifact/job per file, both daily attempt budgets, quota
  deferral without consuming an attempt and the two-active-lease logic.
- Root deletion removes current derived rows and retains source history,
  reserves its independent lease until acknowledgement, rejects late publish,
  withholds MCP pixels and releases the lease on acknowledgement.

An earlier run of the same verifier passed 38 assertions in 7.87 seconds,
including one real staged Cloudflare render with build `7048a6cabb090b4b`.
The processor validated and stored that native PNG, and the MCP payload read
it back. The two assertion counts overlap and must not be added together.
All fixture changes in both runs were rolled back. The staged transport key
was read only into memory; no hosted Supabase or secret storage was changed.

The temporary command, run from the isolated checkout, was:

```sh
deno run --no-lock --config supabase/functions/mcp-server/deno.json \
  --allow-read --allow-env \
  --allow-net=127.0.0.1:56322,agent-previews-elaborating.sam-da1.workers.dev:443 \
  /private/tmp/elaborating-preview-background-integration.ts
```

Only the earlier run added `--staged`. The script hard-restricts its database
target to `127.0.0.1:56322/postgres`. It is a temporary verification artifact,
not a committed test dependency. Its rollback transaction and role mutex prove
real SQL/processor behavior, not HTTP/PostgREST integration or independent
connection contention. The staged call proves native rendering, not the
database cron-to-Edge-Function authentication path or production availability.

## Independent database contention check

A separate temporary verifier at `/private/tmp/elaborating-preview-concurrency.ts`
used five distinct PostgreSQL connections against the same isolated local
server. All 26 assertions passed: exactly two simultaneous claims won; releasing
one lease allowed one replacement; superseding an active job preserved its slot,
invalidated currentness and refused stale publication; acknowledgement allowed
one replacement. Four successful claims consumed four attempts. Generated
fixtures were removed and the prior global usage ledger was restored exactly.
This establishes real connection contention separately from the rollback-only
processor verifier above. Neither verifier changed hosted state.

## Production verification

Runtime release `87f8eb17625c7ca1c11575ed2573c1fa0e16af84` passed
[CI](https://github.com/meech-ward/elaborat.ing/actions/runs/43791076171)
and all four jobs in the
[production deployment](https://github.com/meech-ward/elaborat.ing/actions/runs/43792599290).
The approved transport credential is configured in Supabase. MCP is active at
version 210 and `drawing-previews` at version 1. Downloaded entrypoints and tool
registration match the release; the CLI's source-path guard prevented checking
every bundled module by download. Runtime artifacts identify renderer build
`7048a6cabb090b4b`.

Nine public asset requests verified the current build index, manifest,
canonical renderer HTML, entry script, native font worker and its imports,
and a valid 20,380-byte WOFF2 font. A direct authenticated renderer smoke
returned a valid 93,056-byte PNG. The one-time `AGENT_PREVIEW_BOOTSTRAP`
repository variable was reset to `false` after these checks.

A temporary project and drawing were created through the authenticated MCP
connection. No browser app session opened that drawing. The database cron,
Edge Function and Cloudflare renderer prepared its current PNG:

| Saved version / generation | Attempts | Stored PNG | Observed pixels |
| --- | --- | --- | --- |
| 1 / 1 | 2 | 4,956 bytes, 500 × 280 | Green rectangle, black dot on the left |
| 2 / 2 | 1 | 15,267 bytes, 492 × 280 | Orange ellipse, black dot on the right |

The first image's shape, colour and dot position were randomly chosen without
being shown to the model. Image inspection matched all three before source
inspection. An owner SQL read fetched only this synthetic project's PNG and
metadata. Version, generation, metadata input version and renderer build
matched; both image digest and snapshot changed after the MCP update. During
replacement, the row was pending for version 2 rather than serving version 1.
The temporary project was archived after verification, not permanently deleted.

The first attempt received a transient `rate_limit`. Its retry waited behind
the initial backfill and then succeeded; a diagnostic snapshot showed 98 ready
artifacts and an eligible rank of 12 for that retry. This verifies retry
progress, not a fixed completion-time guarantee. Neither MCP save waited for a
render.

## Remaining client and transport checks

The deployed Worker includes `enable_request_signal`; actual hosted
disconnect-to-browser-cleanup timing is still unverified. Local controlled
cancellation tests do not establish that timing or eliminate brief browser
cleanup overlap.

For each supported host/model, request a stored preview without an MCP App
card and identify an image-only feature. Record exact combinations and narrow
support claims if a host cannot consume image content. This chat's connector
inventory did not refresh to include `get_file_preview`, so the owner SQL PNG
observation above does not establish image delivery through that tool in a
particular MCP host. No such host-specific observation is recorded yet.

Retain normal build, typecheck, lint, Bun, Edge Function, database, migration,
bundle and browser checks. Full note/MDX capture needs its own saved dependency
snapshot, viewport/pagination and component-sandbox design.
