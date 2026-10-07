import type { PlanStatus } from "../../../supabase/functions/_shared/chatgpt/keeper.ts"
import { planErrorFor, type PlanError, type PlanErrorCode } from "../../../supabase/functions/_shared/chatgpt/responses.ts"

/**
 * The app's side of the token keeper's /chatgpt/* endpoints, on its own
 * origin. The browser sends JSON and gets JSON or the stream back; it never
 * sees a ChatGPT token.
 */

export type { PlanStatus }

const CODES: readonly PlanErrorCode[] = ["not_eligible", "usage_limit", "unavailable", "reconnect", "error"]

/** The keeper's answer to a request that failed, as the app shows it. */
export function keeperError(status: number, body: unknown): PlanError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  if (typeof record.error === "string" && (CODES as readonly string[]).includes(record.error)) {
    return { error: record.error as PlanErrorCode, message: typeof record.message === "string" ? record.message : planErrorFor(status, null).message }
  }
  return planErrorFor(status, body)
}

export class KeeperError extends Error {
  constructor(readonly planError: PlanError) {
    super(planError.message)
    this.name = "KeeperError"
  }
}

const NOT_RUNNING = "The ChatGPT connection is not running here. Start the app with VITE_CHATGPT_PLAN=1 bun run dev and open it at http://127.0.0.1:5173."

/** POSTs JSON to the keeper. */
export function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal })
}

async function call<T>(path: string, body: unknown = {}): Promise<T> {
  let response: Response
  try {
    response = await post(path, body)
  } catch {
    throw new KeeperError({ error: "error", message: NOT_RUNNING })
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new KeeperError({ error: "error", message: NOT_RUNNING })
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new KeeperError(keeperError(response.status, json))
  return json as T
}

export const fetchPlanStatus = () => call<PlanStatus>("/chatgpt/status")

/** Starts Sign in with ChatGPT; the page goes to OpenAI and comes back here. `consent` asks again for plan use. */
export async function connectPlan(consent = false): Promise<void> {
  const { url } = await call<{ url: string }>("/chatgpt/start", { return_to: `${window.location.pathname}${window.location.search}`, consent })
  window.location.assign(url)
}

export const disconnectPlan = () => call<{ revoked: boolean }>("/chatgpt/disconnect")
