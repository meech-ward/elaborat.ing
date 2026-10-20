import { useEffect, useState } from "react"
import { Download, Maximize2, Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { downloadBlob } from "@/features/workbench/download"
import type { ImageAsset } from "./types"

type LoadedImage = { path: string; id: string; original: Blob; url: string; animated: boolean }
export type ImageViewProps = {
  path: string
  asset: ImageAsset
  readImage: (path: string, preview?: boolean) => Promise<Blob>
  onError?: (message: string) => void
}

/** Animated originals reach an image element only after an explicit Play action. */
export function ImageView({ path, asset, readImage, onError }: ImageViewProps) {
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [playback, setPlayback] = useState<{ image: LoadedImage; url: string } | null>(null)
  const [failure, setFailure] = useState<{ path: string; id: string; text: string } | null>(null)
  const [enlarged, setEnlarged] = useState(false)
  useEffect(() => {
    let live = true
    let url: string | null = null
    void (async () => {
      const original = await readImage(path)
      const { inspectImage } = await import("./format")
      const animated = inspectImage(new Uint8Array(await original.arrayBuffer()), asset.media_type).animated
      let shown = original
      if (animated) {
        shown = await readImage(path, true)
        const header = inspectImage(new Uint8Array(await shown.arrayBuffer()), shown.type)
        if (header.animated) {
          const { prepareImage } = await import("./prepare")
          shown = (await prepareImage(original, asset.object_key.split("/")[0])).preview
        }
      }
      if (!live) return
      url = URL.createObjectURL(shown)
      setLoaded({ path, id: asset.id, original, url, animated })
      setFailure(null)
    })().catch((cause: unknown) => {
      if (!live) return
      const text = cause instanceof Error ? cause.message : String(cause)
      setFailure({ path, id: asset.id, text })
      onError?.(text)
    })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [path, asset.id, asset.media_type, asset.object_key, readImage, onError])
  useEffect(() => () => { if (playback) URL.revokeObjectURL(playback.url) }, [playback, loaded])
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)")
    const pause = () => { if (reduced.matches) setPlayback(null) }
    reduced.addEventListener("change", pause)
    return () => reduced.removeEventListener("change", pause)
  }, [])
  const image = loaded?.path === path && loaded.id === asset.id ? loaded : null
  const playing = Boolean(image && playback?.image === image)
  const url = image ? playing ? playback!.url : image.url : null
  const error = failure?.path === path && failure.id === asset.id ? failure.text : null
  const name = path.split("/").at(-1) ?? path
  const playButton = image?.animated ? <Button variant="outline" aria-pressed={playing} onClick={() => setPlayback(playing ? null : { image, url: URL.createObjectURL(image.original) })}>
    {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{playing ? "Pause animation" : "Play animation"}
  </Button> : null
  return <section className="flex h-full min-h-0 flex-col gap-3 p-4" aria-label={`Image ${name}`}>
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 break-all text-sm text-muted-foreground">{name} · {asset.width} × {asset.height} · {(asset.byte_length / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} kB</p>
      {playButton}
      <Button variant="outline" disabled={!url} onClick={() => setEnlarged(true)}><Maximize2 aria-hidden="true" />Enlarge</Button>
      <Button variant="outline" disabled={!image} onClick={() => { if (image) downloadBlob(image.original, name) }}><Download aria-hidden="true" />Download image</Button>
    </div>
    {image?.animated && <p role="status" className="text-xs text-muted-foreground">{playing ? "Animation playing." : "Animation paused. Play to view the original animation."}</p>}
    {error ? <p role="alert" className="text-destructive">{error}</p> : url ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded border border-border bg-white p-3">
      <img src={url} alt={name} width={asset.width} height={asset.height} className="max-h-full max-w-full object-contain" />
    </div> : <p role="status" className="text-muted-foreground">Loading image…</p>}
    <Dialog open={enlarged && Boolean(url)} onOpenChange={setEnlarged}>
      <DialogContent className="sm:max-w-[calc(100%-2rem)]">
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription className="sr-only">Full image. Press Escape to close.</DialogDescription>
        {playButton}
        {url && <div className="max-h-[80dvh] overflow-auto rounded bg-white"><img src={url} alt={name} width={asset.width} height={asset.height} className="mx-auto h-auto max-w-full" /></div>}
      </DialogContent>
    </Dialog>
  </section>
}
