# Notion export

The note's file menu offers **Export to Notion**. Unlisted Markdown and MDX
pages also offer it under **Export** in their floating controls, without
signing in. Choose **Prepare export**,
review any conversion notes, then **Download ZIP**. In Notion on desktop or
web, open **Settings → Import → ZIP** and select the file. There is no Notion
connection, API token, server export job or change to project sharing.

The browser builds one HTML page with adjacent `assets/` files. There are no
README or metadata pages for Notion to import accidentally. Ordinary source
download remains available as **Export**, and project ZIP downloads keep their
existing exact-file behavior. **Export to Google Docs** is also available as
a [DOCX download](google-docs-export.md). PDF and direct publishing to external
accounts are separate future features.

An unlisted export uses one frozen copy of the shared file and its already
authorized rendering dependencies. It includes the saved source and original
image bytes from that response, with matching current component output where
available. Unopened embedded notes are expanded in the export. It does not
read the project or include private discussions, and project-file links do
not grant access to other files. A known link revocation or replacement of
the displayed bundle closes the export and drops its prepared result.

## Included content

- Headings, paragraphs, lists, tasks, emphasis, links, code, quotes and simple
  tables become semantic HTML, so Notion can make editable blocks.
- Project images travel as complete copies. SVG images become PNG. No export
  image depends on a Storage URL, temporary URL or third-party host.
- Excalidraw and D2 embeds become PNGs. The native renderer keeps drawing
  images, fonts and saved diagram overrides. It requests twice the native
  dimensions where the pixel budget allows, with the drawing transform scaled
  to match the canvas. This avoids a small drawing inside an enlarged blank
  image; reducing scale for the pixel budget preserves the same content bounds.
- Embedded `Document` notes become expanded sections in the same page,
  including children that were never expanded in the editor.
- The current root buffer and retained child buffers include unsaved edits.
  Source files and assets are frozen while the package is prepared; imported
  component modules follow the rendered editor's saved-module authority.
- Custom components use their current rendered output when a matching view
  exists. Otherwise a temporary, noninteractive isolated preview renders the
  frozen source. Canvas and validated SVG become PNGs. An unopened component
  starts from its normal initial state.

Interactive controls become static content. Entered input, password, select
and textarea values are omitted. Scripts, authoring controls, comments,
dialogs, application styling and edit history are excluded. Built-in tabs
become readable sections when converted from source.

Whole custom HTML components do not yet have a visual image fallback. A form
can lose its CSS layout and field boxes while retaining labels. The
[component export proposal](component-exports.md) researches bounded captures
and links back to the interactive document; that follow-up is not implemented.

Missing assets, invalid source, unsupported markup and unavailable component
snapshots produce visible placeholders or source and conversion notes. The
dialog lets the person review these before downloading. It never silently
fetches a remote image or grants custom code permission. Shared-project code
that has not been approved in Rendered stays source in the export.

Links to other project files keep an Elaborating project URL where one is
available. Following such a link still requires the file's normal access.
Exporting a note does not package every ordinary linked project file.

## Loading follow-up (pending)

The exporter is implemented and starts from an explicit action. The app-wide
[progressive loading requirement](progressive-loading.md) also applies to
editor and temporary-preview preparation used by exports; related work is
tracked as T57, T58 and T59 in the [task queue](tasks.md), waiting for
implementation approval. Browsing a note must not prepare an export or load
its conversion engines in anticipation.

An explicitly requested export still processes its complete frozen dependency
graph. **Ready** and **Download ZIP** require a completed package and its
conversion notes, including any missing or unsupported content. Progressive
display must not expose a partial ZIP or weaken cancellation, original asset
copies, custom-code consent, snapshot validation, isolation or quotas.

## Bounds and isolation

The converter parses source without evaluating it. Captured component HTML
is untrusted: the host reparses it with an inert parser and reconstructs an
allowlist of semantic elements and safe links. It validates images before
packaging them. Captured SVG goes through the same XML, resource, geometry,
text and decoded-pixel checks as uploaded SVG before rasterization.

The preview uses its existing opaque origin, CSP and private MessagePort.
Snapshot requests are tied to the session, document revision, render epoch
and request ID. The parent supplies the allowed island IDs and owns their
source ranges. Stale, missing, additional and oversized replies are refused.
Export does not expose tokens, generic file reads or network access to the
preview, and it never moves or edits live DOM nodes.

Limits are 128 source files, 8 MiB of source, four nested document levels,
64 embedded instances, 256 unique images and 64 MiB of image bytes. Packaged
images stay within 5 MiB and 8 million pixels each; a drawing's embedded
images have a 24-million-pixel aggregate bound before native decoding.
The final HTML is capped at 5 MiB. Snapshot limits are 128 islands, 2 MiB per
island and 8 MiB in total. Cancellation releases the temporary preview and
prevents a late result from replacing a newer export.

Notion can change formatting during import. Its importer supports HTML,
Markdown, ZIP packages and adjacent image assets, but not live scripts,
complex layouts or application-specific embeds. The package deliberately
uses that portable subset. See [Notion's import documentation](https://www.notion.com/help/import-data-into-notion).

## Verification

`tests/browser/notion-export.spec.ts` covers editable semantic HTML, original
image bytes, captions, SVG and native drawing/diagram PNGs, unopened and
unsaved children, current and fresh component state, omitted form values,
remote-resource refusal, cancellation, phone accessibility and the unchanged
raw source download. The cached-converter repeat works with the browser
offline. These journeys pass in Chromium and Firefox, alongside existing
sandbox, embedded-document and public-sharing regressions. Converter, asset,
snapshot protocol, immutable-file and quota unit tests live beside their
implementation.
