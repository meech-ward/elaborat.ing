import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { COMPONENTS_META_KEY, componentEditors, componentSources, sharedWithUser } from './componentSources.ts'
import { FILE_VIEW_URI, fileUrl, projectUrl } from './fileView.ts'
import { path, projectId } from './projects.ts'
import { errorResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// preview_component: the components a component file (.mdx) exports, shown
// to the user with sample props in the same MCP Apps view as show_file. An
// agent drafting a component passes its source to see it before saving it.
// The server only reads files: the view compiles the file and the files it
// imports with the app's rules and runs them in a sandboxed frame of its own
// (src/chat-card/preview/), and tells the model on its next turn when the
// preview failed or a component threw. In a project shared with the user the
// view asks before it runs saved files' code, as show_file's does for a note.

/** The longest draft previewed; a component file this big belongs in a save. */
const MAX_SOURCE = 200_000
/** The most characters of sample props, as JSON. */
const MAX_PROPS = 20_000

export function registerComponentPreview(server: McpServer, { supabase, userClaims }: ToolContext): void {
  server.registerTool(
    'preview_component',
    {
      title: 'Preview component',
      description:
        'Show the user a preview of the MDX components a component file (.mdx) exports, drawn with sample props in the chat as a card. ' +
        'To preview a draft before saving it, pass its source; it is not saved, and its workspace: imports come from the saved files. ' +
        'Name one component to show only it, and pass props to use instead of the defaults its componentMeta declares. ' +
        'Where the chat allows it, a preview that fails or a component that throws is reported to you on your next turn. ' +
        'Notes that use components are previewed by show_file.',
      inputSchema: z.object({
        project_id: projectId,
        path: path.describe('The component file, such as components/chart.mdx. With source, the path the draft is for.'),
        source: z.string().max(MAX_SOURCE).optional().describe('A draft of the file to preview instead of the saved one. It is not saved.'),
        component: z
          .string()
          .regex(/^[A-Z][A-Za-z0-9_]*$/)
          .optional()
          .describe('The one exported component to show. By default, each one the file exports.'),
        props: z.record(z.string(), z.unknown()).optional().describe('Sample props as JSON values, such as {"title": "Q3"}. By default, the componentMeta defaults.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: FILE_VIEW_URI } },
    },
    async ({ project_id, path, source, component, props }) => {
      try {
        if (!/\.mdx$/i.test(path)) return errorResult('Components live in .mdx files. Pass the path of one, such as components/chart.mdx.')
        if (props && JSON.stringify(props).length > MAX_PROPS) return errorResult(`The props are longer than ${MAX_PROPS} characters as JSON. Pass smaller samples.`)
        const { data, error } = await supabase
          .from('project_files')
          .select('path, content, version, updated_at')
          .eq('project_id', project_id)
          .eq('path', path)
          .maybeSingle()
        if (error) throw error
        if (!data && source === undefined) return errorResult(`No file at ${path} in this project. Pass source to preview a draft.`)
        const draft = source !== undefined
        const own = source ?? String(data?.content ?? '')
        const modules = await componentSources(supabase, project_id, own, { [path]: own })
        const shared = await sharedWithUser(supabase, project_id, userClaims?.id)
        const editors = shared ? await componentEditors(supabase, project_id, Object.keys(modules), userClaims?.id) : null
        const what = component ? `${component} from ${path}` : `the components in ${path}`
        const which = draft ? 'a draft, not saved' : `version ${data?.version}`
        return {
          content: [{ type: 'text', text: `Showing a preview of ${what} (${which}) to the user.` }],
          structuredContent: {
            project_id,
            path,
            kind: 'component',
            version: data?.version ?? null,
            updated_at: data?.updated_at ?? null,
            url: data ? fileUrl(project_id, path) : projectUrl(project_id),
            truncated: false,
            embeds: [],
            draft,
            component: component ?? null,
            props: props ?? null,
            shared,
          },
          // The sources reach the view, not the model.
          _meta: { [COMPONENTS_META_KEY]: { modules, ...(editors ? { editors } : {}) } },
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
