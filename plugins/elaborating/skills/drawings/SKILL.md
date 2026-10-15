---
name: drawings
description: Create or change hand-drawn style drawings (Excalidraw scenes) in elaborat.ing and embed them in notes. The default whenever the user asks to draw, sketch or diagram something in an elaborat.ing project: flows, architecture, ideas, whiteboards and any boxes and arrows.
---

# Drawings

The user's instructions win over this skill when they differ.

## Files

- A drawing is an Excalidraw scene saved as JSON in a `.excalidraw` file, such
  as `drawings/idea.excalidraw`. The app also opens Obsidian's
  `.excalidraw.md` files: keep those in their own format.
- A drawing is the default whenever the user asks to draw, sketch or diagram
  something, boxes and arrows included. Make a D2 diagram instead only when
  the user asks for D2, or for a structured diagram that has to be laid out
  from code: database tables and their relationships, a sequence diagram, or
  a graph with dozens of connected nodes.
- To make or extend a drawing the user can watch in elaborat.ing, or in its
  panel beside the chat, use `draw`, not one big `write_file`. Add several
  shapes per call, a row or a group of related shapes with their arrows,
  about 4 to 10 elements, in reading order: the user sees each one sketched
  in turn. Don't add one shape per call. Every element needs a new id;
  `draw` fills in the fields you leave out and lists each label and arrow in
  its shape's `boundElements`.
- In `draw`, give a rectangle, ellipse or diamond a `label` and leave out
  its size: `draw` adds the label as a text with the id `<shape id>-label`,
  centred, and sizes the shape to fit it. Join two shapes with an arrow's
  `from` and `to`, their ids, instead of `x`, `y` and `points`: `draw` runs
  it straight between their outlines and binds both ends. An arrow can have
  a `label` too. Leave about 150 px between shapes for the arrows and their
  labels. For example:

  ```json
  {"path": "drawings/flow.excalidraw", "elements": [
    {"id": "api", "type": "rectangle", "x": 0, "y": 0, "label": "API"},
    {"id": "db", "type": "ellipse", "x": 300, "y": 0, "label": "Database"},
    {"id": "api-to-db", "type": "arrow", "from": "api", "to": "db", "label": "SQL"}
  ]}
  ```
- To change or remove elements, read the drawing, change only what you need,
  and keep every other element and field as it is, ids included. Save once
  with `write_file` and the `base_version` you read, then add anything new
  with `draw`.
- To make a new drawing the user should watch being drawn in the chat, use
  `create_and_show`. Put `elements` before `appState`, and write each shape,
  then its arrows, in the short form below.
- To change a drawing while the user watches in the chat, read it and save
  the whole scene with `update_and_show` and the `base_version` you read,
  keeping every other element and field as it is, ids included, and writing
  new or changed shapes and arrows in the short form: the card shows the
  drawing as saved, draws in the elements you changed or added, and fades
  the ones you removed. To change a label, give its shape or arrow the new
  `label`: it replaces the old label text, which you can leave out. For
  quiet changes, and drawings the user isn't watching, use `write_file`.
- Embed it in a note with `<Drawing src="drawings/idea.excalidraw" />`, and
  show it with `show_file`. Create it before the note that embeds it.
- To comment on one element, pass its `element_id` to `add_comment`.

## The scene

`create_and_show`, `update_and_show` and `write_file` take the same short
form as `draw`: each shape with a `label` and no size, and each arrow by
`from` and `to`. The drawing is saved with the full Excalidraw elements
`draw` would make, so it is a fraction of the JSON to write:

```json
{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {"id": "draft", "type": "rectangle", "x": 0, "y": 0, "label": "Draft", "backgroundColor": "#fff3bf", "fillStyle": "solid"},
    {"id": "review", "type": "ellipse", "x": 300, "y": 0, "label": "Review"},
    {"id": "draft-to-review", "type": "arrow", "from": "draft", "to": "review"}
  ],
  "appState": {"viewBackgroundColor": "#ffffff"},
  "files": {}
}
```

- A rectangle, ellipse or diamond with a `label` and no `width` or `height`
  is sized to fit the label, which is added as a text with the id
  `<shape id>-label`, centred. A long label wraps, so the shape is at most
  about 240 px wide: shapes 300 apart leave room for an arrow.
- An arrow with `from` and `to`, the ids of two shapes, and no `x`, `y` or
  `points`, runs straight between their outlines and is bound to both. It
  can have a `label` too.
- Full Excalidraw elements still work, also in the same file. Each needs a
  unique `id`, a `type`, `x`, `y`, `width` and `height`, and the app fills
  in the fields you leave out. A label is then a text element with
  `containerId` set to its shape's id, listed in the shape's
  `boundElements`, and an arrow's `points` are relative to its `x` and `y`;
  to attach it to shapes, set `startBinding` and `endBinding`
  (`{"elementId": "draft"}`) and list the arrow in each shape's
  `boundElements`.
- Types: rectangle, ellipse, diamond, text, arrow, line and freedraw.
- Style: `strokeColor`, `backgroundColor` (`"transparent"` or a colour),
  `fillStyle` (`"solid"` or `"hachure"`), `strokeWidth` (1, 2 or 4),
  `roughness` (0 for clean lines, 1 for sketchy), `roundness`
  (`{"type": 3}` for rounded corners, which a rectangle in the short form
  has unless you give `null`).
- Text: `text`, `fontSize` and `fontFamily` (5 hand-drawn, 6 plain, 8 code).
