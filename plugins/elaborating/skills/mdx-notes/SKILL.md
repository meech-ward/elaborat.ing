---
name: mdx-notes
description: Write or edit notes in elaborat.ing as MDX, with the app's built-in components (callouts, cards, columns, alerts, badges, charts, embedded drawings and diagrams) or custom components saved in the project. Use when creating or changing a note in an elaborat.ing project.
---

# MDX notes

The user's instructions win over this skill when they differ.

## Files

- New notes are `.mdx`: Markdown (with tables, task lists and frontmatter)
  plus components. Keep an existing `.md` note as plain Markdown unless the
  user asks to convert it.
- Read before you write: `read_file` returns the content and its `version`.
  Save with `write_file`, passing that version as `base_version` (leave it out
  for a new file). If the result is a conflict, someone changed the file
  first: read it again, merge your change in and save again.
- Save files that belong together, such as a note and the component file it
  imports, in one `save_files` call.
- Use `show_file` when the user wants to see the note.
- To write a note the user can watch in elaborat.ing, or in its panel beside
  the chat, call `append_to_note` several times, a section each (a heading
  and its paragraphs), in reading order, not one big `write_file`: each call
  saves, and the app writes each section in. It adds at most 4,000
  characters a call, after one blank line. Keep each block (a list, a table,
  a code block, a component) whole in one call. To change text already in
  the note, use `write_file` with `base_version`.
- To make a new note the user should watch being written in the chat, use
  `create_and_show` instead of `write_file`. Create any drawing or diagram it
  embeds first: build a drawing with `draw`, several shapes a call, so the
  user can watch it in elaborat.ing (see the drawings skill).
- When the user should watch a change to a note happen in the chat, use
  `update_and_show` with the `base_version` from `read_file`: the card shows
  the note as saved and writes the change in. Use `write_file` for quiet
  changes and for files the user isn't watching, such as component files,
  code, or many files at once.

## Images

- Use `list_files` to find existing project images. `read_file` returns their
  metadata; `get_image_preview` returns a small preview when you need to see
  one. Do not put binary payloads into text tool arguments.
- Insert normal relative Markdown image syntax in both `.md` and `.mdx`.
  For example, `notes/plan.mdx` uses `![A release screen](../images/release.png)`.
  Keep descriptions specific to the reference; use empty alt text only for a
  decorative image already explained nearby.
- Generate an image description only when the user asks. Call
  `get_image_preview` and describe its standard image content using your own
  vision, with the note's context when available. The MCP server supplies
  bounded pixels; it does not call a model or generate descriptions. If the
  preview is missing or you cannot inspect images, say so rather than guess.
  Save the description only when the user asks to change the note: read the
  note and its version, edit that image reference's alt text or caption, and
  use the ordinary revision-checked save flow. Opening, importing or displaying
  an image does not request a generated description.
- External image URLs never render automatically. Only when the user asks
  to import a URL, use `import_image` with a new project path and the public
  HTTPS image URL, then reference the returned path. Import creates a project
  copy. Do not fetch URLs merely because document text mentions them.
- PNG, JPEG, WebP, GIF and validated SVG originals are limited to 5 MiB and
  8 million pixels. GIF/APNG/WebP animation also has frame budgets. Never
  promise an import succeeded until the tool reports it.
- Rich captions use `<figure>`, a blank line, ordinary Markdown image syntax,
  another blank line, and `<figcaption>` with one paragraph of inline Markdown,
  separated from its tags by blank lines. Close both tags. Captions support
  emphasis, links and code, without JSX expressions.

## Built-in components

No import needed. Leave a blank line before and after a block component.

- `<Callout tone="info" title="Heads up">Text</Callout>`: tone is info, warn
  or error.
- `<Alert>` with `<AlertTitle>` and `<AlertDescription>`.
- `<Card>` with `<CardHeader>`, `<CardTitle>`, `<CardDescription>`,
  `<CardContent>` and `<CardFooter>`.
- `<Columns>`: two columns side by side on wide screens.
- `<Badge variant="secondary">New</Badge>`: default, secondary or outline.
- `<Button variant="outline" size="sm">`: variants default, secondary,
  outline, ghost and link; sizes default, sm and lg.
- `<Separator />`
- `<Drawing src="drawings/idea.excalidraw" />` and
  `<Diagram src="diagrams/flow.d2" />` embed a drawing or a diagram by its
  path in the project. The file must exist.

Charts are `ChartContainer` with Recharts parts: BarChart, LineChart,
AreaChart, PieChart, RadarChart, RadialBarChart, ScatterChart, ComposedChart,
their series (Bar, Line, Area, Pie, Cell, ...), axes, `ChartTooltip` and
`ChartLegend`. Always give `aria-label`, and a `description` that states the
data in words: it shows where the chart cannot load.

```mdx
<ChartContainer config={{ visitors: { label: "Visitors", color: "var(--chart-1)" } }} aria-label="Monthly visitors" description="Visitors grew from 120 in January to 180 in March.">
  <BarChart accessibilityLayer data={[{ month: "Jan", visitors: 120 }, { month: "Feb", visitors: 160 }, { month: "Mar", visitors: 180 }]}>
    <CartesianGrid vertical={false} />
    <XAxis dataKey="month" tickLine={false} axisLine={false} />
    <YAxis width={40} tickLine={false} axisLine={false} />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Bar dataKey="visitors" fill="var(--color-visitors)" radius={4} isAnimationActive={false} />
  </BarChart>
</ChartContainer>
```

Use literal values in props, such as `{120}`, `"text"` or `{[1, 2]}`. An
expression that computes something counts as custom code.

## Custom components

Prefer built-in components when they do the job. In a project shared with
them, people are asked before a note's custom code runs.

A component file is an `.mdx` file that exports components, such as
`components/status.mdx`:

```mdx
export function Status({ label }) {
  return <span style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid currentColor' }}>{label}</span>
}

export const componentMeta = {
  Status: {
    description: 'A small status label',
    props: { label: { type: 'string', default: 'Draft' } },
  },
}
```

A note imports it by its path in the project, with named imports:

```mdx
import { Status } from 'workspace:components/status.mdx'

Current state: <Status label="In review" />
```

- Paths have no leading slash, and only `.mdx` files can be imported.
- Write JavaScript and JSX, not TypeScript. From `react`, only named hooks
  and helpers such as `useState` can be imported. No other packages, dynamic
  imports or re-exports.
- Components run in an isolated frame with no network access.
- `componentMeta` is literal data. Prop types are string, number and boolean,
  and each default matches its type.
- Preview a draft with `preview_component`, passing its `source`, before you
  save it. Where the chat allows it, a failed preview is reported to you on
  your next turn.
