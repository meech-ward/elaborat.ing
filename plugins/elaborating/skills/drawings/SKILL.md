---
name: drawings
description: Create or change hand-drawn style drawings (Excalidraw scenes) in elaborat.ing and embed them in notes. Use when the user wants a sketch, a whiteboard or shapes placed by hand in an elaborat.ing project.
---

# Drawings

The user's instructions win over this skill when they differ.

## Files

- A drawing is an Excalidraw scene saved as JSON in a `.excalidraw` file, such
  as `drawings/idea.excalidraw`. The app also opens Obsidian's
  `.excalidraw.md` files: keep those in their own format.
- For boxes and arrows that should lay themselves out, a D2 diagram is usually
  the better choice. Use a drawing for sketches and hand-placed layouts.
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
  then its label, then its arrows.
- To change a drawing while the user watches in the chat, read it and save
  the whole scene with `update_and_show` and the `base_version` you read,
  keeping every other element and field as it is, ids included: the card
  shows the drawing as saved, draws in the elements you changed or added, and
  fades the ones you removed. For quiet changes, and drawings the user isn't
  watching, use `write_file`.
- Embed it in a note with `<Drawing src="drawings/idea.excalidraw" />`, and
  show it with `show_file`. Create it before the note that embeds it.
- To comment on one element, pass its `element_id` to `add_comment`.

## The scene

```json
{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {"id": "draft", "type": "rectangle", "x": 0, "y": 0, "width": 180, "height": 80, "strokeColor": "#1e1e1e", "backgroundColor": "#fff3bf", "fillStyle": "solid", "roundness": {"type": 3}, "boundElements": [{"id": "draft-label", "type": "text"}, {"id": "draft-to-review", "type": "arrow"}]},
    {"id": "draft-label", "type": "text", "x": 50, "y": 27.5, "width": 80, "height": 25, "text": "Draft", "fontSize": 20, "fontFamily": 5, "textAlign": "center", "verticalAlign": "middle", "containerId": "draft"},
    {"id": "review", "type": "ellipse", "x": 300, "y": 0, "width": 180, "height": 80, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "boundElements": [{"id": "review-label", "type": "text"}, {"id": "draft-to-review", "type": "arrow"}]},
    {"id": "review-label", "type": "text", "x": 350, "y": 27.5, "width": 80, "height": 25, "text": "Review", "fontSize": 20, "fontFamily": 5, "textAlign": "center", "verticalAlign": "middle", "containerId": "review"},
    {"id": "draft-to-review", "type": "arrow", "x": 188, "y": 40, "width": 104, "height": 0, "points": [[0, 0], [104, 0]], "endArrowhead": "arrow", "startBinding": {"elementId": "draft", "focus": 0, "gap": 8}, "endBinding": {"elementId": "review", "focus": 0, "gap": 8}}
  ],
  "appState": {"viewBackgroundColor": "#ffffff"},
  "files": {}
}
```

- Every element needs a unique `id`, a `type`, `x`, `y`, `width` and
  `height`. The app fills in the fields you leave out. `draw` takes full
  elements too, such as the ones above, but its `label`, `from` and `to` are
  quicker to write.
- Types: rectangle, ellipse, diamond, text, arrow, line and freedraw.
- Style: `strokeColor`, `backgroundColor` (`"transparent"` or a colour),
  `fillStyle` (`"solid"` or `"hachure"`), `strokeWidth` (1, 2 or 4),
  `roughness` (0 for clean lines, 1 for sketchy), `roundness`
  (`{"type": 3}` for rounded corners).
- Text: `text`, `fontSize` and `fontFamily` (5 hand-drawn, 6 plain, 8 code).
- A label inside a shape is a text element with `containerId` set to the
  shape's id, and the shape lists it in `boundElements`.
- An arrow's `points` are relative to its `x` and `y`. To attach it to shapes,
  set `startBinding` and `endBinding`, and list the arrow in each shape's
  `boundElements`.
