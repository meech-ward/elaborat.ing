const BUCKET = "project-images"
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"])
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only the canonical image bucket is provisioned; no listing or deletion. */
export async function provisionImageBucket(projectURL: string, secretKey: string, config: unknown, fetcher: typeof fetch = fetch): Promise<void> {
  const project = new URL(projectURL)
  if (project.username || project.password || project.search || project.hash || project.pathname !== "/" || project.protocol !== "https:" && !(project.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(project.hostname))) throw new Error("Use a Supabase project origin, with HTTPS outside localhost.")
  if (!secretKey || /\s/.test(secretKey)) throw new Error("Set ELABORATING_EMBED_SECRET_KEY to the project's secret API key.")
  const bucket = record(record(record(config).storage).buckets)[BUCKET]
  const settings = record(bucket)
  const size = typeof settings.file_size_limit === "string" ? /^(\d+)(B|KB|MB|GB|KiB|MiB|GiB)$/.exec(settings.file_size_limit) : null
  const units: Record<string, number> = { B: 1, KB: 1000, MB: 1000000, GB: 1000000000, KiB: 1024, MiB: 1048576, GiB: 1073741824 }
  const limit = size ? Number(size[1]) * units[size[2]]! : 0
  const types = settings.allowed_mime_types
  if (settings.public !== false || !Number.isSafeInteger(limit) || limit < 1 || limit > 5 * 1024 * 1024 || !Array.isArray(types) || types.length < 1 || types.some(type => typeof type !== "string" || !MEDIA_TYPES.has(type)) || new Set(types).size !== types.length) throw new Error("Declare project-images as private with a limit of at most 5 MiB and supported image MIME types.")
  const headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" }
  const endpoint = `${project.origin}/storage/v1/bucket`
  const existing = await fetcher(`${endpoint}/${BUCKET}`, { headers, signal: AbortSignal.timeout(15000) })
  let create = existing.status === 404
  if (!existing.ok && !create) {
    const error: unknown = await existing.json().catch(() => null)
    create = String(record(error).statusCode) === "404"
    if (!create) throw new Error(`Image bucket lookup failed (HTTP ${existing.status}).`)
  }
  const properties = { public: false, file_size_limit: limit, allowed_mime_types: types }
  const response = await fetcher(create ? endpoint : `${endpoint}/${BUCKET}`, {
    method: create ? "POST" : "PUT", headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify(create ? { id: BUCKET, name: BUCKET, ...properties } : properties),
  })
  if (!response.ok) throw new Error(`Image bucket ${create ? "creation" : "update"} failed (HTTP ${response.status}).`)
}

if (import.meta.main) {
  const url = process.env.ELABORATING_PROJECT_URL
  const secret = process.env.ELABORATING_EMBED_SECRET_KEY
  if (!url || !secret) throw new Error("Set ELABORATING_PROJECT_URL and ELABORATING_EMBED_SECRET_KEY.")
  await provisionImageBucket(url, secret, Bun.TOML.parse(await Bun.file(new URL("../supabase/config.toml", import.meta.url)).text()))
  console.log("Private project-images bucket configured.")
}
