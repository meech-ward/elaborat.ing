import { expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script = path.join(import.meta.dirname, 'configure-agent-preview.ts')
const fixtureSecret = 'fixture_preview_credential_'.repeat(2)
interface Capture {
  args: string[]
  rejected?: string
  filename?: string
  mode?: number
  secrets?: Record<string, string>
}
async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true } catch { return false }
}

/** Real CLI subprocess, but every bunx invocation is a refusing local fixture. */
async function invoke(args: string[], secret = fixtureSecret, fail = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'configure-preview-test-'))
  try {
    const bin = path.join(directory, 'bin'), capturePath = path.join(directory, 'capture.json')
    await mkdir(bin)
    await writeFile(path.join(bin, 'bunx'), `#!${process.execPath}
import { readFile, stat, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), result = {args};
if (args[0] !== 'wrangler' || args[1] !== 'deploy') {
  result.rejected = 'A newer staged version prevents the old secret put command';
  await writeFile(process.env.PREVIEW_TEST_CAPTURE, JSON.stringify(result));
  process.exit(42);
}
const index = args.indexOf('--secrets-file');
if (index !== -1) {
  result.filename = args[index + 1];
  result.mode = (await stat(result.filename)).mode & 0o777;
  result.secrets = JSON.parse(await readFile(result.filename, 'utf8'));
}
await writeFile(process.env.PREVIEW_TEST_CAPTURE, JSON.stringify(result));
process.exit(process.env.PREVIEW_TEST_FAIL === '1' ? 23 : 0);
`, { mode: 0o700 })
    const child = Bun.spawn([process.execPath, script, ...args], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: directory,
        AGENT_PREVIEW_SECRET: secret, PREVIEW_TEST_CAPTURE: capturePath, PREVIEW_TEST_FAIL: fail ? '1' : '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    const captured = await exists(capturePath) ? JSON.parse(await readFile(capturePath, 'utf8')) as Capture : undefined
    return { exitCode, stdout, stderr, captured,
      secretFileExists: captured?.filename ? await exists(captured.filename) : false,
      secretDirectoryExists: captured?.filename ? await exists(path.dirname(captured.filename)) : false }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('a staged Worker receives code and its sole preview credential in one atomic deploy', async () => {
  const result = await invoke(['cloudflare', '--dry-run'])
  expect(result.exitCode).toBe(0)
  expect(result.captured?.rejected).toBeUndefined()
  expect(result.captured?.args).toEqual(['wrangler', 'deploy', '--dry-run', '--secrets-file', result.captured?.filename])
  expect(result.captured?.secrets).toEqual({ AGENT_PREVIEW_SECRET: fixtureSecret })
  expect(result.captured?.mode).toBe(0o600)
  expect(result.secretFileExists).toBe(false)
  expect(result.secretDirectoryExists).toBe(false)
  expect(result.stdout + result.stderr).not.toContain(fixtureSecret)
})

test('an optional missing preview credential still deploys the app without a secrets file', async () => {
  const result = await invoke(['cloudflare'], '')
  expect(result.exitCode).toBe(0)
  expect(result.captured?.args).toEqual(['wrangler', 'deploy'])
  expect(result.captured?.filename).toBeUndefined()
  expect(result.captured?.secrets).toBeUndefined()
})

test('a failed deployment reports failure and removes the temporary credential file and directory', async () => {
  const result = await invoke(['cloudflare'], fixtureSecret, true)
  expect(result.exitCode).not.toBe(0)
  expect(result.captured?.args[1]).toBe('deploy')
  expect(result.captured?.secrets).toEqual({ AGENT_PREVIEW_SECRET: fixtureSecret })
  expect(result.secretFileExists).toBe(false)
  expect(result.secretDirectoryExists).toBe(false)
  expect(result.stderr).toContain('The Cloudflare app could not be deployed.')
  expect(result.stdout + result.stderr).not.toContain(fixtureSecret)
})

test('invalid credentials and unsupported CLI arguments fail before any deployment process', async () => {
  const invalidSecret = await invoke(['cloudflare'], 'invalid credential!')
  expect(invalidSecret.exitCode).not.toBe(0)
  expect(invalidSecret.captured).toBeUndefined()
  for (const args of [[], ['elsewhere'], ['cloudflare', '--unknown'], ['cloudflare', '--dry-run', '--dry-run'], ['supabase', '--dry-run']]) {
    const result = await invoke(args, '')
    expect(result.exitCode).not.toBe(0)
    expect(result.captured).toBeUndefined()
    expect(result.stderr).toContain('Usage:')
  }
})

test('the Supabase target retains its no-credential no-op behavior', async () => {
  const result = await invoke(['supabase'], '')
  expect(result.exitCode).toBe(0)
  expect(result.captured).toBeUndefined()
  expect(result.stdout).toContain('keeping previews unavailable')
})
