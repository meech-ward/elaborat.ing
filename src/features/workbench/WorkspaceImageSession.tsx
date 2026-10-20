import { useEffect, useState, type ReactNode } from 'react'
import { Banner } from '@/features/design-system'
import { LazyImageView } from '../images/LazyImages'
import { ImageConflictBanner } from './ImageConflictBanner'
import { FileHeader } from './FileHeader'
import type { WorkspaceFileRef, WorkspaceStore } from './workspaceStore'
import type { ConflictChoice } from '../project-storage/sync'

/** Image bytes are durable already. A standalone draft can be saved here too. */
export function WorkspaceImageSession({ path, file, client, active, navigation, readOnly, onResolveConflict, refreshList, onState }: {
  path: string; file?: WorkspaceFileRef; client: WorkspaceStore; active: boolean; navigation?: ReactNode; readOnly: string | null;
  onResolveConflict?: (choice: ConflictChoice) => Promise<void>; refreshList: () => Promise<void>;
  onState: (path: string, dirty: boolean, notice: string | null) => void;
}) {
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => { onState(path, Boolean(file?.draft), notice) }, [path, file?.draft, notice, onState])
  const save = async () => {
    if (saving || readOnly || !client.saveImages) return
    setSaving(true); setNotice(null)
    try {
      const paths = [path], seen = new Set<string>()
      for (let index = 0; index < paths.length; index++) {
        const next = paths[index]
        if (seen.has(next)) continue
        seen.add(next)
        const asset = await client.draftImageAsset?.(next)
        if (asset?.original_path && !seen.has(asset.original_path)) paths.push(asset.original_path)
      }
      await client.saveImages([...seen])
      await refreshList()
    } catch (error) { setNotice(`Image save failed: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <FileHeader path={path} active={active} navigation={navigation}
      save={!readOnly && file?.draft && client.saveImages ? { disabled: saving || file.conflict, onSave: () => void save() } : null}
      actions={!readOnly && file?.draft && client.saveImages ? [{ label: 'Save', disabled: saving || file.conflict, onSelect: () => void save() }] : []} />
    {notice && <Banner tone="warn">{notice}</Banner>}
    {file?.conflict && <ImageConflictBanner path={path} client={client} draft={file.draft} onResolveConflict={readOnly ? undefined : onResolveConflict} />}
    {client.readImage && file?.asset ? <LazyImageView path={path} asset={file.asset} readImage={client.readImage} /> : <Banner tone="warn">This image has not downloaded completely. Connect and sync to download it.</Banner>}
  </div>
}
