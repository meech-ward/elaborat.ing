import { useEffect, useState } from 'react'
import { downloadImageAsset } from './assetDownload'
import type { ImageAsset } from './types'

function Version({ projectId, asset, label }: { projectId: string; asset: ImageAsset | null; label: string }) {
  const [loaded, setLoaded] = useState<{ id: string; url?: string; error?: string } | null>(null)
  useEffect(() => {
    if (!asset) return
    let alive = true, url: string | undefined
    void downloadImageAsset(projectId, asset, true).then(blob => {
      if (!alive) return
      url = URL.createObjectURL(blob)
      setLoaded({ id: asset.id, url })
    }).catch((error: unknown) => { if (alive) setLoaded({ id: asset.id, error: error instanceof Error ? error.message : String(error) }) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [projectId, asset])
  return <figure className="min-w-0 flex-1 rounded border border-border p-3">
    <figcaption className="mb-2 text-xs text-muted-foreground">{label}</figcaption>
    {!asset ? <p className="text-muted-foreground">No image</p> : loaded?.id === asset.id && loaded.url ? <><img src={loaded.url} alt={`${label} preview`} width={asset.width} height={asset.height} className="max-h-64 max-w-full object-contain" /><p className="mt-2 text-xs text-muted-foreground">{asset.width} × {asset.height} · {Math.ceil(asset.byte_length / 1024)} kB</p></> : <p role={loaded?.error ? 'alert' : 'status'}>{loaded?.id === asset.id && loaded.error ? loaded.error : 'Loading image…'}</p>}
  </figure>
}
export function ImageVersions({ projectId, before, after }: { projectId: string; before: ImageAsset | null; after: ImageAsset | null }) {
  return <div className="flex flex-wrap gap-3"><Version projectId={projectId} asset={before} label="Before" /><Version projectId={projectId} asset={after} label="After" /></div>
}
