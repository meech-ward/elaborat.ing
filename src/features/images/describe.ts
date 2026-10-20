import { z } from 'zod/mini'
import { fetchPlanStatus, keeperError, post } from '../assistant/api'
import { readEvents } from '../assistant/sse'
import { imageDataURL, type ImageMediaType } from './types'

const Status = z.object({ connected: z.boolean(), plan: z.boolean(), models: z.array(z.object({ slug: z.string() })) })
/** Called by the person's Suggest description button, using their existing ChatGPT connection. */
export async function describeImage(preview: Blob,signal?:AbortSignal): Promise<string> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  signal?.throwIfAborted()
  if (preview.size > 32768 || !['image/png', 'image/jpeg', 'image/webp'].includes(preview.type))
    throw new Error('A small raster preview is required to suggest a description.')
  let status: z.infer<typeof Status>
  try { status = Status.parse(await fetchPlanStatus(signal)) }
  catch { signal?.throwIfAborted(); throw new Error('Connect ChatGPT in the assistant settings to suggest image descriptions.') }
  if (!status.connected || !status.plan || !status.models.length)
    throw new Error('Connect ChatGPT in the assistant settings to suggest image descriptions.')
  let selected: string | null = null
  try { selected = localStorage.getItem('elaborating:assistant-model') } catch { /* use available model */ }
  const model = status.models.find(model => model.slug === selected)?.slug ?? status.models[0].slug
  signal?.throwIfAborted()
  const pixels=new Uint8Array(await preview.arrayBuffer())
  signal?.throwIfAborted()
  const response = await post('/chatgpt/responses', {
    model,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Suggest concise, accurate alt text for this image for a document. Describe visible content only. Do not infer identities or sensitive traits. Return only one plain text description under 300 characters. Do not call any tools.' },
      { type: 'input_image', image_url: imageDataURL(pixels, preview.type as ImageMediaType), detail: 'low' },
    ] }],
  }, signal)
  if (!response.ok) throw new Error(keeperError(response.status, await response.json().catch(() => null)).message)
  if (!response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('Connect ChatGPT in the assistant settings to suggest image descriptions.')
  let description = ''
  for await (const event of readEvents(response.body!)) {
    signal?.throwIfAborted()
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') description += event.delta
    if (description.length > 2048) throw new Error('The suggested description was too long. Write a description instead.')
    if (event.type === 'response.failed' || event.type === 'error') throw new Error('A description could not be suggested. Try again or write one.')
  }
  description = description.replace(/\s+/g, ' ').trim().replace(/^"|"$/g, '')
  if (!description) throw new Error('No description was suggested. Write a description instead.')
  return description
}
