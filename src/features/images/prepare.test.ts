import {expect,test} from 'bun:test';
import {prepareImage} from './prepare';

test('preparing a large file rejects its size before allocating the file buffer',async () => {
  let reads=0;
  const file={size:5*1024*1024+1,arrayBuffer:async()=>{reads++;return new ArrayBuffer(0)}} as Blob;
  await expect(prepareImage(file,'5f3db947-730e-4cc1-bf82-a093d66f6909')).rejects.toThrow('5 MiB');
  expect(reads).toBe(0);
});

test('a canceled decode releases its bitmap before allocating a preview canvas',async () => {
  const controller=new AbortController();
  const previous=globalThis.createImageBitmap;
  let closed=0;
  globalThis.createImageBitmap=(async()=>{controller.abort(); return {width:1,height:1,close:()=>{closed++}} as ImageBitmap}) as typeof createImageBitmap;
  try {
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
    await expect(prepareImage(new Blob([bytes],{type:'image/png'}),'5f3db947-730e-4cc1-bf82-a093d66f6909',undefined,controller.signal)).rejects.toHaveProperty('name','AbortError');
    expect(closed).toBe(1);
  } finally {globalThis.createImageBitmap=previous;}
});
