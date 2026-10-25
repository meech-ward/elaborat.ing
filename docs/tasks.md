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

## Small things

Found while doing other tasks; each is small or rare. Make one a task when it
matters.

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
- Align browser-test platform signals on macOS: the Desktop Chrome and Firefox
  fixtures use a Windows user agent while `navigator.platform` is `MacIntel`.
  Monaco binds Source shortcuts to Ctrl, while the app and Playwright's
  `ControlOrMeta` use Cmd, so shortcut checks can miss their intended action.
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
  spans several lines is refused: the quote is written again, and that
  paragraph's source already holds its `> ` markers, so they are doubled.
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
- A note whose component files pass the app's 2 MiB in all is sent only the
  ones read before the limit (`componentSources` in
  `supabase/functions/mcp-server/tools/componentSources.ts`); where those fit
  in the chat card, its preview says the next file is missing, not that the
  files pass 2 MiB.

## Done

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
