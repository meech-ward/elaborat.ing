# Custom component exports and links

**Status: research proposal, implementation pending.** The 2026-11-04 request
authorizes research and documentation. The recommendations below extend the
existing [Notion ZIP](notion-export.md) and [Google Docs DOCX](google-docs-export.md)
exports; they are not implemented export behavior.

Keep document content editable, capture visual components as images, and offer
readers a link back to the interactive component in its original document.
A login form should retain its layout and empty field boxes in the export.
A callout should retain editable text. Neither needs runnable MDX in Notion
or Google Docs. An image records one export-time view; a link opens the latest
saved document and does not restore transient component state.

## What exists today

Code audit at `6f63d65`, checked on 2026-11-04:

- Markdown and an explicit subset of built-in components convert to semantic
  HTML, then to the chosen format. Other components and expressions request
  source-matched snapshots from the isolated rendered view. Some built-ins,
  including dynamic widgets, also use that snapshot path.
- The frame supplies rendered HTML and selected computed styles. The parent
  sanitizer keeps semantic content but drops presentation styles. DOCX applies
  its own document styles. This explains why a CSS-driven form can become
  adjacent labels such as `EmailPassword`.
- Form controls and their values are omitted before the reply leaves the
  frame. Whole HTML components do not become PNGs. Existing canvas and safe
  SVG content do become raster assets.
- Matching live views contribute current component output. Source-only and
  unopened notes use a fresh, offscreen, noninteractive rendered view with a
  finite viewport. Imported modules retain saved-source authority.
- The public reader has no URL target that opens and reveals a component.
  Existing iframe-local `#fragment` clicks can scroll to a DOM id/name, but
  the outer unlisted URL does not route its fragment to that frame. Ordinary
  Markdown headings do not currently get automatic IDs, and private note-link
  navigation discards target fragments.

Relevant code: [source conversion](../src/features/exports/notionHtml.ts),
[frame serialization](../src/preview/notionSnapshot.ts),
[snapshot protocol](../src/features/rendered/protocol.ts),
[renderer API](../src/features/rendered/RenderedEditor.tsx),
[offscreen preparation](../src/features/exports/NotionSnapshotRenderer.tsx),
[common export preparation](../src/features/exports/notionExport.ts), and
[public reader](../src/features/file-sharing/SharedFileRenderer.tsx).

## Recommended conversion policy

Choose the representation from a supported conversion contract, rather than
guessing whether arbitrary component HTML looks simple enough.

| Content | Proposed export | Reason |
|---|---|---|
| Prose, code, lists, tables and supported callouts/cards | Editable structure | Preserve reading, selection, search and ordinary editing. |
| Supported tabs and collapsible document sections | Expanded readable sections | Include their content without requiring interaction. |
| Project images, Excalidraw and D2 | Existing original-image or native-renderer path | Preserve the existing detail and geometry guarantees. |
| Custom forms, dashboards, games and other unknown visual components | One bounded PNG of each selected component region | Preserve layout instead of silently flattening CSS. |
| Dynamic inline expressions with a supported text result | Editable text where the result is representable | Avoid replacing an ordinary sentence with a picture. |
| A component that cannot be captured or is too tall to remain readable | Visible text/source fallback, a conversion note and an available link | Never treat an empty image or missing component as success. |

For a captured component, include an authored label or caption. When interactive
links are enabled, place an ordinary text link below the image. A text link
travels more predictably between formats
than relying on an image hotspot. Use a generic label if none was authored;
do not add a model call or automatic description. Check the resulting image
alternative text in both importers. A picture alone cannot provide the same
accessibility or editability as its original component, so preserve an authored
text explanation when available.

A first release should support bounded forms and visual cards. Long components
need either readable, bounded image segments or an explicit fallback. Fitting
one very tall screenshot onto a DOCX page can make every label unreadably small.
Do not silently clip it or allocate a giant full-height canvas before splitting
it. Segmenting long components is a separate capture capability to prove.

## What each destination can preserve

For the existing Notion ZIP and DOCX download, embedded PNGs plus normal text
links are the shared target. An imported file does not carry the MDX runtime.
The [Office import workflow](https://support.google.com/docs/answer/9406611)
lets a person open the DOCX with Google Docs without connecting their account
to Elaborating.

Notion separately supports live URL embeds, but this would be another feature.
Its [embed guide](https://www.notion.com/help/embed-and-connect-other-apps)
requires an embeddable URL and notes limitations for external-login embeds.
Our current shared reader retains `X-Frame-Options: DENY`, as declared in
[the Worker](../worker/index.ts) and [static headers](../public/_headers).
It cannot simply become a live Notion embed. A dedicated embeddable view would
need an explicit framing/access design and importer verification; do not loosen
the existing reader's policy as part of image export.

Google Docs also offers third-party link previews through
[Workspace add-ons and smart chips](https://developers.google.com/workspace/add-ons/guides/preview-links-smart-chips).
That is a separately configured integration with URL handlers and preview
cards, not a way to place the MDX runtime in a DOCX. Keep ordinary links in the
first scope. These richer integrations are optional later work, not prerequisites
for preserving the form's appearance now.

## Browser capture options

Versions below were checked against published package metadata on 2026-11-04.
All three candidates use the MIT license. These are candidates for a feasibility
check, not new application dependencies.

| Option | Published candidate | Assessment |
|---|---|---|
| `html-to-image` | `1.11.13` | First candidate. Its normal subtree path clones computed styles and pseudo-elements into SVG `foreignObject`, then rasterizes. It avoids a helper iframe on that path. Its upstream browser claims do not establish compatibility with this app's sandbox. See the [release README](https://github.com/bubkoo/html-to-image/blob/v1.11.13/README.md) and [package metadata](https://github.com/bubkoo/html-to-image/blob/v1.11.13/package.json). |
| `modern-screenshot` | `4.7.0` | Alternative with resource timeouts and browser decoding workarounds. It creates a helper iframe and reads its document for default styles. That is a potential opaque-origin incompatibility to test. See its [helper iframe](https://github.com/qq15725/modern-screenshot/blob/v4.7.0/src/sandbox.ts), [style lookup](https://github.com/qq15725/modern-screenshot/blob/v4.7.0/src/get-default-style.ts) and [package metadata](https://github.com/qq15725/modern-screenshot/blob/v4.7.0/package.json). |
| `html2canvas` | `1.4.1` | Lower-priority option. Its default renderer reconstructs CSS into canvas and clones the owner document into a helper iframe. Published support omits useful properties including box shadows, filters and `object-fit`; its color parser has a limited function table. See [CSS support](https://github.com/niklasvh/html2canvas/blob/v1.4.1/docs/features.md), [color parsing](https://github.com/niklasvh/html2canvas/blob/v1.4.1/src/css/types/color.ts), [cloning](https://github.com/niklasvh/html2canvas/blob/v1.4.1/src/dom/document-cloner.ts) and [package metadata](https://github.com/niklasvh/html2canvas/blob/v1.4.1/package.json). |

Use release-tag source and documentation when evaluating an exact version.
Upstream development documentation can describe APIs that the published
package does not contain. In particular, the development html-to-image README
describes a newer renderer/plugin API than this candidate.

Browser-native capture is worth tracking, but it does not replace the first
candidate. Chrome's [HTML-in-Canvas guide](https://developer.chrome.com/docs/modern-web-guidance/guides/visual-design/export-html-media-from-canvas)
describes a Chrome 157 path with drawable descendants inside a canvas. That
requires different DOM ownership and does not establish the Chromium, Firefox
and Safari coverage needed here. Screen, Element and Region Capture use a
user-selected display stream with permission and activation requirements,
which is a poor fit for an automatic component export. See
[getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
and [Element and Region Capture](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API/Element_Region_Capture).

A hosted headless browser would be another architecture and data-access path.
Keep it outside the first scope. The proposed browser path needs no new
database table, storage service, external account connection or server job.

## Capture inside the existing isolation boundary

The preview has an opaque origin, `allow-scripts allow-forms` without
`allow-same-origin`, data-only images/fonts, and `connect-src 'none'`. A parent
cannot inspect its DOM to take a screenshot. Helper iframe access also needs
verification under these exact restrictions; do not add same-origin permission,
a proxy or remote resources to make a library work. The restriction comes from
[HTML sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing),
and `connect-src` independently governs fetches even when images can use data
URLs. See [CSP connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src).

The proposed path is:

1. Freeze source, authorized assets and the export's selected component regions
   through the existing preparation flow. Reuse a matching live view or prepare
   an offscreen view under the current code-consent rules.
2. Load the capture helper only for **Prepare export**. Extend the existing
   trusted [frame module delivery](../src/preview/frame.ts) used by charts and
   highlighting: versioned-folder scripts in hosted frames, or code delivered
   over the private parent port for `srcdoc`. Keep arbitrary imports and resource
   fetches forbidden. Bundling the library into every initial preview would
   violate the loading rule.
3. Clone only the selected component inside the frame. Preserve its measured
   dimensions, styles and permitted pixels without moving or modifying live
   nodes, triggering handlers, or changing focus and scroll.
4. Remove authoring chrome, menus, dialogs and hidden content. Replace form
   controls in the clone with inert empty visual equivalents, preserving their
   labels and boxes. Clear current/default values, selections and autofill
   state before any image serialization. Library defaults copy live values;
   filtering whole fields out would lose the appearance we want to preserve.
5. Wait within a deadline for authorized fonts/images and freeze animations in
   the clone. Capture one bounded component at a time, then send only its PNG
   and validated metadata to the parent through the private message channel.
6. Validate identity, revision, dimensions and bytes again in the parent. Send
   valid PNGs through the existing asset packager so both formats share one
   implementation. Keep the existing semantic fallback and diagnostics.

Private preparation currently freezes root/retained drafts and memoizes other
dependencies on first read, with immutable image identities. It is not an
atomic snapshot of the entire saved project at button-click time. Public
preparation clones one delivered shared bundle. Preserve these rules and define
any stronger revision requirement before claiming a single project-wide cut.

The first candidate has no supported clone-edit hook. Passing the live form
to `toPng` with a filter would either retain values or remove its field boxes.
The feasibility check must prove a privacy-scrubbed staging clone whose measured
layout survives the library's own cloning, before invoking its rasterizer.
Otherwise choose a different proved path. See the pinned
[options](https://github.com/bubkoo/html-to-image/blob/v1.11.13/src/types.ts) and
[control cloning](https://github.com/bubkoo/html-to-image/blob/v1.11.13/src/clone-node.ts).

Use only already-authorized data images and inlined font CSS. The candidate's
`fontEmbedCSS` option can avoid its normal web-font discovery/fetch path;
resource behavior still needs a no-network test. `document.fonts.ready` waits
for used fonts and layout, but does not by itself embed font bytes into the
generated SVG. See [font readiness](https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts).

Canvas must remain origin-clean, and SVG image decoding has resource and native
widget restrictions. A tainted canvas cannot be read or exported. See
[canvas security](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)
and [SVG image restrictions](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).
The candidate's intermediate `foreignObject` belongs only inside the unprivileged
capture process. Do not weaken the separate [SVG validator](../src/features/images/svg.ts)
or send that HTML/SVG to the host as trusted content; the portable result is PNG.

Removing normal form values is an export policy, not a guarantee that arbitrary
custom code cannot display sensitive text somewhere else. The existing semantic
snapshot has the same limit. Do not promise that capture can recognize every
piece of private content drawn by a component.

## Dimensions, transport and cancellation

Start from the component's actual rendered bounds and request 2x pixels where
the budget allows. Record CSS dimensions separately from pixel dimensions so
Notion and DOCX can size the image correctly while retaining detail. Keep the
current appearance for a live capture; an offscreen capture uses its documented
finite viewport. Any theme or layout override must apply only to the clone.

Current asset limits are 5 MiB and 8 million pixels per packaged image,
256 unique assets and 64 MiB total. Snapshot replies separately allow 128
entries, 2 MiB of HTML per entry and 8 MiB total. Those are different limits:
a 5 MiB PNG encoded as base64 cannot fit in a 2 MiB HTML entry.

Define a typed binary-raster reply before implementation. Keep the HTML limits;
propose an 8 MiB total budget per capture request across all returned entries,
counting HTML UTF-8 bytes and raw PNG bytes together, a 5 MiB per-raster limit,
an 8 MP output pixel limit and a 4096-pixel maximum output edge after scaling.
Validate these proposed transport limits against the reference documents before
adoption. Do not solve an oversized response by silently removing the existing
guards.

Output limits do not bound peak memory. One 8 MP RGBA bitmap alone occupies
32 million bytes, about 30.5 MiB, before intermediate SVG, DOM clones, source
images and encoding buffers. Measure peak memory and define decoded-input
budgets as part of the feasibility check.

Preflight finite positive bounds, pixel area, DOM node count, depth, resource
bytes and export totals before canvas allocation. Set the pixel ratio explicitly,
rather than inheriting an unbounded device ratio. PNG retries may reduce scale
within an agreed readability threshold; otherwise return a visible fallback.
Avoid successful-looking blank image placeholders when a resource fails.

Retain parent-owned island ranges and the current private port, session,
document identity, source revision, render epoch and request ID checks. Add
explicit cancellation to live capture: today canceling an export discards its
result, but an already-running live snapshot continues until completion or its
deadline. The pinned libraries do not promise cancellation of all cloning and
raster work. Bound synchronous work, check between stages, release buffers and
clones, and reject every stale reply. An AbortSignal alone cannot interrupt a
long synchronous traversal.

## Links to the interactive component

Prefer revealing the component within its document. It preserves imports,
providers, lexical scope and surrounding explanation. An arbitrary MDX
invocation is not necessarily a component file that can be opened on its own.

| Export context | Proposed link behavior |
|---|---|
| Unlisted reader | Reuse that exact share URL with a bounded component target in its fragment. Resolve only inside the currently authorized bundle. |
| Private project | Use its normal authenticated document URL. A draft-only target can fall back to the document because it may not exist in the saved version. |
| No permitted destination | Export the image and label without inventing a public URL or enabling sharing. |

Export must never enable, rotate or broaden a share link automatically. A
public fragment is a display selector, not file-read authority. It must not
select another project, request a path outside the bundle, carry account
credentials or include typed values. Opening a link still checks the active
share; already downloaded image bytes remain in the exported file after
revocation.

An unlisted URL is itself a bearer link. Including it in a ZIP or DOCX gives
recipients, and potentially destination link-preview services, access to the
latest whole shared document and its authorized dependencies. It is not limited
to the pictured component or export-time revision. Offer **Include interactive
links** as an explicit export option, initially off, with that scope explained
before preparation. Private destinations keep their usual login/access checks.

The first target format should be versioned and length-bounded. Use saved
file identities, the ancestor document-instance chain, a source fingerprint
and the saved revision. On an exact revision, resolve the specific instance.
After unrelated edits, match only an unambiguous source/context fingerprint
within the authorized graph. Do not publish raw render IDs as permanent anchors:
they use content hashes plus duplicate occurrence and can change after edits.
Matching should tolerate unrelated text edits, but cannot guarantee identity
after the target itself changes without a persisted anchor.

Private root URLs are path-based today. A file ID inside a fragment does not
make an old path survive a rename: the private route must resolve the authorized
ID before opening a stale path and navigate to its current canonical URL.
Unlisted roots instead retain their existing token/file identity behavior.

If a match is absent or ambiguous, keep the latest document readable and show
a clear notice. Do not guess another identical login form. Persistent authored
anchors can be a later, explicit source-format decision; do not silently add
props to an arbitrary custom component or promise permanent positioning.

This needs more than URL parsing. The current `revealRange` maps prose leaves
and cannot reveal an arbitrary component island. Add a checked island/object
reveal operation, resolve any collapsed ancestor documents, wait for their
attachment and layout, then scroll within the correct frame. Add navigation,
revision and revocation cancellation, nested-frame scroll offsets, fragment
history handling and an accessible target announcement. Initial scrolling
should not steal the caret; offer an explicit action to focus the component.

Private targets may open in a persisted Source view. Select Rendered without
discarding drafts, await its readiness and preserve invited-project custom-code
consent. A target link is never consent to run code. Built-in tabs and custom
collapsibles need their own reveal contract; where content remains hidden,
reveal a visible enclosing island with a notice rather than simulating arbitrary
clicks. One expression can produce several runtime widgets, so a generic target
can identify that source island without identifying an individual `.map()` item.
Do not accept URL-supplied CSS selectors or executable snippets.

Single-component public routes remain deferred. They need an invocation/context
contract, handling for multiple instances, their own navigation and access
behavior, and a decision about how much of the parent document is delivered.
Showing only one component on screen would not by itself hide other authorized
source already delivered to the browser.

## Verification and implementation order

1. **T60, capture feasibility and contract.** Test the exact published candidate
   in the unchanged production sandbox before choosing it. Record browser
   versions, resource requests, dimensions, pixel coverage, timing, memory
   bounds and failure behavior. Include Chromium, Firefox and real Safari.
2. **T61, visual fallback in both exports.** Preserve semantic/native handlers,
   add bounded PNG capture and cancellation, and expose failures in the existing
   conversion review. Keep the helper out of every first-paint bundle and load
   it only on explicit preparation. No new model calls or account integrations.
3. **T62, component link targets.** Implement bounded target parsing and checked
   reveal against the existing project/share authority, including nested
   documents and safe stale-target behavior. This can proceed independently
   once its target contract is settled.

Capture fixtures must cover the reference login form's empty fields, states,
labels, spacing, borders, fonts and buttons; Tailwind 4 colors, grid/flex,
pseudo-elements, SVG, canvas, masks, hidden content and animated elements;
phone/desktop widths, very tall components and repeated offline exports.
Include modified fields, passwords, textarea/select values and autofill
sentinels, and prove omission before raster bytes leave the frame. Capture
must preserve the live view's focus, scroll and component state.

Inspect image bytes and native DOCX relationships, original-asset hashes,
image aspect ratios, text outside captures and the complete Notion ZIP.
Render every DOCX page and inspect for clipping, unreadable scaling and missing
content. Perform actual Notion and Google Docs imports before claiming importer
fidelity; current DOCX render checks do not establish that. A cached repeat
should work offline; first-use offline capture also needs its optional module
and fonts to have been cached.

Link fixtures must include repeated identical components, a component edited
or deleted after export, moved files, duplicate embedded instances, collapsed
children, malformed or oversized fragments, revoked links, private project
access, draft-only components, back/forward navigation and mobile accessibility.
Keep shared source, tokens and account data out of committed test fixtures.

The [task queue](tasks.md) keeps these follow-ups Waiting. This proposal does
not authorize the separate app-wide [progressive loading](progressive-loading.md)
implementation or change the pending status of T55 through T59.
