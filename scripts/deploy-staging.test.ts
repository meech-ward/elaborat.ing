import { afterEach, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  deployStaging,
  renderStagingConfig,
  STAGING_BROWSER_FUNCTIONS,
  stagingDeploymentEnvironment,
  stagingSettings,
  validateStagingWorker,
} from "./deploy-staging"

const projectId = "abcdefghijklmnopqrst"
const appOrigin = "https://elaborating-staging.example.workers.dev"
const publicEnvironment = {
  VITE_SUPABASE_URL: `https://${projectId}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_staging_fixture",
  STAGING_APP_ORIGIN: appOrigin,
  VITE_SANDBOX_ORIGIN: "",
  VITE_CHATGPT_PLAN: "",
  VITE_LOCAL_SUGGESTIONS: "1",
}
const environment = {
  PATH: process.env.PATH,
  CLOUDFLARE_API_TOKEN: "cloudflare_fixture",
  STAGING_SUPABASE_PROJECT_ID: projectId,
  STAGING_SUPABASE_PUBLISHABLE_KEY: publicEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY,
  STAGING_APP_ORIGIN: appOrigin,
  STAGING_SUPABASE_ACCESS_TOKEN: "sbp_staging_fixture",
  STAGING_SUPABASE_DB_PASSWORD: "staging password",
  STAGING_SUPABASE_SECRET_KEY: "sb_secret_staging_fixture",
}
const worker = () => ({
  name: "elaborating",
  vars: { MCP_UPSTREAM: "https://production.example/mcp" },
  routes: [{ pattern: "elaborat.ing", custom_domain: true }],
  env: { staging: {
    name: "elaborating-staging", workers_dev: true, routes: [],
    assets: { directory: "./dist-staging" }, vars: { MCP_UPSTREAM: "", MCP_PROBE_UPSTREAM: "" },
  } },
})
const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "elaborating-deploy-staging-test-"))
  temporary.push(root)
  await mkdir(path.join(root, "env/staging"), { recursive: true })
  await mkdir(path.join(root, "supabase/staging"), { recursive: true })
  await writeFile(path.join(root, "env/staging/.env.staging"), Object.entries(publicEnvironment).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n"))
  await writeFile(path.join(root, "wrangler.jsonc"), JSON.stringify(worker()))
  const template = await readFile(new URL("../supabase/staging/config.toml", import.meta.url), "utf8")
  await writeFile(path.join(root, "supabase/staging/config.toml"), template)
  await writeFile(path.join(root, "supabase/config.toml"), '[storage.buckets.project-images]\npublic=false\nfile_size_limit="5MiB"\nallowed_mime_types=["image/png"]\n')
  return root
}

test("deployment requires a nonproduction project and public values that match the committed staging file", () => {
  expect(stagingSettings(environment, publicEnvironment)).toMatchObject({ projectId, appOrigin, projectURL: publicEnvironment.VITE_SUPABASE_URL })
  for (const invalid of [
    { STAGING_SUPABASE_PROJECT_ID: "njxjkmtvconypwujbiur" },
    { STAGING_SUPABASE_PROJECT_ID: "differentprojectrefzz" },
    { STAGING_SUPABASE_PROJECT_ID: "$(echo do-not-run)" },
    { STAGING_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_wrong" },
    { STAGING_APP_ORIGIN: "https://elaborat.ing" },
    { STAGING_APP_ORIGIN: `${appOrigin}/path` },
    { STAGING_APP_ORIGIN: "https://elaborating-staging.example.workers.dev.attacker.test" },
    { STAGING_APP_ORIGIN: "http://elaborating-staging.example.workers.dev" },
    { STAGING_SUPABASE_ACCESS_TOKEN: "" },
    { STAGING_SUPABASE_DB_PASSWORD: "" },
    { STAGING_SUPABASE_SECRET_KEY: "sb_publishable_wrong_role" },
  ]) expect(() => stagingSettings({ ...environment, ...invalid }, publicEnvironment)).toThrow()
  for (const invalid of [{ VITE_SANDBOX_ORIGIN: "https://production-sandbox.test" }, { VITE_CHATGPT_PLAN: "1" }, { VITE_LOCAL_SUGGESTIONS: "0" }]) {
    expect(() => stagingSettings(environment, { ...publicEnvironment, ...invalid })).toThrow()
  }
})

test("the staging CLI environment replaces inherited production credentials, while builds receive neither set", () => {
  const inherited = {
    ...environment, SUPABASE_ACCESS_TOKEN: "production_access", SUPABASE_DB_PASSWORD: "production_password",
    SUPABASE_DB_URL: "postgres://production", ELABORATING_EMBED_SECRET_KEY: "production_secret",
    ELABORATING_PROJECT_URL: "https://production.example", SES_SMTP_PASSWORD: "production_smtp",
    VITE_SUPABASE_URL: "https://production.example", VITE_OTHER: "unexpected", CUSTOM: "literal value",
  }
  const cli = stagingDeploymentEnvironment(inherited, stagingSettings(environment, publicEnvironment))
  expect(cli.SUPABASE_ACCESS_TOKEN).toBe(environment.STAGING_SUPABASE_ACCESS_TOKEN)
  expect(cli.SUPABASE_DB_PASSWORD).toBe(environment.STAGING_SUPABASE_DB_PASSWORD)
  expect(cli.ELABORATING_EMBED_SECRET_KEY).toBe(environment.STAGING_SUPABASE_SECRET_KEY)
  expect(cli.ELABORATING_PROJECT_URL).toBe(publicEnvironment.VITE_SUPABASE_URL)
  expect(JSON.stringify(cli)).not.toContain("production")
  expect(Object.keys(cli).some(name => name.startsWith("STAGING_") || name.startsWith("VITE_"))).toBe(false)
  const browser = stagingDeploymentEnvironment(inherited)
  expect(Object.keys(browser).some(name => /^(SUPABASE_|ELABORATING_|STAGING_|VITE_|SES_SMTP_)/.test(name))).toBe(false)
  expect(browser.CLOUDFLARE_API_TOKEN).toBe(environment.CLOUDFLARE_API_TOKEN)
  expect(inherited.SUPABASE_ACCESS_TOKEN).toBe("production_access")
})

test("the Worker guard refuses production routes, inherited names, wrong output and MCP forwarding", () => {
  const settings = stagingSettings(environment, publicEnvironment)
  expect(() => validateStagingWorker(JSON.stringify(worker()), settings)).not.toThrow()
  for (const change of [
    { name: "elaborating" }, { name: "another-worker" }, { workers_dev: false },
    { routes: [{ pattern: "elaborat.ing" }] }, { routes: undefined },
    { assets: { directory: "./dist" } },
    { vars: { MCP_UPSTREAM: "https://production.example/mcp" } },
    { vars: { MCP_PROBE_UPSTREAM: "https://production.example/probe" } },
  ]) {
    const config = worker()
    expect(() => validateStagingWorker(JSON.stringify({ ...config, env: { staging: { ...config.env.staging, ...change } } }), settings)).toThrow()
  }
})

test("the staging Auth template enables password signup and only staging or staging-local redirects", async () => {
  const template = await readFile(new URL("../supabase/staging/config.toml", import.meta.url), "utf8")
  const rendered = renderStagingConfig(template, stagingSettings(environment, publicEnvironment))
  const config = Bun.TOML.parse(rendered) as { auth: { site_url: string; additional_redirect_urls: string[]; email: { enable_confirmations: boolean; smtp: { enabled: boolean } }; external: { github: { enabled: boolean }; google: { enabled: boolean } }; oauth_server: { enabled: boolean } } }
  expect(config.auth.site_url).toBe(appOrigin)
  expect(config.auth.additional_redirect_urls).toEqual([`${appOrigin}/**`, "http://localhost:5174/**", "http://127.0.0.1:5174/**"])
  expect(config.auth.email.enable_confirmations).toBe(false)
  expect(config.auth.email.smtp.enabled).toBe(false)
  expect(config.auth.external.github.enabled).toBe(false)
  expect(config.auth.external.google.enabled).toBe(false)
  expect(config.auth.oauth_server.enabled).toBe(false)
  expect(rendered).not.toContain("https://elaborat.ing")
})

test("bootstrap runs the browser backend, Vault migrations and private bucket before its isolated frontend", async () => {
  const root = await fixture()
  const calls: string[] = []
  let configWorkdir = ""
  await deployStaging({
    root, environment, bun: "/cached/bun", log: () => {},
    run: async step => {
      calls.push(step.label)
      expect(step.cwd).toBe(root)
      if (step.command.includes("supabase@2.118.0")) {
        expect(step.command[step.command.indexOf("--project-ref") + 1]).toBe(projectId)
        expect(step.env.SUPABASE_ACCESS_TOKEN).toBe(environment.STAGING_SUPABASE_ACCESS_TOKEN)
        if (step.command.includes("functions")) {
          expect(step.command).toEqual(["/cached/bun", "x", "supabase@2.118.0", "functions", "deploy", ...STAGING_BROWSER_FUNCTIONS, "--use-api", "--project-ref", projectId, "--workdir", root, "--yes"])
          expect(step.command).not.toContain("mcp-server")
          expect(step.command).not.toContain("send-events")
        }
        if (step.command.includes("secrets")) {
          const file = step.command[step.command.indexOf("--env-file") + 1]
          expect(await readFile(file, "utf8")).toBe(`ELABORATING_APP_ORIGIN=${appOrigin}\n`)
        }
        if (step.command.includes("config")) {
          configWorkdir = step.command[step.command.indexOf("--workdir") + 1]
          expect(configWorkdir).not.toBe(root)
          expect(await readFile(path.join(configWorkdir, "supabase/config.toml"), "utf8")).toContain(`site_url = "${appOrigin}"`)
        }
      } else {
        expect(Object.keys(step.env).some(name => /^(SUPABASE_|ELABORATING_|STAGING_|VITE_)/.test(name))).toBe(false)
        expect(step.command).toEqual(step.label.startsWith("Building") ? ["/cached/bun", "run", "build:staging"] : ["/cached/bun", "x", "wrangler", "deploy", "--env", "staging"])
      }
    },
    provision: async (url, key, config) => {
      calls.push("bucket")
      expect(url).toBe(publicEnvironment.VITE_SUPABASE_URL)
      expect(key).toBe(environment.STAGING_SUPABASE_SECRET_KEY)
      expect(config).toEqual({ storage: { buckets: { "project-images": { public: false, file_size_limit: "5MiB", allowed_mime_types: ["image/png"] } } } })
    },
  })
  expect(calls).toEqual([
    "Setting staging invitation origin", "Deploying staging browser functions", "Applying staging migrations and Vault configuration", "bucket",
    "Checking staging Auth configuration", "Applying staging Auth configuration", "Building the staging app", "Deploying the staging Worker",
  ])
  await expect(access(configWorkdir)).rejects.toThrow()
  expect(await readFile(path.join(root, "supabase/config.toml"), "utf8")).not.toContain(appOrigin)
})

test("failed guards cause no deployment calls, and a failed backend step stops the release and removes temporary files", async () => {
  const root = await fixture()
  let calls = 0
  await expect(deployStaging({ root, environment: { ...environment, STAGING_SUPABASE_PROJECT_ID: "njxjkmtvconypwujbiur" }, run: async () => { calls++ }, provision: async () => { calls++ }, log: () => {} })).rejects.toThrow("never production")
  expect(calls).toBe(0)
  let temporaryDirectory = ""
  await expect(deployStaging({
    root, environment, log: () => {},
    run: async step => {
      calls++
      if (step.command.includes("secrets")) temporaryDirectory = path.dirname(step.command[step.command.indexOf("--env-file") + 1])
      if (step.command.includes("functions")) throw new Error("Function build failed")
    },
    provision: async () => { throw new Error("Bucket must not be reached") },
  })).rejects.toThrow("Function build failed")
  expect(calls).toBe(2)
  await expect(access(temporaryDirectory)).rejects.toThrow()
})

test("a CLI failure redacts raw and URL-encoded credentials before reporting its output", async () => {
  const root = await fixture()
  const executable = path.join(root, "fake bun")
  await writeFile(executable, '#!/bin/sh\nprintf "%s|%s|%s|staging%%20password\\n" "$SUPABASE_ACCESS_TOKEN" "$SUPABASE_DB_PASSWORD" "$ELABORATING_EMBED_SECRET_KEY"\nexit 7\n', { mode: 0o700 })
  const logs: string[] = []
  let failure = ""
  try {
    await deployStaging({ root, environment, bun: executable, log: message => logs.push(message), provision: async () => { throw new Error("No bucket call") } })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  expect(failure).toContain("exit 7")
  expect(failure).toContain("[redacted]")
  for (const secret of [environment.STAGING_SUPABASE_ACCESS_TOKEN, environment.STAGING_SUPABASE_DB_PASSWORD, environment.STAGING_SUPABASE_SECRET_KEY]) {
    expect(failure).not.toContain(secret)
    expect(failure).not.toContain(encodeURIComponent(secret))
    expect(logs.join("\n")).not.toContain(secret)
  }
})
