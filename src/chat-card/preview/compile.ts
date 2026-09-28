/**
 * Compiles what the chat card previews, with the app's own pipeline: a note
 * and the component files it imports (`workspace:` specifiers), or the
 * components one component file exports. The server sends the sources
 * (show_file and preview_component put them in the result's `_meta`); the
 * card compiles them here into plain JavaScript, which is only text, and the
 * component preview's frame runs it as ordinary inline scripts
 * (frameDocument.ts). Nothing is evaluated from a string, so it runs under
 * the MCP Apps default policy, which has no 'unsafe-eval'.
 *
 * The module rules are the app's (componentModules.ts): the same imports,
 * reserved names, React allowlist and limits, so a preview here fails where
 * the app would, with the same message.
 */
import { compile } from "@mdx-js/mdx"
import remarkFrontmatter from "remark-frontmatter"
import remarkGfm from "remark-gfm"
import {
  componentModulePath,
  inspectComponentModule,
  prepareComponentEnvironment,
  workspaceImportPlugin,
  type ComponentSourceLoader,
} from "@/features/document/componentModules"
import { GUARD_NAME } from "./protocol"

/** The most components one preview of a component file shows. */
export const MAX_PREVIEW_ITEMS = 12

export type PreviewProgram = {
  /** Compiled component files, each after the files it imports. */
  modules: Array<{ path: string; code: string }>
  /** The note's compiled code; null for a component file. */
  note: string | null
  /** For a component file: the file and the components to show, with their props. */
  target: string | null
  items: Array<{ name: string; props: Record<string, unknown> }> | null
}

/** Reads component files from the sources the server sent. */
function loaderFor(sources: Record<string, string>): ComponentSourceLoader {
  return async (path) => {
    const text = sources[path]
    if (text === undefined) throw new Error(`No component file at ${path}.`)
    return { text, revision: "0" }
  }
}

type MdastNode = { type: string; name?: string | null; attributes?: unknown[]; children?: MdastNode[]; position?: unknown }

const isJsx = (node: MdastNode) => node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement"

/**
 * Wraps each outermost JSX element in the guard (GUARD_NAME), which the
 * frame provides: an error boundary that shows the element's error in its
 * place, so the rest of the note still shows. Elements inside another one
 * are left alone, because components such as Tabs and charts read their
 * children's types.
 */
export function guardPlugin() {
  const wrap = (node: MdastNode) => {
    if (!node.children) return
    node.children = node.children.map((child) => {
      if (!isJsx(child)) {
        wrap(child)
        return child
      }
      const attributes: unknown[] = [{ type: "mdxJsxAttribute", name: "name", value: child.name ?? "Fragment" }]
      if (child.type === "mdxJsxTextElement") attributes.push({ type: "mdxJsxAttribute", name: "inline", value: null })
      return { type: child.type, name: GUARD_NAME, attributes, children: [child], position: child.position }
    })
  }
  return (tree: unknown) => wrap(tree as MdastNode)
}

/**
 * A compile error as the card shows it: MDX's own words with the line they
 * are about, and plain words for the parse error of an import or export,
 * which MDX words after the parser it uses.
 */
export function compileErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // MDX's messages (VFileMessage) have a reason and a place; some browsers give every error a line in its script.
  const { line, reason, cause } = error as Error & { line?: unknown; reason?: unknown }
  if (typeof reason !== "string") return error.message
  let text = error.message
  if (text.startsWith("Could not parse import/exports with acorn")) {
    const detail = cause instanceof Error ? cause.message.replace(/\s*\(\d+:\d+\)$/, "") : ""
    text = `An import or export is not valid JavaScript${detail ? `: ${detail}` : ""}`
  }
  return typeof line === "number" ? `${text} (line ${line})` : text
}

/** A note and the component files it imports, compiled. */
export async function compileNote(source: string, sources: Record<string, string>): Promise<PreviewProgram> {
  const environment = await prepareComponentEnvironment(source, loaderFor(sources))
  let note: string
  try {
    note = String(
      await compile(source, {
        format: "mdx",
        outputFormat: "function-body",
        remarkPlugins: [remarkGfm, remarkFrontmatter, guardPlugin, workspaceImportPlugin],
      }),
    )
  } catch (error) {
    throw new Error(`Invalid MDX: ${compileErrorMessage(error)}`)
  }
  return { modules: environment.modules, note, target: null, items: null }
}

/**
 * The components a component file exports, compiled with the files it
 * imports: the one named, or each of them (up to MAX_PREVIEW_ITEMS), with
 * the props given or else the defaults its componentMeta declares.
 */
export async function compileComponents(
  path: string,
  sources: Record<string, string>,
  request: { component: string | null; props: Record<string, unknown> | null },
): Promise<PreviewProgram> {
  const specifier = `workspace:${path}`
  componentModulePath(specifier)
  const own = sources[path]
  if (own === undefined) throw new Error(`No component file at ${path}.`)
  const { definitions } = await inspectComponentModule(own)
  const chosen = request.component === null ? definitions.slice(0, MAX_PREVIEW_ITEMS) : definitions.filter((entry) => entry.name === request.component)
  if (chosen.length === 0) {
    throw new Error(
      request.component === null
        ? `${path} exports no components. Export one as a function, such as export function Name() {}.`
        : `${path} exports no component named ${request.component}.`,
    )
  }
  // The same import a note would write, so the file is checked and compiled as the app would.
  const importer = `import { ${chosen.map((entry) => entry.name).join(", ")} } from ${JSON.stringify(specifier)}\n`
  const environment = await prepareComponentEnvironment(importer, loaderFor(sources))
  const items = chosen.map((entry) => ({
    name: entry.name,
    props: request.props ?? Object.fromEntries(entry.props.map((prop) => [prop.name, prop.defaultValue])),
  }))
  return { modules: environment.modules, note: null, target: path, items }
}
