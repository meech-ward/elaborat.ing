// Inference on the person's ChatGPT plan: the Responses request the keeper
// sends for the browser, the models it may name, and what each plan error
// means to the app. Plain TypeScript, shared by the keeper and the browser.
import { errorCodeOf, RESOURCE } from './oauth.ts'
import { ASSISTANT_INSTRUCTIONS, TOOL_NAMESPACE } from './tools.ts'

export const RESPONSES_URL = `${RESOURCE}/responses`
export const MODELS_URL = `${RESOURCE}/models`
/** The largest request body the keeper takes from the browser, in bytes: a whole chat, files included. */
export const MAX_REQUEST_BYTES = 4_000_000

export type PlanModel = { slug: string; name: string }

/** The models the account may pick, in the server's order: those with visibility "list". */
export function listedModels(body: unknown): PlanModel[] {
  const models = body && typeof body === 'object' ? (body as { models?: unknown }).models : null
  if (!Array.isArray(models)) return []
  return models.flatMap((model) => {
    if (!model || typeof model !== 'object') return []
    const { slug, display_name: name, visibility } = model as Record<string, unknown>
    return visibility === 'list' && typeof slug === 'string' && slug ? [{ slug, name: typeof name === 'string' && name ? name : slug }] : []
  })
}

/**
 * The request the keeper sends to OpenAI for the browser's `{ model, input }`.
 * Everything else is pinned here: no storage, a stream, the app's
 * instructions and its four tools. Any other field the browser adds is
 * dropped; a model not in the person's list, or input that is not a list of
 * items, is refused.
 */
export function buildResponsesRequest(body: unknown, models: readonly string[]): { ok: true; request: Record<string, unknown> } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'The request must be a JSON object.' }
  const { model, input } = body as Record<string, unknown>
  if (typeof model !== 'string' || !models.includes(model)) return { ok: false, message: 'Choose one of your ChatGPT models.' }
  if (!Array.isArray(input) || input.length === 0 || !input.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    return { ok: false, message: 'The input must be a list of items.' }
  }
  if (JSON.stringify(input).length > MAX_REQUEST_BYTES) return { ok: false, message: 'This chat is too long. Start a new chat.' }
  return {
    ok: true,
    request: { model, input, instructions: ASSISTANT_INSTRUCTIONS, tools: [TOOL_NAMESPACE], store: false, stream: true },
  }
}

/**
 * What the app shows for a plan error: needs Plus or Pro, the usage limit,
 * unavailable for now, reconnect, or any other error with its message.
 */
export type PlanErrorCode = 'not_eligible' | 'usage_limit' | 'unavailable' | 'reconnect' | 'error'
export type PlanError = { error: PlanErrorCode; message: string }

const MESSAGES: Record<PlanErrorCode, string> = {
  not_eligible: 'Needs ChatGPT Plus or Pro.',
  usage_limit: 'You have reached your ChatGPT usage limit for this app.',
  unavailable: 'ChatGPT plan usage is unavailable right now.',
  reconnect: 'Reconnect ChatGPT to continue.',
  error: 'ChatGPT could not answer.',
}

/**
 * The app's error for an OpenAI answer: by the error code when there is one
 * (also a response.failed event's error, mid-stream), else by the status.
 * Admission failures carry `{"detail": ...}`, kept as the message.
 */
export function planErrorFor(status: number, body: unknown): PlanError {
  const code = errorCodeOf(body)
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {}
  const detail = [nested.message, record.detail, record.message].find((value): value is string => typeof value === 'string' && value !== '')
  let error: PlanErrorCode
  if (code === 'subscription_sharing_user_not_eligible') error = 'not_eligible'
  else if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) error = 'usage_limit'
  else if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) error = 'unavailable'
  else if (code === 'subscription_sharing_invalid_user' || status === 401) error = 'reconnect'
  else error = 'error'
  return { error, message: error === 'error' && detail ? detail : MESSAGES[error] }
}
