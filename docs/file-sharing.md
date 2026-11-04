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
The exporter uses a frozen copy of the response already available to the
reader, including original images, drawings, components and embedded notes.
It does not fetch other project files or include comments or entered form
values. A known revocation or a changed displayed bundle cancels an open
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

## Loading follow-up (pending)

Sharing is implemented; the app-wide [progressive loading requirement](progressive-loading.md)
is still pending here. The reader currently waits for the complete server
bundle before loading its viewer. Dependency reads and image original/preview
downloads are serial, and refresh rebuilds the bundle even when its revision
has not changed. Drawing and image preparation also publishes results in batches.

T55, T57, T58 and T59 in the [task queue](tasks.md) track this follow-up, waiting for
implementation approval. Prioritize readable content and independently ready
assets while retaining token validation, revocation, source-authorized reads,
full-resolution images, response limits and document network isolation.
Unlisted document responses must not become an offline cache as a shortcut.

Regression coverage includes cross-project and dependency authorization,
revocation/rotation, private-discussion separation, author privacy, comment
ownership, sign-in draft return, rendering and accessibility in Chromium and
Firefox and bundle budgets. The new shared-page first paint is measured at
162.4 kB gzip JavaScript with a 171 kB budget; existing page budgets are
unchanged. Coverage lives in `file-sharing-owner.spec.ts`,
`file-sharing-public.spec.ts`, `rendered-sandbox.spec.ts`, the feature unit
tests and the two file-share database suites. Hosted anonymous reading and
signed-in comments are verified after the automatic CI and deployment gate.
