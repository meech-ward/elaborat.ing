/** Group only the portable, attribute-free figure tags our image authoring writes. */
type Node = {type:string;value?:unknown;name?:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}};[key:string]:unknown};
export function normalizeImageFigures(tree:unknown):void {
  const group = (parent:Node) => {
    const children = parent.children;
    if (!children) return;
    // CommonMark groups adjacent closing HTML tags into one node. Split
    // only a node made entirely of these known tags, keeping exact offsets.
    for (let index=0;index<children.length;index++) {
      const child = children[index];
      if (child.type !== 'html' || typeof child.value !== 'string' || !child.value.includes('\n')) continue;
      const lines = [...child.value.matchAll(/[^\r\n]+/g)];
      if (lines.length < 2 || !lines.every(line => /^\s*<\/?(?:figure|figcaption)>\s*$/.test(line[0]))) continue;
      const start = child.position?.start.offset;
      children.splice(index,1,...lines.map(line => ({type:'html',value:line[0],...(start === undefined ? {} : {position:{start:{offset:start+line.index},end:{offset:start+line.index+line[0].length}}})})));
      index += lines.length - 1;
    }
    for (let index=0;index<children.length;index++) {
      const opening = children[index];
      const match = opening.type === 'html' && typeof opening.value === 'string' ? /^\s*<(figure|figcaption)>\s*$/.exec(opening.value) : null;
      if (match) {
        let depth = 1, end = index + 1;
        for (;end<children.length;end++) {
          const child = children[end];
          if (child.type !== 'html' || typeof child.value !== 'string') continue;
          if (child.value.trim() === `<${match[1]}>`) depth++;
          if (child.value.trim() === `</${match[1]}>` && --depth === 0) break;
        }
        if (depth === 0) {
          const closing = children[end];
          const node:Node = {type:'mdxJsxFlowElement',name:match[1],attributes:[],children:children.slice(index+1,end),
            ...(opening.position && closing.position ? {position:{start:opening.position.start,end:closing.position.end}} : {})};
          children.splice(index,end-index+1,node);
        }
      }
      group(children[index]);
    }
  };
  group(tree as Node);
}
