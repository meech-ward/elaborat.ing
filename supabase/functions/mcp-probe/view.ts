// Temporary host capability probe, remove after testing.
//
// The probe tool's MCP Apps view: a page the host frames that reports, on
// screen and as text to copy, what the host gives a view and what its frame
// allows. It speaks the MCP Apps bridge by hand (ui/initialize, then the
// tool-result and host-context notifications) and tries each capability once:
// WebAssembly, a Worker from a blob, a nested srcdoc frame, new Function, a
// font from the app's site, a link through the host, and elaborat.ing's
// /embed-probe page in a frame, which the site now refuses (X-Frame-Options
// DENY), so that row reads as blocked.
//
// It declares the same widget domain as the panel and the card
// (mcp-server/tools/panel.ts) and shows its own origin at the top, to test
// whether another server that claims the domain gets the panel's origin.
// https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

/** Change the URI when the HTML or its `_meta` changes: hosts cache the view by it. */
export const PROBE_VIEW_URI = 'ui://elaborating-probe/host-probe-v2.html'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
export const APP_ORIGIN = 'https://elaborat.ing'
/** A font the app's site serves with CORS (public/chat-card). */
export const PROBE_FONT_URL = `${APP_ORIGIN}/chat-card/space-grotesk-latin-BkCJBHb8.woff2`
export const EMBED_PROBE_URL = `${APP_ORIGIN}/embed-probe`

/**
 * The view's policy: fonts from the app's site, and the app's pages in a
 * frame. Its widget domain is the one the panel and the card declare, set the
 * same way (`openai/widgetDomain`, no `ui.domain`).
 */
export const PROBE_VIEW_META = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [APP_ORIGIN], frameDomains: [APP_ORIGIN] } },
  'openai/widgetCSP': { connect_domains: [], resource_domains: [APP_ORIGIN], frame_domains: [APP_ORIGIN], redirect_domains: [APP_ORIGIN] },
  'openai/widgetDomain': APP_ORIGIN,
  'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d2127; --muted: #5d6573; --bg: #ffffff; --line: #d9dde3; --ok: #1f7a3d; --bad: #b3261e; --wait: #8a6d00; }
:root[data-theme="dark"] { --fg: #e8eaee; --muted: #a2a9b6; --bg: #16191f; --line: #333944; --ok: #6fd08c; --bad: #ff8a80; --wait: #e5c34b; }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
h1 { font-size: 16px; margin: 0 0 4px; }
p { margin: 0 0 10px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
td { border-top: 1px solid var(--line); padding: 5px 6px; vertical-align: top; overflow-wrap: anywhere; }
td:first-child { width: 34%; color: var(--muted); }
.ok { color: var(--ok); } .bad { color: var(--bad); } .wait { color: var(--wait); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
textarea { width: 100%; height: 180px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
iframe.embed { width: 100%; height: 420px; border: 1px solid var(--line); border-radius: 8px; }
h2 { font-size: 14px; margin: 16px 0 6px; }
.origin { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
.origin strong { display: block; font-size: 24px; line-height: 1.25; overflow-wrap: anywhere; }
.origin p { margin: 4px 0 0; }
`

const SCRIPT = String.raw`
(function () {
  var APP = "https://elaborat.ing";
  var FONT_URL = document.body.dataset.font;
  var EMBED_URL = document.body.dataset.embed;
  var results = {};
  var order = [];
  var nextId = 1;
  var pending = {};
  var violations = [];

  function set(key, value, tone) {
    if (!(key in results)) order.push(key);
    results[key] = { value: String(value), tone: tone || "" };
    render();
  }
  function short(value) {
    try {
      return JSON.stringify(value, function (key, item) {
        return typeof item === "string" && item.length > 300 ? item.slice(0, 300) + "... (" + item.length + " chars)" : item;
      });
    } catch (error) { return String(value); }
  }
  function render() {
    var body = document.getElementById("results");
    body.textContent = "";
    var lines = [];
    order.forEach(function (key) {
      var row = document.createElement("tr");
      var name = document.createElement("td");
      var value = document.createElement("td");
      name.textContent = key;
      value.textContent = results[key].value;
      if (results[key].tone) value.className = results[key].tone;
      row.append(name, value);
      body.append(row);
      lines.push(key + ": " + results[key].value);
    });
    document.getElementById("report").value = "elaborat.ing host probe, " + new Date().toISOString() + "\n" + lines.join("\n");
  }

  function post(message) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ id: id, method: method, params: params });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error("no answer in 10 s")); } }, 10000);
    });
  }
  function notify(method, params) { post({ method: method, params: params || {} }); }
  function describeError(error) { return error && (error.message || error.name) ? (error.name ? error.name + ": " : "") + (error.message || "") : short(error); }

  function applyContext(context, label) {
    if (!context) return;
    if (context.theme) document.documentElement.dataset.theme = context.theme;
    set(label, short(context));
    if ("displayMode" in context) set("display mode", context.displayMode);
    if (context.availableDisplayModes) set("available display modes", short(context.availableDisplayModes));
    if ("openai/deepLink" in context) set("deep link (host context)", short(context["openai/deepLink"]));
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.origin === APP && data && data.type === "elaborating-embed-probe") {
      set("embed page", "reported from " + event.origin, "ok");
      set("embed report", short(data.report));
      return;
    }
    if (data && data.probe === "srcdoc") { srcdocAnswered(); return; }
    if (event.source !== window.parent || !data || data.jsonrpc !== "2.0") return;
    if (data.method === undefined) {
      var waiting = pending[data.id];
      if (!waiting) return;
      delete pending[data.id];
      if (data.error) waiting.reject(data.error); else waiting.resolve(data.result);
      return;
    }
    if (data.method === "ui/notifications/tool-result") set("tool result", short(data.params && (data.params.structuredContent || data.params)));
    else if (data.method === "ui/notifications/tool-input") set("tool input", short(data.params && data.params.arguments));
    else if (data.method === "ui/notifications/host-context-changed") applyContext(data.params, "host context (changed)");
    else if (data.id !== undefined) {
      if (data.method === "ping" || data.method === "ui/resource-teardown") post({ id: data.id, result: {} });
      else post({ id: data.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  document.addEventListener("securitypolicyviolation", function (event) {
    var blocked = event.blockedURI || "";
    try { blocked = blocked.indexOf(":") > 0 && blocked.indexOf("//") > 0 ? new URL(blocked).origin : blocked; } catch (error) {}
    violations.push(event.effectiveDirective + " " + blocked);
    set("CSP violations", violations.join(", "), "bad");
  });

  // The frame itself.
  document.getElementById("own-origin").textContent = location.origin;
  set("view origin", location.origin);
  set("referrer", document.referrer ? new URL(document.referrer).origin : "(none)");
  set("ancestor origins", location.ancestorOrigins ? Array.prototype.join.call(location.ancestorOrigins, ", ") || "(none)" : "not supported by this browser");
  set("user agent", navigator.userAgent);
  set("viewport", window.innerWidth + " x " + window.innerHeight);
  set("window.openai", window.openai ? Object.keys(window.openai).join(", ") : "absent");

  // The bridge.
  set("bridge", "waiting for ui/initialize", "wait");
  request("ui/initialize", {
    appInfo: { name: "elaborat.ing host probe", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: "2026-01-26",
  }).then(function (result) {
    result = result || {};
    set("bridge", "initialized, protocol " + (result.protocolVersion || "?"), "ok");
    set("host info", short(result.hostInfo));
    set("host capabilities", short(result.hostCapabilities));
    applyContext(result.hostContext, "host context");
    notify("ui/notifications/initialized");
    notify("ui/notifications/size-changed", { width: window.innerWidth, height: document.documentElement.scrollHeight });
  }, function (error) { set("bridge", "ui/initialize failed: " + describeError(error), "bad"); });

  // WebAssembly: an empty module, which a policy without wasm-unsafe-eval refuses to compile.
  try {
    WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(
      function () { set("WebAssembly", "works", "ok"); },
      function (error) { set("WebAssembly", "blocked: " + describeError(error), "bad"); });
  } catch (error) { set("WebAssembly", "blocked: " + describeError(error), "bad"); }

  // A Worker from a blob.
  try {
    var workerUrl = URL.createObjectURL(new Blob(["postMessage(6 * 7)"], { type: "text/javascript" }));
    var worker = new Worker(workerUrl);
    var workerTimer = setTimeout(function () { set("Worker (blob)", "no answer in 5 s", "bad"); worker.terminate(); }, 5000);
    worker.onmessage = function (event) { clearTimeout(workerTimer); set("Worker (blob)", event.data === 42 ? "works" : "odd answer", "ok"); worker.terminate(); };
    worker.onerror = function (event) { clearTimeout(workerTimer); set("Worker (blob)", "blocked: " + (event.message || "error"), "bad"); };
  } catch (error) { set("Worker (blob)", "blocked: " + describeError(error), "bad"); }

  // A nested srcdoc frame that runs a script.
  var srcdocDone = false;
  function srcdocAnswered() { if (!srcdocDone) { srcdocDone = true; set("nested srcdoc frame", "scripts run", "ok"); } }
  try {
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.display = "none";
    frame.srcdoc = "<script>parent.postMessage({ probe: 'srcdoc' }, '*')<\/script>";
    var loaded = false;
    frame.onload = function () { loaded = true; };
    document.body.append(frame);
    setTimeout(function () { if (!srcdocDone) set("nested srcdoc frame", loaded ? "loads, but its script did not run" : "blocked", "bad"); }, 5000);
  } catch (error) { set("nested srcdoc frame", "blocked: " + describeError(error), "bad"); }

  // new Function, which a policy without unsafe-eval refuses.
  try { set("new Function", new Function("return 6 * 7")() === 42 ? "works" : "odd answer", "ok"); }
  catch (error) { set("new Function", "blocked: " + describeError(error), "bad"); }

  // A font from the app's site.
  try {
    var face = new FontFace("ProbeFont", "url(" + JSON.stringify(FONT_URL) + ")");
    var fontTimer = setTimeout(function () { set("font from elaborat.ing", "no answer in 8 s", "bad"); }, 8000);
    face.load().then(function () { clearTimeout(fontTimer); document.fonts.add(face); set("font from elaborat.ing", "loads", "ok"); },
      function (error) { clearTimeout(fontTimer); set("font from elaborat.ing", "blocked: " + describeError(error), "bad"); });
  } catch (error) { set("font from elaborat.ing", "blocked: " + describeError(error), "bad"); }

  // The app's embed probe in a frame; it reports back with postMessage.
  set("embed page", "loading " + EMBED_URL, "wait");
  var embed = document.createElement("iframe");
  embed.className = "embed";
  embed.title = "elaborat.ing embed probe";
  embed.src = EMBED_URL;
  document.getElementById("embed").append(embed);
  setTimeout(function () { if (results["embed page"].tone === "wait") set("embed page", "no report in 15 s (blocked, or still loading)", "bad"); }, 15000);

  // Buttons.
  document.getElementById("open").onclick = function () {
    set("open link", "asked the host to open " + APP, "wait");
    request("ui/open-link", { url: APP + "/" }).then(
      function (result) { set("open link", "host answered " + short(result) + ". Did a tab or window open?", "ok"); },
      function (error) { set("open link", "host refused: " + describeError(error), "bad"); });
  };
  function askMode(mode) {
    request("ui/request-display-mode", { mode: mode }).then(
      function (result) { set("display mode request", mode + ": host answered " + short(result), "ok"); },
      function (error) { set("display mode request", mode + ": " + describeError(error), "bad"); });
  }
  document.getElementById("fullscreen").onclick = function () { askMode("fullscreen"); };
  document.getElementById("inline").onclick = function () { askMode("inline"); };
  document.getElementById("select").onclick = function () {
    var report = document.getElementById("report");
    report.focus();
    report.select();
    try { document.execCommand("copy"); } catch (error) {}
  };
  document.getElementById("reload").onclick = function () { location.reload(); };
  render();
})();
`

export const PROBE_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>elaborat.ing host probe</title>
<style>${STYLE}</style>
</head>
<body data-font="${PROBE_FONT_URL}" data-embed="${EMBED_PROBE_URL}">
<h1>Host probe</h1>
<p>A temporary test of what this chat allows. Copy the report below and send it back.</p>
<div class="origin">
<strong id="own-origin"></strong>
<p>If this matches the panel's origin, another app could claim it.</p>
</div>
<div class="row">
<button id="open" type="button">Open elaborat.ing</button>
<button id="fullscreen" type="button">Fullscreen</button>
<button id="inline" type="button">Inline</button>
<button id="reload" type="button">Reload view</button>
</div>
<table><tbody id="results"></tbody></table>
<h2>Report</h2>
<div class="row"><button id="select" type="button">Select report</button></div>
<textarea id="report" readonly aria-label="Report"></textarea>
<h2>elaborat.ing in a frame</h2>
<div id="embed"></div>
<script>${SCRIPT}</script>
</body>
</html>
`
