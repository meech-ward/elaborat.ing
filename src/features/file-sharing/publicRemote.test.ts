import { describe, expect, test } from 'bun:test'
import { SharedBundle, SharedDiscussion, ShareToken, shareCommentRPC, readSharedStream } from './publicRemote'
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


describe('progressive shared response boundary', () => {
  const events = () => [{type: 'start', share: bundle().share},
    {type: 'file', file: {...bundle().files[0], content: '# Ready café 🌱'}, pendingPaths: ['child.md'], pendingImages: []},
    {type: 'file', file: {id: OTHER, path: 'child.md', content: '# Child', version: 1}, pendingPaths: [], pendingImages: []}, {type: 'complete'}]
  const response = (records: unknown[], chunk = 1) => {
    const data = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join('\n') + '\n')
    return new Response(new ReadableStream<Uint8Array>({start(controller) {
      for (let offset = 0; offset < data.length; offset += chunk) controller.enqueue(data.slice(offset, offset + chunk))
      controller.close()
    }}))
  }
  test('complete UTF-8 records publish independently and retain previous file identity', async () => {
    const progress: SharedBundle[] = []
    const result = await readSharedStream(response(events()), partial => progress.push(partial))
    expect(progress[0].files).toHaveLength(1)
    expect(progress[0].files[0].content).toBe('# Ready café 🌱')
    expect(progress[0].complete).toBe(false)
    expect(progress[1].files[0]).toBe(progress[0].files[0])
    expect(result.complete).toBe(true)
    expect(result.files).toHaveLength(2)
  })
  test('truncated and revoked streams fail after partial availability instead of becoming export-ready', async () => {
    await expect(readSharedStream(response(events().slice(0, -1)))).rejects.toThrow('before loading completed')
    const seen: SharedBundle[] = []
    await expect(readSharedStream(response([...events().slice(0, 2), {type: 'error', status: 404, error: 'Unavailable'}]), partial => seen.push(partial))).rejects.toThrow('This link is unavailable.')
    expect(seen).toHaveLength(1)
    expect(seen[0].complete).toBe(false)
  })
  test('a missing authorized child stays local while undeclared error paths are rejected', async () => {
    const result = await readSharedStream(response([...events().slice(0, 2), {type: 'file-error', path: 'child.md'}, {type: 'complete'}]))
    expect(result.files[0].content).toBe('# Ready café 🌱')
    expect(result.fileErrors).toEqual(['child.md'])
    await expect(readSharedStream(response([...events().slice(0, 2), {type: 'file-error', path: 'private.md'}, {type: 'complete'}]))).rejects.toThrow('manifest is invalid')
  })
  test('rejects undeclared nonroot records even when they declare their own safe path', async () => {
    const extra = {type: 'file', file: {id: USER, path: 'unrelated.md', content: 'Unrelated private source', version: 1}, pendingPaths: ['unrelated.md'], pendingImages: []}
    const seen: SharedBundle[] = []
    await expect(readSharedStream(response([...events().slice(0, 2), extra, ...events().slice(2)]), partial => seen.push(partial))).rejects.toThrow('not declared')
    expect(seen).toHaveLength(1)
    expect(seen[0].files.some(file => file.path === 'unrelated.md')).toBe(false)
    await expect(readSharedStream(response([events()[0], extra, ...events().slice(1)]))).rejects.toThrow('root file')
  })
  test('rejects an aggregate declared graph beyond the server file budget', async () => {
    const root = {...events()[1], pendingPaths: Array.from({length: 128}, (_, index) => `missing-${index}.md`)}
    await expect(readSharedStream(response([events()[0], root]))).rejects.toThrow('too large')
  })
  test('a malformed event cancels the remaining body and cannot publish a source prefix', async () => {
    let canceled = false
    const received = new Response(new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({type: 'start', share: bundle().share}) + '\n' + '{"type":"file","file":false}\n'))
    }, cancel() {canceled = true}}))
    const seen: SharedBundle[] = []
    await expect(readSharedStream(received, partial => seen.push(partial))).rejects.toThrow()
    expect(canceled).toBe(true)
    expect(seen).toEqual([])
  })
})
