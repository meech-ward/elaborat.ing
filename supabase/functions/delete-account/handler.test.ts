import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { handleDeleteAccount, type Caller, type DeleteAccountDeps } from './handler.ts'

const PERSON = '11111111-1111-4111-8111-111111111111'
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001'
const SOLO = 'aaaaaaaa-0000-4000-8000-000000000002'

const person: Caller = { id: PERSON, clientId: null }
const body = { email: '  Person@Example.com ' }

/** A fake database and Auth: the person owns Team and Solo; `limit` more attempts are allowed today. */
function fake({
  session = 'live' as 'live' | 'ended' | 'unreachable',
  limit = 5,
  email = 'person@example.com' as string | null,
  exists = true,
  failProject = null as string | null,
  failUser = false,
} = {}) {
  const calls: Array<[string, unknown?]> = []
  let attempts = 0
  const deps: DeleteAccountDeps = {
    checkSession: async () => {
      calls.push(['checkSession'])
      return session === 'unreachable' ? { error: { message: 'fetch failed', status: 0 } } : session
    },
    readAccount: async (userId) => {
      calls.push(['readAccount', userId])
      return { data: exists ? { email } : null, error: null }
    },
    begin: async () => {
      calls.push(['begin'])
      if (attempts >= limit) return { data: null, error: { code: 'PT429', message: 'You have reached the limit of 5 account deletion attempts a day. Try again in 5 hours.' } }
      attempts++
      return { data: { owned: [{ id: SOLO, title: 'Solo', archived: false, members: 0 }, { id: TEAM, title: 'Team', archived: false, members: 2 }], shared: 1 }, error: null }
    },
    deleteProject: async (projectId) => {
      calls.push(['deleteProject', projectId])
      if (projectId === failProject) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      return { data: { id: projectId, deleted: true }, error: null }
    },
    deleteUser: async (userId) => {
      calls.push(['deleteUser', userId])
      return { error: failUser ? { message: 'Database error deleting user', status: 500 } : null }
    },
  }
  return { deps, calls }
}

Deno.test('a token issued to an OAuth client is refused before anything is read', async () => {
  const { deps, calls } = fake()
  const response = await handleDeleteAccount({ id: PERSON, clientId: 'client-1' }, body, deps)
  assertEquals(response.status, 403)
  assertEquals(await response.json(), { error: 'Only a signed-in person can delete their account' })
  assertEquals(calls, [])
})

Deno.test('a body without an email is refused before anything is read', async () => {
  const { deps, calls } = fake()
  const response = await handleDeleteAccount(person, { confirm: true }, deps)
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Type your email to confirm' })
  assertEquals(calls, [])
})

Deno.test('an email that is not the account\'s deletes nothing and counts nothing', async () => {
  const { deps, calls } = fake()
  const response = await handleDeleteAccount(person, { email: 'someone@example.com' }, deps)
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'That is not the email of this account' })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession']])
})

Deno.test('an account without an email cannot confirm', async () => {
  const { deps, calls } = fake({ email: null })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'This account has no email to confirm with' })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession']])
})

Deno.test('a token from a session that has signed out deletes nothing and counts nothing', async () => {
  const { deps, calls } = fake({ session: 'ended' })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 401)
  assertEquals(await response.json(), { error: 'You are signed out. Sign in again to delete your account.' })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession']])
})

Deno.test('when the session cannot be checked, nothing is deleted', async () => {
  const { deps, calls } = fake({ session: 'unreachable' })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 502)
  assertEquals(await response.json(), { error: 'Your account could not be checked. Nothing was changed. Try again.' })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession']])
})

Deno.test('the owned projects are deleted as the caller, then the account', async () => {
  const { deps, calls } = fake()
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { deleted: true, projects: 2 })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession'], ['begin'], ['deleteProject', SOLO], ['deleteProject', TEAM], ['deleteUser', PERSON]])
})

Deno.test('over the daily limit, nothing is deleted and the message says when to try again', async () => {
  const { deps, calls } = fake({ limit: 0 })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 429)
  assertEquals(await response.json(), { error: 'You have reached the limit of 5 account deletion attempts a day. Try again in 5 hours.' })
  assertEquals(calls, [['readAccount', PERSON], ['checkSession'], ['begin']])
})

Deno.test('the database refusing an agent is passed on as 403', async () => {
  const { deps } = fake()
  deps.begin = async () => ({ data: null, error: { code: '42501', message: 'Only a signed-in person can delete their account' } })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 403)
  assertEquals(await response.json(), { error: 'Only a signed-in person can delete their account' })
})

Deno.test('a project that cannot be deleted stops before the account, and says how far it got', async () => {
  const { deps, calls } = fake({ failProject: TEAM })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 500)
  assertEquals(await response.json(), { error: '1 of your 2 projects were deleted, and your account was not. Try again.' })
  assertEquals(calls.some(([name]) => name === 'deleteUser'), false)
})

Deno.test('the account failing to delete after its projects says so', async () => {
  const { deps } = fake({ failUser: true })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 502)
  assertEquals(await response.json(), { error: 'Your projects were deleted, but your account could not be. Try again.' })
})

Deno.test('an account already deleted answers as deleted, so the app can finish signing out', async () => {
  const { deps, calls } = fake({ exists: false })
  const response = await handleDeleteAccount(person, body, deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { deleted: true, projects: 0 })
  assertEquals(calls, [['readAccount', PERSON]])
})
