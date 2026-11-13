import { expect, test } from 'bun:test'
import { device, FakeProjectServer } from './testing'

test('nested empty folders expose every usable parent without persisting implied folders', async () => {
  const a = device(new FakeProjectServer())
  const { id } = await a.sync.createProject('Nested empty folders')
  const store = a.files(id)
  await store.createDirectories(['docs/deep/empty', 'docs/other', 'z/empty'])

  const entries = await store.listEntries()
  expect(entries.files).toEqual([])
  expect(entries.directories).toEqual(['docs', 'docs/deep', 'docs/deep/empty', 'docs/other', 'z', 'z/empty'])
  expect(entries.folders).toEqual(['docs/deep/empty', 'docs/other', 'z/empty'])
  expect((await a.db.transaction(a.partition, 'readonly', tx => tx.listFolders(id))).map(folder => folder.path).sort()).toEqual(entries.folders)
  expect((await a.files(id).listEntries()).directories).toEqual(entries.directories)
})

test('folder ancestors remain usable after sync and a fresh device download, and disappear after their last child is removed', async () => {
  const server = new FakeProjectServer()
  const a = device(server)
  const { id } = await a.sync.createProject('Synced empty folders')
  const store = a.files(id)
  await store.createDirectory('archive/2026')
  expect((await a.sync.sync(id)).status).toBe('synced')

  const b = device(server)
  const project = (await b.sync.refresh()).find(project => project.id === id)!
  await b.sync.download(project)
  expect(await b.files(id).listEntries()).toMatchObject({ directories: ['archive', 'archive/2026'], folders: ['archive/2026'] })

  await store.removeDirectory('archive/2026')
  expect((await a.sync.sync(id)).status).toBe('synced')
  expect((await b.sync.sync(id)).status).toBe('synced')
  expect(await b.files(id).listEntries()).toMatchObject({ directories: [], folders: [] })
})

test('explicit folders, files and drafts share one unique ancestor listing while removed folders leave no phantom parents', async () => {
  const a = device(new FakeProjectServer())
  const { id } = await a.sync.createProject('Mixed directory sources')
  const store = a.files(id)
  await store.createDirectories(['docs/deep', 'docs/empty'])
  const saved = await store.write('docs/readme.md', 'Saved text.', null)
  await store.persistDrafts([{ path: 'docs/deep/draft.md', content: 'Unsaved text.', baseRevision: null }])
  expect((await store.listEntries()).directories).toEqual(['docs', 'docs/deep', 'docs/empty'])

  await store.removeDirectory('docs/empty')
  await store.removeDirectory('docs/deep')
  expect(await store.listEntries()).toMatchObject({ directories: ['docs', 'docs/deep'], folders: [] })
  await store.discardDraft('docs/deep/draft.md')
  expect((await store.listEntries()).directories).toEqual(['docs'])
  await store.delete('docs/readme.md', saved.revision)
  expect((await store.listEntries()).directories).toEqual([])
})
