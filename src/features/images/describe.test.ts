import { afterEach, expect, test } from 'bun:test'
import { describeImage } from './describe'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
test('description sends only a small preview on explicit call and returns editable plain text', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (String(path).endsWith('/status')) return Response.json({ connected: true, plan: true, models: [{ slug: 'chosen-model' }] })
    return new Response('data: {"type":"response.output_text.delta","delta":"A red "}\n\ndata: {"type":"response.output_text.delta","delta":"car. "}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  expect(calls).toHaveLength(0)
  expect(await describeImage(new Blob([new Uint8Array([1])], { type: 'image/png' }))).toBe('A red car.')
  expect(calls.map(call => call.path)).toEqual(['/chatgpt/status', '/chatgpt/responses'])
  expect(calls[1].body).toMatchObject({ model: 'chosen-model', input: [{ role: 'user', content: [{ type: 'input_text' }, { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'low' }] }] })
})
test('no connection and unbounded originals never start inference', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ connected: false, plan: false, models: [] }) }) as unknown as typeof fetch
  await expect(describeImage(new Blob([new Uint8Array(32769)], { type: 'image/png' }))).rejects.toThrow('small raster')
  expect(calls).toBe(0)
  await expect(describeImage(new Blob(['small'], { type: 'image/png' }))).rejects.toThrow('Connect ChatGPT')
  expect(calls).toBe(1)
})

test('Cancel during status prevents sending the image even if the status response arrives late',async () => {
  const controller=new AbortController();
  const calls:string[]=[];
  let finish!: (response:Response)=>void;
  let statusSignal:AbortSignal | null | undefined;
  globalThis.fetch=(async (path:string | URL | Request,init?:RequestInit)=> {
    calls.push(String(path)); statusSignal=init?.signal;
    return await new Promise<Response>(resolve=>{finish=resolve});
  }) as typeof fetch;
  const pending=describeImage(new Blob(['preview'],{type:'image/png'}),controller.signal);
  controller.abort();
  finish(Response.json({connected:true,plan:true,models:[{slug:'model'}]}));
  await expect(pending).rejects.toHaveProperty('name','AbortError');
  expect(statusSignal?.aborted).toBe(true);
  expect(statusSignal?.reason).toBe(controller.signal.reason);
  expect(calls).toEqual(['/chatgpt/status']);
});
