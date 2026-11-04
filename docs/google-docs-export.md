# Google Docs export

Markdown and MDX notes offer **Export to Google Docs** in the project file
menu and the unlisted reader's **Export** menu. Choose **Prepare export**,
review any conversion notes, then **Download DOCX**. Upload the file to Google
Drive and open it with Google Docs. Google supports editing Office files and
converting them into native Docs; see
[Google's Office file guide](https://support.google.com/docs/answer/9406611).

This is a local document download. The app does not connect a Google account,
create a file in Drive, or change sharing. Unlisted readers need no Elaborating
account to export the content already shared with them.

## Content and layout

The exporter writes native WordprocessingML with the pinned `docx` library,
not an HTML attachment that depends on Word-specific conversion. Text stays
editable: headings, paragraphs, emphasis, links, code, lists, tasks and simple
tables become document content. Images are embedded in the file, retaining
their aspect ratio and fitting the portrait page's reading area. Image pixels
retain their original detail; SVG, animation and unsupported image formats
use bounded static raster copies. Drawing PNG export scales the drawing and
its canvas together, including when a pixel limit reduces the requested scale.

The shared conversion pipeline also powers [Notion export](notion-export.md).
It expands embedded notes, creates native drawing and diagram images, captures
matching current component output where available, and uses an isolated
temporary preview for unopened components. Interactive components become
static content. Custom form inputs and CSS layouts are not preserved; labels
can run together when their layout came only from CSS. Unsupported content
produces visible source or placeholders and conversion notes for review.
Google Docs may change formatting on import.

The [component export proposal](component-exports.md) covers an image fallback
for visual custom components and links back to their document location.
Whole-component PNG capture and these link targets are not implemented yet.

In a project, current root and retained child drafts are included. In an
unlisted reader, one saved shared bundle is frozen for the operation; reads
cannot go outside its already authorized files and images. Known revocation
or a changed displayed bundle cancels that export and drops its prepared
result. Comments, entered form values, account credentials and application
editing controls are excluded.

## Loading and isolation

The DOCX builder loads only when preparing this format. Browsing, opening the
export menu, preparing Notion, and viewing Source do not require that builder.
The format and its ZIP dependency stay outside every first-paint bundle.

The source graph, image validation, immutable identities, quotas, cancellation
and opaque-frame snapshot checks are shared with the Notion exporter. It
never fetches remote document images or gives component code network access.
A completed file is required before **Download DOCX** becomes available.
The [progressive loading follow-ups](progressive-loading.md) remain pending;
this explicit export action does not implement that app-wide loading pass.

## Verification

Converter tests inspect native document XML, image relationships and bytes,
headings, lists, tables, links, captions, image bounds and unsupported input.
Chromium and Firefox journeys cover project drafts, anonymous shared exports,
current and unopened component views, mobile accessibility, cancellation,
revision changes, revocation, unchanged Notion export and cached offline use.
The supplied script's DOCX was rendered and all 27 pages checked for page
layout and image scaling. Its 18 original images retain their exact bytes,
and its 15 drawing images fill their corrected export canvases.
Generating and inspecting a DOCX does not verify a live Google Drive import.
