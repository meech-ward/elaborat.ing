import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Exercise the pinned CLI's real --use-api source collector. The local API
// deliberately refuses deployment after receiving its multipart source files.
const cli = Bun.argv.slice(2)
if (cli.length === 0) cli.push("supabase")
const version = Bun.spawn([...cli, "--version"], { stdout: "pipe", stderr: "pipe" })
const [versionCode, versionText] = await Promise.all([version.exited, new Response(version.stdout).text()])
assert.equal(versionCode, 0, "The pinned Supabase CLI must be available")
assert.equal(versionText.trim(), "2.118.0", "Run this source check with Supabase CLI 2.118.0")

const project = "aaaaaaaaaaaaaaaaaaaa"
const sentinel = "LOCAL_SOURCE_ASSET_CHECK_REFUSED"
const fontPath = "supabase/functions/_shared/svgFont.ts"
const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
const font = await Bun.file(new URL(`../${fontPath}`, import.meta.url)).text()
const directory = await mkdtemp(join(tmpdir(), "elaborating-function-assets-"))
type Upload = { path: string; assets: Map<string, string> }
const uploads: Upload[] = []
const unexpected: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === `/v1/projects/${project}/functions/deploy`) {
      const assets = new Map<string, string>()
      for (const [field, value] of await request.formData()) {
        if (field === "file" && value instanceof File) assets.set(value.name, await value.text())
      }
      uploads.push({ path: url.pathname, assets })
    } else if (request.method !== "GET" || url.pathname !== `/v1/projects/${project}`) {
      unexpected.push(`${request.method} ${url.pathname}`)
    }
    return Response.json({ message: sentinel }, { status: 400 })
  },
})

try {
  const profile = join(directory, "loopback.yaml")
  // functions deploy resolves --profile rather than SUPABASE_API_URL. Keep
  // the complete endpoint set local and override any inherited credentials.
  await Bun.write(profile, `name: source-assets-test\napi_url: http://127.0.0.1:${server.port}\ndashboard_url: http://127.0.0.1:${server.port}\nproject_host: localhost\n`)
  for (const name of ["images", "mcp-server"]) {
    const before = uploads.length
    const child = Bun.spawn([...cli, "functions", "deploy", name, "--use-api", "--project-ref", project, "--yes", "--profile", profile, "--workdir", sourceRoot], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        SUPABASE_ACCESS_TOKEN: `sbp_${"0".repeat(40)}`,
        SUPABASE_TELEMETRY_DISABLED: "true",
        DO_NOT_TRACK: "1",
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill(), 30_000)
    let code: number, output: string, errors: string
    try {
      [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    } finally { clearTimeout(timeout) }
    assert.notEqual(code, 0, "The fake API must refuse every deployment")
    assert.match(output + errors, new RegExp(sentinel), `${name} must reach the loopback API`)
    assert.equal(uploads.length, before + 1, `${name} must upload one source artifact`)
    const assets = uploads.at(-1)!.assets
    assert.equal(assets.get(fontPath), font, `${name} deployment must contain the exact generated SVG font module`)
    assert(assets.has(`supabase/functions/${name}/index.ts`), `${name} must contain its entry point`)
    console.log(`${name}: verified ${assets.size} source files, including the bundled SVG font`)
  }
  assert.deepEqual(unexpected, [], "The source collector must make only expected loopback API requests")
} finally {
  server.stop(true)
  await rm(directory, { recursive: true, force: true })
}
