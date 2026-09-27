import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { handleShare, type Caller, type Prepared, type ShareDeps } from './handler.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const BOB = '22222222-2222-4222-8222-222222222222'
const NEW = '66666666-6666-4666-8666-666666666666'
const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001'

const owner: Caller = { id: OWNER, clientId: null }
const body = { projectId: PROJECT, email: '  New@Example.com ', role: 'editor' }

/** A fake database and Auth: Bob has an account, anything else does not; `limit` more invitations are allowed today. */
function fake({ limit = 50, accounts = { 'bob@example.com': BOB } as Record<string, string> } = {}) {
  const calls: Array<[string, unknown]> = []
  let sent = 0
  const deps: ShareDeps = {
    readProject: async (projectId) => {
      calls.push(['readProject', projectId])
      return { data: projectId === PROJECT ? { owner_id: OWNER, title: 'Team notes' } : null, error: null }
    },
    prepare: async (args) => {
      calls.push(['prepare', args])
      if (args.inviter_id !== OWNER) return { data: null, error: { code: '42501', message: 'Only the project owner can change sharing' } }
      if (sent >= limit) return { data: null, error: { code: 'PT429', message: 'You have reached the limit of 50 invitations a day. Try again in 5 hours.' } }
      sent++
      const prepared: Prepared = { member_id: accounts[args.email] ?? null, title: 'Team notes', inviter_email: 'owner@example.com' }
      return { data: prepared, error: null }
    },
    shareProject: async (args) => {
      calls.push(['shareProject', args])
      return { data: { project_id: args.project_id }, error: null }
    },
    inviteUserByEmail: async (email, options) => {
      calls.push(['inviteUserByEmail', { email, ...options }])
      return { data: { user: { id: NEW } }, error: null }
    },
    record: async (args) => {
      calls.push(['record', args])
      return { data: { project_id: args.project_id }, error: null }
    },
    redirectTo: 'https://elaborat.ing/',
  }
  return { deps, calls }
}

Deno.test('a token issued to an OAuth client is refused before anything is read', async () => {
  const { deps, calls } = fake()
  const response = await handleShare({ id: OWNER, clientId: 'client-1' }, body, deps)
  assertEquals(response.status, 403)
  assertEquals(await response.json(), { error: 'Only a signed-in person can invite people by email' })
  assertEquals(calls, [])
})

Deno.test('someone who does not own the project is refused before any account is looked up', async () => {
  const { deps, calls } = fake()
  const response = await handleShare({ id: OTHER, clientId: null }, body, deps)
  assertEquals(response.status, 403)
  assertEquals(await response.json(), { error: 'Only the project owner can change sharing' })
  assertEquals(calls, [['readProject', PROJECT]])
})

Deno.test('a project the caller cannot read is refused the same way', async () => {
  const { deps, calls } = fake()
  const response = await handleShare(owner, { ...body, projectId: 'bbbbbbbb-0000-4000-8000-000000000002' }, deps)
  assertEquals(response.status, 403)
  assertEquals(calls.map(([name]) => name), ['readProject'])
})

Deno.test('an email with an account gets the usual invitation, as the caller, and no email', async () => {
  const { deps, calls } = fake()
  const response = await handleShare(owner, { ...body, email: 'Bob@Example.com', role: 'viewer' }, deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { projectId: PROJECT, email: 'bob@example.com', role: 'viewer' })
  assertEquals(calls, [
    ['readProject', PROJECT],
    ['prepare', { inviter_id: OWNER, project_id: PROJECT, email: 'bob@example.com' }],
    ['shareProject', { project_id: PROJECT, member_id: BOB, member_role: 'viewer' }],
  ])
})

Deno.test('an email without an account gets an invitation email naming the owner and project, then the invitation', async () => {
  const { deps, calls } = fake()
  const response = await handleShare(owner, body, deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { projectId: PROJECT, email: 'new@example.com', role: 'editor' })
  assertEquals(calls, [
    ['readProject', PROJECT],
    ['prepare', { inviter_id: OWNER, project_id: PROJECT, email: 'new@example.com' }],
    [
      'inviteUserByEmail',
      { email: 'new@example.com', redirectTo: 'https://elaborat.ing/', data: { invited_by: 'owner@example.com', project_title: 'Team notes' } },
    ],
    ['record', { inviter_id: OWNER, project_id: PROJECT, member_id: NEW, member_role: 'editor' }],
  ])
})

Deno.test('past the daily limit, the owner gets a clear refusal and nobody is invited', async () => {
  const { deps, calls } = fake({ limit: 2 })
  assertEquals((await handleShare(owner, body, deps)).status, 200)
  assertEquals((await handleShare(owner, { ...body, email: 'bob@example.com' }, deps)).status, 200)
  const response = await handleShare(owner, { ...body, email: 'third@example.com' }, deps)
  assertEquals(response.status, 429)
  assertEquals(await response.json(), { error: 'You have reached the limit of 50 invitations a day. Try again in 5 hours.' })
  assertEquals(calls.filter(([name]) => name === 'inviteUserByEmail' || name === 'shareProject').length, 2)
  assertEquals(calls.at(-1)?.[0], 'prepare')
})

Deno.test('a bad email, role or project id is refused without reading anything', async () => {
  const { deps, calls } = fake()
  const bad = await handleShare(owner, { ...body, email: 'not an email' }, deps)
  assertEquals([bad.status, await bad.json()], [400, { error: 'Enter an email address' }])
  assertEquals((await handleShare(owner, { ...body, role: 'owner' }, deps)).status, 400)
  assertEquals((await handleShare(owner, { ...body, projectId: 'p' }, deps)).status, 400)
  assertEquals((await handleShare(owner, null, deps)).status, 400)
  assertEquals(calls, [])
})

Deno.test('the owner inviting their own email gets the database refusal', async () => {
  const { deps } = fake()
  deps.prepare = async () => ({ data: null, error: { code: '22023', message: 'You own this project already' } })
  const response = await handleShare(owner, { ...body, email: 'owner@example.com' }, deps)
  assertEquals([response.status, await response.json()], [400, { error: 'You own this project already' }])
})

Deno.test('when Auth cannot send the email, no invitation is recorded and the reason is not leaked', async () => {
  const { deps, calls } = fake()
  deps.inviteUserByEmail = async () => ({ data: { user: null }, error: { message: 'smtp: 535 authentication failed', status: 500 } })
  const response = await handleShare(owner, body, deps)
  assertEquals([response.status, await response.json()], [502, { error: 'The invitation email could not be sent. Try again later.' }])
  assertEquals(calls.some(([name]) => name === 'record'), false)
})

Deno.test('an unexpected database error is not shown to the caller', async () => {
  const { deps } = fake()
  deps.prepare = async () => ({ data: null, error: { code: 'XX000', message: 'internal detail' } })
  const response = await handleShare(owner, body, deps)
  assertEquals([response.status, await response.json()], [500, { error: 'The project could not be shared. Try again.' }])
})
