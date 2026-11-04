# Unlisted file sharing

Implemented with separate file-link access. Existing project invitations
remain unchanged.

An owner enables a link for one saved file from **Share file**. Anyone holding
the link can read the rendered file without an account. The owner can copy,
replace or disable the link. The link follows a file's stable identity across
renames and shows its latest saved version. Deleted files are unavailable.

Images, drawings, diagrams, literal embedded documents and imported component
files needed for rendering are included. These dependencies become visible
to link holders, including their underlying source. Ordinary hyperlinks do
not share additional files. The page has no project browser or Source view.

Markdown and MDX notes offer **Export** in the floating controls. Anyone with
the active link can prepare and download a Notion ZIP or Google Docs DOCX
without signing in.
The exporter freezes the displayed revision, including drawings, components
and embedded notes. Prepare export completes any image originals still missing
from that revision's authorized manifest. It does not fetch other project files
or include comments or entered form values. A known revocation or a changed displayed bundle cancels an open
export. See [Notion export](notion-export.md) and
[Google Docs export](google-docs-export.md).

Visitors can start a comment on the whole file, selected text or a section.
Posting asks them to sign in, then returns to the same shared page with their
draft and selection. Link discussion is separate from private project
comments. Public author information never includes email addresses. Authors
can edit or remove their own words; the owner can moderate. Archived projects
remain readable but refuse comment writes.

Notes fill the viewport with the workbench's scrolling preview. Compact
floating controls replace the page header and outer document card. Comments
open in a full-height desktop rail or the normal bottom sheet on phones.
The document can scroll above the floating controls, including its last line;
fixed component dialogs stay within the preview. Sign-in recovery retains
the renderer's source position.

The server validates the active token and resolves a bounded dependency graph
from authoritative saved source. Arbitrary client paths never authorize
reads. It checks access again before returning the bundle. Images are sent
from the existing private bucket without exposing object keys or reusable
Storage links. Custom components render automatically, including in embedded
documents, without a custom-code warning or Run code step. The normal preview
isolation remains: components have no network or account access. Invited
shared projects retain their separate custom-code consent flow.

Share responses use no-store, and shared pages request noindex and
no-referrer. Unlisted means anyone can forward the link; it is not an
invitation-only access policy. Disabling a link stops later access, but cannot
erase copies a visitor already received.

## Progressive loading

The viewer module starts alongside a no-store streaming manifest request.
Each NDJSON record carries a complete validated file or image. The requested
root source appears before delayed child sources and Storage downloads; sibling
file reads and image preparation use separate bounded queues. Each ready result
publishes independently after a fresh active-link and revision check. Missing or
invalid descendants and image failures remain local to their placeholders.
Access changes, source revision changes, malformed streams and aggregate limits
invalidate the partial snapshot.

The browser parses complete UTF-8 records and retains existing file objects as
resources arrive. Components can wait for their streamed complete module source
without blocking independently checked prose. Initially collapsed child frames
stay detached. Retained collapsed children suspend compilation, resource decoding
and projection while keeping their sessions. Pending images reserve their saved
dimensions. Drawings render for the current note, its active component modules or
the selected drawing, rather than every file in the dependency graph. Background
saved-source and original-byte transfer does not instantiate a child preview.

Refresh sends the displayed identity and revision. An unchanged reply revalidates
the active link without reconstructing the graph or downloading image bytes,
and leaves an incomplete stream running. Navigation cancels queued reads and
ignores late completions. The server parses all dependency authority from saved
source; client-selected paths never authorize reads, and reusable Storage URLs
are never exposed. The global file, text, depth, image and response limits apply
across the stream. The 128-identity graph budget includes the root, missing
references and optional companions. Each distinct dependency is scheduled once;
its identity is reserved before publishing its declaration or starting a read.
The browser requires the root record first and accepts later files only after
an earlier record declared them.

The legacy complete response remains available for compatible callers. Neither
manifest nor asset responses are cached offline. A stream is readable before
it is complete; failed or unfinished graph/image records cannot become an
export snapshot. Prepare export completes the frozen revision through a full
capability read when necessary, then verifies that its identity still matches.
Save, component isolation and discussion access keep their existing guarantees. Server tests
cover root readiness before blocked child source and Storage bytes, unchanged
and revoked links, graph-bound image reads, local descendant failures, revision
changes during download, cancellation, aggregate limits and batched reads.
Client boundary tests cover split UTF-8 records, truncated/malformed streams,
file identity retention and invalidation. `progressive-public.spec.ts` covers
controlled blocked and failing images, delayed and missing child source,
collapsed children, unchanged refresh, revocation and stale work in both browsers.

Regression coverage includes cross-project and dependency authorization,
revocation/rotation, private-discussion separation, author privacy, comment
ownership, sign-in draft return, rendering and accessibility in Chromium and
Firefox and bundle budgets. The shared-page JavaScript first-paint budget
remains 171 kB gzip; `check:bundle` measures the current build. Existing page
budgets are unchanged. Coverage lives in `file-sharing-owner.spec.ts`,
`file-sharing-public.spec.ts`, `rendered-sandbox.spec.ts`, the feature unit
tests and the two file-share database suites. Hosted anonymous reading and
signed-in comments are verified after the automatic CI and deployment gate.
