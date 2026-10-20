import { expect, test } from 'bun:test';
import { imageDataURL, MAX_IMAGE_BYTES } from './types';
import { imageFilesFromPayloads, imageFilePayloads, decodeImageDataURL } from './transport';
import { childMessageSchema, imagesMessageSchema, checkParentMessage } from '../rendered/protocol';

const tiny = imageDataURL(new Uint8Array([137,80,78,71]),'image/png');
const file = {name:'photo.png',mediaType:'image/png' as const,dataURL:tiny};
test('clipboard transport keeps bytes and file order for the trusted picker',async () => {
  const files = imageFilesFromPayloads([file,{...file,name:'second.png'}]);
  expect(files.map(file => file.name)).toEqual(['photo.png','second.png']);
  expect([...new Uint8Array(await files[0].arrayBuffer())]).toEqual([137,80,78,71]);
  expect(await imageFilePayloads(files)).toEqual([file,{...file,name:'second.png'}]);
});
test('image intent transport rejects oversized, mislabeled and unsafe file proposals',() => {
  for (const value of ['https://example.com/x.png','data:image/bmp;base64,AA==','data:image/png;base64,A===','data:image/png;base64,!!!!'])
    expect(() => decodeImageDataURL(value)).toThrow();
  expect(() => decodeImageDataURL(tiny,'image/jpeg')).toThrow();
  expect(() => imageFilesFromPayloads([{...file,name:'../photo.png'}])).toThrow();
  expect(() => imageFilesFromPayloads(Array(9).fill(file))).toThrow();
  const tooLarge = imageDataURL(new Uint8Array(MAX_IMAGE_BYTES + 1),'image/png');
  expect(() => decodeImageDataURL(tooLarge)).toThrow();
  const large = imageDataURL(new Uint8Array(3 * 1024 * 1024),'image/png');
  expect(() => imageFilesFromPayloads(Array(8).fill({...file,dataURL:large}))).toThrow('20 MiB');
});
test('frame image intents contain a finite boundary and bounded raster proposals',() => {
  const intent = {kind:'insert-image',session:'session-image',revision:1,boundary:'after:5',files:[file]};
  expect(childMessageSchema.safeParse(intent).success).toBe(true);
  expect(childMessageSchema.safeParse({...intent,files:Array(9).fill(file)}).success).toBe(false);
  expect(childMessageSchema.safeParse({...intent,files:[{...file,mediaType:'image/bmp'}]}).success).toBe(false);
  expect(childMessageSchema.safeParse({...intent,source:'![invented](x.png)'}).success).toBe(false);
});
test('preview messages allow only bounded local raster data and never establish a session',() => {
  const message = {kind:'images',session:'session-image',revision:1,reset:true,images:[{key:'assets/a.png',dataURL:tiny,width:1,height:1}]};
  expect(imagesMessageSchema.safeParse(message).success).toBe(true);
  expect(imagesMessageSchema.safeParse({...message,images:[{...message.images[0],dataURL:'https://example.com/x.png'}]}).success).toBe(false);
  expect(imagesMessageSchema.safeParse({...message,images:[{...message.images[0],width:100_000,height:100_000}]}).success).toBe(false);
  expect(checkParentMessage({data:message,source:{},activeSession:null}).ok).toBe(false);
  expect(checkParentMessage({data:message,source:{},activeSession:'another-session'}).ok).toBe(false);
});
