import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'

import { registerCommentTools } from './comments.ts'
import { registerComponentPreview } from './componentPreview.ts'
import { registerFileView } from './fileView.ts'
import { registerProjectTools } from './projects.ts'
import { registerSearchTool } from './search.ts'
import type { ToolContext } from './types.ts'
import { registerWhoamiTool } from './whoami.ts'

export type { ToolContext } from './types.ts'

// The one composition point for this server. Add one registration call for
// each tool module; the MCP SDK rejects duplicate protocol tool names.
//
// Every tool states readOnlyHint, destructiveHint and openWorldHint. A tool
// that changes or removes anything (a file, a title, a thread's state, who
// has access) is destructive, even when it can be undone; only a tool that
// just adds is not. No tool reaches outside the user's own account, so
// openWorldHint is always false. annotations.test.ts holds the list.
export function registerTools(server: McpServer, context: ToolContext): void {
  registerWhoamiTool(server, context)
  registerProjectTools(server, context)
  registerSearchTool(server, context)
  registerFileView(server, context)
  registerComponentPreview(server, context)
  registerCommentTools(server, context)
}
