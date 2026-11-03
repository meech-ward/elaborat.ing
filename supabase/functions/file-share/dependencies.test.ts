import { assertEquals, assert } from 'jsr:@std/assert@1.0.19'
import { createClient } from 'npm:@supabase/supabase-js@2.108.2'
import { fileShareDependencies } from './dependencies.ts'

const TOKEN = 'a'.repeat(64)
function fake(result: unknown = []) {
  const calls: Array<{path: string; body: unknown}> = []
  const client = createClient('https://example.supabase.co', 'server-only-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push({path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null})
      // The canonical schema intentionally grants no service_role SELECT on
      // project_files. A direct table query is an integration regression.
      assert(url.pathname.startsWith('/rest/v1/rpc/file_share_'), 'Only token-scoped share RPCs may read the database')
      return Response.json(result)
    } },
  })
  return {calls, deps: fileShareDependencies(client)}
}
Deno.test('the SDK adapter uses capability RPCs and never reads project tables directly', async () => {
  const f = fake([{id: 'root', path: 'allowed.md'}])
  await f.deps.context(TOKEN)
  assertEquals((await f.deps.read(TOKEN, 'allowed.md')).data, {id: 'root', path: 'allowed.md'})
  assertEquals(f.calls, [
    {path: '/rest/v1/rpc/file_share_context', body: {token: TOKEN}},
    {path: '/rest/v1/rpc/file_share_dependencies', body: {token: TOKEN, paths: ['allowed.md']}},
  ])
})
Deno.test('missing or malformed dependency arrays cannot become a file record', async () => {
  for (const answer of [[], null, {id: 'wrong', path: 'private.md'}]) {
    const f = fake(answer)
    assertEquals((await f.deps.read(TOKEN, 'allowed.md')).data, null)
  }
})
