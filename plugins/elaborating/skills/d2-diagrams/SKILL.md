---
name: d2-diagrams
description: Create or change D2 diagrams in elaborat.ing, such as flows, architecture and table relationships, and embed them in notes. Use when the user wants a diagram that lays itself out from code in an elaborat.ing project.
---

# D2 diagrams

The user's instructions win over this skill when they differ.

## Files

- A diagram is D2 source in a `.d2` file, such as `diagrams/sign-in.d2`.
  Write only that file. When someone opens it in the app, the app lays it out
  and saves two files next to it: the canvas (`sign-in.excalidraw`), which
  keeps shapes people moved and anything drawn by hand, and a layout record
  (`sign-in.d2.json`). Don't write or edit those two.
- To change a diagram, read its `.d2` file and save the new source with
  `write_file` and its `base_version`. Changes made by hand on the canvas
  survive the next layout.
- To move, rename or delete a diagram, do the same to each of its three files
  that exists (see `list_files`) in one `save_files` call, so they stay
  together.
- Embed it in a note with `<Diagram src="diagrams/sign-in.d2" />`. The file
  must exist, so create it first or in the same `save_files` call.
- `show_file` draws a diagram from its canvas. A new diagram has no canvas
  until it is opened in the app, and after a source change the card may say
  it is out of date. Give the user the link to open it.
- Comments on a diagram's shapes are on its canvas: to add one, use the
  `.excalidraw` path and the shape's `element_id` with `add_comment`.

## Writing D2

- Layout is automatic, so don't give positions. Set `direction: right` or
  `direction: down` at the top.
- These shapes are drawn as themselves: rectangle (the default), square, oval,
  circle, diamond, text and sql_table. A container (`api: { web; worker }`)
  becomes a frame. Other shapes, such as cylinder or person, are drawn as
  boxes.
- Keep labels short and put the detail in the note around the diagram.

```d2
direction: right
start: Start {shape: oval}
check: Approved? {shape: diamond}
ship: Ship it
fix: Fix issues
start -> check: submit
check -> ship: yes
check -> fix: no
fix -> check: revise
```

A table diagram:

```d2
users: {
  shape: sql_table
  id: int {constraint: primary_key}
  email: varchar {constraint: unique}
}
orders: {
  shape: sql_table
  id: int {constraint: primary_key}
  user_id: int {constraint: foreign_key}
}
users.id <-> orders.user_id: places
```
