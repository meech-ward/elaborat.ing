import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {encodeProseText,type DocumentFormat} from '../document';
import {imageMarkdown} from './paths';

type Node = {type:string;url?:string;value?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};
/** Keep inline Markdown formatting while making text literal in both Markdown and MDX. */
export function captionMarkdown(source:string,format:DocumentFormat):string {
  if (source.length > 4096) throw new Error('Captions can have up to 4,096 characters.');
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Node;
  if (tree.children?.length !== 1 || tree.children[0].type !== 'paragraph') throw new Error('Use one caption paragraph with bold, italics, links or code.');
  const patches:Array<{from:number;to:number;insert:string}> = [];
  const visit = (node:Node) => {
    if (!['paragraph','text','strong','emphasis','delete','inlineCode','link','break'].includes(node.type))
      throw new Error('Captions support text, bold, italics, links and code.');
    if (node.type === 'link' && (/^[a-z][a-z\d+.-]*:/i.test(node.url ?? '') && !/^(?:https?:|mailto:)/i.test(node.url ?? '') || /[\\\u0000-\u001f\u007f]/.test(node.url ?? ''))) throw new Error('Use a web, email or project link in the caption.');
    if (node.type === 'text') {
      const from = node.position?.start.offset,to = node.position?.end.offset;
      if (from === undefined || to === undefined) throw new Error('The caption could not be positioned.');
      patches.push({from,to,insert:encodeProseText(node.value ?? '',format)});
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree.children[0]);
  let result = source;
  for (const patch of patches.reverse()) result = result.slice(0,patch.from)+patch.insert+result.slice(patch.to);
  return result;
}
export function imageFigureMarkdown(src:string,alt:string,caption:string,format:DocumentFormat):string {
  return `<figure>\n\n${imageMarkdown(src,alt,format)}\n\n<figcaption>\n\n${captionMarkdown(caption,format)}\n\n</figcaption>\n</figure>`;
}
