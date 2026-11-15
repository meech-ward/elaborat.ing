# Agent visual previews

**Status: implemented and verified locally and in a staged browser deployment, 2026-11-15.**
The MCP tool, standalone renderer, Worker adapter and deployment support are
implemented. Production release and real client observations are recorded
separately from the checks below.

`get_file_preview` returns pixels to an agent for `.excalidraw`,
`.excalidraw.md` and `.d2` files. `read_file` still reads source; `show_file`
still presents a card. Full Markdown/MDX page capture is outside this scope.
Rendering starts only on an explicit request, never on ordinary reads/saves.
The renderer is built separately and excluded from the service-worker
precache. Ordinary views do not import it. Preserve existing first-paint
budgets and [progressive loading](progressive-loading.md) boundaries; this
feature preserves the implemented T55 through T59 loading contracts.

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

`expected_version` asserts the current root file version. It does not request
history or a project-head revision. Omit `region` for an overview. A region is
normalized to the complete exported picture: finite nonnegative coordinates,
positive dimensions and a rectangle within `[0, 1]` on each axis. Cropping
changes the viewport without removing contextual scene elements.

A region requires the `expected_snapshot` returned with its overview. This
digest covers file identities, paths, versions, content hashes, missing
companions, renderer build and presentation profile. Mismatches fail before
browser work, including companion-only D2 saves. The digest is a consistency
assertion, not an access credential or retained historical image.

Success contains one MCP `image/png` block, concise text and metadata: root
identity/version, complete input manifest, snapshot/build/profile,
`saved_scene` or `projected_diagram`, regeneration status, diagnostics, actual
SVG viewBox, region, pixel dimensions, scale and app link. Pixels are not
duplicated in JSON or `_meta`; there is no MCP App resource. Standard
[MCP image content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content)
does not establish that every host/model can inspect it.

Errors distinguish missing/inaccessible inputs, unsupported content,
assertion conflicts, invalid input, limits, unavailable rendering, rate
limits, cancellation and render/compile failures. Raw provider failures and
credentials are withheld. Failed D2 compilation or regeneration conflicts
return diagnostics without labeling an old canvas as successful output.

## Authorized saved inputs

The existing caller-scoped Supabase client and RLS read `project_files`.
Drawings need one row. D2 source, canonical `.excalidraw` companion and
`.d2.json` sidecar are read in one select statement, giving a consistent input
set without loading the project. Missing companions are explicit. No new
RPC, privileged read or schema change is used.

Exact strings and their manifest are frozen before rendering. Browser drafts,
remote imports and generated companion saves do not participate. Changes
during a job do not relabel its pixels: the reply identifies actual input
versions. Before returning pixels or source-bearing error diagnostics,
another caller-scoped read verifies the same root file ID is still accessible.
Deletion, replacement or revoked access withholds output.

## Native rendering

The standalone browser entry uses the app's parser, pinned Excalidraw 0.18.1
SVG exporter, fonts and arrow-label mask repair. D2 shares
`projectDiagramArtifact` and its manual-edit merge behavior. Missing or stale
artifacts compile without being saved; malformed companions and merge
conflicts remain explicit errors.

The `light-v1` profile uses the app's D2 palette. Native content is exported
in light mode, with scene embedding disabled, then rasterized on a white
backing. This is saved-content rendering, not a person's current editor,
theme, zoom, selection or unsaved changes.

Native SVG supplies the actual viewBox for crops and avoids native PNG
export's separate intermediate canvases for labeled arrows. The adapter
repairs SVG-namespaced presentation attributes emitted by the pinned
exporter: XML image decoding needs ordinary `clip-path` attributes for
frame/image clipping. Saved geometry is not rewritten.

Obsidian compressed payloads use a bounded adaptation of lz-string 1.5.0's
MIT-licensed decoder. `src/agent-preview/boundedLz.ts` retains attribution and
license. Output and retained dictionary strings are bounded before
concatenation; expanded JSON receives structural/scene checks before native
restoration.

All referenced image headers are checked before decoding. Static rasters
receive actual pixel decode/dimension verification; supported vectors and
animations become validated static pixels. Missing/corrupt bytes fail.
External embedded pages use native placeholders with a diagnostic, without
fetching content. Output resolution can be reduced to fit its budget, with
a diagnostic and a detail crop still available.

## Worker boundary and privacy

The MCP function posts the frozen job to a fixed HTTPS
`AGENT_PREVIEW_ENDPOINT`, normally `/_agent-preview`. It shares a separately
generated `AGENT_PREVIEW_SECRET` with the Worker through their secret stores.
This is not a user JWT, Supabase service key or embed credential. The browser
receives job data and public assets only, with no account session, auth
headers, signed Storage URLs or service secret.

The Worker uses its `BROWSER` binding and pinned `@cloudflare/puppeteer` to
launch a browser and isolated context per job. Recording, cache and service
workers are disabled. Provider guardrails restrict the hostname; request
interception allows only exact published renderer/font/worker URLs and GET,
with no query or credential channel. CSP and image validation add independent
restrictions. Callers cannot choose URLs, scripts, HTML or browser options.

Evaluation returns bounded JSON, rather than a page screenshot or raw HTML.
Job identity, input digest, build, region, PNG headers and dimensions are
checked across browser/Worker/MCP boundaries. MCP also decodes the bounded
PNG with Photon and frees it before publishing. Browser/context cleanup runs
on success, failure, cancellation, deadline and late browser acquisition.

The service retains no preview images or project copies. The configured
Cloudflare browser processes authorized private content, an additional data
path self-hosters must disclose. See the official
[Puppeteer guide](https://developers.cloudflare.com/browser-run/puppeteer/),
[browser binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)
and [data-handling FAQ](https://developers.cloudflare.com/browser-run/faq/).

## Current limits

| Boundary | Application limit |
| --- | --- |
| Saved source/canvas/layout | 2 MiB UTF-8 each; 7 MiB serialized job |
| Expanded drawing JSON | 2 MiB, including compressed Obsidian payloads |
| D2 source | 64 KiB UTF-8 before compilation |
| Scene | 3,000 elements; 100,000 points; 200,000 rendered text characters |
| JSON structure | Depth 48; 300,000 visited/pending values; unsafe prototype keys rejected |
| Geometry | Numeric magnitudes bounded at 10,000,000; stroke/font/roughness and patterned-fill work also checked |
| Images | 32 distinct; 2 MiB input bytes; 24 million aggregate pixels; 16 MiB validated raster bytes |
| Native SVG | 8,388,608 characters before rasterization |
| Output | 1,600-pixel longest edge; 1.6 million pixels |
| Transport | 96 KiB PNG bytes; 128 KiB base64 characters; 140,000 complete-result characters |
| Diagnostics | Ten bounded code/message entries |
| Time | 45-second MCP deadline; 42-second Worker rendering deadline, then cleanup |

Existing per-image validation also applies. Dimensions are bounded before
raster allocation; cropping does not allocate a full-scene canvas. The
3,000-element check follows D2 compilation/emission and does not bound its
intermediate allocations. Source caps, isolation and deadlines limit this
path; provider memory failures remain explicit failures, not a proved
compiler memory ceiling.

The Worker allows one active job per isolate and requires its limiter.
`wrangler.jsonc` sets ten jobs/minute per Cloudflare location, separately from
provider account quotas. Missing/failed limiting disables rendering. These
are not a global daily spending cap. Rate-limit replies preserve retry timing;
the MCP tool does not automatically loop through paid retries.

## Build, setup and deployment

`vite-plugins/agent-preview.ts` emits an immutable renderer folder and matching
MCP manifest. Deployment retains the current and two previous published
builds, verifies manifests/content hashes, then publishes assets before the
MCP function. The Worker resolves exact retained builds; missing/corrupt
retention stops deployment.

The core app/source tools work without configured previews. Secret
provisioning, endpoint/origin settings and first-deploy bootstrap are in the
[self-host guide](self-host.md#optional-visual-previews-for-agents) and
`scripts/configure-agent-preview.ts`. An authorized local Supabase CLI identity
provisions the MCP runtime secret and endpoint before deployment, and again
when rotating them. The Supabase CI token deliberately has no
`edge_functions_secrets_write`; CI does not perform this setup. The app job
continues to provision Cloudflare from the matching GitHub
`AGENT_PREVIEW_SECRET`. Browser usage has separate quotas and charges;
enabling it requires an operating budget.

## Verification record and remaining release checks

Local checks on 2026-11-15 include 200 passing MCP tool tests and the reported
1,764-test Bun application baseline, plus focused Worker/provider and
retained-build tests. MCP tests cover real in-memory image transport,
snapshots/crops, corrupt PNG decoding, cancellation, credential separation
and revoked-access output withholding. Worker tests use a controlled browser
stand-in, not a hosted Browser Run session.

The final production-browser suite passed eight tests in Chromium and Firefox.
It covers native frames and exact normalized crop alignment, fonts and the
emitted native subset worker, embedded images, corrupt payloads, compressed
Obsidian, and fresh/stale/saved D2 projection with manual additions. Native
syntax and merge conflicts return explicit failures.

An unpromoted Cloudflare Worker version returned validated PNGs through the
real browser binding for the repository's native and compressed fixtures, a
detail crop and a freshly compiled D2 diagram. Observed warm checks were about
4.7 seconds for the crop, 5.1 seconds for the compressed drawing and 8.5 seconds
for fresh D2, including network and browser work. These are synthetic checks,
not latency guarantees. Cloudflare canonicalizes `index.html` to its directory;
the provider navigates only the trusted derived directory alias to avoid a
blocked redirect while keeping other paths forbidden.

Typecheck, lint, the focused function checks, retained-build tests, Worker dry
run, committed chat-card rebuild and the unchanged bundle budgets passed.

Additional operational and client checks:

1. Exercise the actual binding with cold fonts, native/Obsidian drawings,
   frames, pressure strokes, arrows, cropped/flipped images and live D2.
   Compare overview/detail with the fixed native presentation profile.
2. Prove exact asset restrictions and isolation with hostile inputs and two
   consecutive private jobs. Check resource failures, cancellation, late
   launch cleanup, concurrency, quotas and actual latency.
3. Exercise hosted MCP owner/member roles, archives, nonmembers, revocation,
   root replacement and companion-only snapshot races. Confirm the deployed
   function/build pairing.
4. For each supported client/model, request a preview without a card and
   identify an image-only feature absent from text/metadata. Verify readable
   crops and a host without MCP Apps support. Record exact combinations and
   narrow support claims when a host fails.

Retain normal build, typecheck, lint, Bun, Edge Function, bundle and browser
checks. Transport tests alone prove neither model vision nor production
availability. Full note/MDX capture needs a separate saved dependency snapshot,
viewport/pagination and existing component-sandbox consent/isolation design.
