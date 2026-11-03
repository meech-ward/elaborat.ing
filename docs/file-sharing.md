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

Visitors can start a comment on the whole file, selected text or a section.
Posting asks them to sign in, then returns to the same shared page with their
draft and selection. Link discussion is separate from private project
comments. Public author information never includes email addresses. Authors
can edit or remove their own words; the owner can moderate. Archived projects
remain readable but refuse comment writes.

Notes use the workbench's viewport-sized scrolling preview, so fixed controls
and dialogs stay within the reader's view. Sign-in recovery retains both the
page position and the renderer's source position.

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

Regression coverage includes cross-project and dependency authorization,
revocation/rotation, private-discussion separation, author privacy, comment
ownership, sign-in draft return, rendering and accessibility in Chromium and
Firefox and bundle budgets. The new shared-page first paint is measured at
162.4 kB gzip JavaScript with a 171 kB budget; existing page budgets are
unchanged. Coverage lives in `file-sharing-owner.spec.ts`,
`file-sharing-public.spec.ts`, `rendered-sandbox.spec.ts`, the feature unit
tests and the two file-share database suites. Hosted anonymous reading and
signed-in comments are verified after the automatic CI and deployment gate.
