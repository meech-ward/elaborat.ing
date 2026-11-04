# Progressive loading

**Status: implemented and locally verified on 2026-11-04.** Implementation was
authorized on 2026-11-04. T55 through T59 cover the public reader, project
storage, preview assets, MDX preparation and useful-content verification.

## Implementation

- Public links stream the complete validated requested source before child
  sources and image bytes. Every published result checks the active link and
  revision. Discovered identities, including missing and optional paths, are
  bounded before reads are queued. Missing descendants stay local; revocation,
  revision changes, invalid streams and aggregate limits invalidate the view.
  Unchanged refresh keeps an ongoing stream and its ready content intact.
- Projects prioritize a requested file, including a later navigation during a
  partial pull. The durable partial marker, progress and retry state are
  separate from the complete offline revision. Image demand can join or move
  ahead of background work. Cancellation reaches metadata and Storage requests.
  [Project loading](project-loading.md) defines recovery, migration and exports.
- Source-only and hidden/collapsed previews do no unseen decoding or drawing
  work. Visible assets publish individually with known image dimensions.
  Exact immutable/source identities retain healthy pixels while siblings arrive.
  File-session orchestration loads when a file opens, preserving the existing
  first-paint budgets without increasing them.
- MDX parses its entire current source and can show checked, read-only prose
  with protected pending/unavailable islands. Imports and expressions do not
  execute in that provisional projection. Matching approved code restores
  editing. Runtime initialization failures use the same safe fallback; stale
  render epochs cannot invalidate a newer projection. See
  [component preparation](progressive-components.md).
- Chat cards already show server HTML while their component frame prepares.
  Deferred drawings and images share two bounded host calls and publish
  individually. Resource portals preserve the prose DOM and selection; an
  initial component frame waits for an active prose selection to finish.
  The embedded project panel uses the same prioritized project opening after
  its existing pass and account checks.

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

## Historical audit before implementation

Read-only code audit on 2026-11-04, against `e5cf8ed`. Recheck current code
before implementing. This table records the original gaps, rather than the
implemented behavior above.

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

### Hosted browser baseline

Repeated anonymously on 2026-11-04 against the maintainer-supplied reference.
This measured the existing deployment, not the new branch. Headless desktop
browsers used a 1280 by 900 viewport on an Apple M4 with 32 GiB memory, no CPU
or network throttle, and service workers blocked. Each browser had one fresh
context and one revisit in the same context. Backend/CDN caches were not reset.

| Browser | Client cache | FCP | API headers since navigation | Body transfer after headers | Readable prose |
|---|---|---:|---:|---:|---:|
| Chromium | Cold | 0.288 s | 23.652 s | 0.259 s | 24.799 s |
| Chromium | Revisit | 0.084 s | 13.658 s | 0.368 s | 14.490 s |
| Firefox | Cold | 0.639 s | 25.078 s | 0.573 s | 27.386 s |
| Firefox | Revisit | 0.075 s | 13.030 s | 0.655 s | 15.808 s |

The anonymous JSON was 3,344,861 decoded bytes. Cross-origin resource timing
did not expose compressed API bytes; privileged request timing supplied phases.
The interval from body completion to readable prose ranged from 0.464 to
2.123 seconds, combining viewer loading, validation, compilation and rendering;
those costs were not individually profiled.
Chromium emitted request-failed instrumentation as the HTTP 200 share response
ended despite readable content, so that event alone does not diagnose a network
failure. All-inline-image decoding was not observed within ten seconds after
readable content; no scrolling or child expansion was forced. Image DOM counts
include repeated instances and are not unique-asset counts.

These single samples isolate client milestones, not an end-user performance
target. Concurrent local work and warmed backend caches limit comparison.
Post-deployment performance measurements of the new protocol must use the same conditions
and distinguish first prose, first asset and complete assets. No reference
token, source, credentials, trace or screenshot was saved in the repository.

### Hosted progressive-stream smoke check

After deployment of `1f40b6f` on 2026-11-04, fresh Chromium and Firefox contexts
checked the same reference with service workers blocked. Both received an HTTP
200 NDJSON stream containing all 35 files and 18 images, followed by completion
and EOF, with no protocol, file, image or transport errors. The root file
arrived in physical response chunk 13 of 114 in Chromium and chunk 5 of 223 in
Firefox. Both showed substantial rendered prose before the stream completed,
and decoded image pixels were present. This verifies root-first transport and
useful progressive display through the hosted gateway, rather than only local
fixtures. No source, token, screenshot or trace was persisted.

This functional check did not record milestone durations or simulate constrained
devices or networks. Chromium reported one unclassified failed-request event;
Firefox reported none. Neither browser reported a page error, and the manifest
finished successfully in both. These samples do not establish a latency target.

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

## Verification and regression budgets

The deterministic production-browser checks cover cold first visits, cached
revisits and offline reopening. `tests/browser/readiness.ts` writes sanitized
JSON attachments for shell paint, HTML/data phases, requested content and
offline completion. Hidden cross-origin timing fields remain null. Source and
public content assertions wait on visible readable content; independent gates
hold unrelated metadata, bytes, decoding or modules until that assertion passes.
Milestones are navigation-relative observations and can include prior user
actions or assertions. Summed request durations aggregate completed requests;
they are not an isolated render or expansion duration.

The requested-Source journey has a generous 20-second CI ceiling to catch a
hung view. The stronger regressions assert readiness ordering while unrelated
work is explicitly blocked, independent of machine speed. This CI ceiling is
not a production SLA. The hosted observations above are baselines, not targets;
real-device/network budgets need post-deployment samples of the new protocol.

The `progressive-loading`, `progressive-public`, `progressive-project` and
`progressive-preview` browser specs exercise these milestones, cancellation,
navigation, stale revisions, revocation, partial offline recovery, component
failure, hidden/collapsed work, selection and known-dimension layout. The chat
card and embedded-panel regressions check their distinct loading paths. The
precache check holds optional engines while requested text becomes usable, then
waits for the complete build cache; its inventory and offline guarantee are
unchanged. Existing editing, consent, accessibility and bundle checks remain.

Local verification completed on 2026-11-04:

- Production, chat-card, browser, harness and next-version builds; TypeScript
  and ESLint passed. Rebuilding the committed chat card produces identical
  artifacts. All seven first-paint budgets and heavy-library boundaries pass
  without raising a budget.
- App tests: 1,674 passed, 13 skipped and two existing TODOs across 196 files.
  The two script-test files passed all four tests.
- All nine Edge Functions passed frozen Deno checks and tests: 302 tests.
- Combined browser coverage checked 874 selected Chromium/Firefox cases:
  872 passed and two existing touch checks were skipped. The broad run and
  green focused reruns cover the same final behavior; the final affected
  loading, approval, embeds and rendering suite passed 146 of 146, and the
  corrected component suite passed 30 of 30. The final workbench, rendering,
  loading, editing and approval confirmation passed 252 of 252, including saved-copy
  caret/focus, module-rebuild focus and ready pixels, code-block drafts during
  unrelated source changes, retained stale-edit refusal notices, type-in and
  deferred hidden-tab adoption. Interrupted offline
  recovery also passed three consecutive runs in each browser.

This verifies local production fixtures and source contracts. The hosted
timings above measure the earlier deployment; the new deployment's functional
stream check establishes progressive display without a timing comparison.
Repeated post-deployment measurements and representative device/network targets
remain operational follow-up. The 20-second Source guard is deliberately
generous relative to the observed 1.065 to 2.106 seconds below; it catches a
hung CI view rather than defining an end-user latency target.

### Local fixture observations

The 2026-11-04 production-browser run used headless Chromium and Firefox on
the same Apple M4/32 GiB machine, no network or CPU throttle, four main test
workers and occasional concurrent focused checks. These are navigation-relative
observations from synthetic fixtures, including assertions and earlier user
actions, rather than isolated render durations or hosted performance targets.
The public-root range covers four different blocked/failing-asset fixtures.

| Milestone | Chromium | Firefox |
|---|---:|---:|
| Project home | 0.333 s | 0.796 s |
| Requested Source | 1.065 s | 2.106 s |
| Cold project, unrelated metadata still blocked | 1.513 s | 2.144 s |
| Cached Rendered | 1.554 s | 1.600 s |
| Expanded document, including earlier actions | 1.935 s | 2.047 s |
| Partial project reopened offline | 0.905 s | 1.906 s |
| Public readable root | 0.508–1.138 s | 0.798–1.396 s |
| Chat-card prose | 0.171 s | 0.143 s |
| Chat-card first independent asset | 0.214 s | 0.174 s |
| Whole-build offline preparation complete | 4.832 s | 9.077 s |

The controlled gates, not these elapsed values, prove that unrelated work
cannot block ready content. The complete-cache milestone follows release of
the optional-engine gate; it does not measure a production download rate.
