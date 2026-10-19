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

## T36: show_file keeps a note's component files under the size cap

**Status:** Ready

`show_file` (`supabase/functions/mcp-server/tools/fileView.ts`) sends a
note's component files in `_meta` with no cap; only a note cut at 20,000
characters sends none. Component files can be up to 2 MiB, which takes
`_meta` past `MAX_META_CHARS` (120,000), and Claude then shows no card at all
(it stores a large result as a file). `preview_component` already refuses a
preview over the cap. When a note's HTML, source and component files would
pass the cap, send the note without its component files, so the card shows
the server's HTML, and say why in the card. Done when a Deno test with a large
component file fails on the old code.

## T37: stop loading deferred drawings once the host stops answering

**Status:** Ready

The chat card loads the drawings that didn't fit in a result with
`card_embed`, one at a time, giving each call 20 s
(`src/chat-card/cardDeferred.ts`). A host that never answers shows the last
link only after 20 s for each drawing. After the first call times out, show
the rest of the links at once. The chat-card stand-in host's `silent` option
and Playwright's clock cover it.

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

## T42: the card's messages to the model don't replace each other

**Status:** Ready

The card tells the model things with `ui/update-model-context`
(`host.tellModel` in `src/chat-card/bridge.ts`): a save made in the card, a
component preview that failed, and each diagram it couldn't draw. Each call
replaces the card's previous context, as the spec says, so a save's message
and the diagram messages replace each other; only the diagram messages repeat
one another. Keep one context that holds all of them.

## Small things

Found while doing other tasks; each is small or rare. Make one a task when it
matters.

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
- In a note's Rendered view, bold or italics on a selection that ends in a
  space before a letter (a double-clicked word, in some browsers) is refused:
  the closing `**` or `*` would follow the space. The references a delete
  writes there (`flanked` in `src/features/rendered/fluidProjection.ts`) are
  tried only for typing and deletes.
- A delete in a note's Rendered view that leaves italics ending in a quote
  or other punctuation right before a letter still writes that letter as a
  numeric reference (`*"*&#116;hese`): exact, but hard to read in Source, and
  there is no space to move out of the italics there.
- A delete in a note's Rendered view from plain text into italics that leaves
  them starting with a space writes it as a reference (`*&#32;italic*`), which
  holds it exactly; ` *italic*` would read better.
- In a note's Rendered view, Enter at the start of a line in a quote is
  refused: it splits the quote's paragraph, and Markdown has no empty
  paragraph inside a quote. Putting the empty paragraph above the quote, as
  Enter at the start of a heading does (`src/preview/fluidEditor.ts`), would
  work.
- In a note's Rendered view, Enter right before a space inside italics or
  bold writes the space as a reference (`*&#32;two*`), which holds it exactly;
  `*two*` would read better, but the editor would then take a document
  without the space.
- In a note's Rendered view, a second empty line between two blocks (Enter on
  an empty line Enter made) is refused: blank lines between blocks make one
  empty paragraph at most.
- A few refusals in a note's Rendered view still reach the error banner above
  the views in the check's own words, such as "Rejected stale rendered
  transaction; source has changed." (the `onError` calls in
  `src/features/rendered/RenderedEditor.tsx`), not the plain "Edit not
  applied:" notice.
- Switching a note from Source or Rendered to Split doesn't carry the caret
  or the text at the top to the pane that appears, as switching between
  Source and Rendered does (WorkspaceSession's `showMode`).

## Done

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

After T33 the work was tracked elsewhere until the queue came back here in
October 2026; `git log` describes each change by its outcome.
