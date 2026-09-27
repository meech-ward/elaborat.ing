import type { CallToolResult } from 'npm:@modelcontextprotocol/server@2.0.0'

// Shared helpers for building MCP tool results, so every tool returns the same
// shape and signals failure the same way.

/**
 * A successful structured result with a JSON text fallback for older clients.
 */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
    structuredContent: value ?? null,
  }
}

/**
 * A failed result. The message goes back to the model so it can correct itself,
 * so keep it actionable — and free of credentials, claims, and stack traces.
 */
export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}

/** The errcode the database raises when a per-user limit is reached. */
export const LIMIT_ERROR_CODE = 'PT429'

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) return null
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'string' && property ? property : null
}

/**
 * Turn an unknown thrown value into a safe MCP error. Supabase API errors often
 * carry a `code` and `hint`, both of which help a model fix its next call.
 */
export function runtimeErrorResult(error: unknown): CallToolResult {
  // Supabase client errors (PostgrestError) are plain objects, not Error instances.
  const message =
    error instanceof Error ? error.message : (readString(error, 'message') ?? String(error))
  const code = readString(error, 'code')
  const hint = readString(error, 'hint')

  // A per-user limit (supabase/schemas/limits.sql): its message already says
  // which limit was reached and when to try again, so it goes back as is.
  if (code === LIMIT_ERROR_CODE) return errorResult(message)

  return errorResult(
    [code ? `[${code}]` : null, message, hint ? `Hint: ${hint}` : null].filter(Boolean).join(' ')
  )
}
