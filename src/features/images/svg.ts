import { DOMParser } from '@xmldom/xmldom'

const SVG = 'http://www.w3.org/2000/svg'
const elements = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern marker filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'.split(' '))
const numericAttributes = new Set('x y x1 x2 y1 y2 cx cy r rx ry width height viewbox points d transform gradienttransform patterntransform markerwidth markerheight refx refy orient stroke-width stroke-dashoffset stroke-dasharray stroke-miterlimit font-size font-size-adjust letter-spacing word-spacing textlength startoffset pathlength dx dy filter filterres stddeviation radius scale basefrequency numoctaves seed order kernelmatrix divisor bias targetx targety kernelunitlength surfacescale diffuseconstant specularconstant specularexponent limitingconeangle pointsatx pointsaty pointsatz azimuth elevation values tablevalues slope intercept amplitude exponent offset k1 k2 k3 k4 z style'.split(' '))
const numbers = (value:string) => Array.from(value.matchAll(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi), match => Number(match[0]));
const lengthToken = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?([a-z%]*)/gi;

/** CSS filter functions can otherwise bypass the equivalent primitive limits. */
function boundedFilterFunctions(value:string):number {
  let functions=0;
  for (const match of value.matchAll(/\b(blur|drop-shadow|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\s*\(/gi)) {
    functions++;
    const name=match[1].toLowerCase();
    if (name !== 'blur' && name !== 'drop-shadow') continue;
    const start=match.index!+match[0].length;
    let depth=1,end=start;
    while (end<value.length && depth) {if (value[end] === '(') depth++; else if (value[end] === ')') depth--; end++;}
    if (depth) throw new Error('The SVG filter is invalid.');
    const body=value.slice(start,end-1).replace(/(?:rgba?|hsla?|color)\([^)]*\)/gi,'').replace(/#[\da-f]{3,8}\b/gi,'');
    const lengths=Array.from(body.matchAll(lengthToken));
    if ((name === 'blur' && lengths.length !== 1) || (name === 'drop-shadow' && (lengths.length < 2 || lengths.length > 3)) || /[()]/.test(body) || lengths.some(length => (length[1] && length[1].toLowerCase() !== 'px') || Math.abs(Number.parseFloat(length[0])) > 128))
      throw new Error('This SVG filter is too complex.');
  }
  return functions;
}

/** SVG remains an image: no scripts, HTML, external resources, embedded images or CSS imports. */
export function inspectSVG(bytes: Uint8Array) {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('SVG must use UTF-8.') }
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(source)) throw new Error('SVG document types and external resources are not supported.')
  const doc = new DOMParser({ onError: () => { throw new Error('The SVG is not valid XML.') } }).parseFromString(source, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG) throw new Error('Choose a valid SVG image.')
  const dimension = (value: string | null) => value && /^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value) ? parseFloat(value) : null
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = dimension(root.getAttribute('width')) ?? (box.length === 4 ? box[2] : null)
  const height = dimension(root.getAttribute('height')) ?? (box.length === 4 ? box[3] : null)
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('SVG needs positive dimensions or a viewBox.')
  const coordinateWidth = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 ? box[2] : width;
  const coordinateHeight = box.length === 4 && box.every(Number.isFinite) && box[3] > 0 ? box[3] : height;
  const references = new Map<typeof root,Set<string>>();
  const textCosts = new Map<typeof root,number>();
  const filterCosts = new Map<typeof root,number>();
  const geometryCosts = new Map<typeof root,number>();
  const ids = new Map<string, typeof root>();
  let numericValues = 0;
  let nodes = 0, attributeBytes = 0, filters = 0, textCharacters = 0
  const visit = (element: typeof root, depth: number) => {
    if (++nodes > 10000 || depth > 64) throw new Error('This SVG is too complex.')
    if (element.namespaceURI !== SVG || !elements.has(element.localName ?? '')) throw new Error(`SVG element ${element.localName} is not supported. Use vector shapes without scripts or embedded content.`)
    let ownFilters=element.localName?.startsWith('fe') ? 1 : 0,ownText=0,ownGeometry=0;
    if (ownFilters && ++filters > 32) throw new Error('This SVG has too many filter effects.')
    if (element.hasAttribute('id')) {
      const id = element.getAttribute('id')!;
      if (ids.has(id)) throw new Error('SVG IDs must be unique.');
      ids.set(id,element);
    }
    const localReferences = new Set<string>();
    references.set(element,localReferences);
    for (let index = 0; index < element.attributes.length; index++) {
      const attribute = element.attributes.item(index)!
      const name = attribute.name.toLowerCase(), value = attribute.value
      if (name === 'xmlns' || name === 'xmlns:xlink') {
        if (value !== (name === 'xmlns' ? SVG : 'http://www.w3.org/1999/xlink')) throw new Error('Unsupported SVG namespace.');
        continue;
      }
      attributeBytes += value.length
      if (attributeBytes > 500000 || (name === 'd' && value.length > 100000)) throw new Error('This SVG is too complex.')
      if (numericAttributes.has(name)) {
        const values = numbers(value);
        ownGeometry+=values.length;
        numericValues += values.length;
        if (numericValues > 100000 || values.some(number => !Number.isFinite(number) || Math.abs(number) > 10_000_000) || /(?:^|[\s,(])[-+]?(?:infinity|nan)(?:$|[\s,)])/i.test(value))
          throw new Error('SVG geometry is too large or complex.');
      }
      if (name === 'style' || name === 'filter') {
        const count=boundedFilterFunctions(value);
        filters+=count; ownFilters+=count;
        if (filters>32) throw new Error('This SVG has too many filter effects.');
      }
      if (name.startsWith('on') || name === 'xml:base' || /(?:expression|@import|javascript:|data:|https?:|file:|\/\/)/i.test(value) || /[\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
        throw new Error('SVG scripts and external resources are not supported.')
      if (name.endsWith('href')) {
        if (!/^#[a-zA-Z_][\w:.-]*$/.test(value)) throw new Error('SVG links must point inside the image.');
        localReferences.add(value.slice(1));
      }
      for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
        if (!/^['"]?#[a-zA-Z_][\w:.-]*['"]?$/.test(match[1].trim())) throw new Error('SVG resources must stay inside the image.')
        localReferences.add(match[1].trim().replace(/^['"]|['"]$/g,'').slice(1));
      }
      if (/url\s*\(/i.test(value) && (value.match(/url\s*\(/gi)?.length ?? 0) !== [...value.matchAll(/url\s*\([^)]*\)/gi)].length)
        throw new Error('The SVG has an invalid resource reference.')
    }
    if (element.localName === 'filter' || element.localName?.startsWith('fe')) {
      const valuesFor = (name:string,limit:number,integers=false,signed=false) => {
        if (!element.hasAttribute(name)) return;
        const value = element.getAttribute(name)!;
        const list = numbers(value);
        if (!list.length || value.replace(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi,'').replace(/[\s,]/g,'') || list.some(number => (!signed && number < 0) || Math.abs(number) > limit || (integers && !Number.isInteger(number))))
          throw new Error('This SVG filter is too complex.');
        return list;
      };
      valuesFor('stdDeviation',128); valuesFor('radius',128);
      valuesFor('numOctaves',8,true);
      const order=valuesFor('order',15,true);
      if (order && (order.length > 2 || order.some(number => number < 1))) throw new Error('This SVG filter kernel is too large.');
      const matrix=valuesFor('kernelMatrix',10_000_000,false,true);
      if (matrix && matrix.length > 225) throw new Error('This SVG filter kernel is too large.');
      const resolution=valuesFor('filterRes',32767,true);
      if (resolution && (resolution.length > 2 || resolution.some(number => number < 1) || resolution[0]*(resolution[1] ?? resolution[0]) > 8_000_000)) throw new Error('This SVG filter resolution is too large.');
      const boundingBox = element.localName === 'filter' && element.getAttribute('filterUnits') !== 'userSpaceOnUse';
      let regionWidth=0,regionHeight=0;
      for (const name of ['x','y','width','height']) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name)!.trim();
        if (!/^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?%?$/i.test(value)) throw new Error('The SVG filter region is invalid.');
        const number=Number.parseFloat(value)/(value.endsWith('%') ? 100 : 1);
        const axis=name === 'x' || name === 'width' ? coordinateWidth : coordinateHeight;
        const normalized=boundingBox ? number : value.endsWith('%') ? number*axis : number;
        if (!Number.isFinite(normalized) || Math.abs(normalized) > (boundingBox ? 4 : axis*4) || ((name === 'width' || name === 'height') && normalized <= 0)) throw new Error('The SVG filter region is too large.');
        if (name === 'width') regionWidth=normalized*(boundingBox ? coordinateWidth : 1);
        if (name === 'height') regionHeight=normalized*(boundingBox ? coordinateHeight : 1);
      }
      if (regionWidth*regionHeight > 8_000_000) throw new Error('The SVG filter region is too large.');
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) visit(child as typeof root, depth + 1)
      else if (![3, 4, 8].includes(child.nodeType)) throw new Error('The SVG contains unsupported content.')
      else if (child.nodeType !== 8) {
        const length=child.nodeValue?.length ?? 0;
        textCharacters+=length; ownText+=length;
        if (length>16000 || textCharacters>100000) throw new Error('This SVG contains too much text.');
      }
    }
    textCosts.set(element,ownText); filterCosts.set(element,ownFilters); geometryCosts.set(element,ownGeometry);
  }
  visit(root, 0)
  // Reuse chains can otherwise expand a small XML document into a huge tree.
  let expanded = 0,expandedText=0,expandedFilters=0,expandedGeometry=0
  const expand = (element: typeof root, stack: Set<typeof root>) => {
    if (stack.size > 64) throw new Error('SVG reference chains are too long.');
    if (stack.has(element)) throw new Error('SVG references cannot form a cycle.');
    if (++expanded > 20000) throw new Error('This SVG has too many repeated shapes.')
    if ((expandedText+=textCosts.get(element) ?? 0)>100000) throw new Error('This SVG repeats too much text.');
    if ((expandedFilters+=filterCosts.get(element) ?? 0)>64) throw new Error('This SVG repeats too many filter effects.');
    if ((expandedGeometry+=geometryCosts.get(element) ?? 0)>200000) throw new Error('This SVG repeats too much geometry.');
    const next = new Set([...stack,element]);
    for (const id of references.get(element) ?? []) {
      const target = ids.get(id)
      if (target) expand(target,next)
    }
    for (let child = element.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) expand(child as typeof root,next)
  }
  expand(root, new Set())
  return { width: Math.ceil(width), height: Math.ceil(height), source }
}
