import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { pipeline } from 'npm:@supabase/middleware@0.5.0'
import {
  withOAuthProtectedResource,
  withSupabase,
  type SupabaseContext,
} from 'npm:@supabase/server@1.6.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { postToCallback } from '../_shared/callbacks.ts'
import { EVENT_CAPABILITIES, type EventsContext, registerEvents } from './events.ts'
import { registerTools, type ToolContext } from './tools/index.ts'
import { limitToolCalls } from './tools/limits.ts'

// An MCP server as a single Supabase Edge Function, composed as a pipeline:
//
//   withOAuthProtectedResource  OAuth discovery for external MCP clients. Runs
//                               before the auth gate so unauthenticated clients
//                               can fetch the RFC 9728 metadata, and adds the
//                               WWW-Authenticate challenge to the gate's 401.
//   withSupabase                Verifies the user access token and builds an
//                               RLS-scoped client, so both embedded product
//                               agents and external OAuth clients act as the
//                               signed-in user.
//   handleMcp                   MCP transport and tools (./tools/index.ts),
//                               and MCP Events (./events.ts).
//
// On Supabase Edge Functions the public URLs in the OAuth metadata are derived
// automatically, locally and hosted. Off Edge Functions, pass `resourceServer`
// and `authorizationServer` to withOAuthProtectedResource.

function readTextEnv(name: string, fallback: string): string {
  return Deno.env.get(name)?.trim() || fallback
}

// A self-hosted copy can name and describe itself with these function secrets.
const SERVER_NAME = readTextEnv('MCP_SERVER_NAME', 'elaborat.ing')
const SERVER_DESCRIPTION = readTextEnv(
  'MCP_SERVER_DESCRIPTION',
  "Read, write and search the notes, drawings and diagrams in the user's elaborat.ing projects, and work through the comments people leave on them."
)

const SERVER_INSTRUCTIONS =
  `${SERVER_DESCRIPTION} ` +
  'Every tool acts as the signed-in user, with their access: only the projects they own or that are shared with them. ' +
  "Read a tool's description and annotations before calling it: some tools change files. " +
  // How elaborat.ing files are written, so what agents create renders in the app.
  'Projects hold notes, drawings and diagrams. Write new notes as MDX (.mdx): Markdown plus components. ' +
  'Embed a drawing with <Drawing src="path/to/file.excalidraw" /> and a diagram with <Diagram src="path/to/file.d2" />, ' +
  "using the file's path in the project; the file must exist, so create it first. " +
  'A drawing is an Excalidraw scene saved as .excalidraw JSON; a diagram is D2 source saved as .d2. ' +
  'Existing .md notes are plain Markdown: keep them as they are unless asked. To show a file to the user, use show_file; ' +
  'to show the user a component you are writing, use preview_component. ' +
  'When the user asks you to work through their comments, list_comments with ask_agent true finds the threads they asked ' +
  'an agent about: change each file, reply_comment with the version your save returned, and leave the thread for them to resolve.'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
}

function createServer(context: ToolContext, events: EventsContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, description: SERVER_DESCRIPTION, version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: EVENT_CAPABILITIES }
  )

  // Counts each tool call against the user's limit before the tool runs.
  limitToolCalls(server, context)
  registerTools(server, context)
  registerEvents(server, events)
  return server
}

// The Edge Runtime's built-in models, for the search tool. Its type file
// declares this global, but `deno check` does not apply global declarations
// from a remote module, so the one call used here is declared locally.
declare const Supabase: {
  ai: { Session: new (model: string) => { run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown> } }
}
const model = new Supabase.ai.Session('gte-small')
const embed = async (text: string) => (await model.run(text, { mean_pool: true, normalize: true })) as number[]

async function handleMcp(request: Request, ctx: SupabaseContext): Promise<Response> {
  // The server and its tools are bound to this caller for exactly one request.
  const clientId = ctx.jwtClaims?.client_id
  const admin: SupabaseClient = ctx.supabaseAdmin
  const handler = createMcpHandler(
    () =>
      createServer(
        {
          supabase: ctx.supabase,
          // auth: 'user' guarantees both claim shapes before this handler runs.
          userClaims: ctx.userClaims!,
          jwtClaims: ctx.jwtClaims!,
          embed,
        },
        {
          userId: ctx.userClaims!.id,
          clientId: typeof clientId === 'string' && clientId !== '' ? clientId : null,
          countCall: () => ctx.supabase.rpc('count_tool_call'),
          // A local change to the block: only the service role writes
          // subscriptions (events.sql), so one is saved only after this server
          // has checked the caller and heard its callback answer the challenge.
          rpc: (fn, args) => admin.rpc(fn, args),
          post: postToCallback,
        }
      ),
    { onerror: (error) => console.error('MCP request failed', error) }
  )

  return handler.fetch(request)
}

// The handler is passed inline so TypeScript infers its context from the entries.
// Passing `handleMcp` directly collapses the inferred context to `object`.
Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: 'user', cors: { headers: CORS_HEADERS } })],
    (request, ctx) => handleMcp(request, ctx)
  )
)
