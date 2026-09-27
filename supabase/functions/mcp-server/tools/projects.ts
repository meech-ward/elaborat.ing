import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { errorResult, jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Tools for working in the signed-in user's projects. Every call goes through
// the database functions the app itself uses, as this user, so RLS and the
// database's rules apply: agents can archive a project but never permanently
// delete one, and cannot accept invitations on the user's behalf.

export const projectId = z.uuid().describe('The project id, from list_projects.')
export const path = z
  .string()
  .min(1)
  .describe('A path inside the project, such as notes/plan.md. No leading slash.')
const baseVersion = z
  .number()
  .int()
  .positive()
  .describe('The file version you last read. Saving fails with a conflict if the file changed since.')
const mutationId = z
  .uuid()
  .optional()
  .describe('Optional id for this change. Repeat it when retrying, so the change is never applied twice.')

type Rpc = (name: string, args?: Record<string, unknown>, listKey?: string) => Promise<CallToolResult>

// MCP structured results must be objects, so list results are wrapped under a key.
function rpcCaller({ supabase }: ToolContext): Rpc {
  return async (name, args, listKey) => {
    try {
      const { data, error } = await supabase.rpc(name, args)
      if (error) throw error
      return jsonResult(listKey ? { [listKey]: data } : data)
    } catch (error) {
      return runtimeErrorResult(error)
    }
  }
}

export function registerProjectTools(server: McpServer, context: ToolContext): void {
  const rpc = rpcCaller(context)
  const { supabase } = context

  const save = (id: string, changes: unknown[], mutation?: string) =>
    rpc('save_files', {
      project_id: id,
      mutation_id: mutation ?? crypto.randomUUID(),
      changes,
    })

  server.registerTool(
    'list_projects',
    {
      description:
        "List the projects the user can read: their own and ones shared with them. Each has an id, title, revision, archived_at and the user's role.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => rpc('list_projects', undefined, 'projects')
  )

  server.registerTool(
    'list_files',
    {
      description:
        'List the files and folders in a project, with each file version. Does not return file contents; use read_file for that.',
      inputSchema: z.object({ project_id: projectId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project_id }) => {
      try {
        const [files, folders] = await Promise.all([
          supabase
            .from('project_files')
            .select('path, version, updated_at')
            .eq('project_id', project_id)
            .order('path'),
          supabase.from('project_folders').select('path').eq('project_id', project_id).order('path'),
        ])
        if (files.error) throw files.error
        if (folders.error) throw folders.error
        return jsonResult({
          files: files.data,
          folders: folders.data.map((folder) => folder.path),
        })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'read_file',
    {
      description:
        'Read one file: its content and its version. Pass the version as base_version when you save changes to it.',
      inputSchema: z.object({ project_id: projectId, path }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project_id, path }) => {
      try {
        const { data, error } = await supabase
          .from('project_files')
          .select('path, content, version, updated_at')
          .eq('project_id', project_id)
          .eq('path', path)
          .maybeSingle()
        if (error) throw error
        if (!data) return errorResult(`No file at ${path} in this project. Use list_files to see what exists.`)
        return jsonResult(data)
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'create_project',
    {
      description: 'Create a new project owned by the user.',
      inputSchema: z.object({ title: z.string().min(1).max(160).describe('The project title.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ title }) => rpc('create_project', { project_id: crypto.randomUUID(), title })
  )

  server.registerTool(
    'rename_project',
    {
      description: 'Change a project title. Needs editor access.',
      inputSchema: z.object({ project_id: projectId, title: z.string().min(1).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, title }) => rpc('rename_project', { project_id, title })
  )

  server.registerTool(
    'write_file',
    {
      description:
        'Create or replace one file. To create a new file, omit base_version. To change an existing file, pass the version you read. ' +
        'If the result status is "conflict", someone changed the file first: read it again, merge, and retry. ' +
        'New notes are .mdx; embed drawings and diagrams with <Drawing src="..." /> and <Diagram src="..." /> (see the server instructions).',
      inputSchema: z.object({
        project_id: projectId,
        path,
        content: z.string().describe('The complete new file content.'),
        base_version: baseVersion.optional(),
        mutation_id: mutationId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, path, content, base_version, mutation_id }) =>
      save(project_id, [{ op: 'put', path, content, base_version }], mutation_id)
  )

  server.registerTool(
    'save_files',
    {
      description:
        'Apply several changes to a project at once. Either every change is saved or none is. ' +
        'Each change is {"op":"put","path","content","base_version"?}, {"op":"delete","path","base_version"}, ' +
        '{"op":"move","path","to","base_version"}, {"op":"mkdir","path"} or {"op":"rmdir","path"}. ' +
        'Use this to keep related files consistent, such as a D2 diagram and its generated canvas.',
      inputSchema: z.object({
        project_id: projectId,
        changes: z
          .array(
            z.discriminatedUnion('op', [
              z.object({ op: z.literal('put'), path, content: z.string(), base_version: baseVersion.optional() }),
              z.object({ op: z.literal('delete'), path, base_version: baseVersion }),
              z.object({ op: z.literal('move'), path, to: path, base_version: baseVersion }),
              z.object({ op: z.literal('mkdir'), path }),
              z.object({ op: z.literal('rmdir'), path }),
            ])
          )
          .min(1)
          .max(4096),
        mutation_id: mutationId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, changes, mutation_id }) => save(project_id, changes, mutation_id)
  )

  server.registerTool(
    'move_file',
    {
      description: 'Move or rename a file. Pass the version you read.',
      inputSchema: z.object({ project_id: projectId, path, to: path, base_version: baseVersion, mutation_id: mutationId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, path, to, base_version, mutation_id }) =>
      save(project_id, [{ op: 'move', path, to, base_version }], mutation_id)
  )

  server.registerTool(
    'delete_file',
    {
      description:
        "Delete a file. Its history is kept, so a person can restore it. Pass the version you read.",
      inputSchema: z.object({ project_id: projectId, path, base_version: baseVersion, mutation_id: mutationId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, path, base_version, mutation_id }) =>
      save(project_id, [{ op: 'delete', path, base_version }], mutation_id)
  )

  server.registerTool(
    'create_folder',
    {
      description: 'Create an empty folder. Folders that contain files exist without this.',
      inputSchema: z.object({ project_id: projectId, path, mutation_id: mutationId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, path, mutation_id }) => save(project_id, [{ op: 'mkdir', path }], mutation_id)
  )

  server.registerTool(
    'archive_project',
    {
      description:
        'Archive a project, making it read-only until unarchived. This is how an agent removes a project; only the user can permanently delete one, in the app.',
      inputSchema: z.object({ project_id: projectId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id }) => rpc('archive_project', { project_id })
  )

  server.registerTool(
    'unarchive_project',
    {
      description: 'Unarchive a project so it can be changed again.',
      inputSchema: z.object({ project_id: projectId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id }) => rpc('unarchive_project', { project_id })
  )

  server.registerTool(
    'share_project',
    {
      description:
        "Invite another account to one of the user's own projects, change their role, or remove them (role null). " +
        'An invitation grants nothing until that person accepts it in the app.',
      inputSchema: z.object({
        project_id: projectId,
        member_id: z.uuid().describe("The other person's account id."),
        role: z.enum(['viewer', 'commenter', 'editor']).nullable().describe('null removes them.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ project_id, member_id, role }) =>
      rpc('share_project', { project_id, member_id, member_role: role })
  )

  server.registerTool(
    'list_members',
    {
      description:
        'List who a project is shared with: its owner first, then the members, each with user_id, email, role, invited_at and accepted_at. ' +
        'The owner also sees invitations not yet accepted (accepted_at null). Use a user_id with share_project to change a role.',
      inputSchema: z.object({ project_id: projectId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ project_id }) => rpc('list_members', { project_id }, 'members')
  )

  server.registerTool(
    'list_invitations',
    {
      description:
        'List projects other people have invited the user to. Only the user can accept an invitation, in the app.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => rpc('list_invitations', undefined, 'invitations')
  )

  server.registerTool(
    'leave_project',
    {
      description: 'Leave a project shared with the user, or decline an invitation to it.',
      inputSchema: z.object({ project_id: projectId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ project_id }) => rpc('leave_project', { project_id })
  )
}
