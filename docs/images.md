# Images

Images are project files. Notes use ordinary relative Markdown references;
the trusted app supplies their pixels to the isolated rendered document.
Opening a note never fetches a third-party image URL.

**Status:** implemented and tested, tracked in
[T43 through T50](tasks.md#t43-prove-the-image-asset-contract-and-validation).
The final private hosted upload/download/save check awaits a signed-in
browser. Hosted description suggestions require the assistant's existing
OpenAI approval. The limits and storage contracts below are settled.

## Authoring

Image is available in the rendered view's Insert block control and right-click
menu for Markdown and MDX. Upload, clipboard image paste and file drop open
the trusted picker. Multiple images retain their order and are inserted
only after every description has been confirmed. Pasted URLs stay text.

The picker offers existing project images, an image description or an explicit
Decorative choice, an optional rich caption, crop and resize controls, and
explicit URL import. It checks the original position and document revision
again before changing source. Cancelling leaves the note unchanged; changing
the note while choosing requires choosing the position again.

Crop and resize make a new PNG file after Apply. Note insertion retains the
original in the project. Drawings copy the chosen bytes into their native
scene and leave existing project files unchanged. Rich captions apply to
notes. Animated images become still copies when transformed. Existing
project images in notes are reused without copying unless a transform is requested.
Names receive readable suffixes instead of overwriting another file.

Suggest description sends only a small raster preview through the existing
ChatGPT plan connection. It runs only when clicked, uses the person's chosen
available model, and returns editable alt text. It requires the same connected
ChatGPT plan and local token keeper as the assistant. Builds without that
connection hide the suggestion control. Hosted activation waits for the same
OpenAI approval as the assistant. It does not infer or save a description while
an image is merely opened.

Images fit the reading column, keep their colours in either theme, and have
an accessible enlarged view. Note and chat previews use static thumbnails;
opening an original GIF, APNG or animated WebP preserves its animation.
Replace, Edit description and Remove change precise source ranges and use the
note's existing Undo/Redo history. Removing a reference keeps its reusable
project file. The explorer opens images with dimensions and a download action.

Drawing file actions include Insert image. Uploads and project images become
independent native Excalidraw binary files with new element/file identities.
The scene keeps its own bytes when the project asset later changes. Native
Excalidraw image tools and standalone drawing exports continue to work.

Owners and editors can change images. Viewers, commenters and archived
projects display them without insertion or editing controls.

## Portable source and files

A note at `notes/launch.md` can refer to `assets/release.png` with:

```md
![The release screen](../assets/release.png)
```

Alt text belongs to each reference. The same file can have different
descriptions in different documents. New note source contains no Storage URL,
signed URL, backend identifier or base64 photo. Native Excalidraw files retain
their existing embedded-image format.

Rich captions use a portable HTML figure around ordinary Markdown, with blank
lines so both Markdown and MDX parse the image and caption. Captions support
one paragraph with emphasis, bold, links and inline code. They do not execute
custom caption JSX or expressions.

The Markdown/MDX parser finds actual images, reference images and literal
HTML/JSX image tags, including static image references in approved component
sources. Relative URLs resolve from the note or component file. Code fences,
comments, computed values and paths that escape the project do not authorize
file reads. Modules using the same literal URL get distinct reference keys.

Moves rebase supported image references when an image, folder, note or
component moves, preserving surrounding syntax. Ambiguous affected references
stop the move with a reason. Deletion reports dependants before asking for
confirmation. Missing images show a placeholder and alt text.

ZIP import/export and folder import carry original PNG, JPEG, WebP, GIF and SVG bytes
at their logical paths. Local project sign-in carries image blobs too. Offline
insertion and reuse need no server; downloaded images and unsaved drafts
survive reload. Sync does not advance its complete offline revision before
current image bytes have been downloaded and checked.

## Asset storage and saves

The private bucket is `project-images`. Original and preview objects have
immutable keys `<project UUID>/<asset UUID>/original` and `.../preview`.
An asset records verified type, dimensions, byte length and SHA-256. Current
files and saved versions contain `kind: image` and an asset snapshot; their
text content is empty. Text files retain their existing representation.

New assets are durable local drafts before insertion. Saving a note promotes
its staged images, any retained transform originals and source changes in
one local batch. Sync uploads the objects before committing asset references
and note writes together through `save_files`. Replacement makes a new asset
and file version. Moves preserve the bytes. Explicit asset operations prevent
older text-only clients from accidentally overwriting images.

Reservations belong to the uploader and project, last one hour, and include
original and preview bytes. Lost answers reuse immutable object identities
and mutation receipts. A failed upload or conflict leaves local recovery
copies intact. A ready uncommitted asset is readable only by its uploader
while their membership and reservation remain valid. Committed assets follow
accepted project membership, including retained history. Recovery checks the
server's upload status before retrying. A confirmed expired, never-committed
upload gets fresh object and mutation identities so delayed cleanup cannot
remove its replacement. A committed lost answer keeps its original identity
and receipt.

Removing a logical file or reference keeps historical bytes. Historical image
lookup resolves path and version at the requested project revision, including
before a replacement, move or deletion. Agent change review displays image
previews and can restore an earlier immutable asset, including a move and
replacement in one checked save.

Clients cannot overwrite or physically delete Storage objects. Expired staging
and person-authorized permanent project/account deletion feed a durable
cleanup queue. The trusted worker uses Storage API deletion and acknowledges
successful removals. Deleting an uploader's account preserves assets belonging
to someone else's project. Agents cannot trigger permanent deletion.

## Formats, quotas and runtime proof

- Originals: PNG, JPEG, WebP, GIF and validated SVG, at most 5 MiB each.
- Raster and SVG dimensions: at most 8 million pixels. Headers are checked
  before allocating a raster decode; the server then decodes and verifies it.
- GIF, APNG and animated WebP: at most 120 frames and 24 million total frame
  pixels. Original bytes remain intact; generated previews are static.
- SVG: UTF-8 XML with vector shapes and local references. Scripts, event
  handlers, HTML, embedded images, external resources, stylesheets, entity
  declarations and unsupported elements are refused. Node/depth/path/filter
  and reference expansion budgets bound complexity. It is displayed as an
  image, never injected into the document DOM.
- Thumbnails: separate PNG/WebP raster files, at most 480 pixels on the long
  side and 32 KiB. Alpha and the original's bytes are preserved.
- Current project files: 64 MiB including live image originals. Text/native
  drawing files keep their existing 2 MiB serialized-file limit.
- Retained originals, previews and outstanding reservations: 256 MiB per
  project owner across their projects. Ownership transfer checks and moves
  this charge atomically. Upload attempts are limited to 30 per minute.

The original 25-million-pixel proposal was rejected by a Deno decoder proof:
a 25 MP PNG reached about 381 MB RSS before app dependencies. The 8 MP proof
used about 212 MB RSS. The raster validator serializes decodes per isolate.
Photon WASM performs raster decoding; resvg WASM makes SVG thumbnails without
system font or external resource loading.
SVG text uses the bundled Space Grotesk Latin font as a deterministic fallback,
including when an image requests a font that is unavailable. This preserves
text instead of silently producing a blank preview; preview typography and
glyph coverage can differ from the original. Convert text to vector outlines
when exact typography is required. The original SVG remains unchanged.
The fallback comes from the already pinned
`@fontsource-variable/space-grotesk@5.3.0` package, with its SIL Open Font License
embedded beside the bytes in `supabase/functions/_shared/svgFont.json`.
Regenerate it with `bun scripts/build-svg-font.ts`; no font is downloaded or
read from the host filesystem at runtime.
Renderable SVG text is capped at 4,000 UTF-16 characters per text node and
8,000 in total, including whitespace inside text elements and expanded local
references. The separate XML text budget remains 16,000 characters per node
and 100,000 overall. A same-request local Edge proof decoded an 8 MP PNG,
16,000 glyphs and another 8 MP PNG successfully; the retained 8,000-glyph
limit leaves headroom. A 100,000-glyph proof reached the runtime CPU limit.

Local Supabase Edge tests exercised authenticated 8 MP PNG, SVG, another
8 MP PNG, concurrent PNG/SVG uploads, private object reads, commit and trusted
cleanup. Database tests cover membership isolation, quota concurrency,
ownership transfer, staged expiry and retained historical lookup. These are
local proofs; hosted deployment validation is recorded with the task checks.

A drawing's base64 copy must fit its final 2 MiB serialized scene. Oversized
copies are refused before mutation; the picker offers explicit resizing.
Original metadata, including photo metadata, is retained, not stripped.

## Network isolation and URL import

Both document policies keep `img-src data:` and their existing network
restrictions. The parent parses authoritative source, loads authorized bytes,
and sends bounded payloads tied to the frame session, revision and reference.
The frame receives no account tokens, Storage URLs or generic file access.
Heavy processing and picker code load on demand.

Import from URL is an explicit online action. It downloads once and creates a
project copy. The importer accepts public HTTPS URLs without credentials or
custom ports, sends no cookies, authorization or referrer, and pins TLS to a
validated public DNS address. Every redirect is checked again, with at most
three redirects, one ten-second deadline, bounded headers and a streamed
5 MiB body cap. Private, loopback, metadata, reserved and mixed public/private
DNS answers are rejected. Actual contents pass the normal decoder afterward.
Authenticated sources, page scraping and automatic hotlinking are unsupported.

## Chats and agents

Text reads of image files return metadata, not binary payloads. The assistant
and MCP can inspect a bounded preview, reuse a project path in a note, or
explicitly import an authorized URL. The URL-import MCP tool declares
`openWorldHint: true`. Source text alone never authorizes network import.
Native drawing text reads can still contain their embedded image bytes.

App and chat previews use source-owned reference keys, bounded raster previews
and deferred loading. Hosts that cannot load an image retain alt text and
Open in elaborat.ing. Server drawing previews validate and rasterize native
images instead of interpolating arbitrary scene data URLs. Unsupported legacy
entries retain their original saved scene and show a preview fallback.

## Outside this change

Drag handles and persistent display-width presets, rotation, filters,
galleries, OCR, image generation, authenticated remote sources, live
hotlinking, video/audio, and replacing native Excalidraw image storage with
shared asset references.

## Platform references

- [Private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
  and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).
- [Storage schema](https://supabase.com/docs/guides/storage/schema/design): mutate
  objects through Storage APIs, not SQL metadata deletion.
- [Standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads).
- [Responses function output images](https://developers.openai.com/api/docs/guides/function-calling).
- [Document isolation](architecture.md#component-isolation) and
  [platform setup](platform-notes.md#supabase-schema-and-config-as-code).
