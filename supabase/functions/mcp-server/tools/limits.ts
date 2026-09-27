import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'

import { errorResult, LIMIT_ERROR_CODE } from './result.ts'
import type { ToolContext } from './types.ts'

// Every tool call counts against the user's agent tool calls a minute. The
// count and the limit live in the database (supabase/schemas/limits.sql), as
// every other per-user limit does. Over the limit, the call returns the
// database's message, which says when to try again, and the tool does not run.
// Any other failure to count lets the call through: the limit is there to stop
// runaway agents, not to take the server down with the counter, and the tool's
// own database calls still check everything else.
// Call this before registering the tools; it wraps each one as it is registered.
export function limitToolCalls(server: McpServer, { supabase }: ToolContext): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown
  const registerCounted = (name: unknown, config: unknown, callback: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => {
      const counted = await Promise.resolve(supabase.rpc('count_tool_call')).catch(() => null)
      if (counted?.error?.code === LIMIT_ERROR_CODE) return errorResult(counted.error.message)
      return await callback(...args)
    })
  server.registerTool = registerCounted as unknown as McpServer['registerTool']
}
