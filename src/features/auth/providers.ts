import { z } from "zod/mini"

/** The sign-in providers the sign-in page can offer, in order. */
export const PROVIDERS = [
  { id: "github", label: "Continue with GitHub" },
  { id: "google", label: "Continue with Google" },
] as const

export type ProviderId = (typeof PROVIDERS)[number]["id"]

// Auth's public settings list every external provider with whether it is on,
// and whether passkey sign-in is on.
const AuthSettings = z.object({
  external: z.object({ github: z.optional(z.boolean()), google: z.optional(z.boolean()) }),
  passkeys_enabled: z.optional(z.boolean()),
})

/** The sign-in methods Auth has on besides email: providers, and passkeys. */
export type SignInOptions = { providers: ProviderId[]; passkeys: boolean }

/**
 * The providers turned on in Supabase Auth, in `PROVIDERS` order, and whether
 * passkey sign-in is on, from its public settings (`GET /auth/v1/settings`).
 * Throws when the settings cannot be read.
 */
export async function signInOptions(
  config: { supabaseUrl: string; supabasePublishableKey: string },
  fetchSettings: typeof fetch = fetch,
): Promise<SignInOptions> {
  const response = await fetchSettings(`${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/settings`, {
    headers: { apikey: config.supabasePublishableKey },
  })
  if (!response.ok) throw new Error(`Auth settings answered ${response.status}.`)
  const { external, passkeys_enabled } = AuthSettings.parse(await response.json())
  return {
    providers: PROVIDERS.filter((provider) => external[provider.id] === true).map((provider) => provider.id),
    passkeys: passkeys_enabled === true,
  }
}
