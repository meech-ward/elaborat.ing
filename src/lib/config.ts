import { z } from "zod/mini"

// Public build-time configuration. Only public values belong here: Vite inlines
// every VITE_ variable into the client bundle.
export const ConfigSchema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().check(z.minLength(1)),
})

export type AppConfig = { supabaseUrl: string; supabasePublishableKey: string }

export function parseConfig(env: Record<string, unknown>): AppConfig {
  const parsed = ConfigSchema.parse(env)
  return {
    supabaseUrl: parsed.VITE_SUPABASE_URL,
    supabasePublishableKey: parsed.VITE_SUPABASE_PUBLISHABLE_KEY,
  }
}
