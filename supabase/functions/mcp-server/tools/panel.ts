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
// the view says so, with the origins to allow and a link to the site, and
// reports those origins to this server (panel_origins), which logs them, so
// nobody has to copy the line by hand; it reports them once more when the app
// did open, so the log holds the origin either way. Each
// page the view frames carries a one-time pass in its fragment (#pass=), minted
// here as the person (mint_panel_pass), which the app redeems before it shows
// any project: open_panel's result has one for the first page, and the view
// asks panel_pass for each one after. A pass is only ever in `_meta`, which
// reaches the view and not the model.
// https://github.com/openai/mcp-extensions/blob/main/docs/spec.md

/** Change the URI when the HTML changes: hosts cache the view by it. */
export const PANEL_VIEW_URI = 'ui://elaborating/panel-v3.html'
/**
 * Earlier names of the panel view. A host keeps the tool list it last read, so
 * it asks for the name that list carries until it refreshes; serving the
 * earlier names too means a rename never shows "App unavailable" meanwhile.
 * The content is always the current view.
 */
export const OLD_PANEL_VIEW_URIS = ['ui://elaborating/panel-v2.html', 'ui://elaborating/panel-v1.html']
/** The result `_meta` key holding the app's page to frame, such as /embed/projects/<id>. `_meta` reaches the view, not the model. */
export const PANEL_META_KEY = 'elaborat.ing/embed'
/** The result `_meta` key holding a one-time pass for the page the view frames. */
export const PANEL_PASS_KEY = 'elaborat.ing/pass'

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

/** At most this many origins in one panel_origins report: the view's own and the pages around it. */
export const PANEL_ORIGINS_MAX = 10

/** Whether `value` is exactly one https origin: scheme and host, no path, query, fragment or credentials. */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}

/** The view's origins line as the view sends it: https origins, one space apart, at most PANEL_ORIGINS_MAX. */
const originsLine = z
  .string()
  .max(PANEL_ORIGINS_MAX * 260)
  .refine((value) => {
    const list = value.split(' ')
    return list.length <= PANEL_ORIGINS_MAX && list.every(isHttpsOrigin)
  }, { message: `origins must be https origins (scheme and host only) separated by single spaces, at most ${PANEL_ORIGINS_MAX} of them.` })

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
  var PASS = /^[0-9a-f]{64}$/;
  var frame = document.getElementById("app");
  var fallback = document.getElementById("fallback");
  var nextId = 1, pending = {}, initialized = false, ready = false, readyTimer = null, serverTools = false;
  var theme = null, metaPath = null, deepPath = null, shown = null, blocked = false, inline = true, maxHeight = null;
  // The result's pass, for the first page; spent passes; which page load is current; whether it asked for a new pass.
  var metaPass = null, spent = {}, loads = 0, retried = false;
  // Whether the tool's result has arrived, or the view stopped waiting for it.
  var resultSeen = false, waitTimer = null;
  // Whether the view has told the server its origins: once for the fallback, once for the app opening.
  var reportedBlocked = false, reportedOk = false;

  function post(message) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ method: method, params: params || {} }); }
  function callTool(name, args) {
    var openai = window.openai;
    if (serverTools || !openai || typeof openai.callTool !== "function") return request("tools/call", { name: name, arguments: args });
    return openai.callTool(name, args);
  }

  // Where this view sits: its own origin, then the pages around it. The app's
  // site lets the view frame it once these are its allowed ancestors.
  function origins() {
    var list = [location.origin];
    var ancestors = location.ancestorOrigins;
    if (ancestors) for (var i = 0; i < ancestors.length; i++) list.push(ancestors[i]);
    else if (document.referrer) { try { list.push(new URL(document.referrer).origin); } catch (error) {} }
    return list.filter(function (origin, index) { return origin && origin !== "null" && list.indexOf(origin) === index; }).join(" ");
  }

  // Tell the server where the view sits, so its log holds the origins to allow (ok: the app opened here).
  function reportOrigins(ok) {
    var line = origins();
    if (!line) return;
    Promise.resolve().then(function () { return callTool("panel_origins", ok ? { origins: line, ok: true } : { origins: line }); }).catch(function () {});
  }
  function showFallback() {
    document.getElementById("origins").textContent = origins();
    fallback.hidden = false;
    frame.hidden = true;
    if (!reportedBlocked) { reportedBlocked = true; reportOrigins(false); }
  }

  // The page to frame: the tool's, unless it is only the projects; then the host's deep link; then the projects.
  function target() {
    if (metaPath && metaPath !== "/embed") return metaPath;
    return deepPath || metaPath || "/embed";
  }
  // A pass for the next page: the result's, once, then a new one from panel_pass (null when there is none).
  function takePass() {
    if (metaPass) {
      var pass = metaPass;
      metaPass = null;
      spent[pass] = true;
      return Promise.resolve(pass);
    }
    return Promise.resolve().then(function () { return callTool("panel_pass", {}); }).then(function (result) {
      var pass = result && result._meta && result._meta["elaborat.ing/pass"];
      return typeof pass === "string" && PASS.test(pass) ? pass : null;
    }, function () { return null; });
  }
  // Each page the view frames is a new frame, so even a page that differs only in its pass loads again.
  function load(url) {
    var next = frame.cloneNode(false);
    next.src = url;
    frame.parentNode.replaceChild(next, frame);
    frame = next;
  }
  // again: the app asked for a new pass, so the same page opens again with one.
  function show(again) {
    if (!initialized || blocked) return;
    // The result names the page and carries its pass: wait a moment for it before framing anything.
    if (!resultSeen) {
      if (!waitTimer) waitTimer = setTimeout(function () { resultSeen = true; show(); }, 2000);
      return;
    }
    var path = target();
    if (path === shown && !again) return;
    if (path !== shown) retried = false;
    shown = path;
    ready = false;
    clearTimeout(readyTimer);
    var current = ++loads;
    takePass().then(function (pass) {
      if (current !== loads) return;
      fallback.hidden = true;
      load(APP + path + (theme ? "?theme=" + encodeURIComponent(theme) : "") + (pass ? "#pass=" + pass : ""));
      frame.hidden = false;
      readyTimer = setTimeout(function () { if (!ready) showFallback(); }, 10000);
    });
  }

  function readMeta(meta) {
    if (!meta || typeof meta !== "object") return;
    var pass = meta["elaborat.ing/pass"];
    if (typeof pass === "string" && PASS.test(pass) && !spent[pass]) metaPass = pass;
    var value = meta["elaborat.ing/embed"];
    if (typeof value === "string" && EMBED_PATH.test(value)) metaPath = value;
    resultSeen = true;
    show();
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
        if (!reportedOk) { reportedOk = true; reportOrigins(true); }
      } else if (data.type === "elaborating-embed:open" && typeof data.url === "string" && data.url.indexOf(APP + "/") === 0) {
        openLink(data.url);
      } else if (data.type === "elaborating-embed:pass" && !retried) {
        // The page had no pass that works (one already used, say, when the chat shows the view again): one new one.
        retried = true;
        show(true);
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
    if (data.method === "ui/notifications/tool-result") readMeta((data.params && data.params._meta) || {});
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
    serverTools = !!(result.hostCapabilities && result.hostCapabilities.serverTools);
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
<p>elaborat.ing isn't switched on for this panel yet.</p>
<button id="open" type="button">Open in elaborat.ing</button>
<details><summary>Details</summary>Origins to allow:<code id="origins"></code></details>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`

export function registerPanel(server: McpServer, { supabase, userClaims }: ToolContext): void {
  /** A new one-time pass for the app in the panel, minted as the person. */
  const mintPass = async (): Promise<string> => {
    const { data, error } = await supabase.rpc('mint_panel_pass')
    if (error) throw error
    if (typeof data !== 'string' || !/^[0-9a-f]{64}$/.test(data)) throw new Error('No pass for the panel')
    return data
  }

  for (const [index, uri] of [PANEL_VIEW_URI, ...OLD_PANEL_VIEW_URIS].entries()) {
    server.registerResource(
      index === 0 ? 'panel_view' : `panel_view_${index}`,
      uri,
      {
        title: 'elaborat.ing',
        description: "The user's elaborat.ing projects beside the chat: the app itself, in a frame. Used by open_panel.",
        mimeType: MCP_APP_MIME_TYPE,
      },
      () => ({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: PANEL_VIEW_HTML, _meta: PANEL_VIEW_META }] })
    )
  }

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
          _meta: { [PANEL_META_KEY]: appPath === '/' ? '/embed' : `/embed${appPath}`, [PANEL_PASS_KEY]: await mintPass() },
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  // For the view only (the model never sees it): a new pass each time the
  // view frames a page after the first. It adds a short-lived row and changes
  // nothing of the person's, so it is neither read-only nor destructive.
  server.registerTool(
    'panel_pass',
    {
      title: 'Panel pass',
      description: 'Used by the Projects panel itself: a one-time pass that lets it open elaborat.ing. Not for use in a conversation.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: 'A new pass for the panel.' }], _meta: { [PANEL_PASS_KEY]: await mintPass() } }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  // For the view only: where it sits, as one log line of this function and
  // nothing else, so the origins to allow can be read from the logs instead of
  // copied from the panel. `ok` means the app did open there. Nothing is
  // stored, so it is not destructive; it is not read-only, since it logs.
  server.registerTool(
    'panel_origins',
    {
      title: 'Panel origins',
      description:
        'Used by the Projects panel itself: reports the origins the panel sits in, so the site can allow them. Not for use in a conversation.',
      inputSchema: z.object({ origins: originsLine, ok: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ origins, ok }) => {
      console.log(JSON.stringify({ event: ok ? 'panel_ok' : 'panel_origins', user: userClaims.id, origins }))
      return { content: [{ type: 'text', text: 'Noted.' }] }
    }
  )
}
