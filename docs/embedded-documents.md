# Embedded documents

Implementation plan for editable, collapsible project documents. The syntax
is an MDX built-in, like Drawing and Diagram:

```mdx
<Document src="notes/implementation.mdx" title="Implementation details" defaultCollapsed />
```

The child can be a `.md` or `.mdx` file. `src` is a literal project-root
path. The parent is MDX; plain Markdown keeps its existing syntax. There
are no URL, cross-project or heading-fragment embeds in this release.

## Behavior

In an editable MDX note, right-click where the document belongs, choose
**Document**, and select an existing note. Insert block offers the same
choice. The inserted reference starts collapsed. Expand its title to load
and edit the child, or open it separately from the header.

- The child remains a separate file. Editing it inline changes its draft;
  the parent stores only the reference. Removing the reference never deletes
  the child.
- Each file has one editing session, shared by every embed and its normal
  tab, with one source buffer, draft, undo history and saved revision.
- Expansion loads the file on demand. Collapse retains the session and
  history. The expanded editor grows with its content and uses the parent
  page's vertical scroll.
- A header shows the title, filename and unsaved state, with collapse and
  Open separately controls. Missing files and refused references explain
  the problem in place.
- Undo acts on the file whose editor has focus. Saving the parent also saves
  its loaded, changed descendants with the normal revision checks. This is
  a series of per-file saves: a failed child is named and retains its draft;
  already successful saves remain saved.
- Permissions, image handling and custom-code consent follow the child
  file's ordinary editor. Read-only projects remain read-only. Loading an
  embed does not authorize custom code.
- Cycles, excessive nesting and excessive open embed instances are refused.
  Supported references participate in existing rename, move and delete
  planning. Computed paths cannot authorize file reads.

## Implementation sequence

1. Add the static reference parser, component catalog entry, insertion and
   completion controls, and move/delete reference support.
2. Pool per-file workbench sessions, including files loaded only by an
   embed. Keep their drafts and operation guards active and connect all
   views to the canonical source history. Add descendant save orchestration.
3. Reuse the isolated rendered editor inside nested opaque frames. Bind each
   child directly to its app-owned session with a private MessagePort;
   validate its declaring source, owner window, revision and bootstrap nonce.
4. Add lazy expansion, retained collapse, content sizing, status and error
   controls. Show a safe Open separately fallback in chat cards where an
   editable workbench session is unavailable.
5. Verify exact child edits, shared history and drafts, parent saves,
   read-only behavior, nesting/cycles, missing files, reference operations,
   isolation, offline use and accessibility in Chromium and Firefox. Run
   the repository checks and bundle budgets before deployment.

## Isolation decision

A child needs the whole rendered editor, including precise source mapping,
object islands and resources. Flattening its output into the parent's prose
editor would mix source ownership and undo histories. A nested preview
instead reuses the existing compiler and validated editing protocol.

Nested frames use `sandbox="allow-scripts"` and app-generated `srcdoc`.
Only local `about:` child documents are added to the preview's `frame-src`;
network connections, arbitrary frame URLs, same-origin access and storage
remain unavailable. A hosted preview's child loads the same trusted,
versioned bootstrap script already allowed by its inherited policy. An
offline preview uses the self-contained inline bootstrap. Bootstrap data
does not come from document source. Policy inheritance follows the
[CSP specification](https://www.w3.org/TR/CSP/#security-inherit-csp).

The app validates every reference against the authoritative parent source
before attaching a child window. The child's first document receives a
private channel directly from the trusted app ancestor, which may itself
be embedded in a chat panel. No document receives application credentials.

## Release status

Implemented and verified in Chromium and Firefox, including phone layouts,
fresh offline loads, shared undo, parent saves, retained drafts, rename,
cycle/missing-file errors, read-only permissions and code consent.
Regression coverage lives in `tests/browser/document-embeds.spec.ts`,
`tests/browser/rendered-sandbox.spec.ts` and `tests/browser/offline.spec.ts`,
with parser, session-registry and capability-controller unit tests alongside
their source files.

Limits are 16 embedded views per document, 64 across the open project, four
levels below the root document, and 128 retained notes before another file
can load through an embed. Opening
the project again releases the retained sessions after their drafts are kept.
Chat cards show a same-project Open document link; inline editing is in the
workbench. Collapse state is retained while the preview is mounted;
`defaultCollapsed` controls its initial state.
