import { expect, test } from "bun:test"
import { signInOptions } from "./providers"

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
  expect(await signInOptions(config, on.fetchSettings)).toEqual({ providers: ["github", "google"], passkeys: false })
  expect(on.seen).toEqual([{ url: "https://project.supabase.co/auth/v1/settings", apikey: "sb_publishable_key" }])

  expect(await signInOptions(config, settings({ external: { github: false, google: true } }).fetchSettings)).toEqual({ providers: ["google"], passkeys: false })
  expect(await signInOptions(config, settings({ external: { email: true } }).fetchSettings)).toEqual({ providers: [], passkeys: false })
})

test("passkey sign-in is offered only when Auth reports it on", async () => {
  expect(await signInOptions(config, settings({ external: { email: true }, passkeys_enabled: true }).fetchSettings)).toEqual({ providers: [], passkeys: true })
  expect(await signInOptions(config, settings({ external: { email: true }, passkeys_enabled: false }).fetchSettings)).toEqual({ providers: [], passkeys: false })
  await expect(signInOptions(config, settings({ external: {}, passkeys_enabled: "yes" }).fetchSettings)).rejects.toThrow()
})

test("settings that cannot be read are an error, not a guess", async () => {
  await expect(signInOptions(config, settings({ message: "down" }, 503).fetchSettings)).rejects.toThrow("Auth settings answered 503.")
  await expect(signInOptions(config, settings({ external: { github: "yes" } }).fetchSettings)).rejects.toThrow()
})
