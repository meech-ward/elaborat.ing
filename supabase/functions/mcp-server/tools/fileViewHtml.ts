import { CARD_SCRIPT, CARD_STYLE } from './cardEditorScript.ts'

// The HTML an MCP Apps host (Claude, ChatGPT) renders for show_file, in a
// sandboxed frame: the chat card, a small React app built from the app's
// component library (src/chat-card, built into cardEditorScript.ts by
// `bun run build:chat-card`). An inline stylesheet and script (which carries
// the app's fonts as bytes) show the note, drawing or diagram with no network
// requests. The editor and the component previews load as modules from
// https://elaborat.ing/chat-card/ when first needed, which the view's
// `_meta.ui.csp` declares (fileView.ts); where a host does not allow them the
// card stays read-only, as it runs under the spec's default policy. It
// talks to the host over the MCP Apps postMessage bridge: ui/initialize,
// then the tool-input and tool-result notifications, theme changes, size
// changes and ui/open-link. Drawings arrive as SVG the server drew, in the
// result's `_meta` (which the host passes to the view and keeps from the
// model); in dark mode they go through Excalidraw's own dark filter.
//
// A note can be edited in place where the host lets views call tools: Edit
// opens the app's rendered editor on the note's source (sent in `_meta` too),
// and Save calls write_file through the bridge with the version the card
// showed, so a note changed since then is a conflict, never overwritten.
// After a save the card reloads itself with show_file and tells the model
// with ui/update-model-context.
// https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

export const FILE_VIEW_HTML = `<!doctype html>
<html lang="en" data-theme="supabase-green">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>elaborat.ing file</title>
<style>${CARD_STYLE}</style>
</head>
<body>
<div id="root"></div>
<script>${CARD_SCRIPT}</script>
</body>
</html>
`
