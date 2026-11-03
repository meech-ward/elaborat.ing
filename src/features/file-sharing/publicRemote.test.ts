import { describe, expect, test } from 'bun:test'
import { SharedBundle, SharedDiscussion, ShareToken, shareCommentRPC } from './publicRemote'
import { readShareDraft, saveShareDraft, forgetShareDraft, type ShareCommentDraft } from './commentDraft'

const SHARE = '11111111-1111-4111-8111-111111111111'
const FILE = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const bundle = () => ({share: {id: SHARE, file_id: FILE, path: 'notes/a.md', version: 3, revision: 5, archived: false}, files: [{id: FILE, path: 'notes/a.md', content: '# A', version: 3}], images: []})

describe('shared file boundaries', () => {
  test('accepts a complete root and rejects duplicate, unsafe or mismatched files', () => {
    expect(SharedBundle.safeParse(bundle()).success).toBe(true)
    for (const bad of [
      {...bundle(), files: []}, {...bundle(), files: [...bundle().files, ...bundle().files]},
      {...bundle(), share: {...bundle().share, version: 4}},
      {...bundle(), files: [{...bundle().files[0], path: '../secret.md'}]},
      {...bundle(), images: [{path: 'x.png', dataURL: 'https://external.test/image', width: 1, height: 1}]},
    ]) expect(SharedBundle.safeParse(bad).success).toBe(false)
    expect(ShareToken.safeParse('a'.repeat(64)).success).toBe(true)
    for (const token of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '../secret', 'A'.repeat(64)]) expect(ShareToken.safeParse(token).success).toBe(false)
  })
  test('rejects leaked email addresses and private agent provenance in public discussion', () => {
    const thread = {id: SHARE, file_id: FILE, path: 'notes/a.md', file_deleted: false, file_version: 3, anchor: {kind: 'document'},
      created_at: '2026-11-03T00:00:00Z', resolved_at: null, resolved_by: null,
      comments: [{id: FILE, author: {user_id: USER, email: null, name: 'Ada'}, via_agent: false, body: 'hello', created_at: '2026-11-03T00:00:00Z', edited_at: null, deleted_at: null}]}
    const discussion = {share_id: SHARE, file_id: FILE, file_version: 3, archived: false, can_moderate: false, threads: [thread]}
    expect(SharedDiscussion.safeParse(discussion).success).toBe(true)
    for (const change of [{author: {user_id: USER, email: 'private@example.test', name: 'Ada'}}, {author: {user_id: USER, email: null, name: 'private@example.test'}}, {via_agent: true}]) {
      expect(SharedDiscussion.safeParse({...discussion, threads: [{...thread, comments: [{...thread.comments[0], ...change}]}]}).success).toBe(false)
    }
  })
  test('pins a comment write to the initiating account and refuses a later account', async () => {
    let account = USER
    let pinned: string | null = null
    const client = {
      auth: {getSession: async () => ({data: {session: {user: {id: account}, access_token: 'first-session'}}, error: null})},
      rpc: () => ({setHeader: (_: string, value: string) => {account = OTHER; pinned = value; return Promise.resolve({data: {ok: true}, error: null})}}),
    }
    await shareCommentRPC('add_file_share_comment', {}, USER, async () => client as never)
    expect(pinned as string | null).toBe('Bearer first-session')
    await expect(shareCommentRPC('add_file_share_comment', {}, USER, async () => client as never)).rejects.toThrow('account changed')
  })
})

describe('sign-in comment drafts', () => {
  const draft = (): ShareCommentDraft => ({shareId: SHARE, fileId: FILE, fileVersion: 3, threadId: SHARE, commentId: FILE,
    anchor: {kind: 'document'}, body: 'Keep my comment', sourceOffset: 12345, scroll: 400, savedAt: 1000})
  const storage = () => {
    const values = new Map<string, string>()
    return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value)}, removeItem: (key: string) => {values.delete(key)}}
  }
  test('retains words, anchor, identity and reading position until explicitly cleared', () => {
    const memory = storage()
    saveShareDraft(draft(), memory, 777, 2000)
    expect(readShareDraft(SHARE, memory, 3000)).toEqual({...draft(), scroll: 777, savedAt: 2000})
    expect(readShareDraft(OTHER, memory, 3000)).toBeNull()
    forgetShareDraft(SHARE, memory)
    expect(readShareDraft(SHARE, memory, 3000)).toBeNull()
  })
  test('ignores malformed, expired and future records, and fails visibly before losing a draft', () => {
    const memory = storage(), key = 'elaborating.shared-comment.v1:' + SHARE
    for (const raw of ['{', 'x'.repeat(50_001), JSON.stringify({...draft(), shareId: OTHER}), JSON.stringify({...draft(), body: 'x'.repeat(10_001)}), JSON.stringify({...draft(), sourceOffset: -1})]) {
      memory.values.set(key, raw); expect(readShareDraft(SHARE, memory, 1000)).toBeNull()
    }
    saveShareDraft(draft(), memory, 0, 1000)
    expect(readShareDraft(SHARE, memory, 86_402_000)).toBeNull()
    expect(readShareDraft(SHARE, memory, -100_000)).toBeNull()
    const blocked = {getItem: () => {throw Error('blocked')}, setItem: () => {throw Error('blocked')}, removeItem: () => {throw Error('blocked')}}
    expect(readShareDraft(SHARE, blocked)).toBeNull()
    expect(() => saveShareDraft(draft(), blocked, 0)).toThrow('blocked')
    expect(() => forgetShareDraft(SHARE, blocked)).not.toThrow()
  })
})
