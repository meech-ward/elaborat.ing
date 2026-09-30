// Temporary host capability probe, remove after testing.
//
// A separate MCP server at https://elaborat.ing/mcp-probe (the Worker passes
// it to this function), so the production server's tool list stays as it is.
// No sign-in, no database, no user data. It has one tool, probe_host, whose
// view opens from the host's sidebar (global entrypoint) or a conversation's
// panel (thread entrypoint) and reports what the host allows, and one MCP
// Events event, comment.created (events.ts). Every request writes one
// structured log line with its method, so a test can be read from the logs.
// https://github.com/openai/mcp-extensions/blob/main/docs/spec.md

import { createMcpHandler, McpServer, type ServerCapabilities } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { type EventsDeps, listEvents, log, subscribe, unsubscribe } from './events.ts'
import { MCP_APP_MIME_TYPE, PROBE_VIEW_HTML, PROBE_VIEW_META, PROBE_VIEW_URI } from './view.ts'

const INSTRUCTIONS =
  'A temporary test server for elaborat.ing. It has one tool, probe_host, which shows a panel reporting what this chat allows, ' +
  'and one event, comment.created, to test watching a project for comments. It reads and changes no data.'

/** A monochrome 20x20 icon for the entrypoints (a magnifier), drawn in the host's text colour. */
const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round">' +
      '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.2 12.2 17 17"/></svg>'
  )

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name',
}

/** Request `_meta` keys whose values are safe to show: client hints, never ids. */
const SHOWN_HINTS = ['openai/locale', 'openai/userAgent']

export function createProbeServer(deps: EventsDeps): McpServer {
  // `events` is not in the SDK's capability type yet; server/discover returns the capabilities as declared.
  const capabilities: ServerCapabilities & { events: Record<string, never> } = { events: {} }
  const server = new McpServer({ name: 'elaborat.ing probe', version: '1.0.0' }, { instructions: INSTRUCTIONS, capabilities })

  server.registerResource(
    'host_probe_view',
    PROBE_VIEW_URI,
    { title: 'Host probe', description: 'A temporary view that reports what the chat host allows.', mimeType: MCP_APP_MIME_TYPE },
    () => ({ contents: [{ uri: PROBE_VIEW_URI, mimeType: MCP_APP_MIME_TYPE, text: PROBE_VIEW_HTML, _meta: PROBE_VIEW_META }] })
  )

  server.registerTool(
    'probe_host',
    {
      title: 'Host probe',
      description:
        'Temporary test tool for elaborat.ing. Shows a panel that reports what this chat allows: host context, display mode, links, ' +
        'WebAssembly, workers, frames, fonts and embedding elaborat.ing. Use this when the user asks to run the elaborat.ing host probe.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      icons: [{ src: ICON, mimeType: 'image/svg+xml', sizes: ['any'] }],
      _meta: {
        ui: { resourceUri: PROBE_VIEW_URI, visibility: ['model', 'app'] },
        'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
        'openai/widgetAccessible': true,
      },
    },
    (_args, ctx) => {
      const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>
      const meta = (ctx.mcpReq._meta ?? {}) as Record<string, unknown>
      const report = {
        probe: 'elaborat.ing host probe',
        server_time: new Date().toISOString(),
        protocol_version: envelope['io.modelcontextprotocol/protocolVersion'] ?? 'legacy (initialize)',
        client_info: envelope['io.modelcontextprotocol/clientInfo'] ?? null,
        request_meta_keys: Object.keys(meta),
        hints: Object.fromEntries(SHOWN_HINTS.filter((key) => key in meta).map((key) => [key, meta[key]])),
      }
      log('tools/call', { tool: 'probe_host', protocol: report.protocol_version, metaKeys: report.request_meta_keys })
      return {
        content: [{ type: 'text', text: 'Showing the elaborat.ing host probe. It is a temporary test; the user reads its report.' }],
        structuredContent: report,
      }
    }
  )

  const anyParams = { params: z.optional(z.looseObject({})) }
  server.server.setRequestHandler('events/list', anyParams, () => listEvents())
  server.server.setRequestHandler('events/subscribe', anyParams, (params) => subscribe(params, deps))
  server.server.setRequestHandler('events/unsubscribe', anyParams, (params) => unsubscribe(params))
  return server
}

/** The method, protocol and client of a JSON-RPC body, for the log line; nothing else. */
async function describeRequest(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== 'POST') return { httpMethod: request.method }
  try {
    const body = await request.clone().json()
    const message = Array.isArray(body) ? body[0] : body
    const params = message?.params ?? {}
    const meta = params._meta ?? {}
    const client = meta['io.modelcontextprotocol/clientInfo'] ?? params.clientInfo
    return {
      method: message?.method ?? (message?.result !== undefined ? 'response' : 'unknown'),
      protocol: meta['io.modelcontextprotocol/protocolVersion'] ?? params.protocolVersion ?? request.headers.get('mcp-protocol-version'),
      client: client ? `${client.name ?? '?'} ${client.version ?? ''}`.trim() : null,
      userAgent: request.headers.get('user-agent'),
      batch: Array.isArray(body) ? body.length : undefined,
    }
  } catch {
    return { method: 'unparsed' }
  }
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function createProbeHandler(deps: EventsDeps): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(() => createProbeServer(deps), { onerror: (error) => console.error('MCP probe request failed', error) })
  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    const described = await describeRequest(request)
    log('request', described)
    // One message per request: a batch could make one request send many challenges. Protocol 2026-07-28 has no batches.
    if (described.batch !== undefined) {
      return withCors(Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } }, { status: 400 }))
    }
    return withCors(await handler.fetch(request))
  }
}
