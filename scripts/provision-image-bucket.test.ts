import { expect, test } from "bun:test"
import { provisionImageBucket } from "./provision-image-bucket"

const config = { storage: { buckets: { "project-images": { public: false, file_size_limit: "5MiB", allowed_mime_types: ["image/png", "image/svg+xml"] } }, analytics: { enabled: true, buckets: { unrelated: {} } } } }
const origin = "https://project.example.test"
const secret = "sb_secret_fixture"

test("provisioning creates only the declared image bucket, then repeats as an update", async () => {
  let exists = false
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetcher = (async (url, init) => {
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    expect(headers.get("apikey")).toBe(secret)
    expect(headers.get("authorization")).toBe(`Bearer ${secret}`)
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (method === "GET") return exists ? Response.json({ id: "project-images" }) : Response.json({ statusCode: "404" }, { status: 400 })
    exists = true
    return Response.json({ name: "project-images" })
  }) as typeof fetch
  for (let repeat = 0; repeat < 3; repeat++) await provisionImageBucket(origin, secret, config, fetcher)
  expect(calls.map(call => call.method)).toEqual(["GET", "POST", "GET", "PUT", "GET", "PUT"])
  expect(calls.every(call => call.url === `${origin}/storage/v1/bucket/project-images` || call.method === "POST" && call.url === `${origin}/storage/v1/bucket`)).toBe(true)
  expect(calls[1]!.body).toEqual({ id: "project-images", name: "project-images", public: false, file_size_limit: 5242880, allowed_mime_types: ["image/png", "image/svg+xml"] })
  expect(calls[3]!.body).toEqual(calls[5]!.body)
})

test("invalid or public image configuration cannot make any Storage request", async () => {
  let calls = 0
  const fetcher = (async () => { calls++; return Response.json({}) }) as typeof fetch
  for (const invalid of [{}, { ...config.storage.buckets["project-images"], public: true }, { ...config.storage.buckets["project-images"], file_size_limit: "50MiB" }, { ...config.storage.buckets["project-images"], allowed_mime_types: ["text/html"] }]) {
    await expect(provisionImageBucket(origin, secret, { storage: { buckets: { "project-images": invalid } } }, fetcher)).rejects.toThrow("Declare project-images")
  }
  expect(calls).toBe(0)
})

test("an unreadable bucket never becomes a creation or deletion request", async () => {
  const methods: string[] = []
  const fetcher = (async (_url, init) => { methods.push(init?.method ?? "GET"); return Response.json({ statusCode: "403" }, { status: 403 }) }) as typeof fetch
  await expect(provisionImageBucket(origin, secret, config, fetcher)).rejects.toThrow("lookup failed (HTTP 403)")
  expect(methods).toEqual(["GET"])
})
