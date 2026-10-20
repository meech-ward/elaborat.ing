import { imageReferenceKey } from "./paths";

type Ast = {type:string;[key:string]:unknown};
/** Route only static intrinsic image calls through the trusted raster renderer. */
export function projectImagesPlugin(options: {modulePath?:string} = {}) {
  return (tree: unknown) => {
    const identifiers = new Set<string>();
    const names = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(names); return; }
      const node = value as Ast;
      if (node.type === 'Identifier') identifiers.add(String(node.name));
      for (const [key,child] of Object.entries(node)) if (!['loc','position','range'].includes(key)) names(child);
    };
    names(tree);
    let binding = '_projectImage';
    while (identifiers.has(binding)) binding += '_';
    let changed = false;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const node = value as Ast;
      const callee = node.callee as Ast | undefined;
      const args = node.arguments as Ast[] | undefined;
      if (node.type === "CallExpression" && callee?.type === "Identifier" && /^_jsx(?:s|DEV)?\d*$/.test(String(callee.name)) && args?.[0]?.type === "Literal" && args[0].value === "img" && args[1]?.type === "ObjectExpression") {
        const properties = args[1].properties as Ast[];
        const sources = properties.filter(property => {
          const key = property.key as Ast | undefined;
          return property.type === "Property" && !property.computed && (key?.name ?? key?.value) === "src";
        });
        const src = sources[0]?.value as Ast | undefined;
        if (sources.length === 1 && src?.type === "Literal" && typeof src.value === "string" && properties.every(property => property.type === "Property")) {
          args[0] = {type:'Identifier',name:binding};
          changed = true;
          src.value = imageReferenceKey(options.modulePath ?? null,src.value);
          delete src.raw;
        }
      }
      for (const [key,child] of Object.entries(node)) if (!["position","loc","range"].includes(key)) visit(child);
    };
    visit(tree);
    if (changed) {
      const body = (tree as Ast).body as Ast[];
      body.splice(body[0]?.directive ? 1 : 0,0,{type:'VariableDeclaration',kind:'const',declarations:[{
        type:'VariableDeclarator',id:{type:'Identifier',name:binding},
        init:{type:'MemberExpression',computed:false,object:{type:'MemberExpression',computed:true,object:{type:'Identifier',name:'arguments'},property:{type:'Literal',value:0}},property:{type:'Identifier',name:'projectImage'}},
      }]});
    }
  };
}
