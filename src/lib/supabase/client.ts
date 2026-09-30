/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; the client is created once, from the app's validated
 * configuration, with passkey sign-in turned on, and `supabaseConfigured`
 * says whether there is one; supabase-js loads with a dynamic import
 * (`loadClient`), and `loadedClient` returns the client once it has.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ConfigSchema, parseConfig } from '@/lib/config'

let client: SupabaseClient | undefined
let loading: Promise<SupabaseClient> | undefined

/** Whether this build was given a Supabase project (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY). */
export function supabaseConfigured(): boolean {
  return ConfigSchema.safeParse(import.meta.env).success
}

/**
 * The app's one browser client. supabase-js is a chunk of its own, off every
 * page's first paint (docs/architecture.md, Principles); the session check
 * (features/auth/useAuth.ts) starts loading it. Rejects when the build has no
 * Supabase configuration, or when the chunk cannot load (the next call tries again).
 */
export function loadClient(): Promise<SupabaseClient> {
  loading ??= import('@supabase/supabase-js').then(
    ({ createClient }) => {
      const config = parseConfig(import.meta.env)
      // Passkeys are an experimental Auth API that the client opts in to.
      client ??= createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { experimental: { passkey: true } } })
      return client
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

/** Whether `loadClient` has resolved. */
export function clientLoaded(): boolean {
  return client !== undefined
}

/**
 * The client, for code that runs only once someone is signed in: the session
 * check loaded it first. Throws before `loadClient` has resolved.
 */
export function loadedClient(): SupabaseClient {
  if (!client) throw new Error('The Supabase client has not loaded yet. Use loadClient().')
  return client
}
