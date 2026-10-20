import { expect, test } from 'bun:test'
import { inspectImage } from './format'

const svg = (body: string, attributes = 'width="20" height="10"') => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`)
test('SVG keeps vector dimensions and permits local gradients', () => {
  expect(inspectImage(svg('<defs><linearGradient id="a"><stop stop-color="red"/></linearGradient></defs><rect width="20" height="10" fill="url(#a)"/>'), 'image/svg+xml')).toMatchObject({ mediaType: 'image/svg+xml', width: 20, height: 10 })
})
test('SVG rejects scripts, HTML, network, entity expansion, styles and cyclic references', () => {
  for (const body of ['<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.com/a.png"/>', '<rect onclick="x()"/>', '<rect style="fill:url(https://example.com/a)"/>', '<style>@import "x";</style>', '<use id="x" href="#x"/>'])
    expect(() => inspectImage(svg(body))).toThrow()
  expect(() => inspectImage(new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY a "x">]><svg/>'))).toThrow()
  expect(() => inspectImage(svg('', 'width="8000001" height="1"'))).toThrow('8 million')
})
test('SVG bounds filter work and follows gradient, pattern and clip references when checking expansion', () => {
  const filters = [
    '<filter x="-1e100" width="1e100"/>',
    '<filter width="1000000%" height="1000000%"/>',
    '<filter filterUnits="userSpaceOnUse" width="1000000" height="1000000"/>',
    '<filter><feGaussianBlur stdDeviation="1e100"/></filter>',
    '<filter><feGaussianBlur stdDeviation="129"/></filter>',
    '<filter><feTurbulence numOctaves="1000000"/></filter>',
    '<filter><feConvolveMatrix order="1000"/></filter>',
    '<filter filterRes="8000000 8000000"/>',
    '<rect style="filter:blur(1e100px)"/>',
    '<rect filter="blur(129px)"/>',
    '<rect style="--radius:100000px;filter:blur(var(--radius))"/>',
    '<rect style="filter:drop-shadow(rgb(255,0,0) 1px 2px 100000px)"/>',
    '<path d="M 0 0 L 1e100 1e100"/>',
    '<linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/>',
    '<pattern id="a"><rect fill="url(#a)"/></pattern>',
    '<clipPath id="a" clip-path="url(#b)"/><clipPath id="b" clip-path="url(#a)"/>',
    '<rect id="a"/><circle id="a"/>',
  ];
  for (const body of filters) expect(() => inspectImage(svg(body))).toThrow();
  expect(inspectImage(svg('<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter><rect width="20" height="10" filter="url(#blur)"/>'))).toMatchObject({width:20,height:10});
  expect(inspectImage(svg('<filter><feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1"/></filter>'))).toMatchObject({width:20,height:10});
  expect(inspectImage(svg('<rect style="filter:blur(2px) drop-shadow(rgb(255,0,0) 1px 2px 3px)"/>'))).toMatchObject({width:20,height:10});
  const expanded=Array.from({length:15},(_,index)=>`<linearGradient id="a${index}" href="#a${index+1}"/><rect fill="url(#a${index})"/>`).join('');
  expect(inspectImage(svg(expanded))).toMatchObject({width:20,height:10});
})
test('SVG text and CDATA have glyph budgets before either image renderer receives them', () => {
  for (const body of [`<title>${'x'.repeat(16001)}</title>`,Array.from({length:7},()=>`<desc>${'x'.repeat(15000)}</desc>`).join('')])
    expect(() => inspectImage(svg(body))).toThrow('too much text');
  for (const body of [`<text>${'x'.repeat(4001)}</text>`,`<text><![CDATA[${'x'.repeat(4001)}]]></text>`,`<text><tspan>${' '.repeat(4001)}</tspan></text>`,`<text><textPath href="#line">${'x'.repeat(4001)}</textPath></text>`])
    expect(() => inspectImage(svg(body))).toThrow('4,000 characters');
  expect(inspectImage(svg(`<text>${'x'.repeat(4000)}</text><text>${'x'.repeat(4000)}</text>`))).toMatchObject({width:20,height:10});
  expect(() => inspectImage(svg(`<text>${'x'.repeat(4000)}</text><text>${'x'.repeat(4000)}</text><text>x</text>`))).toThrow('8,000');
  expect(inspectImage(svg(`${' '.repeat(10000)}<title>${'x'.repeat(16000)}</title>`))).toMatchObject({width:20,height:10});
  expect(inspectImage(svg(`<defs><text id="words">${'x'.repeat(4000)}</text></defs><use href="#words"/>`))).toMatchObject({width:20,height:10});
  expect(() => inspectImage(svg(`<defs><text id="words">${'x'.repeat(4000)}</text></defs><use href="#words"/><use href="#words"/>`))).toThrow('repeated text');
  expect(() => inspectImage(svg(`<defs><filter id="effect"><feGaussianBlur stdDeviation="2"/></filter></defs>${'<rect filter="url(#effect)"/>'.repeat(65)}`))).toThrow('repeats too many filter');
  expect(() => inspectImage(svg(`<defs><path id="line" d="M0 0 ${'L1 1 '.repeat(15000)}"/></defs>${'<use href="#line"/>'.repeat(7)}`))).toThrow('repeats too much geometry');
});
test('GIF accepts a complete bounded frame and rejects truncated or excessive frame data', () => {
  const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), char => char.charCodeAt(0))
  expect(inspectImage(bytes, 'image/gif')).toMatchObject({ mediaType: 'image/gif', width: 1, height: 1, animated: false })
  expect(() => inspectImage(bytes.slice(0, -1))).toThrow('incomplete')
  const huge = bytes.slice(); huge[32] = 255; huge[33] = 255; huge[34] = 255; huge[35] = 255
  expect(() => inspectImage(huge)).toThrow()
})

const gif = (width:number,height:number,frames:number,frameWidth=1,frameHeight=1,x=0,y=0) => {
  const bytes = new Uint8Array(19 + frames * 15 + 1);
  bytes.set(new TextEncoder().encode('GIF89a'));
  const view = new DataView(bytes.buffer);
  view.setUint16(6,width,true); view.setUint16(8,height,true);
  bytes[10]=128; bytes.set([255,255,255],16);
  for (let index=0;index<frames;index++) {
    const at=19+index*15;
    bytes[at]=44; view.setUint16(at+1,x,true); view.setUint16(at+3,y,true);
    view.setUint16(at+5,frameWidth,true); view.setUint16(at+7,frameHeight,true);
    bytes.set([0,2,2,68,1,0],at+9);
  }
  bytes[bytes.length-1]=59;
  return bytes;
};
const pngChunk = (kind:string,payload:Uint8Array) => {
  const result=new Uint8Array(payload.length+12);
  new DataView(result.buffer).setUint32(0,payload.length);
  result.set(new TextEncoder().encode(kind),4); result.set(payload,8);
  return result;
};
const concat = (...parts:Uint8Array[]) => { const all=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0)); let at=0; for (const part of parts) {all.set(part,at);at+=part.length;} return all; };
const apng = (width:number,height:number,frames:number,frameWidth=1,frameHeight=1) => {
  const header = new Uint8Array(13), animation = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0,width); new DataView(header.buffer).setUint32(4,height); header.set([8,6],8);
  new DataView(animation.buffer).setUint32(0,frames);
  return concat(Uint8Array.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('acTL',animation),...Array.from({length:frames},(_,index)=> {
    const frame=new Uint8Array(26), view=new DataView(frame.buffer);
    view.setUint32(0,index); view.setUint32(4,frameWidth); view.setUint32(8,frameHeight);
    return pngChunk('fcTL',frame);
  }),pngChunk('IEND',new Uint8Array()));
};
const webpAnimation = (width:number,height:number,frames:number,frameWidth=1,frameHeight=1) => {
  const header=new Uint8Array(10); header[0]=2;
  const int24=(bytes:Uint8Array,at:number,value:number) => { bytes[at]=value; bytes[at+1]=value>>>8; bytes[at+2]=value>>>16; };
  int24(header,4,width-1); int24(header,7,height-1);
  const chunk=(kind:string,data:Uint8Array)=> { const bytes=new Uint8Array(data.length+8+(data.length%2)); bytes.set(new TextEncoder().encode(kind)); new DataView(bytes.buffer).setUint32(4,data.length,true); bytes.set(data,8); return bytes; };
  const body=concat(new TextEncoder().encode('WEBP'),chunk('VP8X',header),chunk('ANIM',new Uint8Array(6)),...Array.from({length:frames},()=> {
    const frame=new Uint8Array(16); int24(frame,6,frameWidth-1); int24(frame,9,frameHeight-1); return chunk('ANMF',frame);
  }));
  const riff=new Uint8Array(8); riff.set(new TextEncoder().encode('RIFF')); new DataView(riff.buffer).setUint32(4,body.length,true);
  return concat(riff,body);
};

test('animation budgets count full composited canvases for tiny delta frames in GIF, APNG and WebP', () => {
  for (const create of [gif,apng,webpAnimation]) {
    expect(() => inspectImage(create(4000,1000,7))).toThrow('24 million');
    expect(inspectImage(create(4000,1000,6))).toMatchObject({width:4000,height:1000,animated:true});
    expect(() => inspectImage(create(1,1,1,2,1))).toThrow('canvas');
    expect(() => inspectImage(create(1,1,1,8000001,1))).toThrow();
  }
  expect(() => inspectImage(gif(10,10,1,2,2,9,0))).toThrow('canvas');
});

test('APNG frame declarations and WebP chunk endings must be complete and consistent', () => {
  const zero=apng(1,1,1); new DataView(zero.buffer).setUint32(41,0);
  expect(() => inspectImage(zero)).toThrow('Animation');
  const inconsistent=apng(1,1,1); new DataView(inconsistent.buffer).setUint32(41,2);
  expect(() => inspectImage(inconsistent)).toThrow('count');
  const webp=webpAnimation(1,1,1);
  const trailing=concat(webp,new Uint8Array([1])); new DataView(trailing.buffer).setUint32(4,trailing.length-8,true);
  expect(() => inspectImage(trailing)).toThrow('incomplete');
  const invalidCode=gif(1,1,1); invalidCode[29]=1;
  expect(() => inspectImage(invalidCode)).toThrow('invalid');
});
