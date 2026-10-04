import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { FILE_VIEW_META, MCP_APP_MIME_TYPE } from './fileView.ts'
import { path, projectId } from './projects.ts'
import { errorResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// open_panel and its view: the app itself beside the chat. ChatGPT opens the
// tool from its sidebar (global entrypoint) or a conversation's side panel
// (thread entrypoint) with {}, and the model can open it at a project or a
// file. The view is a small page that frames https://elaborat.ing/embed, the
// app in a panel (src/features/embed), which keeps a sign-in of its own and
// updates through the app's own sync. The app's site decides who may frame it
// (EMBED_FRAME_ANCESTORS in wrangler.jsonc); when it may not be framed here
// the view says so, with the origins to allow and a link to the site.
// https://github.com/openai/mcp-extensions/blob/main/docs/spec.md

/** Change the URI when the HTML changes: hosts cache the view by it. */
export const PANEL_VIEW_URI = 'ui://elaborating/panel-v1.html'
/** The result `_meta` key holding the app's page to frame, such as /embed/projects/<id>. `_meta` reaches the view, not the model. */
export const PANEL_META_KEY = 'elaborat.ing/embed'

const APP_ORIGIN = 'https://elaborat.ing'

/**
 * The view frames the app's site, and opens it in a new tab. Its widget
 * domain is the card's, so the site allows one view origin per chat.
 */
export const PANEL_VIEW_META = {
  ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [APP_ORIGIN] } },
  'openai/widgetCSP': { connect_domains: [], resource_domains: [], frame_domains: [APP_ORIGIN], redirect_domains: [APP_ORIGIN] },
  'openai/widgetDomain': FILE_VIEW_META['openai/widgetDomain'],
}

/** A monochrome 20x20 icon for the entrypoints (the app's diamond), drawn in the host's text colour. */
const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linejoin="miter">' +
      '<path d="M10 2.5 17.5 10 10 17.5 2.5 10Z"/></svg>'
  )

/**
 * Whether the server offers the panel: on unless the function secret
 * `EMBED_VIEW_ENABLED` is `false`, which leaves the tool list and resources
 * as they were without it.
 */
export function embedViewEnabled(): boolean {
  try {
    return Deno.env.get('EMBED_VIEW_ENABLED')?.trim().toLowerCase() !== 'false'
  } catch {
    return true
  }
}

const encodePath = (filePath: string) => filePath.split('/').map(encodeURIComponent).join('/')

const STYLE = `
:root { color-scheme: light dark; --fg: #1d2127; --muted: #5d6573; --bg: #ffffff; --line: #d9dde3; }
:root[data-theme="dark"] { --fg: #e8eaee; --muted: #a2a9b6; --bg: #16191f; --line: #333944; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
iframe { display: block; width: 100%; height: 100%; border: 0; }
#fallback { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 16px; }
#fallback[hidden], iframe[hidden] { display: none; }
p { margin: 0; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
details { color: var(--muted); font-size: 13px; max-width: 100%; }
code { display: block; margin-top: 6px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; user-select: all; }
`

const SCRIPT = String.raw`
(function () {
  var APP = "https://elaborat.ing";
  var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var EMBED_PATH = new RegExp("^/embed(?:/projects/" + UUID + "(?:/[^?#]*)?)?$", "i");
  var APP_PATH = new RegExp("^/(?:projects/" + UUID + "(?:/[^?#]*)?)?$", "i");
  var frame = document.getElementById("app");
  var fallback = document.getElementById("fallback");
  var nextId = 1, pending = {}, initialized = false, ready = false, readyTimer = null;
  var theme = null, metaPath = null, deepPath = null, shown = null, blocked = false, inline = true, maxHeight = null;

  function post(message) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ method: method, params: params || {} }); }

  // Where this view sits: its own origin, then the pages around it. The app's
  // site lets the view frame it once these are its allowed ancestors.
  function origins() {
    var list = [location.origin];
    var ancestors = location.ancestorOrigins;
    if (ancestors) for (var i = 0; i < ancestors.length; i++) list.push(ancestors[i]);
    else if (document.referrer) { try { list.push(new URL(document.referrer).origin); } catch (error) {} }
    return list.filter(function (origin, index) { return origin && origin !== "null" && list.indexOf(origin) === index; }).join(" ");
  }

  function showFallback() {
    document.getElementById("origins").textContent = origins();
    fallback.hidden = false;
    frame.hidden = true;
  }

  // The page to frame: the tool's, unless it is only the projects; then the host's deep link; then the projects.
  function target() {
    if (metaPath && metaPath !== "/embed") return metaPath;
    return deepPath || metaPath || "/embed";
  }
  function show() {
    if (!initialized || blocked) return;
    var path = target();
    if (path === shown) return;
    shown = path;
    ready = false;
    frame.hidden = false;
    fallback.hidden = true;
    frame.src = APP + path + (theme ? "?theme=" + encodeURIComponent(theme) : "");
    clearTimeout(readyTimer);
    readyTimer = setTimeout(function () { if (!ready) showFallback(); }, 10000);
  }

  function readMeta(meta) {
    var value = meta && meta["elaborat.ing/embed"];
    if (typeof value === "string" && EMBED_PATH.test(value)) { metaPath = value; show(); }
  }
  function readDeepLink(link) {
    var url = link && typeof link.url === "string" ? link.url : null;
    if (!url) return;
    if (url.indexOf(APP + "/") === 0) url = url.slice(APP.length);
    url = url.split(/[?#]/)[0];
    if (APP_PATH.test(url)) { deepPath = "/embed" + (url === "/" ? "" : url); show(); }
  }
  function setTheme(next) {
    if (next !== "light" && next !== "dark") return;
    document.documentElement.dataset.theme = next;
    if (next === theme) return;
    theme = next;
    if (frame.contentWindow && shown) frame.contentWindow.postMessage({ type: "elaborating-embed:theme", theme: theme }, APP);
  }
  // Inline, the view is as tall as the chat allows; opened beside the chat it fills the panel.
  function fit() {
    document.documentElement.style.height = inline && maxHeight ? maxHeight + "px" : "100%";
    notify("ui/notifications/size-changed", { width: window.innerWidth, height: inline && maxHeight ? maxHeight : window.innerHeight });
  }
  function readContext(context) {
    if (!context) return;
    setTheme(context.theme);
    if (typeof context.displayMode === "string") inline = context.displayMode === "inline";
    var dimensions = context.containerDimensions || {};
    var height = dimensions.maxHeight || dimensions.height || (window.openai && window.openai.maxHeight);
    if (typeof height === "number" && height > 0) maxHeight = height;
    if ("openai/deepLink" in context) readDeepLink(context["openai/deepLink"]);
    fit();
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source === frame.contentWindow && event.origin === APP) {
      if (!data || typeof data.type !== "string") return;
      if (data.type === "elaborating-embed:ready") {
        ready = true;
        clearTimeout(readyTimer);
        frame.hidden = false;
        fallback.hidden = true;
        if (theme) frame.contentWindow.postMessage({ type: "elaborating-embed:theme", theme: theme }, APP);
      } else if (data.type === "elaborating-embed:open" && typeof data.url === "string" && data.url.indexOf(APP + "/") === 0) {
        openLink(data.url);
      }
      return;
    }
    if (event.source !== window.parent || !data || data.jsonrpc !== "2.0") return;
    if (data.method === undefined) {
      var waiting = pending[data.id];
      if (!waiting) return;
      delete pending[data.id];
      if (data.error) waiting.reject(data.error); else waiting.resolve(data.result);
      return;
    }
    if (data.method === "ui/notifications/tool-result") readMeta(data.params && data.params._meta);
    else if (data.method === "ui/notifications/host-context-changed") readContext(data.params);
    else if (data.id !== undefined) {
      if (data.method === "ping" || data.method === "ui/resource-teardown") post({ id: data.id, result: {} });
      else post({ id: data.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  // ChatGPT may set the result's _meta in its globals after the result.
  window.addEventListener("openai:set_globals", function () { readMeta(window.openai && window.openai.toolResponseMetadata); });

  function openLink(url) {
    request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
  }
  document.getElementById("open").onclick = function () { openLink(APP + ((shown || target()).replace(/^\/embed/, "") || "/")); };

  request("ui/initialize", {
    appInfo: { name: "elaborat.ing panel", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: "2026-01-26",
  }).then(function (result) {
    result = result || {};
    notify("ui/notifications/initialized");
    initialized = true;
    readMeta(window.openai && window.openai.toolResponseMetadata);
    readContext(result.hostContext);
    // A host that says which frames it allows, without the app's site, would block it.
    var csp = result.hostCapabilities && result.hostCapabilities.sandbox && result.hostCapabilities.sandbox.csp;
    if (csp && (!Array.isArray(csp.frameDomains) || !csp.frameDomains.some(function (domain) { try { return new URL(domain).origin === APP; } catch (error) { return false; } }))) {
      blocked = true;
      showFallback();
      return;
    }
    show();
  }, function () { initialized = true; show(); });
  window.addEventListener("resize", fit);
})();
`

export const PANEL_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>elaborat.ing</title>
<style>${STYLE}</style>
</head>
<body>
<iframe id="app" title="elaborat.ing" hidden></iframe>
<div id="fallback" hidden>
<p>elaborat.ing can't open in this panel.</p>
<button id="open" type="button">Open in elaborat.ing</button>
<details><summary>Details</summary>Origins to allow:<code id="origins"></code></details>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`

export function registerPanel(server: McpServer, { supabase }: ToolContext): void {
  server.registerResource(
    'panel_view',
    PANEL_VIEW_URI,
    {
      title: 'elaborat.ing',
      description: "The user's elaborat.ing projects beside the chat: the app itself, in a frame. Used by open_panel.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    () => ({ contents: [{ uri: PANEL_VIEW_URI, mimeType: MCP_APP_MIME_TYPE, text: PANEL_VIEW_HTML, _meta: PANEL_VIEW_META }] })
  )

  server.registerTool(
    'open_panel',
    {
      title: 'Projects',
      description:
        "Open elaborat.ing beside the chat: the user's projects, or one project or file in it, where they can read, edit and comment. " +
        'Changes saved by an agent show there as they happen. Use this when the user wants to work in elaborat.ing next to the chat. ' +
        'With no arguments it opens the projects list. To show one file in the chat instead, use show_file.',
      inputSchema: z
        .object({ project_id: projectId.optional(), path: path.optional() })
        .refine((input) => input.path === undefined || input.project_id !== undefined, {
          message: 'path needs project_id: give the project the file is in.',
          path: ['path'],
        }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      icons: [{ src: ICON, mimeType: 'image/svg+xml', sizes: ['any'] }],
      _meta: {
        ui: { resourceUri: PANEL_VIEW_URI, visibility: ['model', 'app'] },
        'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
        'openai/widgetAccessible': true,
      },
    },
    async ({ project_id, path: filePath }) => {
      try {
        let title = 'your projects'
        let appPath = '/'
        if (project_id) {
          const { data, error } = await supabase.from('projects').select('title').eq('id', project_id).maybeSingle()
          if (error) throw error
          if (!data) return errorResult('No such project for this account. Use list_projects to see the projects it has.')
          title = filePath ? `${filePath} in ${data.title}` : String(data.title)
          appPath = `/projects/${project_id}${filePath ? `/${encodePath(filePath)}` : ''}`
        }
        const url = `${APP_ORIGIN}${appPath}`
        return {
          content: [{ type: 'text', text: `Opened ${title} beside the chat.` }],
          structuredContent: { url },
          _meta: { [PANEL_META_KEY]: appPath === '/' ? '/embed' : `/embed${appPath}` },
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
