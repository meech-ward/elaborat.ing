import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseEnv } from "node:util"
import { parseConfigFileTextToJson } from "typescript"
import { provisionImageBucket } from "./provision-image-bucket"

const PRODUCTION_PROJECT = "njxjkmtvconypwujbiur"
const CLI_VERSION = "supabase@2.118.0"
export const STAGING_BROWSER_FUNCTIONS = ["embed", "search", "images", "file-share", "share", "delete-account"] as const
type Environment = Record<string, string | undefined>

export type StagingSettings = {
  projectId: string
  projectURL: string
  publishableKey: string
  appOrigin: string
  accessToken: string
  databasePassword: string
  secretKey: string
}

const required = (env: Environment, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Set ${name} before deploying staging.`)
  return value
}

/** Every destination is bound to the committed public staging configuration. */
export function stagingSettings(environment: Environment, publicEnvironment: Environment): StagingSettings {
  const projectId = required(environment, "STAGING_SUPABASE_PROJECT_ID")
  if (!/^[a-z]{20}$/.test(projectId) || projectId === PRODUCTION_PROJECT) throw new Error("Use the separate staging Supabase project, never production.")
  const projectURL = `https://${projectId}.supabase.co`
  if (publicEnvironment.VITE_SUPABASE_URL !== projectURL) throw new Error("Staging project does not match env/staging/.env.staging.")
  const publishableKey = required(environment, "STAGING_SUPABASE_PUBLISHABLE_KEY")
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) || publicEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY !== publishableKey) {
    throw new Error("Staging publishable key does not match env/staging/.env.staging.")
  }
  const appOrigin = required(environment, "STAGING_APP_ORIGIN")
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(appOrigin) || publicEnvironment.STAGING_APP_ORIGIN !== appOrigin) {
    throw new Error("Use the exact workers.dev staging origin in env/staging/.env.staging.")
  }
  if (publicEnvironment.VITE_SANDBOX_ORIGIN || publicEnvironment.VITE_CHATGPT_PLAN || publicEnvironment.VITE_LOCAL_SUGGESTIONS !== "1") {
    throw new Error("Staging must use its local suggestion build and srcdoc previews without the hosted assistant.")
  }
  const accessToken = required(environment, "STAGING_SUPABASE_ACCESS_TOKEN")
  const databasePassword = required(environment, "STAGING_SUPABASE_DB_PASSWORD")
  const secretKey = required(environment, "STAGING_SUPABASE_SECRET_KEY")
  if (!/^sbp_[A-Za-z0-9_-]+$/.test(accessToken) || !/^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey)) {
    throw new Error("Use the staging access token and a modern staging secret API key.")
  }
  return { projectId, projectURL, publishableKey, appOrigin, accessToken, databasePassword, secretKey }
}

/** Production dotenv values cannot become either CLI credentials or browser build input. */
export function stagingDeploymentEnvironment(environment: Environment, settings?: StagingSettings): Environment {
  const clean = { ...environment }
  for (const key of Object.keys(clean)) {
    if (/^(?:VITE_|SUPABASE_|STAGING_|ELABORATING_|SES_SMTP_)/.test(key)) delete clean[key]
  }
  return settings ? {
    ...clean,
    SUPABASE_ACCESS_TOKEN: settings.accessToken,
    SUPABASE_DB_PASSWORD: settings.databasePassword,
    ELABORATING_PROJECT_URL: settings.projectURL,
    ELABORATING_EMBED_SECRET_KEY: settings.secretKey,
  } : clean
}

export function validateStagingWorker(raw: string, settings: StagingSettings): void {
  const parsed = parseConfigFileTextToJson("wrangler.jsonc", raw)
  if (parsed.error) throw new Error("Could not read the staging Worker configuration.")
  const config = parsed.config
  const staging = config?.env?.staging
  const workerName = new URL(settings.appOrigin).hostname.split(".")[0]
  if (!staging || staging.name !== workerName || staging.name === config.name || staging.workers_dev !== true ||
      !Array.isArray(staging.routes) || staging.routes.length !== 0 || staging.assets?.directory !== "./dist-staging" ||
      staging.vars?.MCP_UPSTREAM || staging.vars?.MCP_PROBE_UPSTREAM) {
    throw new Error("Staging must deploy only its configured Worker, dist-staging assets and empty custom routes, without MCP upstreams.")
  }
}

export function renderStagingConfig(template: string, settings: StagingSettings): string {
  if (!template.includes("__STAGING_APP_ORIGIN__")) throw new Error("The staging Auth template needs its origin placeholder.")
  const rendered = template.replaceAll("__STAGING_APP_ORIGIN__", settings.appOrigin)
  const config = Bun.TOML.parse(rendered) as { auth?: { site_url?: string; email?: { enable_confirmations?: boolean; smtp?: { enabled?: boolean } } } }
  if (config.auth?.site_url !== settings.appOrigin || config.auth?.email?.enable_confirmations !== false || config.auth?.email?.smtp?.enabled !== false) {
    throw new Error("Staging Auth must use its own origin, password signup and no production SMTP.")
  }
  return rendered
}

type Command = { label: string; command: string[]; cwd: string; env: Environment }
type Runner = (step: Command) => Promise<void>
type DeployOptions = {
  root?: string
  environment?: Environment
  bun?: string
  run?: Runner
  provision?: typeof provisionImageBucket
  log?: (message: string) => void
}

function redact(output: string, secrets: readonly string[]): string {
  let result = output
  for (const secret of secrets.filter(Boolean)) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) result = result.split(value).join("[redacted]")
  }
  return result
}

function commandRunner(secrets: readonly string[], log: (message: string) => void): Runner {
  return async step => {
    const child = Bun.spawn(step.command, { cwd: step.cwd, env: step.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const output = redact(`${stdout}${stderr}`, secrets).trim()
    if (status !== 0) throw new Error(`${step.label} failed (exit ${status}).${output ? `\n${output.slice(-12000)}` : ""}`)
    if (output) log(output)
  }
}

/** Bootstrap or repeat a browser-only staging release. No production target is accepted. */
export async function deployStaging(options: DeployOptions = {}): Promise<void> {
  const root = options.root ?? path.resolve(import.meta.dirname, "..")
  const environment = options.environment ?? process.env
  const [publicText, workerText, template, canonicalText] = await Promise.all([
    readFile(path.join(root, "env/staging/.env.staging"), "utf8"),
    readFile(path.join(root, "wrangler.jsonc"), "utf8"),
    readFile(path.join(root, "supabase/staging/config.toml"), "utf8"),
    readFile(path.join(root, "supabase/config.toml"), "utf8"),
  ])
  const settings = stagingSettings(environment, parseEnv(publicText))
  validateStagingWorker(workerText, settings)
  const config = renderStagingConfig(template, settings)
  const canonical = Bun.TOML.parse(canonicalText)
  const log = options.log ?? console.log
  const run = options.run ?? commandRunner([settings.accessToken, settings.databasePassword, settings.secretKey, settings.publishableKey], log)
  const supabaseEnv = stagingDeploymentEnvironment(environment, settings)
  const browserEnv = stagingDeploymentEnvironment(environment)
  const bun = options.bun ?? process.execPath
  const temporary = await mkdtemp(path.join(tmpdir(), "elaborating-staging-"))
  try {
    await mkdir(path.join(temporary, "supabase"))
    await writeFile(path.join(temporary, "supabase/config.toml"), config, { mode: 0o600 })
    const functionEnvironment = path.join(temporary, "function.env")
    await writeFile(functionEnvironment, `ELABORATING_APP_ORIGIN=${settings.appOrigin}\n`, { mode: 0o600 })
    const cli = async (label: string, args: string[], workdir = root) => {
      log(label)
      await run({ label, command: [bun, "x", CLI_VERSION, ...args, "--project-ref", settings.projectId, "--workdir", workdir, "--yes"], cwd: root, env: supabaseEnv })
    }
    await cli("Setting staging invitation origin", ["secrets", "set", "--env-file", functionEnvironment])
    await cli("Deploying staging browser functions", ["functions", "deploy", ...STAGING_BROWSER_FUNCTIONS, "--use-api"])
    await cli("Applying staging migrations and Vault configuration", ["db", "push"])
    log("Provisioning the private staging image bucket")
    await (options.provision ?? provisionImageBucket)(settings.projectURL, settings.secretKey, canonical)
    await cli("Checking staging Auth configuration", ["config", "diff"], temporary)
    await cli("Applying staging Auth configuration", ["config", "push"], temporary)
    log("Building the staging app")
    await run({ label: "Building the staging app", command: [bun, "run", "build:staging"], cwd: root, env: browserEnv })
    log("Deploying the staging Worker")
    await run({ label: "Deploying the staging Worker", command: [bun, "x", "wrangler", "deploy", "--env", "staging"], cwd: root, env: browserEnv })
    log(`Staging is deployed at ${settings.appOrigin}. MCP, agent callbacks and production SMTP are not deployed.`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: bun scripts/deploy-staging.ts. Set the STAGING_ environment values; command overrides are not supported.")
    await deployStaging()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
