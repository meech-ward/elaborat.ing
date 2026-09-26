import { z } from "zod"

/** The sign-in providers the sign-in page can offer, in order. */
export const PROVIDERS = [
  { id: "github", label: "Continue with GitHub" },
  { id: "google", label: "Continue with Google" },
] as const

export type ProviderId = (typeof PROVIDERS)[number]["id"]

// Auth's public settings list every external provider with whether it is on.
const AuthSettings = z.object({
  external: z.object({ github: z.boolean().optional(), google: z.boolean().optional() }),
})

/**
 * The providers turned on in Supabase Auth, from its public settings
 * (`GET /auth/v1/settings`), in `PROVIDERS` order. Throws when the settings
 * cannot be read.
 */
export async function enabledProviders(
  config: { supabaseUrl: string; supabasePublishableKey: string },
  fetchSettings: typeof fetch = fetch,
): Promise<ProviderId[]> {
  const response = await fetchSettings(`${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/settings`, {
    headers: { apikey: config.supabasePublishableKey },
  })
  if (!response.ok) throw new Error(`Auth settings answered ${response.status}.`)
  const { external } = AuthSettings.parse(await response.json())
  return PROVIDERS.filter((provider) => external[provider.id] === true).map((provider) => provider.id)
}
