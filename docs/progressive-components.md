# Progressive component preparation

The rendered editor parses the complete current MDX source before showing any
content. On first display, while component modules or code approval are pending,
its display-only projection uses the normal source mapping for independent prose, replaces each
protected island with a static local placeholder, and excludes all imports,
exports and expressions from executable output. No partial source is executed.
Invalid MDX still reports the parser error instead of guessing its meaning.

The provisional view is read-only. Source stays editable; while the view is
provisional, every source revision gets its own checked projection. Rendered writes and export snapshots
wait for the matching approved component environment. Failed modules leave the
independent prose readable with unavailable placeholders and an error notice.
A previous healthy projection for the same document remains mounted while a
new source revision or module rebuild is checked, provided its approved
component environment remains available. Editing and exports wait for the
matching current projection. This preserves unchanged component state instead
of replacing it with temporary static islands. Initial and already provisional
views still publish independent prose as their source changes. A component
failure or withheld code approval replaces executable islands with the checked
static display. Another document never inherits its projection or editing
authority; identity and path both scope the retained view.

Adopting a newer saved copy of the same open file creates a new editing identity.
Its explicit saved-copy handoff may retain a healthy parent projection when its
prepared environment has no custom code or imported modules, and the
path and format match, the handoff's previous source exactly matches that tree,
and its new source and identity exactly match the current document. Imported
modules and custom code in that parent environment cannot use this exception.
Retained child document sessions keep their own access and code-approval scopes.
The old parent tree stays read-only
and receives no editing or export authority while the current projection is
prepared, preserving unchanged builtin component state without a blank frame.

When preparation succeeds, the existing frame and ProseMirror update protocol
retain independent prose and its selection while the component islands update.
Asset pixels continue to arrive over resource messages and do not trigger
compilation or replace the document. Existing component consent and opaque
frame privileges remain unchanged.

MDX component preparation also supplies Monaco's custom component catalog and
prop completion in Source. It therefore stays enabled for a visible Source
note; this parent-side parse and compile does not execute components or prepare
image/drawing previews. Preview pixels and drawing engines require a visible
Rendered/Split surface or an active, expanded embedded view. Hidden and
collapsed views retain their sessions while suspending new preview work.

Hidden Rendered panes suspend projection of new source. Retained embedded views
combine their owner's activity with their own expanded/collapsed visibility,
recursively suspending new preparation while preserving frames, private ports,
component state and drafts. An explicit component export can request a current
projection while the pane is hidden. Validated image dimensions travel as
presentation messages before pixels, reserving the pending image's exact box.

Source completion catalogs are separate from executable component environments.
A complete, validated preparation that finishes after Source becomes incomplete
can still supply completion metadata for the same document and loader generation.
It does not clear the newer error or pending state, publish old executable code,
or authorize rendered edits. Newer successful catalogs supersede older results;
document, account and module-generation changes invalidate late metadata.

Provisional MDX can display independent, parser-validated static images through
its existing trusted image renderer. Markdown images and direct intrinsic image
tags with literal attributes and no children qualify. Executable attributes,
spreads, expressions and images inside an unresolved component stay protected
placeholders. Imports and exports remain excluded. Only parent-validated pixels
for source-parsed image keys enter this display; rendering a static image does
not grant source-edit or export authority.

Image metadata updates carry the current source-parsed image keys separately
from known dimensions. A still-referenced image retains its last known box when
pixels or metadata are temporarily absent. Removed references drop their old
metadata. Identical keys and sizes do not produce another metadata message merely
because prose receives a new revision.

An exact current provisional display can report its bounded content height and
inspect a source-authorized original image. These presentation-only messages
retain sender, session and revision checks; image reads also recheck document
identity, path, source and port before publishing. They grant no rendered edits,
new document access or export authority. Expanded pending children can therefore
show all their safe prose before a component module finishes.
