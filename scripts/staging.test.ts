import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import { stagingCommand, stagingEnvironment } from "./staging"

describe("staging launcher isolation", () => {
  test("all inherited Vite values are removed while process infrastructure survives", () => {
    const inherited = {
      PATH: "/usr/local/bin:/usr/bin", HOME: "/users/example", NODE_ENV: "production",
      VITE_SUPABASE_URL: "https://production.example", VITE_SUPABASE_PUBLISHABLE_KEY: "production-public-key",
      VITE_SANDBOX_ORIGIN: "https://production-sandbox.example", VITE_CHATGPT_PLAN: "production-flag",
      VITE_LOCAL_SUGGESTIONS: "0", VITE_NEW_UNEXPECTED_FLAG: "production-value", VITE_: "also-remove",
      OPTIONAL: undefined,
    }
    const before = { ...inherited }
    const cleaned = stagingEnvironment(inherited, {})
    expect(cleaned).toEqual({ PATH: inherited.PATH, HOME: inherited.HOME, NODE_ENV: "production", OPTIONAL: undefined })
    expect(Object.keys(cleaned).some(name => name.startsWith("VITE_"))).toBe(false)
    expect(inherited).toEqual(before)
    expect(cleaned).not.toBe(inherited)
  })

  test("committed public settings outrank runtime and local dotenv pollution in Vite", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "elaborating-staging-env-"))
    const canonical = [
      '# Public staging settings, including deliberately empty feature flags.',
      'VITE_SUPABASE_URL="https://stage-project.example"',
      'VITE_SUPABASE_PUBLISHABLE_KEY="stage-public-key"',
      'VITE_SANDBOX_ORIGIN=""',
      'VITE_CHATGPT_PLAN=""',
      'export VITE_LOCAL_SUGGESTIONS="1"',
      'STAGING_APP_ORIGIN="https://stage.example"',
    ].join("\n")
    const polluted = [
      'VITE_SUPABASE_URL="https://production.example"',
      'VITE_SUPABASE_PUBLISHABLE_KEY="production-public-key"',
      'VITE_SANDBOX_ORIGIN="https://production-sandbox.example"',
      'VITE_CHATGPT_PLAN="production-flag"',
      'VITE_LOCAL_SUGGESTIONS="0"',
    ].join("\n")
    try {
      await Promise.all([
        writeFile(path.join(directory, ".env.staging"), canonical),
        writeFile(path.join(directory, ".env"), polluted),
        writeFile(path.join(directory, ".env.local"), polluted),
        writeFile(path.join(directory, ".env.staging.local"), polluted),
      ])
      const publicEnvironment = parseEnv(canonical)
      const environment = stagingEnvironment({ ...process.env, ...parseEnv(polluted), VITE_UNEXPECTED_RUNTIME_FLAG: "must-remove" }, publicEnvironment)
      expect(environment.VITE_SANDBOX_ORIGIN).toBe("")
      expect(environment.VITE_CHATGPT_PLAN).toBe("")
      expect(environment.VITE_UNEXPECTED_RUNTIME_FLAG).toBeUndefined()
      const child = Bun.spawnSync([
        "node", "--input-type=module", "--eval",
        'import { loadEnv } from "vite"; process.stdout.write(JSON.stringify(loadEnv("staging", process.argv[1])))',
        directory,
      ], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: environment, stdout: "pipe", stderr: "pipe" })
      expect(child.exitCode).toBe(0)
      const resolved = JSON.parse(child.stdout.toString()) as Record<string, string | undefined>
      expect(resolved).toEqual(Object.fromEntries(Object.entries(publicEnvironment).filter(([name]) => name.startsWith("VITE_"))))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("dev uses Node, explicit staging configuration and a strict localhost port", () => {
    expect(stagingCommand(["dev"], "/project/node_modules/vite/bin/vite.js")).toEqual([
      "node", "/project/node_modules/vite/bin/vite.js",
      "--mode", "staging", "--config", "vite.config.ts",
      "--host", "localhost", "--port", "5174", "--strictPort",
    ])
  })

  test("build and preview use only the separate staging output", () => {
    expect(stagingCommand(["build"], "/vite.js")).toEqual([
      "node", "/vite.js", "build", "--mode", "staging", "--config", "vite.config.ts", "--outDir", "dist-staging",
    ])
    expect(stagingCommand(["preview"], "/vite.js")).toEqual([
      "node", "/vite.js", "preview", "--mode", "staging", "--config", "vite.config.ts",
      "--host", "localhost", "--port", "5174", "--strictPort", "--outDir", "dist-staging",
    ])
  })

  test("unknown commands and overrides cannot escape staging isolation", () => {
    const attempts = [
      [], ["serve"], ["production"], ["dev", "other-root"], ["build", "--mode", "production"],
      ["build", "--config", "other.ts"], ["dev", "--envDir", "."], ["build", "--outDir", "dist"],
      ["preview", "--host", "0.0.0.0"], ["dev", "--port", "5175"], ["dev", "--strictPort=false"],
      ["dev; echo unsafe"], ["build", "--help"],
    ]
    for (const args of attempts) expect(() => stagingCommand(args, "/vite.js")).toThrow(/Usage/)
  })

  test("executable paths and environment values stay literal without shell interpretation", () => {
    const vite = "/project with spaces/$(do-not-run)/vite;also-literal.js"
    expect(stagingCommand(["build"], vite)[1]).toBe(vite)
    expect(stagingEnvironment({ PATH: "/path with spaces/$literal", CUSTOM: "$(do-not-run); value" }, {})).toEqual({
      PATH: "/path with spaces/$literal", CUSTOM: "$(do-not-run); value",
    })
  })
})
