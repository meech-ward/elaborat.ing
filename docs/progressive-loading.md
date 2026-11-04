# Progressive loading

**Status: requirements recorded; implementation pending.** The 2026-11-04
request authorizes documentation only. The follow-ups are
[T55 through T59](tasks.md#t55-show-unlisted-content-before-independent-assets),
waiting for implementation approval. This document does not mark the current
loading paths as fixed.

## Required behavior

Across the app, load what the current view or explicit action needs, and show
each safe, ready piece immediately. Opening a file must prioritize that file.
An unrelated file, a later image, a collapsed child, or preparation for offline
use must not hold up content that can already be read or used.

A lightweight shell and a loading indicator are useful first steps. The
requirement also covers the time until the requested document is readable and
usable. Passing the JavaScript and CSS bundle budgets alone does not prove it.

This applies to project browsing and first open, Source, Rendered and Split,
images, drawings, diagrams, embedded documents, public links, comments, search,
chat cards and the embedded project panel. The audit below confirms particular
gaps; it is not a claim that every route has been measured or has the same bug.

- Begin independent work together where safe, using bounded concurrency and
  cancellation. Avoid chains of requests that can be batched or overlapped.
- Publish ready assets individually, with placeholders and known dimensions
  for pending ones. A slow or failed asset must not hide earlier ready content.
- Load preview engines when that preview is needed. An idle Source-only note
  must not render drawings or decode images for an unseen Rendered view.
  Explicit actions such as image inspection or Prepare export can need them.
- Keep initially collapsed documents deferred; retain already opened sessions
  and drafts. Reuse valid local data and compatible modules; synchronize and
  prepare offline copies in the background.
- Prioritize visible content before optional prefetch and offline caching.
  Do not restart a healthy view, lose interaction state, or replace its source
  with stale work when a later asset or request completes.

## Confirmed gaps and existing behavior

Read-only code audit on 2026-11-04, against `e5cf8ed`. Recheck current code
before implementing. These are loading follow-ups to functioning features.

| Area | Current behavior | Follow-up |
|---|---|---|
| Unlisted file | The server resolves the whole authorized dependency graph and original/preview image bytes in sequence. The browser consumes and validates the whole JSON response before starting the lazy viewer import. | T55 |
| Unlisted refresh | Visible-page polling and focus refresh rebuild and download the whole bundle. The unchanged-revision comparison happens after the response arrives. | T55 |
| First authenticated project open | The workbench waits for the full project pull, including every image original and preview, before any pulled files are applied locally. A missing catalog entry can also await catalog refresh and other project pulls. | T56 |
| Cached project open | The local project opens first and synchronization runs in the background. Retain this useful fast path. | T56 |
| Note preview assets | Active Source-only notes can prepare images and the first eight drawing/diagram previews. Images and drawings are processed serially and each resource map is published only after its entire loop completes. | T57 |
| MDX first display | Component preparation and whole-source projection gate the initial rendered view. Ordinary prose does not wait directly for the image/drawing loops, but there is no independent prose display while component preparation is pending. | T58 |
| Existing lazy behavior | Monaco and the rendered editor load with their views; drawing/diagram views have separate modules; initially collapsed document embeds defer attachment. Preserve these boundaries and address the preview side effects above. | T57, T58 |
| Performance checks | Bundle checks protect first-paint bytes and heavy-library boundaries. They do not enforce readiness of useful document content under delayed data or assets. | T59 |

Entry points for the audit:

- [Shared-file request](../src/features/file-sharing/publicRemote.ts),
  [page](../src/features/file-sharing/PublicFilePage.tsx),
  [resource rendering](../src/features/file-sharing/SharedFileRenderer.tsx),
  [server assembly](../supabase/functions/file-share/handler.ts) and
  [dependency reads](../supabase/functions/file-share/dependencies.ts).
- [Project open](../src/features/projects/ProjectPage.tsx),
  [library](../src/features/project-storage/library.ts) and
  [image caching and project pull](../src/features/project-storage/sync.ts).
- [Note preview effects](../src/features/workbench/WorkspaceSession.tsx),
  [component preparation](../src/features/document/useComponentEnvironment.ts),
  [rendered view](../src/features/rendered/RenderedEditor.tsx) and
  [collapsed documents](../src/preview/documentEmbed.tsx).

### Hosted reference measurement

On 2026-11-03, two direct anonymous requests for the reference script returned
35 files and 18 images. The HTML response completed in about 0.4 seconds.
The document bundle completed in 24.4 seconds on the first call and 15.8
seconds on an immediate repeat. Reading the body after response headers took
about 0.24 and 0.15 seconds respectively. Decoded JSON was about 3.34 MB,
including about 3.13 MB of original and preview image data URLs.

These are observations from one client, not service-level targets or a full
browser trace. They show a long wait before the bundle response begins; they
do not isolate each database, Storage, CPU or startup cost. The earlier
12.8-second hosted reference remains recorded in T55. Future measurements
must distinguish data wait, transfer, module loading and useful display.
Do not put share tokens, document contents or account credentials in traces
or committed fixtures.

## Contracts that the follow-ups must preserve

Progressive display does not authorize new access or weaker validation.
Public dependency reads must remain bound to an active file link and the
server-parsed allowed graph. Recheck revocation and revisions as required
before publishing later results; do not introduce generic path reads,
offline public-document caching, or account credentials in the preview.
Keep sandbox isolation, private-project code consent, all byte/pixel/depth
bounds and full-resolution image behavior.

Separate partial availability for display from complete offline availability.
The current project revision represents fully ingested data, including
validated image originals and previews. It cannot be advanced merely because
the selected note is visible. Define any partial-ready state and recovery
contract before implementation, including older open tabs, interrupted pulls,
account partitions, version conflicts, immutable image identity and drafts.

MDX needs safe, source-backed boundaries. Do not execute partial source,
present an unvalidated projection as editable, or bypass component policy to
show prose earlier. Pending components can have stable placeholders only
where the validated document model supports them. Preserve selection, focus,
scroll position, Undo/Redo and component state as resources arrive.

An operation that promises a complete result still completes that result
before reporting success. Save and Sync retain authoritative commit and
revision rules. Project ZIP and Notion export keep their complete-package
checks and conversion review; they must not offer incomplete downloads.
The demand for those assets comes from the explicit export action.

The service worker's existing whole-build precache is intentional offline
preparation. It is separate from the first-display requirement. Check that
background downloads do not contend with requested content; changing the
precache inventory or offline guarantee needs its own recorded decision.

## Verification required before calling this implemented

T59 must cover cold first visits, cached revisits and offline reopening, and
record time to readable requested content separately from shell paint and
time to all assets. Agree realistic budgets from measurements on representative
devices and networks; the observations above are not acceptable targets.

Use controlled delayed, failing and out-of-order unrelated assets in Chromium
and Firefox. Prove that requested text and the first ready asset appear while
later assets remain blocked, and that an idle Source-only view does no preview
work. Exercise first project open, unlisted links, MDX and embedded documents,
plus cancellation, navigation, stale revisions, revocation and interrupted
offline preparation. Preserve editing and accessibility checks and the
existing bundle budgets. Complete the shared-renderer audit for chat cards
and the project panel without assuming their loading paths are identical.

Update this document, the linked feature notes, architecture, roadmap and
task statuses with evidence as each follow-up is implemented. Until then,
describe the behavior above as required or pending.
