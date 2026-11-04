import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"

/** Bun may preload the root .env.local before this launcher runs. */
export function stagingEnvironment(
  environment: Record<string, string | undefined>,
  publicEnvironment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const staging = { ...environment }
  for (const name of Object.keys(staging)) {
    if (name.startsWith("VITE_")) delete staging[name]
  }
  // Vite prioritizes process env over every dotenv file, including .local.
  // Pin the committed destination and flags rather than letting an ignored
  // staging override point the frontend somewhere the deploy guards reject.
  for (const [name, value] of Object.entries(publicEnvironment)) {
    if (name.startsWith("VITE_") && value !== undefined) staging[name] = value
  }
  return staging
}

/** Fixed options keep staging's environment, output and local port isolated. */
export function stagingCommand(args: readonly string[], viteBin: string): string[] {
  const [mode] = args
  if (args.length !== 1 || !["dev", "build", "preview"].includes(mode)) {
    throw new Error("Usage: bun scripts/staging.ts <dev|build|preview>. Extra arguments are not supported.")
  }
  return [
    "node", viteBin,
    ...(mode === "dev" ? [] : [mode]),
    "--mode", "staging", "--config", "vite.config.ts",
    ...(mode === "build" ? [] : ["--host", "localhost", "--port", "5174", "--strictPort"]),
    ...(mode === "dev" ? [] : ["--outDir", "dist-staging"]),
  ]
}

async function run(): Promise<number> {
  // Node does not preload Bun's root dotenv files. The committed public
  // settings also outrank local overrides in Vite's staging envDir.
  const viteBin = fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json")))
  const command = stagingCommand(process.argv.slice(2), viteBin)
  const publicEnvironment = parseEnv(await readFile(new URL("../env/staging/.env.staging", import.meta.url), "utf8"))
  const child = Bun.spawn(command, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: stagingEnvironment(process.env, publicEnvironment),
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  })
  const interrupt = () => { if (child.exitCode === null) child.kill("SIGINT") }
  const terminate = () => { if (child.exitCode === null) child.kill("SIGTERM") }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

if (import.meta.main) {
  try {
    process.exit(await run())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
