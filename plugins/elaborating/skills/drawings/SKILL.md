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
- To change a drawing, read it, change only the elements you need, and keep
  every other element and field as it is, ids included. Save with
  `write_file` and the `base_version` you read.
- Embed it in a note with `<Drawing src="drawings/idea.excalidraw" />`, and
  show it with `show_file`.
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
  `height`. The app fills in the fields you leave out.
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
