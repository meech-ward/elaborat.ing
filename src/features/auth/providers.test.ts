import { expect, test } from "bun:test"
import { enabledProviders } from "./providers"

const config = { supabaseUrl: "https://project.supabase.co/", supabasePublishableKey: "sb_publishable_key" }

function settings(body: unknown, status = 200) {
  const seen: Array<{ url: string; apikey: string | null }> = []
  const fetchSettings = (async (url: string, init?: RequestInit) => {
    seen.push({ url, apikey: new Headers(init?.headers).get("apikey") })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { seen, fetchSettings }
}

test("only the providers Auth reports on are offered, in a fixed order", async () => {
  const on = settings({ external: { google: true, email: true, github: true, apple: true }, disable_signup: false })
  expect(await enabledProviders(config, on.fetchSettings)).toEqual(["github", "google"])
  expect(on.seen).toEqual([{ url: "https://project.supabase.co/auth/v1/settings", apikey: "sb_publishable_key" }])

  expect(await enabledProviders(config, settings({ external: { github: false, google: true } }).fetchSettings)).toEqual(["google"])
  expect(await enabledProviders(config, settings({ external: { email: true } }).fetchSettings)).toEqual([])
})

test("settings that cannot be read are an error, not a guess", async () => {
  await expect(enabledProviders(config, settings({ message: "down" }, 503).fetchSettings)).rejects.toThrow("Auth settings answered 503.")
  await expect(enabledProviders(config, settings({ external: { github: "yes" } }).fetchSettings)).rejects.toThrow()
})
