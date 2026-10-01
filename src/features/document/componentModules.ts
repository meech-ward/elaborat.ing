import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { z } from 'zod/mini';
import { en } from 'zod/locales';
import { COMPONENT_CATALOG, type ComponentDefinition } from './componentCatalog';
import { isTrustedReactExport } from './trustedReactImports';
import type { ComponentSourceLoader } from './componentSource';

// Kept apart so the workbench reads component files without loading the MDX compiler.
export { savedComponentSource, type ComponentSourceLoader } from './componentSource';

const identifier = /^[A-Z][A-Za-z0-9_]*$/;
const reserved = new Set([...COMPONENT_CATALOG.map(c => c.name), 'SourceText', 'SourceCode', 'SourceBlock', 'FluidIsland', 'CustomControls']);
const propSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string().check(z.maxLength(4096)), z.number(), z.boolean()]),
  description: z.optional(z.string().check(z.maxLength(1024))),
  choices: z.optional(z.array(z.string().check(z.maxLength(256))).check(z.minLength(1), z.maxLength(32))),
}).check(z.refine(p => typeof p.default === p.type && (!p.choices || p.type === 'string' && p.choices.includes(String(p.default))), 'Default/choices must match the prop type'));
const metadataSchema = z.record(z.string().check(z.regex(identifier)), z.strictObject({
  description: z.optional(z.string().check(z.maxLength(1024))),
  props: z.optional(z.record(z.string().check(z.regex(/^[a-zA-Z][\w]*$/), z.refine(n => !['children','key','ref','__slot'].includes(n))), propSchema).check(z.refine(p => Object.keys(p).length <= 24))),
})).check(z.refine(m => Object.keys(m).length <= 64));
/** Zod's English messages, which a metadata error quotes (zod/mini has none of its own). */
const english = { error: en().localeError };

// Parser-owned ESTree is inspected as data, never evaluated in the parent.
type Node = { type: string; [key: string]: unknown };
type ImportBinding = { path: string; imported: string; local: string };
export interface ComponentEnvironment {
  source: string;
  catalog: readonly ComponentDefinition[];
  /** Topologically ordered; code executes exclusively in the opaque frame. */
  modules: Array<{ path: string; code: string }>;
  key: string;
  /**
   * The custom code the note runs, as written: each imported file's imports
   * and exports, and the note's own (path null) when it exports anything or
   * its text has an expression that does more than state a value. Empty when
   * the note uses only built-in components and literal values.
   */
  code: Array<{ path: string | null; esm: string }>;
}

function node(value: unknown): Node {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid component syntax');
  return value as Node;
}
function walk(value: unknown, visitor: (n: Node) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const child of value) walk(child,visitor); return; }
  if ('type' in value) visitor(value as Node);
  for (const [key, child] of Object.entries(value)) if (!['position','loc','range'].includes(key)) walk(child,visitor);
}
const EXPRESSIONS = new Set(['mdxFlowExpression','mdxTextExpression','mdxJsxAttributeValueExpression','mdxJsxExpressionAttribute']);
/** Whether an expression only states a value: a comment, or literal data such as {2}, {"a"} or {[1, 2]}. */
function statesValue(expression: Node): boolean {
  const estree = (expression.data as {estree?: unknown} | undefined)?.estree;
  if (!estree) return String(expression.value ?? '').trim() === '';
  const body = node(estree).body as unknown[];
  if (body.length === 0) return true;
  if (body.length !== 1 || node(body[0]).type !== 'ExpressionStatement') return false;
  const value = node(node(body[0]).expression);
  if (value.type === 'TemplateLiteral') return (value.expressions as unknown[]).length === 0;
  try { literal(value); return true; } catch { return false; }
}
function literal(value: unknown): unknown {
  const n = node(value);
  if (n.type === 'Literal') return n.value;
  if (n.type === 'UnaryExpression' && n.operator === '-' && node(n.argument).type === 'Literal' && typeof node(n.argument).value === 'number') return -(node(n.argument).value as number);
  if (n.type === 'ArrayExpression') return (n.elements as unknown[]).map(literal);
  if (n.type === 'ObjectExpression') {
    const out: Record<string,unknown> = Object.create(null);
    for (const item of n.properties as unknown[]) {
      const p = node(item), key = node(p.key);
      if (p.type !== 'Property' || p.computed || p.method || p.kind !== 'init') throw new Error('Component metadata must be literal data');
      const name = key.type === 'Identifier' ? String(key.name) : String(key.value);
      if (Object.hasOwn(out,name) || ['__proto__','constructor','prototype'].includes(name)) throw new Error('Duplicate or reserved metadata key');
      out[name] = literal(p.value);
    }
    return out;
  }
  throw new Error('Component metadata must be literal data');
}
export function componentModulePath(specifier: string): string {
  if (!specifier.startsWith('workspace:')) throw new Error('Only named workspace: MDX component imports are supported');
  const path = specifier.slice(10);
  // A workspace: specifier carries a raw canonical identity, not a URL.
  // Storage must resolve it as a raw identity: %, ? and # stay literal.
  if (path.length > 512 || !/\.mdx$/i.test(path) || /[\\:\u0000-\u001f\u007f]/.test(path) || path.split('/').some(s => !s || s.startsWith('.'))) throw new Error('Unsafe workspace component path');
  return path;
}
function snippetEscape(value: string): string { return value.replace(/[\\$}]/g,'\\$&'); }
function reactImportProperties(n: Node) {
  const specs = n.specifiers as unknown[];
  if (!specs.length) throw new Error('React imports require allowlisted named exports');
  return specs.map(item => {
    const spec = node(item);
    if (spec.type !== 'ImportSpecifier') throw new Error('React imports require allowlisted named exports');
    const imported = node(spec.imported), local = node(spec.local);
    if (imported.type !== 'Identifier' || !isTrustedReactExport(String(imported.name))) throw new Error(`Unsupported React export ${String(imported.name ?? imported.value)}`);
    if (local.type !== 'Identifier' || reserved.has(String(local.name))) throw new Error('Invalid or reserved React import alias');
    return {type:'Property',kind:'init',method:false,shorthand:false,computed:false,key:imported,value:local};
  });
}
function definition(name: string, data?: z.infer<typeof metadataSchema>[string]): ComponentDefinition {
  const props = Object.entries(data?.props ?? {}).map(([name,p]) => ({name,type:p.type,defaultValue:p.default,description:p.description ?? name,choices:p.choices}));
  const attrs = props.map(p => ` ${p.name}=${p.type === 'string' ? '"'+String(p.defaultValue).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'"' : '{'+String(p.defaultValue)+'}'}`).join('');
  const template = `<${name}${attrs} />`;
  return {name,description:data?.description ?? `${name} (custom component)`,props,template,snippet:snippetEscape(template)+'$0',editableProps:props.length > 0};
}

export async function inspectComponentModule(source: string): Promise<{definitions: ComponentDefinition[]; imports: ImportBinding[]; esm: string; exports: boolean; expressions: string[]}> {
  const names = new Set<string>(), imports: ImportBinding[] = [], esm: string[] = [], expressions: string[] = [];
  let metadata: unknown = {}, exports = false;
  await compile(source, {format:'mdx',outputFormat:'function-body',remarkPlugins:[remarkFrontmatter,remarkGfm,() => (tree: unknown) => {
    walk(tree,n => {
      if (n.type === 'mdxjsEsm') esm.push(String(n.value));
      if (EXPRESSIONS.has(n.type) && !statesValue(n)) expressions.push(String(n.value));
      if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') exports = true;
      if (n.type === 'ImportExpression') throw new Error('Dynamic imports are unavailable in components');
      if (n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration' && n.source) throw new Error('Re-exports are unavailable in component modules');
      if (n.type === 'ImportDeclaration') {
        if (node(n.source).value === 'react') { reactImportProperties(n); return; }
        const path = componentModulePath(String(node(n.source).value));
        const specs = n.specifiers as unknown[];
        if (!specs.length) throw new Error('Component imports require named exports');
        for (const item of specs) {
          const spec = node(item);
          if (spec.type !== 'ImportSpecifier') throw new Error('Component imports require named exports');
          const imported = String(node(spec.imported).name), local = String(node(spec.local).name);
          if (!identifier.test(imported) || !identifier.test(local) || reserved.has(local)) throw new Error('Invalid or reserved component import name');
          imports.push({path,imported,local});
        }
      }
      if (n.type !== 'ExportNamedDeclaration' || !n.declaration) return;
      const d = node(n.declaration);
      if (d.type === 'FunctionDeclaration') names.add(String(node(d.id).name));
      if (d.type === 'VariableDeclaration') for (const item of d.declarations as unknown[]) {
        const declaration = node(item);
        if (node(declaration.id).type !== 'Identifier') continue;
        const name = String(node(declaration.id).name);
        if (name === 'componentMeta') metadata = literal(declaration.init);
        if (declaration.init && ['ArrowFunctionExpression','FunctionExpression'].includes(node(declaration.init).type)) names.add(name);
      }
    });
  }]});
  const parsed = metadataSchema.safeParse(metadata, english);
  if (!parsed.success) throw new Error(`Invalid component metadata: ${parsed.error.message}`);
  for (const name of Object.keys(parsed.data)) if (!names.has(name)) throw new Error(`Component metadata names missing local export ${name}`);
  const definitions = [...names].filter(name => identifier.test(name)).map(name => {
    if (reserved.has(name)) throw new Error(`Component name ${name} is reserved`);
    return definition(name,parsed.data[name]);
  });
  return {definitions,imports,esm:esm.join('\n'),exports,expressions};
}

/** Replace only parser-proven imports. Source bytes/ranges are never rewritten. */
export function workspaceImportPlugin() {
  return (tree: unknown) => walk(tree,n => {
    if (n.type !== 'ImportDeclaration') return;
    if (node(n.source).value === 'react') {
      const properties = reactImportProperties(n);
      for (const key of Object.keys(n)) delete n[key];
      Object.assign(n,{type:'VariableDeclaration',kind:'const',declarations:[{type:'VariableDeclarator',id:{type:'ObjectPattern',properties},init:{type:'MemberExpression',computed:false,object:{type:'MemberExpression',computed:true,object:{type:'Identifier',name:'arguments'},property:{type:'Literal',value:0}},property:{type:'Identifier',name:'trustedReact'}}}]});
      return;
    }
    const path = componentModulePath(String(node(n.source).value));
    const properties = (n.specifiers as unknown[]).map(item => {
      const spec = node(item);
      if (spec.type !== 'ImportSpecifier') throw new Error('Only named component imports are supported');
      return {type:'Property',kind:'init',method:false,shorthand:false,computed:false,key:spec.imported,value:spec.local};
    });
    for (const key of Object.keys(n)) delete n[key];
    Object.assign(n,{type:'VariableDeclaration',kind:'const',declarations:[{type:'VariableDeclarator',id:{type:'ObjectPattern',properties},init:{type:'MemberExpression',computed:true,object:{type:'MemberExpression',computed:false,object:{type:'MemberExpression',computed:true,object:{type:'Identifier',name:'arguments'},property:{type:'Literal',value:0}},property:{type:'Identifier',name:'workspaceModules'}},property:{type:'Literal',value:path}}}]});
  });
}

export async function prepareComponentEnvironment(source: string, load?: ComponentSourceLoader): Promise<ComponentEnvironment> {
  const size = (text: string) => new TextEncoder().encode(text).byteLength;
  let bytes = size(source);
  if (bytes > 2 * 1024 * 1024) throw new Error('Component source graph exceeds 2 MiB');
  const root = await inspectComponentModule(source);
  const modules: ComponentEnvironment['modules'] = [], loaded = new Map<string,ComponentDefinition[]>(), visiting = new Set<string>();
  const versions: string[] = [];
  // The note's own code: its imports and exports, and the expressions in its text that run code.
  const code: ComponentEnvironment['code'] = root.exports || root.expressions.length > 0 ? [{path:null,esm:[root.esm,...root.expressions].join('\n')}] : [];
  const resolve = async (bindings: ImportBinding[], depth: number): Promise<ComponentDefinition[]> => {
    if (depth > 8) throw new Error('Component dependency depth exceeds 8');
    const definitions: ComponentDefinition[] = [];
    for (const binding of bindings) {
      if (visiting.has(binding.path)) throw new Error(`Component import cycle at ${binding.path}`);
      let exports = loaded.get(binding.path);
      if (!exports) {
        if (!load) throw new Error('Workspace component imports require a workspace file backend');
        if (loaded.size + visiting.size >= 32) throw new Error('Component dependency count exceeds 32');
        visiting.add(binding.path);
        const file = await load(binding.path);
        bytes += size(file.text);
        if (bytes > 2 * 1024 * 1024) throw new Error('Component source graph exceeds 2 MiB');
        const info = await inspectComponentModule(file.text);
        await resolve(info.imports,depth+1);
        const compiled = String(await compile(file.text,{format:'mdx',outputFormat:'function-body',remarkPlugins:[remarkFrontmatter,remarkGfm,workspaceImportPlugin]}));
        exports = info.definitions;
        loaded.set(binding.path,exports);
        modules.push({path:binding.path,code:compiled});
        code.push({path:binding.path,esm:info.esm});
        versions.push(binding.path+'\0'+file.revision+'\0'+file.text);
        visiting.delete(binding.path);
      }
      const imported = exports.find(d => d.name === binding.imported);
      if (!imported) throw new Error(`Missing component export ${binding.imported} in ${binding.path}`);
      definitions.push({...imported,name:binding.local,template:imported.template.replace(`<${imported.name}`,`<${binding.local}`),snippet:imported.snippet.replace(`<${imported.name}`,`<${binding.local}`)});
    }
    return definitions;
  };
  const custom = [...root.definitions,...await resolve(root.imports,0)];
  if (custom.length > 64) throw new Error('A note supports at most 64 custom components');
  if (new Set(custom.map(c => c.name)).size !== custom.length) throw new Error('Duplicate component binding');
  // Exact version material is an internal key, never an authorization token.
  return {source,catalog:[...COMPONENT_CATALOG,...custom],modules,key:versions.join('\0'),code};
}
