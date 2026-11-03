import {MAX_NOTION_SNAPSHOT_HTML_BYTES} from '../features/rendered/protocol';

const OMIT = new Set(['script','style','link','meta','base','iframe','object','embed','input','textarea','select','option','dialog','template','noscript']);
const OMIT_ROLES = new Set(['menu','menubar','dialog','alertdialog','toolbar','tooltip','listbox','combobox']);
const CHROME = new Set(['custom-component-controls','document-code-actions','project-image-actions','callout-controls','authoring-prop-control','authoring-insert','authoring-actions','authoring-block-menu']);
const HTML = new Set(['p','div','span','h1','h2','h3','h4','h5','h6','section','article','aside','main','header','footer','blockquote','pre','code','br','hr','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','a','strong','b','em','i','u','s','del','mark','small','sub','sup','abbr','details','summary','figure','figcaption','img','dl','dt','dd']);
const SVG = new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','clippath','lineargradient','radialgradient','stop','pattern','mask','use','image','title','desc']);
const VOID = new Set(['br','hr','img']);
const ATTRS = new Set(['alt','title','width','height','colspan','rowspan','start','reversed','type','scope','open','dir','lang']);
const SVG_ATTRS = new Set(['xmlns','viewbox','d','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','points','fill','fill-opacity','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-opacity','opacity','transform','preserveaspectratio','text-anchor','dominant-baseline','offset','stop-color','stop-opacity','gradientunits','gradienttransform','patternunits','patterntransform','clippathunits','maskunits','maskcontentunits','id','clip-path','mask']);
const STYLE_PROPERTIES = new Set(['color','background-color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','white-space','border','border-top','border-bottom','border-left','border-right','border-color','border-width','border-style','border-radius','padding','padding-top','padding-bottom','padding-left','padding-right','margin','margin-top','margin-bottom','margin-left','margin-right','display','gap','flex-direction','align-items','justify-content','grid-template-columns','width','height','max-width','min-width','vertical-align','fill','stroke','stroke-width']);
const escape = (text: string) => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function safeStyle(style: string): string {
  return style.split(';').flatMap(declaration => {
    const colon = declaration.indexOf(':');
    if (colon < 0) return [];
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    return STYLE_PROPERTIES.has(property) && value.length <= 512 && !/[\\<>\u0000-\u001f]|url\s*\(|expression\s*\(|@import|javascript:/i.test(value)
      ? [`${property}:${value}`] : [];
  }).join(';');
}

function safeHref(value: string): boolean {
  return value.length <= 2048 && !/[\u0000-\u0020\\]/.test(value) && /^(?:https?:\/\/|mailto:|tel:|#)/i.test(value);
}
function safeImage(value: string): boolean {
  return value.length <= MAX_NOTION_SNAPSHOT_HTML_BYTES && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export type NotionSnapshotOptions = {
  /** Tests may supply their DOM's implementation; no canvas is modified. */
  canvas?: (canvas: Element) => string;
  /** A finite set of presentation styles, read only from this frame. */
  style?: (element: Element) => string;
  hidden?: (element: Element) => boolean;
};

/**
 * Serialize a static clone, never innerHTML from arbitrary component code.
 * No live node is moved or changed. Controls (including every password field)
 * and authoring/dialog chrome cannot contribute values or executable markup.
 * The parent must still treat this HTML as untrusted and sanitize its export.
 */
export function serializeNotionSnapshot(root: Element, options: NotionSnapshotOptions = {}): string {
  const chunks: string[] = [];
  let bytes = 0, nodes = 0;
  const append = (value: string) => {
    bytes += new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_NOTION_SNAPSHOT_HTML_BYTES) throw new Error('A component is too large to export.');
    chunks.push(value);
  };
  const visit = (node: Node, depth: number) => {
    if (++nodes > 20_000 || depth > 64) throw new Error('A component is too complex to export.');
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? '';
      if (value.length > MAX_NOTION_SNAPSHOT_HTML_BYTES) throw new Error('A component is too large to export.');
      append(escape(value)); return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName?.toLowerCase() ?? element.tagName.toLowerCase();
    if (OMIT.has(tag) || OMIT_ROLES.has(element.getAttribute('role') ?? '') || element.hasAttribute('hidden') ||
      (element.getAttribute('class') ?? '').split(/\s+/).some(name => CHROME.has(name)) || options.hidden?.(element)) return;
    if (tag === 'canvas') {
      const data = (options.canvas ?? rasterizeNotionCanvas)(element);
      if (!safeImage(data)) throw new Error('A canvas could not be exported within the image limit.');
      append(`<img alt="Component canvas" src="${escape(data)}">`); return;
    }
    if (tag === 'button') {
      // Labels are document content; actions and current form values are not.
      // Resource inspection buttons contain their image, while their caption's
      // Edit action is purely workbench chrome.
      const parent = element.parentNode as Element | null;
      if (parent?.nodeType === 1 && parent.tagName.toLowerCase() === 'figcaption') return;
      append('<span>');
      for (let index = 0; index < element.childNodes.length; index++) visit(element.childNodes.item(index)!, depth + 1);
      append('</span>'); return;
    }
    const known = HTML.has(tag) || SVG.has(tag);
    if (known) {
      // Keep SVG's case-sensitive names and attributes for the host's strict
      // sanitizer/rasterizer. Unknown/custom HTML elements are unwrapped.
      const name = SVG.has(tag) ? element.tagName : tag;
      append(`<${name}`);
      for (let index = 0; index < element.attributes.length; index++) {
        const attribute = element.attributes.item(index)!;
        const key = attribute.name.toLowerCase(), value = attribute.value;
        if (key === 'style' || key.startsWith('on') || key.startsWith('data-')) continue;
        if (tag === 'img' && key === 'src') {if (safeImage(value)) append(` src="${escape(value)}"`); continue;}
        if (key === 'href' || key === 'xlink:href') {
          if (SVG.has(tag) ? /^#[A-Za-z0-9_:.-]+$/.test(value) || tag === 'image' && safeImage(value) : tag === 'a' && safeHref(value)) append(` ${attribute.name}="${escape(value)}"`);
          continue;
        }
        if ((ATTRS.has(key) || SVG.has(tag) && SVG_ATTRS.has(key)) && value.length <= (key === 'd' || key === 'points' ? MAX_NOTION_SNAPSHOT_HTML_BYTES : 8192) &&
          !/[\u0000-\u001f]|(?:javascript:|expression\s*\()/i.test(value) &&
          (!/url\s*\(/i.test(value) || /^url\(#[A-Za-z0-9_:.-]+\)$/.test(value)))
          append(` ${attribute.name}="${escape(value)}"`);
      }
      const style = safeStyle(options.style?.(element) ?? element.getAttribute('style') ?? '');
      if (style) append(` style="${escape(style)}"`);
      append('>');
    }
    for (let index = 0; index < element.childNodes.length; index++) visit(element.childNodes.item(index)!, depth + 1);
    if (known && !VOID.has(tag)) append(`</${SVG.has(tag) ? element.tagName : tag}>`);
  };
  // The source-mapped island container is editor chrome, not document content.
  for (let index = 0; index < root.childNodes.length; index++) visit(root.childNodes.item(index)!, 0);
  return chunks.join('');
}

export function rasterizeNotionCanvas(element: Element): string {
  const source = element as HTMLCanvasElement;
  if (!source.width || !source.height) return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6kAAAAASUVORK5CYII=';
  const scale = Math.min(1, 4096 / source.width, 4096 / source.height, Math.sqrt(8_000_000 / source.width / source.height));
  const canvas = source.ownerDocument.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(source.width * scale));
  canvas.height = Math.max(1, Math.floor(source.height * scale));
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const context = canvas.getContext('2d');
      if (!context) throw new Error();
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/png');
      if (safeImage(data)) return data;
      canvas.width = Math.max(1, Math.floor(canvas.width / 2));
      canvas.height = Math.max(1, Math.floor(canvas.height / 2));
    }
    throw new Error();
  } catch {throw new Error('A canvas could not be exported within the image limit.');}
}

/** Copy useful visual styling without fixed positioning or network CSS. */
export function notionPresentationStyle(element: Element): string {
  const view = element.ownerDocument.defaultView;
  if (!view) return element.getAttribute('style') ?? '';
  const style = view.getComputedStyle(element);
  return [...STYLE_PROPERTIES].filter(property => element.localName !== 'img' || property !== 'width' && property !== 'height')
    .map(property => `${property}:${style.getPropertyValue(property)}`).join(';');
}

export function notionElementHidden(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display === 'none' || style?.visibility === 'hidden';
}
