/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; the client is created once, from the app's validated
 * configuration, and `supabaseConfigured` says whether there is one.
 */
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { ConfigSchema, parseConfig } from '@/lib/config'

let client: SupabaseClient | undefined

/** Whether this build was given a Supabase project (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY). */
export function supabaseConfigured(): boolean {
  return ConfigSchema.safeParse(import.meta.env).success
}

/** The app's one browser client. Throws when the build has no Supabase configuration. */
export function createClient(): SupabaseClient {
  if (!client) {
    const config = parseConfig(import.meta.env)
    client = createSupabaseClient(config.supabaseUrl, config.supabasePublishableKey)
  }
  return client
}
