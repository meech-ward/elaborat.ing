import type { AssistantStatus } from "@/features/design-system"
import type { PlanError } from "../../../supabase/functions/_shared/chatgpt/responses.ts"
import type { PlanStatus } from "./api"

/** The ChatGPT connection as the panel last checked it. */
export type Connection = { kind: "loading" } | { kind: "ready"; status: PlanStatus } | { kind: "failed"; error: PlanError }

const STATUS_FOR: Record<PlanError["error"], AssistantStatus> = {
  not_eligible: "not-eligible",
  usage_limit: "limit",
  unavailable: "unavailable",
  reconnect: "reconnect",
  error: "error",
}

/** What the panel shows: the connection first, then the last turn's error. */
export function statusOf(connection: Connection, problem: PlanError | null): { status: AssistantStatus; message?: string; planOff?: boolean } {
  if (connection.kind === "loading") return { status: "loading" }
  if (connection.kind === "failed") return { status: STATUS_FOR[connection.error.error], message: connection.error.message }
  const { status } = connection
  if (status.problem === "reconnect" || problem?.error === "reconnect") return { status: "reconnect" }
  if (!status.connected || !status.plan) return { status: "not-connected", planOff: status.connected && !status.plan }
  if (status.problem) return { status: STATUS_FOR[status.problem] }
  if (problem) return { status: STATUS_FOR[problem.error], message: problem.message }
  return { status: "ready" }
}

