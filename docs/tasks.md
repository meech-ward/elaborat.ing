# Task queue

The open work on elaborat.ing, each task written so a contributor or a coding
agent with only this repository can pick it up. The maintainer keeps it
stocked. When you finish a task, mark it **Done** in the same change, and add
anything you noticed but didn't fix, as a new task or a line under "Small
things".

**How to work the queue**

1. Fetch the latest `main`.
2. Take the first task marked **Ready** that no open pull request names.
3. Do it following [AGENTS.md](../AGENTS.md): the smallest complete change,
   with a test that fails without it.
4. Contributors: work on a branch from `main` and open a pull request titled
   `T<number>: <task title>`, listing what you checked and any decision the
   maintainer should confirm. Don't merge. The maintainer's own agents push to
   `main` once the checks pass; CI runs again there and the deploy follows.

Every task is done only when `bun run build`, `bun run typecheck`,
`bun run lint` and `bun run test` pass, plus the task's own checks.

Status values: **Ready** (take it), **Waiting** (depends on something named in
the task), **Taken** (someone is doing it; skip it), **Done**.

People using the app report bugs as
[GitHub issues](https://github.com/meech-ward/elaborat.ing/issues); the
maintainer turns the ones to fix into tasks here.

## Open

The [app-wide progressive loading requirement](progressive-loading.md) applies
to every surface, including existing features. Its completed implementation
tasks are [T55](#t55-show-unlisted-content-before-independent-assets),
[T56](#t56-open-the-requested-project-file-before-offline-preparation),
[T57](#t57-prepare-only-visible-assets-and-publish-each-ready-result),
[T58](#t58-show-safe-document-content-while-mdx-components-prepare), and
[T59](#t59-check-time-until-useful-content-across-the-app).
Implementation was authorized on 2026-11-04. Each task below records the
corresponding implementation and verification status.

## T34: check live drawing and writing in Claude and ChatGPT, and answer three host questions

**Status:** Waiting (a person signed in to Claude and to ChatGPT with the elaborat.ing connector)

An agent can't sign in to these chats. A person runs these in Claude (in a new
chat) and in ChatGPT (refresh the connector first), on a computer and on a
phone, and reports what they saw:

1. "In my elaborat.ing project, make a drawing `art/signup-flow.excalidraw` of
   a signup flow and let me watch you draw it." Shapes draw in while the agent
   writes, then the saved card takes over.
2. "Write a new note `notes/launch-plan.mdx` about the launch and let me watch
   you write it." The text comes in as it is written.
3. "Change `art/signup-flow.excalidraw`: rename one box and colour another
   blue, and let me watch it change here in the chat." The saved drawing
   shows, then the changes draw in.
4. ChatGPT only, with the elaborat.ing panel: open the drawing in the panel,
   then ask for a step added with `draw`, a few elements at a time; and have a
   note written with `append_to_note`, one section per call, while it is open
   in the panel. Each step fades in, each section writes in.
5. Show a note with more drawings than fit in one result (five large
   hachure-filled drawings). All of them show, the last ones a moment later.
6. Claude only: "Make a D2 diagram `art/blog-schema.d2` of a blog's database
   tables and show it to me." Does the diagram draw, or does the card say to
   open it, and does the model then offer a drawing?

What it answers:

- **Does ChatGPT stream a tool's input to the card while the model writes
  it?** Each live card calls `card_report` once, and the mcp-server function
  logs a `card_live` line saying how many partial inputs arrived. Read those
  lines in the Supabase function logs.
- **Does Claude's card run D2's engine?** If not, see T35.
- **Do ChatGPT's results of the card's own tool calls keep `_meta`?** The card
  no longer depends on it (deferred drawings come through `card_embed`, and a
  reload never falls back to older text), but `panel_pass` still does (T38).

Done when the answers are in [platform notes](platform-notes.md), and
`card_report` and its `card_live` logging are removed, since they exist only
to answer the first question.

## T35: show D2 diagrams in chats whose policy doesn't let the card run D2's engine

**Status:** Waiting (T34's answer for Claude, then a decision on cost)

The chat card lays out a new or changed D2 diagram itself, with D2's
WebAssembly engine in a `blob:` worker (`src/chat-card/diagram/`). A host
whose view policy allows neither `'wasm-unsafe-eval'` nor `blob:` workers
can't run it, and the MCP Apps spec's default policy has neither, so Claude
probably can't. There the card shows a link, and the model hears it can offer
an Excalidraw drawing instead.

To show the diagram anyway, it has to be laid out on a server and sent as an
SVG, as drawings are. Edge Functions can't run the engine (the WebAssembly
build takes about 350 MB of memory to start). The native `d2` binary (v0.7.1)
lays out a six-table diagram in about 0.25 s with dagre (about 42 MB) or 1.6
to 1.8 s with ELK (about 150 MB), so a small container service would do, at
some cost. Done when this is decided, and, if built, `show_file` sends a
server-drawn SVG for a diagram the app hasn't drawn yet.

## T38: panel_pass works where a host drops _meta from the view's own calls

**Status:** Waiting (T34's answer on `_meta`)

The panel's view gets a one-time pass for each page it opens from
`panel_pass` (`supabase/functions/mcp-server/tools/panel.ts`), in the
result's `_meta` only. If ChatGPT drops `_meta` from the results of the view's
own calls, the panel can't open a second page. If T34 finds it does, send the
pass where the view can read it; the tool is the view's alone.

## T39: the diagram view shows D2's errors as plain lines

**Status:** Ready (check it first)

D2 reports compile errors as a JSON list naming a made-up file, `index.d2`.
The chat card turns them into `path:line:col: message` (`plainErrors` in
`src/chat-card/diagram/draw.ts`); the app's diagram view
(`src/features/workbench/DiagramView.tsx`) seems to show them as they come.
Check on screen with a diagram that doesn't compile, and if so, reuse the
card's function.

## T40: arrows meet rounded rectangles at their outline

**Status:** Ready

`draw` and the short form give a new rectangle rounded corners (Excalidraw's
adaptive roundness), but an arrow placed between two shapes stops at the
rectangle's square box (`reach` in
`supabase/functions/mcp-server/tools/drawingCompletion.ts`), so an arrow
meeting a corner at an angle stops up to about 13 px short of the rounded
outline. Use the rounded outline. The card's live view bundles this code, so
rebuild the card and bump `FILE_VIEW_URI`.

## T41: one D2 engine at a time across chat cards

**Status:** Ready

Each chat card that lays out a diagram starts D2's engine in a worker (about
165 MB, `src/chat-card/diagram/d2Engine.ts`) and stops it once idle, but cards
whose layouts start less than 10 s apart run two engines at once (about 920 MB
at the peak), as when an agent writes two diagrams back to back. That can be
too much for a phone. Share one engine between cards, or queue their layouts.

## T43: prove the image asset contract and validation

**Status:** Done

Start [image support](images.md) by settling the contracts its implementation
depends on. Files, history, sync and archive import are text-only today;
preview CSP permits only `data:` images. The scope proposes binary project
files backed by immutable private Storage objects and normal relative
Markdown references in both `.md` and `.mdx`.

Prove a bounded image validator and thumbnail decoder in the intended
browser/server runtimes, including corrupt input, format spoofing, dimensions,
orientation, transparency and bounded animation. Confirm the proposed 5 MiB
original and 8 million pixel limits against runtime memory. Choose and
record the per-account quota for retained/staged bytes and preview budgets.
Define owner charging and atomic quota checks on ownership transfer, and
historical path/version lookup so old notes keep their original images.
Specify file payloads, upload reservation and commit contracts, source path
resolution, and compatibility for older clients before binary writes exist.

Done when a focused executable proof and its tests pass, these open choices
are recorded in the architecture and image scope, and T44 can implement
the contracts without another data-model decision. Use official Storage
APIs; do not introduce a public bucket or relax document isolation.

## T44: private image storage and revision checked asset saves

**Status:** Done

Implement T43's asset contracts from [the image scope](images.md#asset-storage-and-saves).
Extend current project files and file history to distinguish text from
immutable image references. Add upload reservations, authoritative validation,
quota accounting for staging and retained bytes, and asset-reference changes
to the existing atomic `save_files` batch with idempotent retries.

Declare the private bucket in `supabase/config.toml`, add its explicit
provisioning step to deployment and self-host setup, and declare policies,
tables and functions in `supabase/schemas/`. Generate migrations with the
pinned declarative sync command, never by editing generated migrations.
Storage reads follow accepted project membership; writes require edit access
and an active project. Refuse client overwrite and physical deletion,
including from OAuth sessions.

Keep committed historical bytes. Add safe expired-staging cleanup and durable
Storage API cleanup after person-authorized permanent project/account
deletion, capturing object keys before database cascades remove metadata.
Cleanup retries must not race an active upload or a committed save. Charge
the project owner, reassign that charge atomically on ownership transfer,
and preserve other people's project assets when an uploader deletes their
account. Resolve historical references against their saved versions.

Done when pgTAP proves role isolation, pending/revoked membership, archive and
OAuth physical object delete/overwrite refusal; function tests prove
validation, foreign or missing asset refusal, quota races, retries and
cleanup; and a private hosted
upload/download/save is verified with a disposable test project.

Hosted verification passed on 2026-10-20: PNG URL import and SVG upload,
private asset saving, reload with rich captions and visible SVG text, and
downloaded originals with matching SHA-256. The SVG check also verified
explicit Sync now recovery from a refused upload.

## T45: durable image drafts and offline asset sync

**Status:** Done

Add image bytes to the partitioned device model in
`src/features/project-storage/`, following [the image save flow](images.md#asset-storage-and-saves).
Migrate IndexedDB without losing existing text projects. Persist image bytes,
their draft references and dependencies together; prepare hashes and decoding
before the transaction. Reuse the existing Save/Discard, batching, conflict
recovery, pending mutation and sign-out/departure guards.

Upload first, then commit references and text in one server save. Retry lost
answers with the same identities. Cache current project images before showing
the project ready offline; show progress and storage failures. Include the
signed-out local project, sign-in migration and cross-tab updates.

Done when tests cover offline insertion and reload, incomplete downloads,
upload-success/save-failure, save conflicts, lost replies, discard and shared
asset retention, account isolation and access loss. Text-only databases must
upgrade without changing their saved content or drafts.

## T46: portable image files and safe reference changes

**Status:** Done

Extend ZIP/folder import and export in `src/features/projects/projectArchive.ts`
and its callers to carry image bytes alongside unchanged UTF-8 text. Export
real files at their logical paths with no storage URLs or backend ids. Include
bytes required by drafts when the person includes unsaved changes. Validate
binary imports with the same limits as uploads and report skipped entries.

Add parser-backed image references and document-relative path resolution to
the workbench. Test Markdown reference images, static literal image tags,
encoded legal filenames, component-module paths and path traversal refusal.
Extend move/delete planning so moving an image, folder or referring note
rewrites supported references atomically and deletion lists its dependants.
Computed or ambiguous affected references must still stop a move.

Done when ZIP and folder round trips preserve image bytes and note/drawing
text, saved/draft downloads are complete, names cannot escape the project,
and move/delete tests prove source precision and conflict handling.

## T47: insert and view images in notes and drawings

**Status:** Done

Implement [image authoring](images.md#authoring):
Image in both rendered insertion controls, upload, clipboard image paste,
file drop and choosing an existing image. Write standard Markdown image
syntax in `.md` and `.mdx`, with alt text or Decorative, responsive layout,
original colours, enlarged view, reference replacement/removal and shared
source/rendered Undo. T50 adds rich captions and persistent resize/crop copies.

Revalidate the target after asynchronous work and keep pending image bytes
with the draft. The trusted app resolves references and supplies validated,
bounded image payloads for the current session/revision; keep both CSPs
data-only and reject invented paths. Viewers, commenters and archived
projects cannot mutate images through controls, paste, drop or messages.

Verify native Excalidraw upload/paste/drop and add choosing a project image
as a native scene copy. Check the final 2 MiB drawing limit including base64
overhead; offer an explicit smaller copy or leave the drawing unchanged.
Preserve existing scenes and image export fidelity.

Done when Chromium/Firefox journeys cover every ingestion path, placement,
cancel/failure, tab switches, alt editing, Undo/Redo, Save/Discard, reload and
offline use. Include phone, keyboard, axe, transparent/portrait images,
unchanged surrounding source and no remote requests from malicious MDX.
Recheck shell and rendered bundle loading rules.

## T48: image previews and existing image use in chats and agents

**Status:** Done

Make `show_file` and the card display image files and local image references
in plain Markdown and nested MDX, without weakening the preview sandbox.
Replace the server drawing renderer's image placeholders with bounded,
validated native image previews, preserving transforms, crop and opacity.
Add thumbnails and bounded deferred loading within the card's existing size
limits, with alt text and an Open in elaborat.ing fallback.

Add image metadata listing and insertion of existing project-image paths to
MCP and the in-app assistant. Return metadata instead of original bytes for
standalone image file reads. Preserve existing native drawing text reads,
which can contain embedded image payloads. Preserve project permissions,
version checks, change attribution and the assistant's Save/Discard flow. Deploy
readers before enabling binary writes, using T43's old-client compatibility
contract. Update file-format guidance and bump the plugin version if its
skills change. Rebuild the card and bump its view URI when its output changes.

Done when function/card tests cover Markdown, MDX, standalone files, native
drawing images, size caps, deferred failures and hosts without app tool calls.
Test malicious scene entries with remote URLs, spoofed formats, SVG,
animation and oversized/corrupt bytes. Unsupported legacy entries keep
their saved bytes with a display fallback. Browser tests cover the assistant
and panel; logs/results/source contain no credentials or signed asset URLs.
Historical note previews must not pick up a replacement image at the same
path. T43 through T48 complete release one.

## T49: import an image from a URL without remote document requests

**Status:** Done

Add explicit Import from URL to the shared image picker, following
[the URL import contract](images.md#network-isolation-and-url-import). Fetch an image once,
validate and save a private project copy, and insert its local reference.
An external Markdown image can offer Import this image; opening a note or
executing document code never starts an import. Require edit access and an
online connection, and preserve the original source on cancellation/failure.

Prove HTTPS/public-destination enforcement at connection time in the chosen
runtime, reusing the outbound callback checks where applicable. Bound three
redirects, total time, streamed bytes and decoded pixels. Recheck every hop,
block private/metadata/loopback/reserved IPv4 and IPv6, prevent DNS rebinding,
and forward no cookies, authorization or referrer. Add rate/reservation limits
and duplicate-safe retries. Authenticated sources and page scraping are out
of scope. Any agent import tool has `openWorldHint: true` and requires
authorization for the external fetch; document text is not authorization.

Done when adversarial network tests cover redirects to private hosts, mixed
DNS answers, rebinding, alternative IP forms, slow/chunked/oversized or
mislabelled responses, cancellation and retries. Browser tests prove the
saved image works after its source URL disappears and while offline, with
no third-party request when viewing it.

## T50: image transforms, rich captions, SVG, animation and description suggestions

**Status:** Done

The expanded [image feature set](images.md) includes explicit crop and resize
controls that produce new copies and retain originals; portable figure captions
with inline Markdown; validated, bounded SVG and animated GIF/APNG/WebP; and
description suggestions requested through MCP, using the client's own model.
Exercise these in notes and drawing insertion, with exact source Undo/Redo,
offline recovery, malicious SVG and animation budgets, and no document network
access. Description generation starts only when the person asks their MCP
agent. Supply only a bounded preview through `get_image_preview`; save alt
text only when asked, through the existing revision-checked note edits.
The image picker keeps manual descriptions without a direct model connection.

## T51: editable, collapsible document embeds

**Status:** Done

The MDX `Document` built-in embeds a separate same-project Markdown or MDX
file with lazy expansion, retained collapse, an Open separately action and
inline editing. Tabs and all embeds share one canonical draft, source buffer
and undo history. Parent Save includes changed loaded descendants through
ordinary per-file revision checks and names failures without dropping drafts.

References are parser-backed, participate in move/delete planning and refuse
URLs, computed paths, cycles and excessive nesting. Nested opaque previews
keep the existing network restrictions. Open, Save and Run require trusted
user gestures, and custom-code consent stays bound to the document identity.
Chat cards offer a safe same-project link. See
[embedded documents](embedded-documents.md) for the design, checks and limits.

## T52: personal project categories

**Status:** Done

Build the [project category scope](project-categories.md): a flat category
overview and project filters, multiple personal category assignments,
create/rename/archive/restore, cached offline browsing and matching MCP tools.
Keep project sharing and content revisions separate. Declare two tables with
RLS, explicit grants and checked RPCs, generate the migration and prove account
and project-access isolation with pgTAP. Preserve legacy project storage,
invitations, existing role actions and the no-category home. Browser, bundle,
function and database checks pass; hosted verification follows the automatic
release gate. See the scope for behavior and verification details.

## T53: unlisted file links and signed-in public discussion

**Status:** Done

Build [unlisted file sharing](file-sharing.md), separate from project
invitations: anonymous rendered reading of one saved file and its statically
authorized embeds, revocable owner links, and isolated public discussion.
Preserve drafts through sign-in, omit public email addresses and retain the
existing renderer isolation. Verify database access boundaries, browser
journeys, bundle budgets and the hosted flow, including the supplied script.

## T54: rendered typing keeps up in long notes

**Status:** Ready

Each keystroke in a note's Rendered view projects the whole note again on the
page's main thread, with one full MDX parse (`compileProjection` in
`src/features/rendered/instrumentation.ts`): in Bun, about 3.5 ms at 2 KB,
24 ms at 20 KB and 118 ms at 100 KB, and slower in Firefox. A `srcdoc` frame
shares that thread, so typing in a long note stalls. Measure two options
against a 60 KB note, in Chromium and Firefox:

- Project only the block that changed. Keep each top-level block's projection
  by its source, and for an inline edit inside one block that adds or removes
  no line break and no syntax at the start of a line, parse only that block
  and splice it in. Markdown reads blocks in context (setext underlines, lazy
  continuation lines, list interruption, link reference definitions, fences,
  HTML blocks), so either check the whole document again later, when idle,
  or take only edits proven not to depend on it, falling back to the full
  parse.
- Run `prepareFluidTransaction` and `projectFluidSource` in a Web Worker
  (prosemirror-model and @mdx-js/mdx need no DOM). The main thread stays free
  and only the ack waits, which the frame's optimistic editing already allows.

Every edit stays exact: the projection-equality check still decides it, and
compiled code is never reused across texts, since it holds absolute island
offsets. Done when the faster option is built, its numbers before and after
are in the pull request, and the rendered browser specs pass in both
browsers.

## T55: show unlisted content before independent assets

**Status:** Done (2026-11-04)

Implemented root-first, no-store NDJSON reading. Complete validated requested
source appears before child files and image bytes. Four dependency workers and
three image workers share the bounded, server-parsed graph. The 128-identity
limit includes missing and optional paths before requests are queued. Every
published result rechecks capability and revision; malformed streams and
access/revision changes invalidate the partial view. Individual descendant
failures remain local.

The viewer loads alongside data. Cheap unchanged checks leave incomplete
streams and healthy content intact. The client validates declaration order,
UTF-8 framing, completion and aggregate bounds. Export preparation completes
and verifies the frozen graph and original bytes before offering a package.
There are no client-authorized paths, Storage URLs, account credentials or
public offline response caches.

Evidence: file-share Deno authorization, queue, cancellation and limit tests;
sharing boundary/export unit tests; `progressive-public.spec.ts` and
`file-sharing-public.spec.ts` in Chromium and Firefox. The repeated hosted
reference is a baseline of the old deployment, recorded with measurement
limits in [progressive loading](progressive-loading.md).

## T56: open the requested project file before offline preparation

**Status:** Done (2026-11-04)

Implemented targeted authenticated file reads before full metadata and image
preparation, including another requested path during an incomplete pull. A
selected image can join a healthy immutable transfer or start ahead of queued
background images. Catalog lookup does not wait for other projects' pulls.
Ready assets publish after their durable transactions commit.

IndexedDB v3 stores a partial-readiness marker separately from the complete
revision. Upgrades preserve committed drafts; older tabs must reload before
writing. Interrupted pulls, quota errors and lost access keep the previous
checkpoint. Recovery preserves drafts, versions and pending mutation identity.
Metadata/Storage reads are cancellable; an already-sent authoritative save can
settle before optional pull cancellation. ZIP snapshots refuse incomplete data.
See [project loading](project-loading.md) for the full contract.

Evidence: `progressiveLoading.test.ts`, existing storage/sync/image suites,
SDK cancellation tests, and `progressive-project.spec.ts` in both browsers.
Journeys cover blocked bulk metadata, same-project navigation, partial offline
restart/reconnect, queued image priority, the chat panel and optional precache.

## T57: prepare only visible assets and publish each ready result

**Status:** Done (2026-11-04)

Implemented separate bounded image/drawing queues with per-result publication.
Source-only, hidden and initially collapsed previews do no unseen pixel or
drawing-engine work. Opened child sessions retain their drafts, undo and component
state while hidden/collapsed work is suspended. Explicit export and image
inspection request the resources they need.

Exact asset/source/companion identities retain ready pixels as siblings arrive,
invalidate replacements independently and refuse late results. Known image
dimensions reserve layout through bounded data-only messages. Chat cards share
two deferred host calls; portals preserve prose DOM/selection, and their first
component-frame transition waits for an active text selection to finish.

Evidence: asset concurrency, image-dimension, activity/protocol and shared
resource-cache unit tests; `progressive-preview.spec.ts`, `chat-card.spec.ts`,
embedded-document and image regressions in Chromium and Firefox. Existing
resolution, payload, isolation and offline guarantees remain.

## T58: show safe document content while MDX components prepare

**Status:** Done (2026-11-04)

Implemented a complete-source, display-only MDX projection with exact source
mapping, no executable document ESM/expressions and static protected islands.
Independent prose remains readable while modules or consent wait and after a
component fails. Source stays editable; rendered writes and export snapshots
wait for matching approved authority. Invalid MDX remains a parser error.

Source completion retains valid metadata while a later incomplete edit is
being checked; that catalog grants no execution authority. Runtime errors are
scoped to the current document, source, environment and render epoch. Newer
source/modules can recover without stale errors replacing the current view.
Frames, prose selection and healthy component state survive resource arrivals.
See [component preparation](progressive-components.md).

Evidence: projection/protocol tests plus delayed/failed module, runtime recovery,
consent, inline Source, navigation, nested-document and selection browser checks.

## T59: check time until useful content across the app

**Status:** Done (2026-11-04)

Implemented production-browser readiness ordering with independently blocked
metadata, images, drawing/decoding and component work. Tests measure project
home, first/cached Source/Rendered, expanded documents, public readers, cards,
chat panels and offline completion separately. Sanitized JSON attachments
contain timings and counts, never document contents, tokens or credentials.
Navigation-relative milestones include prior actions; aggregate request totals
are not isolated render/expansion durations.

The requested-Source test has a 20-second CI guard, while controlled gates
prove unrelated work cannot block ready content without relying on wall-clock
sleeps. Existing first-paint byte budgets remain unchanged. Optional precache
can be held while text is usable and then completed without changing inventory.

[Progressive loading](progressive-loading.md) records the anonymous hosted
baseline, local check evidence and limits. These observations are not a
production SLA; real-device/network targets and new hosted timings require
post-deployment samples of this branch. Existing editing, accessibility,
consent, revision, cancellation and offline regressions accompany the new checks.

## T60: prove custom component capture inside the existing sandbox

**Status:** Waiting (maintainer authorization to implement the feasibility check)

Follow [custom component exports and links](component-exports.md). Compare
the exact published browser capture candidates against the production opaque
preview and current CSP. Start with html-to-image 1.11.13 as a candidate,
without treating its upstream browser claims as proof. Do not add network,
same-origin permission, a proxy, or capture code to initial preview bundles.

Prove a scrubbed detached clone, empty visual form controls, current-state
capture, fonts, data-only assets, modern CSS and origin-clean canvas output.
Define raster transport, byte/pixel/DOM/deadline bounds, failure diagnostics
and cancellation before increasing any protocol limit. Measure Chromium,
Firefox and real Safari, including phone widths, tall components, autofill,
passwords and offline repeats. Record supported behavior and choose a pinned
implementation only when the checks pass. This task changes no share access.

## T61: preserve visual custom components in Notion and Google Docs exports

**Status:** Waiting (T60 and maintainer authorization to implement)

Implement the proved path from [the proposal](component-exports.md) in common
export preparation. Keep supported content editable and drawing/image exports
native. Unknown visual components get bounded PNGs with an authored label or
caption; unrepresentable components retain explicit fallback and diagnostics.
Preserve source, asset and module authority, input-value omission, code consent,
live focus/scroll/state, revision invalidation, isolation and complete-package
checks. Add no automatic model calls, account connection or sharing changes.

Done when Chromium and Firefox journeys verify both formats, image bounds and
detail, original assets, cached offline use, cancellation and stale replies.
Inspect every page of the reference DOCX and perform actual Notion/Google Docs
imports before claiming their fidelity. Record real Safari capture results and
any supported-browser limitation explicitly. Keep all first-paint budgets.

## T62: link exported components to their place in the original document

**Status:** Waiting (maintainer authorization to settle and implement target behavior)

Define the bounded, versioned target and safe fallback in
[the proposal](component-exports.md). Reuse the current unlisted link or the
private document's authenticated URL. Resolve only against files and instances
already authorized for that reader; never enable a share or add generic file
reads. Published targets cannot rely on raw render IDs or assume prose-only
reveal handles component islands.

Add checked object reveal and collapsed-ancestor expansion, layout readiness,
correct nested scrolling, accessible announcement and navigation cancellation.
Activate Rendered for private targets while preserving drafts and code consent.
Handle path-based root renames and hidden tabs without triggering arbitrary
component actions. Make interactive links an explicit export option because an
unlisted URL grants access to the latest whole shared document, not just its
captured component.
Test exact and changed revisions, duplicate instances, moved/deleted targets,
draft-only components, invalid fragments, revoked shares, private access,
back/forward and mobile use. If matching is absent or ambiguous, show the
document with a clear notice and do not select a different component.
Standalone public component routes and persistent source IDs are separate
decisions; source and sharing remain unchanged by exporting.

## Small things

Found while doing other tasks; each is small or rare. Make one a task when it
matters.

- Pin private-note original-image inspection to one immutable asset identity.
  `WorkspaceSession.readImageOriginal` reads file metadata and then reads bytes
  by path in a separate transaction. Replacing an image at that path between
  those reads can combine old dimensions/media type with newer bytes, or let
  an older original arrive after the inline preview updates. Use the captured
  immutable asset id and recheck its current binding before publishing. Cover
  a same-path asset replacement while original loading is delayed. This
  predates progressive loading; public share readers now bind their reader
  identity to the share revision.

- Investigate multiline composition insertion in Firefox's Source editor.
  Playwright's `keyboard.insertText` can insert the same text twice after
  returning from Rendered: one caret, a composition end followed by an
  `insertCompositionText` input event, and two copies in the durable draft.
  The loading journey uses ordinary key typing and checks the exact source.
  Reproduce with native IME input before assigning the cause to Monaco, the
  application or automation.

- Attribute global preview errors from asynchronous custom code to their
  originating render. Preparation and render failures carry their exact epoch,
  but a timer from a superseded component can throw after a newer tree is
  shown; the global error event currently reports that shown tree's epoch.
  Keep late background errors from revoking a newer healthy projection.

- Google Docs conversion of nested `sup` and `sub` elements can retain both
  vertical-alignment flags on one text run. Clear the inherited opposing flag
  and verify that the innermost element controls the exported alignment.
- Static custom-form export drops input values and CSS layout intentionally,
  but adjacent labels can become `EmailPassword` and source circle markers
  can appear beside a second list bullet. Preserve readable separation and
  choose one bullet representation without including entered form data.

- The public `SharedBundle` schema spreads the image pixel schema's fields
  for originals, losing its combined width-times-height refinement. Align that
  metadata boundary with the existing 8 MP check; the shared export adapter
  and image decoding still validate pixels before use. Keep malformed-image
  coverage without weakening the existing byte or decoded-pixel bounds.

- Consider an explicit local sign-out and account-switch flow. The current
  Sign out action uses Supabase's default global scope, which signs out
  other devices too. Cover session scope and account switching with tests
  so a reviewer account can be used without revoking personal sessions.
- Preserve safe image import validation details when the `images` function
  returns an HTTP error. The MCP wrapper currently exposes only "Edge Function
  returned a non-2xx status code", hiding expected URL refusals such as an
  own-host URL. Cover this boundary without weakening the URL restrictions.
- Record the exact successful release SHA as a GitHub production deployment
  and reject an older or divergent candidate before any deployment writes.
  The newest-green resolver can otherwise roll back a newer reviewed manual
  release when an older CI run finishes or a manual run leaves its SHA empty.
  Compare the successful deployment's SHA to the resolved candidate, rather
  than using the workflow run's head, which can name a different checkout.
- Investigate intermittent browser checks: the animated image's
  reduced-motion Play/Pause check passed on retry during the sharing release,
  and `typing-errors.spec.ts`'s press of Canvas right after typing JSON that
  is not a drawing failed once under parallel load (it passed 16 runs alone).
  Keep the assertions and use their traces to distinguish readiness races from
  application regressions.
- A Save shortcut pressed in a rendered note's frame is dropped when it
  arrives between an edit's acceptance and its React commit:
  `activatedDocumentAction` (`src/features/rendered/RenderedEditor.tsx`)
  checks the authority against the last committed document, and no keydown
  follows. It is why `rendered-split.spec.ts`'s "Cmd+S pressed inside the
  rendered note saves it" fails about 1 run in 6 under load. Check the
  shortcut against the authority, or hold it until the commit.
- `side-panels.spec.ts`'s "the project panel switches to another project and
  back to all projects" checks the project's URL before the workbench
  replaces it with the restored note's (`/projects/<id>/b.md`), so it fails
  now and then. Accept the opened file in that check, or check the note's URL
  once its heading shows.
- Two `workbench-typing.spec.ts` checks race the app. "Format and Export to
  Notion chosen in an edit's first moments..." must open File actions within
  the 300 ms before an edit shows as finishing: control that timer
  (`page.clock`). "A note's Source check is there as soon as its tab comes
  back" starts sampling at the tab's pointerdown, which in Firefox can come a
  frame before the click that switches tabs: start at the click.
- Under Bun 1.3.10 on a Mac, Shiki does not read end-of-line JavaScript
  comments as comments, so their annotations (`// [!code focus]`) are ignored
  and `codeHighlight.test.ts`'s "comment annotations highlight ranges, focus
  and show diffs without changing input" fails every time; under the pinned
  Bun 1.4.2, as on CI, it passes. If it fails under Bun 1.4, preserve the
  annotation assertions and find why before changing Shiki's regex engine or
  tokenization budget.
- The explorer's resize separator sits outside the app's landmarks. A full
  page axe scan reports `region`; checks scoped to the editor pass. Put the
  separator inside an appropriate landmark without changing keyboard resizing.

- The chat-card build audit retains its original direct `eval`, `new Function`
  and request checks, now ignoring JavaScript literals and comments. A broader
  audit should first handle the bundled UMD global-detection fallbacks: bare
  `Function('return this')` in `decimal.js-light` and indirect `eval` in
  `format`. Keep host CSP as the runtime boundary and avoid third-party source
  rewrites in an unrelated feature change.
- A late sync completion that recovered a conflicting project id can navigate
  back to that project after the person has left its page. Guard rekey-driven
  navigation against an unmounted page without losing the recovered project.
- During mixed-version use, an old tab can clear and repeat an identical
  stopped state before a new tab observes it, leaving the optional prior
  explanation until the next new-version retry. A future storage revision
  can add a stop generation; diagnostics must stay separate from sync control.
- Finish making browser-test caret navigation portable on macOS. The fixtures
  now keep native user agents, save shortcuts use `ControlOrMeta`, and the
  shared rendered helper maps line-boundary motion to the native keys.
  Remaining direct Home/End presses outside those journeys can still scroll
  instead of moving the caret. Replace them with explicit caret positions and
  arrow keys, as `tests/browser/rendered-lists-keys.spec.ts` does.
- In `update_and_show`, an old label written before its short-form shape
  (against the taught order) shows in the live view until the saved card
  replaces it.
- Once a person drags a shape, Excalidraw re-wraps an arrow's label to its own
  width (at least 220 px), wider than `draw` wrapped it.
- The label width table in `drawingCompletion.ts` is Excalifont's; text in
  other fonts uses it too, and a few wide characters (Æ, %, @) are wider than
  their class.
- In the ChatGPT panel, a `mailto:` link in a note still goes through the
  frame; the view opens only http and https links.
- A D2 source that crashes the engine outright would be reported to the model
  as "this chat does not let it run D2's engine".
- A host that allows `blob:` workers but not WebAssembly takes the same path
  in the card as one that allows neither, with no test of its own.
- In a note's Rendered view, after a click selects a computed value (a node
  selection) and an edit is refused, keys typed straight after a click
  elsewhere could still be lost before the browser reports that click:
  `adoptDOMCaret` in `src/preview/fluidEditor.ts` leaves node selections
  alone. Not reproduced.
- If the first click into a note is reported more than 20 ms late,
  ProseMirror's check after focus writes the old selection back over it; the
  workaround catches up only when keys were pressed since focus.
- A delete or a format change in a note's Rendered view that leaves italics
  or bold ending in a quote or other punctuation right before a letter writes
  that letter as a numeric reference (`*"*&#116;hese`, `**(two)**&#116;hree`):
  exact, but hard to read in Source, and there is no space to move out of the
  formatting there.
- A delete in a note's Rendered view from plain text into italics that leaves
  them starting with a space writes it as a reference (`*&#32;italic*`), which
  holds it exactly; ` *italic*` would read better.
- In a note's Rendered view, Enter at the start or end of a line the source
  wraps (a line break inside a paragraph) is refused: one of the two
  paragraphs would start or end with that line break, which Markdown drops.
  Taking it as whitespace Markdown cannot hold (`markdownForm` in
  `src/features/rendered/nearestForm.ts`) would apply it.
- Enter at the start of a later paragraph of a quote whose earlier paragraph
  spans several lines now writes the empty paragraph between the two quotes
  (`> one\n> two\n\n\n\n> three`), but no test covers it. Add one through
  `prepareFluidTransaction`, in md and mdx.
- In a note's Rendered view, Enter right before a space inside italics or
  bold writes the space as a reference (`*&#32;two*`), which holds it exactly;
  `*two*` would read better, but the editor would then take a document
  without the space.
- In a note's Rendered view, a request to view or edit a drawing or diagram
  that the app refuses (made as the note changes, or for a path the note does
  not hold) still reaches the error banner in the check's own words, such as
  "Rejected stale view request; source has changed." (`onError` in
  `src/features/rendered/RenderedEditor.tsx`); the plain "Edit not applied:"
  notice is for edits.
- Switching a note from Source or Rendered to Split doesn't carry the caret
  or the text at the top to the pane that appears, as switching between
  Source and Rendered does (WorkspaceSession's `showMode`).
- In a note's Rendered view, Enter at the end of a list item's first paragraph
  is refused when the item has another paragraph (`- a\n\n  para two\n- b`):
  it would leave an empty paragraph before the item's other one, which
  Markdown cannot hold. Decide what Enter does there, such as a new item after
  the whole item, in the frame's Enter chain (`src/preview/fluidEditor.ts`).
- Enter on an empty middle item of a nested list, in a quote or not, is
  refused: the standard Enter leaves an empty paragraph inside the parent
  item. Have the frame's Enter outdent the item there instead (`liftItem`),
  which is written exactly: `- a\n  - b\n  - \n  - d\n- e` becomes
  `- a\n  - b\n- \n  - d\n- e`. A top-level empty middle item in a quote has
  no Markdown form either way.
- An edit that would move a multi-line island (a code block, a component) in
  a quoted list, or in a list item indented with a tab, is refused:
  `islandCopy` (`src/features/rendered/fluidProjection.ts`) has no exact copy
  where the container's prefix is not plain spaces. Make it strip quote
  markers exactly, and test that the island's bytes and id are unchanged
  after the move.
- Tab on an item after one whose text starts with a list on its marker's line
  (`- - b\n- c`) is refused, since Markdown would merge the item into that
  list. Write the new nested list with another bullet, so it stays apart.
- Shift+Tab on a top-level item, and splitting a list around an empty
  paragraph, write the gaps between the items they rewrite anew: in
  `- a\n- b\n- c\n\n- d`, Shift+Tab on b writes `- c\n- d`. Keep each item's
  gap from the source, as `listItemsPatch` does for other list edits.
- Enter in a loose list inside a quote (`> 1. a\n> 2. b\n>\n> 3. c`) writes
  the whole quote again and drops its blank `>` line: `listItemsPatch` gives
  up when a gap holds `>`.
- Shift+Tab out of a loose list writes the list it joins tight:
  `- alpha\n\n  - beta\n\n- gamma` becomes `alpha\n\n- beta\n- gamma`, since
  the style comes from the one-item nested list. Keep it loose when the
  original list was.
- A line break inside bold or italics is written by closing the formatting
  around it (`**alpha**\\\n**bravo**`, `inlineSource` in
  `fluidProjection.ts`), where `**alpha\\\nbravo**` reads back the same. A
  line break has no formatting either, so Shift+Enter inside a link that
  spans a soft line break makes two links.
- Typing a space at the start of the line after a line break (before `bravo`
  in `alpha\\\nbravo`) is refused. Markdown drops that space, but
  `markdownForm` (`src/features/rendered/nearestForm.ts`) drops spaces only at
  the start of a paragraph or heading: drop spaces and tabs right after a
  `hard_break` too.
- Typing anywhere in a paragraph that holds a soft line break (a newline
  typed in Source) turns the break into a space in the saved note, in both
  browsers: prosemirror-view reads typed text back with
  `preserveWhitespace: true`, which reads a newline as a space, and the result
  is writable. Paragraphs with `whitespace: "pre"` may fix it; check how
  pasting parses then.
- Typing right after a soft line break that has a space before it can make
  it a hard break, and the edit is refused.
- After a held line break (Shift+Enter at the end of a line), Home, PageUp
  and the arrow keys with Alt, Ctrl or Meta take the break out, then move from
  the end of the line above.
- A join that puts a block island other than a code fence, a heading or a
  quote (HTML, a table, JSX, math) beside a paragraph in a list item writes a
  blank line between them, which makes the list loose (`followsTightly` in
  `fluidProjection.ts`).
- Bold, italics or strikethrough over a selection that includes an inline
  island (an image, a component) is refused by the range check on format
  steps. Decide whether formatting may be written around islands; if so,
  allow it in `prepareFluidTransaction`, with tests.
- Pasting text that ends in a space and a `#` at the end of an ATX heading
  (`x #`) is refused: `encodeProseText` (`src/features/document/index.ts`)
  escapes a block marker only at the start of an inserted string, so the `#`
  reads as the heading's closing sequence. Escape a trailing `#` run after a
  space when an insert ends a heading; the frame's `#` exception in
  `typedTogether` can then go.
- Two Ctrl+Z presses with no wait between them in Rendered can drop the
  second undo (about 1 run in 4): `FluidEditor` posts the second
  `fluid-history` before the first one's reset render arrives, with the old
  epoch, and the app ignores it. Hold history requests in the frame until the
  reset arrives, or let the app take one from the epoch it just replaced.
- In Chromium, Home or ArrowLeft before an image at the start of a line puts
  the caret inside the image island's hidden controls, so typing there does
  nothing. Keep the caret out of an island's inactive controls in the frame.
- An island edit (a code block, a table cell, a component's prop) renders
  every island again, though none starts again. Charts get new data arrays,
  so with Recharts' default animation each runs a 400 to 1500 ms animation
  that changes nothing on screen, and a `LabelList` hides its labels
  meanwhile. Reuse an island's element across compiles when its compiled
  props are equal (which needs `__slot` numbers that do not shift when a
  component is inserted before it), or keep a chart's data the same object
  while it is deep-equal (`src/preview/lazyCharts.tsx`).
- Leaves in islands after the caret rewrite `data-source-text`,
  `data-authoring-from` and `data-authoring-to` at every keystroke, and
  controlled inputs in component islands after the caret render again, since
  their source offsets move. The source-draft store reads its regions from
  those attributes (`regionOfElement` in `src/preview/sourceDrafts.ts`): keep
  the regions in a registry in the frame, and give the controls of Counter,
  Callout and custom components a slot selector that ignores offsets, which
  they need only to commit.
- In an island's prose (a table's cells, a component's children), a click
  beside a leaf selects the island, and typing then shows "crosses computed
  output" (`objectView` in `src/preview/fluidEditor.ts`,
  `src/preview/authoring.tsx`).
- The source-draft store handles table cells (leaves that are not a
  component's text) only halfway. `captureDraftsBeforeRender` captures them,
  and rebasing them over the cell's own patch fails, so after every cell edit
  the frame shows "An edit was interrupted. Recover your retained draft".
  `restoreSourceDraft` never restores them, so text typed into a second cell
  before the first cell's edit renders is lost when the table is made again,
  and a click from one cell to another can lose the caret
  (`src/preview/sourceDrafts.ts`).
- Text typed into a table cell stays in the frame until Enter or the caret
  leaves the cell, with no pending signal to the page: the note reads
  "Saved", no draft is written, and closing the tab loses it without asking.
  Send a pending signal for a cell's unsent text, or send it as it is typed
  (`EditableText` in `src/preview/authoring.tsx`).
- Pasting text with line breaks into a table cell is refused, as a cell is
  one line of the note; the frame could turn the line breaks into spaces.
- Typing straight after leaving a code block's editor or a table cell can lose
  the first keystroke: the island's edit moves the revision and epoch, the
  frame's next edit, made in the old epoch, is refused as stale, the reset
  drops what the frame had waiting, and the next accepted key clears the
  notice. A fix needs a rebase lease for fluid edits across the app's own
  direct edit, or an answer to that edit that keeps the frame's epoch and
  waiting input; both touch the projection-checked path.
- After an image is inserted, and after a reload straight into Rendered, the
  workbench reads the pixels after the note's first render, so the picture
  still pushes the note down when they come: a whole render carries sizes
  only for pixels the workbench already has. Hand the inserted image's
  preview over with the edit, keep previews across a reload, or give sizes
  from the image file's metadata (`WorkspaceSession.tsx`,
  `RenderedEditor.tsx`).
- When `WorkspaceSession`'s image effect fails (for example
  `parseImageReferences` throws on MDX that does not parse while Source is
  typed in), it gives the rendered view an empty image set, and the frame's
  pictures go, keeping their boxes, until the note parses again. Keep the
  last pixels instead.
- An embedded document's header gets its Open separately and Save document
  buttons only at the first expansion, which reflows the header row
  (`src/preview/DocumentEmbed.tsx`).
- In an embedded document's editor, "Edit not applied" and "Loading
  components" still show in the flow, since its root is `display: contents`,
  so they move the layout. Pass them to the embed host (`DocumentEmbedState`
  in `src/features/rendered/documentEmbeds.ts`), so the parent frame's
  `DocumentEmbed` shows them over its own box.
- The sandbox domain's frame is hidden until it says ready, and meanwhile its
  box shows the page's background, then the panel colour: a small change of
  shade the first time a note opens there. Give the frame's box the panel
  colour while it loads, without changing the comment rail's background
  (`RenderedEditor.tsx`).
- Each `render-ack` still carries the note's authoring boundaries and block
  boundaries, about 23 KB a keystroke in a 60 KB note. Send them as changes
  if acks ever become a measurable cost.
- Make `scopeKey` required in `fluidRenderSchema`
  (`src/features/rendered/protocol.ts`): `RenderedEditor` always sends it, and
  the chat card's `cardEditor.ts`, which hands `FluidEditor` a render
  directly, would pass the projection's too.
- Build the preview frame with the React Compiler preset the app and the
  harness use (`buildFrame` in `vite-plugins/preview-frame.ts` uses only
  `react()`), so the frame's own components are memoized too. Check the
  bundle size, and components that read refs during render.
- Decide whether `compileForPreview`'s authoring markers are still needed:
  nothing in the app calls it, and only tests (`blocks.test.ts`,
  `instrumentation.test.ts`, `documentBlocks.integration.test.tsx`) compile
  with authoring on. Check whether the frame's `SourceBlock` handling
  (`src/preview/authoring.tsx`, `preview-entry.tsx`) can still be reached,
  and remove the path and its tests if not.
- Under JavaScriptCore (Bun, Safari), Source underlines the wrong line for a
  compiler error that has no place: `placedMessage`
  (`src/features/rendered/instrumentation.ts`) appends any Error's line and
  column, and a plain Error there carries its throw site, so "Expected `key`
  to come before any spread expressions" reads "(344:27)", a line of
  estree-util-build-jsx. Take a place only from a VFileMessage, or an error
  with `place` or `position`, and test it under Bun.
- The React Compiler skips `WorkspaceSession`, `WorkspaceWorkbench` and
  `RenderedEditor` silently ("Handle Import expressions", "Support
  ThrowStatement inside of try/catch", "Handle TryStatement with a
  finalizer"). Move their dynamic imports and try/finally bodies into
  module-level helpers, then check what they read during render from mutable
  state outside React (`documentEmbeds`, `store.snapshot()`, refs), which the
  compiler would memoize and leave stale. Done when the compiler compiles each
  and the workbench browser specs pass.
- Typing in Source or Split in an MDX note whose text has a brace or an
  import line still compiles its component environment at every change, and
  inspects and compiles each imported module again; typing in Rendered waits
  for a 500 ms pause. Have the projection return its code inspection (ESM,
  expressions that are not literals, imports), classified exactly as
  `inspectComponentModule` does, so `useComponentEnvironment` can skip a
  compile that would give the same environment, and cache module inspection
  and compiles by path and text (`componentModules.ts`). Keep the custom-code
  check exact.
- `WorkspaceSession` still parses a note with image syntax at every keystroke
  for its own image loading, while `RenderedEditor` keeps the note's image
  keys by runtimeKey. Share one parse, such as the rendered view reporting the
  key set, keeping the parser's allow-list and the modules' ESM scan.
- Every open tab's `WorkspaceSession` renders again on every workbench render
  (saves, sync, list refreshes, panel toggles). Wrap it in `memo` with stable
  per-tab props: the server copy by id and version, `onDuplicate` and
  `onResolveConflict` per path, `embeddedViews` grouped by path, and
  navigation.
- In the app, `RenderedEditor` makes a second React commit of its own at each
  keystroke (the harness makes one). Find the state it sets in a separate
  task, such as the frame's height, and fold it into the edit's commit.
- Typing in a note with comment threads costs about four React commits a
  keystroke: `useNoteComments`' deferred placement renders the session, and
  `RenderedEditor` with it, once more after each one. Place the threads in a
  child that the deferral renders alone, or keep the comments prop the same
  while the marks are.
- Library state changes reach an open workspace as `files` changes:
  `ProjectPage` passes `library.subscribe` as `subscribeSync`, so opening File
  actions (which refreshes the project list) lists the project three times
  and renders the workbench six times, and a save's sync about sixteen times.
  Tell the workspace once per sync that changed this project's files or
  folders.
- Once Rendered has shown, its hidden editor keeps projecting every Source
  keystroke (`RenderedEditor`'s projection effect does not check `active`),
  so typing in Source compiles the note three times a key. Pause the
  projection while it is hidden, and project once when it shows.
- Closing a tab with Discard right after a fast burst of typing can leave its
  draft: an edit still on its way lands after the discard and the session
  writes the draft back, or the discard stops with "This project changed
  while discarding its draft. Try again." (the text is kept). Wait for the
  session's pending edit, or freeze the session, before discarding
  (`closeTab` in `WorkspaceWorkbench.tsx`).
- Closing a tab while a document embedded in it has an edit on its way loses
  that edit without asking, since `closeTab` checks only the closed file's
  own session. Wait for each embedded descendant's `whenEditFinished` and
  `persistDraft` first, walking them as `saveTree` does and as leaving the
  page does.
- Keys typed in Rendered while an edit is being checked wait in the frame, as
  one edit, until the app answers, so a forced reload or a crash loses them
  (leaving a note with unsaved changes asks first). Flush them on `pagehide`,
  or find another way to get them into the draft sooner.
- In Split, typing in Source while rendered keys still wait in the frame
  refuses those keys ("Edit not applied"), and a rendered patch that lands
  after the click moves Monaco's selection, so the Source keys can land in the
  other paragraph. Rebase waiting rendered edits over a Source change, and
  leave a focused Source editor's selection alone (`applyExternalPatches` in
  `src/features/source/MonacoSourceEditor.tsx`).
- An embedded document's unsaved draft has no unsaved marker in the explorer
  when the document has no tab of its own: `ExplorerTree`'s `isDirty` reads
  only the tabs. Let it also read the listed file's draft or the published
  embed state.
- After sync deletes or moves an open file, its session writes the open text
  as a new local draft at the old path, since its draft effect runs again
  when the saved revision leaves the list (`WorkspaceSession.tsx`). Leave such
  a file to the conflict path, or follow the move.
- A Split-view click 2 px inside the source pane's right edge once raised an
  uncaught "Matching panels not found" (`SplitPanes`, next to the resize
  handle), and it did not happen again. Check the handle's hit area.
- `ShareFileDialog` and `AgentChangesView` list the project again on every
  store change, so edits still on their way when one opens make one list
  each. They could ignore `drafts` changes.
- A note whose component files pass the app's 2 MiB in all is sent only the
  ones read before the limit (`componentSources` in
  `supabase/functions/mcp-server/tools/componentSources.ts`); where those fit
  in the chat card, its preview says the next file is missing, not that the
  files pass 2 MiB.

## Done

- Selecting rendered code preserves the native selection and reading
  position, including drag, double-click and keyboard copying after a prose
  selection. Code stays selectable in editable chat cards, and only
  **Edit code** opens the code editor, without accidental edits or saves.
- Code blocks offer Copy code in rendered Markdown/MDX notes, read-only
  views, chat cards and isolated component previews. Copy preserves original
  whitespace and highlighting annotations, or the current code-editor draft,
  without changing or saving the note. Clipboard refusal offers a retry and
  manual selection; frame requests retain activation and isolation checks.
- Code fences share highlighting for 72 common programming, shell, markup
  and configuration languages in notes and chat cards, with case-insensitive
  aliases such as `cpp`/`c++`, `c#`, `rs`, `py` and `yml`. Embedded languages
  are registered together before caching; a bounded two-second per-line
  tokenization budget allows cold C++ and MDX grammars to finish. Language
  labels and exact source stay unchanged, and highlighting remains lazy and
  self-contained for isolated frames and offline use.
- Rendered Enter preserves ordered-list `.` and `)` delimiters, including
  non-1 starts, nested and loose lists. Enter, Backspace and Undo/Redo keep
  precise Markdown/MDX source; unit and Chromium/Firefox regressions pass.
- Stopped sync retains bounded known-safe validation explanations across
  browser reloads, with legacy record and account isolation coverage.
  Retry progress covers queued work, disables duplicate manual retries and
  returns to Synced without refresh. Older request results cannot restore a
  stale error after recovery; saved files and newer drafts remain intact.
- The rendered view edits lists in many more shapes with the standard keys
  (Enter, Tab, Shift+Tab, Backspace, Delete, Shift+Enter), keeps numbered
  lists counting, keeps each island's state across edits, answers each
  keystroke with a small ack, and no longer moves or flashes the note while
  typing or when its fonts, palette or a notice arrive. Every edit stays
  exact; unit and Chromium/Firefox regressions pass.
- T1: find out whether MCP Apps hosts allow runtime-compiled components (#2)
- T2: ship license notices for bundled third-party code (#3)
- T3: extract searchable passages from notes and diagrams (#4)
- T4: sign-in and OAuth consent pages (by the maintainer)
- T5: fail pull requests whose migrations are out of date (#5)
- T6: test the MCP server's tools and check Edge Functions in CI (#6)
- T7: restore the drawing tests with a synthetic Obsidian drawing (#7)
- T8: tell open projects about remote changes over Realtime Broadcast (#8)
- T9: run the drawing fidelity checks on the synthetic Obsidian drawing (#9)
- T10: Enter right after arrow keys splits at the old caret position in Chromium (#10)
- T11: rendered notes use components from project files, and follow their changes (#11)
- T12: the app restarts offline (#12)
- T13: projects exported from the prototype import into elaborat.ing (#13)
- T14: Ctrl+S saves the file whose editor has focus (#14)
- T15: the first visit downloads less for offline use (#15)
- T16: returning to the rendered view keeps its place and does not take focus (#16)
- T17: a touch scroll over a rendered note does not focus the editor, and a tap does (#17)
- T18: Undo in the Source view reverts an edit made in the Rendered view (#18)
- T19: renaming a node on a diagram's canvas updates its code (#19)
- T20: a reloaded project never drops a remembered tab (by the maintainer)
- T21: "Unsaved changes" goes away when the text is back to the saved copy (#20)
- T22: rename and move a folder (#22)
- T23: accept an invitation, and leave a shared project (#23)
- T24: delete a file or a folder (#24)
- T25: archive, unarchive and permanently delete a project (#25)
- T26: closing the last tab keeps the project page mounted (#26)
- T27: the file store refuses to delete a file with unsaved edits (#27)
- T28: viewers and archived projects open read-only (#28)
- T29: sign in with a one-time code, GitHub or Google (#29)
- T30: see who a project is shared with, and change or remove their access (#30)
- T31: a sync conflict shows what differs before you choose (#31)
- T32: a stale message from the rendered frame never shows as a render error (branch claude/t32-stale-frame)
- T33: a new file asks for its name, and an unsaved new note can be renamed (#32)
- T36: show_file keeps a note's component files under the size cap (by the maintainer)
- T37: stop loading deferred drawings once the host stops answering (by the maintainer)
- T42: the card's messages to the model don't replace each other (by the maintainer)

After T33 the work was tracked elsewhere until the queue came back here in
October 2026; `git log` describes each change by its outcome.
