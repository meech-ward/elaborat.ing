import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'
import { jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

const categoryId = z.uuid().describe('A personal category id from list_project_categories.')
const categoryName = z.string().trim().min(1)
  .refine(name => [...name.normalize('NFC')].length <= 160, 'Category names can contain up to 160 characters.')
  .refine(name => !/[\u0000-\u001f\u007f-\u009f]/.test(name), 'Category names cannot contain control characters.')
  .describe('A category name of up to 160 characters, such as Video scripts. Active names are unique in the account.')

/** Organization belongs to the caller; these tools never change project access. */
export function registerProjectCategoryTools(server: McpServer, { supabase }: ToolContext): void {
  const rpc = async (name: string, args?: Record<string, unknown>, list = false): Promise<CallToolResult> => {
    try {
      const { data, error } = await supabase.rpc(name, args)
      if (error) throw error
      return jsonResult(list ? { categories: data } : data)
    } catch (error) {
      return runtimeErrorResult(error)
    }
  }

  server.registerTool('list_project_categories', {
    title: 'List project categories',
    description: 'List the user’s personal project categories, including archived ones. Each has id, name, archived_at and project_ids for projects the user can currently read. Categories organize the user’s own view and grant no access. A project can belong to several categories. Use list_projects for project titles and roles.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, () => rpc('list_project_categories', undefined, true))

  server.registerTool('create_project_category', {
    title: 'Create project category',
    description: 'Create a personal category, such as Video scripts. This does not move or share projects. Supply category_id when retrying a request with a lost response to reuse its identity.',
    inputSchema: z.object({ name: categoryName, category_id: categoryId.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ name, category_id }) => rpc('create_project_category', { category_id: category_id ?? crypto.randomUUID(), name }))

  server.registerTool('rename_project_category', {
    title: 'Rename project category',
    description: 'Rename one of the user’s personal categories. Project titles, contents and permissions stay the same.',
    inputSchema: z.object({ category_id: categoryId, name: categoryName }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, args => rpc('rename_project_category', args))

  server.registerTool('set_project_category_archived', {
    title: 'Archive or restore project category',
    description: 'Archive a personal category, or restore it with archived=false. Its projects and category assignments are preserved. This never archives or deletes projects, and there is no permanent category deletion tool.',
    inputSchema: z.object({ category_id: categoryId, archived: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, args => rpc('set_project_category_archived', args))

  server.registerTool('set_project_category_membership', {
    title: 'Add or remove project from category',
    description: 'Add a readable project to a personal category (included=true), or remove just that assignment (included=false). Other categories and the project itself stay the same. Works for shared, viewer and archived projects. Categories do not grant access or change collaborators’ organization.',
    inputSchema: z.object({ category_id: categoryId, project_id: z.uuid(), included: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, args => rpc('set_project_category_membership', args))

  server.registerTool('set_project_categories', {
    title: 'Set categories for project',
    description: 'Replace a readable project’s active personal category assignments atomically. Pass every category that should remain; an empty list makes it Uncategorized. Read list_project_categories first to preserve existing choices. Archived category assignments are retained. This does not change project contents or sharing.',
    inputSchema: z.object({ project_id: z.uuid(), category_ids: z.array(categoryId).max(128) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, args => rpc('set_project_categories', args, true))
}
