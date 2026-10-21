import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { prepareImage, type PreparedImage } from "./prepare"
import { MAX_IMAGE_INTENT_FILES, MAX_IMAGE_INTENT_BYTES } from "./transport"
import { MAX_IMAGE_BYTES, type ImageAsset } from "./types"
import { safeImagePath } from "./paths"

export type ImageChoice = { prepared?: PreparedImage; existingPath?: string; alt: string; caption?: string }
export type ImagePickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  target?: "note" | "drawing"
  images: Array<{ path: string; asset?: ImageAsset | null }>
  /** Images supplied by a paste or a drop before the picker opened. */
  files?: File[]
  /** Existing reference description, including an explicit empty decorative description. */
  initialAlt?: string
  readImage?: (path: string, preview?: boolean) => Promise<Blob>
  onChoose?: (choice: ImageChoice) => Promise<void>
  onChooseMany?: (choices: ImageChoice[]) => Promise<void>
  importFromURL?: (url: string, signal?: AbortSignal) => Promise<PreparedImage>
}

/** The trusted app owns selection and decoding. No upload starts before Insert. */
export function ImagePicker(props: ImagePickerProps) {
  const inserting = useRef(false)
  const operation = useRef<AbortController | null>(null)
  const beginOperation = useCallback(() => {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    return controller.signal
  }, [])
  const cancelOperation = useCallback(() => operation.current?.abort(), [])
  return <Dialog open={props.open} onOpenChange={(open) => { if (!inserting.current) { if (!open) operation.current?.abort(); props.onOpenChange(open) } }}>
    {props.open && <PickerContent {...props} beginOperation={beginOperation} cancelOperation={cancelOperation} onInsertingChange={(busy) => { inserting.current = busy }} />}
  </Dialog>
}

function PickerContent({ projectId, target = "note", images, files = [], initialAlt, readImage, onChoose, onChooseMany, onOpenChange, importFromURL, onInsertingChange, beginOperation, cancelOperation }: ImagePickerProps & { onInsertingChange: (busy: boolean) => void; beginOperation: () => AbortSignal; cancelOperation: () => void }) {
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++; cancelOperation() }, [cancelOperation])
  const [pending, setPending] = useState(files.length > 0)
  const [inserting, setInserting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<PreparedImage[]>([])
  const [confirmed, setConfirmed] = useState<ImageChoice[]>([])
  const [existingPath, setExistingPath] = useState("")
  const [alt, setAlt] = useState(initialAlt ?? "")
  const [caption, setCaption] = useState("")
  const [edits, setEdits] = useState<{ key: string; x: string; y: string; cropWidth: string; cropHeight: string; width: string; height: string; lock: boolean } | null>(null)
  const [decorative, setDecorative] = useState(initialAlt === "")
  const [url, setURL] = useState("")
  const [preview, setPreview] = useState<string | null>(null)
  const prepared = queue[0]
  const selected = images.find((image) => image.path === existingPath)
  const asset = prepared?.asset ?? selected?.asset
  const busy = pending || inserting
  const edit = asset ? edits?.key === asset.id ? edits : { key: asset.id, x: "0", y: "0", cropWidth: String(asset.width), cropHeight: String(asset.height), width: String(asset.width), height: String(asset.height), lock: true } : null

  useEffect(() => {
    let live = true
    let objectURL: string | null = null
    const blob = prepared ? Promise.resolve(prepared.preview) : existingPath && readImage ? readImage(existingPath, true) : null
    queueMicrotask(() => { if (live) setPreview(null) })
    if (blob) void blob.then((image) => {
      if (!live) return
      objectURL = URL.createObjectURL(image)
      setPreview(objectURL)
    }).catch((cause: unknown) => { if (live) setError(message(cause)) })
    return () => { live = false; if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [prepared, existingPath, readImage])

  useEffect(() => {
    if (!files.length) return
    const run = ++generation.current
    let live = true
    void prepareFiles(files, projectId).then((next) => {
      if (!live || run !== generation.current) return
      setQueue(next)
      setPending(false)
    }).catch((cause: unknown) => {
      if (!live || run !== generation.current) return
      setError(message(cause))
      setPending(false)
    })
    return () => { live = false }
  }, [files, projectId])

  const chooseFiles = async (chosen: File[]) => {
    if (!chosen.length || busy) return
    if (initialAlt !== undefined && chosen.length > 1) { setError("Choose one replacement image."); return }
    const run = ++generation.current
    setPending(true)
    setError(null)
    try {
      const next = await prepareFiles(chosen, projectId)
      if (run !== generation.current) return
      setQueue(next)
      setConfirmed([])
      setExistingPath("")
      setAlt(initialAlt ?? "")
      setDecorative(initialAlt === "")
    } catch (cause) { if (run === generation.current) setError(message(cause)) }
    finally { if (run === generation.current) setPending(false) }
  }

  const insert = async () => {
    if (busy || (!prepared && !existingPath)) return
    if (!decorative && !alt.trim()) { setError("Describe the image, or choose Decorative."); return }
    const choice: ImageChoice = { ...(prepared ? { prepared } : { existingPath }), alt: decorative ? "" : alt.trim(), ...(caption.trim() ? { caption: caption.trim() } : {}) }
    if (queue.length > 1) {
      setConfirmed((choices) => [...choices, choice])
      setQueue((items) => items.slice(1))
      setAlt("")
      setCaption("")
      setDecorative(false)
      setError(null)
      return
    }
    setInserting(true)
    onInsertingChange(true)
    setError(null)
    try {
      const choices = [...confirmed, choice]
      if (onChooseMany) await onChooseMany(choices)
      else if (onChoose) for (const selected of choices) await onChoose(selected)
      else throw new Error("Image insertion is unavailable.")
      onOpenChange(false)
    } catch (cause) { setError(message(cause)) }
    finally { setInserting(false); onInsertingChange(false) }
  }

  return <DialogContent className="sm:max-w-lg" aria-busy={busy} showCloseButton={!inserting}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault() }}
    onDrop={(event) => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      void chooseFiles([...event.dataTransfer.files])
    }}
    onPaste={(event) => {
      const pasted = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"))
      if (!pasted.length) return
      event.preventDefault()
      void chooseFiles(pasted)
    }}>
    <DialogTitle>Insert image</DialogTitle>
    <DialogDescription>Upload, paste or drop an image up to 5 MiB, or choose one from this project.</DialogDescription>
    <div className="flex flex-wrap gap-2">
      <input ref={field} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif,.png,.jpg,.jpeg,.webp,.svg,.gif" multiple={initialAlt === undefined} className="sr-only" aria-label="Upload images" tabIndex={-1} disabled={busy}
        onChange={(event) => { const chosen = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void chooseFiles(chosen) }} />
      <Button variant="outline" disabled={busy} onClick={() => field.current?.click()}>Upload image</Button>
      {queue.length > 1 && <span role="status" className="self-center text-muted-foreground">{queue.length} images to describe</span>}
    </div>
    {images.length > 0 && <div className="grid gap-2">
      <Label htmlFor={`${id}-existing`}>Choose from project</Label>
      <select id={`${id}-existing`} value={existingPath} disabled={busy} className="h-9 w-full rounded-button border border-input bg-field px-2 text-foreground"
        onChange={(event) => { setExistingPath(event.target.value); setQueue([]); setConfirmed([]); setAlt(initialAlt ?? ""); setDecorative(initialAlt === ""); setError(null) }}>
        <option value="">Choose an image</option>
        {images.filter((image) => safeImagePath(image.path)).map((image) => <option key={image.path} value={image.path}>{image.path}</option>)}
      </select>
    </div>}
    {importFromURL && <div className="grid gap-2">
      <Label htmlFor={`${id}-url`}>Import from URL</Label>
      <div className="flex gap-2"><Input id={`${id}-url`} type="url" value={url} disabled={busy} placeholder="https://example.com/image.png" onChange={(event) => setURL(event.target.value)} />
        <Button variant="outline" disabled={busy || !url.trim()} onClick={async () => {
          const run = ++generation.current
          const signal = beginOperation()
          setPending(true); setError(null)
          try { const imported = await importFromURL(url.trim(), signal); if (run !== generation.current) return; setQueue([imported]); setConfirmed([]); setExistingPath(""); setAlt(initialAlt ?? ""); setDecorative(initialAlt === "") }
          catch (cause) { if (run === generation.current) setError(message(cause)) }
          finally { if (run === generation.current) setPending(false) }
        }}>Import</Button></div>
    </div>}
    {(prepared || existingPath) && <>
      {preview && <div className="flex max-h-64 items-center justify-center overflow-hidden rounded border border-border bg-white p-2"><div className="relative inline-block max-w-full overflow-hidden"><img src={preview} alt="Selected image preview" width={asset?.preview_width ?? asset?.width} height={asset?.preview_height ?? asset?.height} className="block max-h-60 max-w-full object-contain" />
        {asset && edit && [edit.x !== "0", edit.y !== "0", Number(edit.cropWidth) !== asset.width, Number(edit.cropHeight) !== asset.height].some(Boolean) && <span aria-hidden="true" className="pointer-events-none absolute border-2 border-ring shadow-[0_0_0_1000px_rgb(0_0_0_/_35%)]" style={{ left: `${100 * Number(edit.x) / asset.width}%`, top: `${100 * Number(edit.y) / asset.height}%`, width: `${100 * Number(edit.cropWidth) / asset.width}%`, height: `${100 * Number(edit.cropHeight) / asset.height}%` }} />}
      </div></div>}
      <p className="break-all text-xs text-muted-foreground">{prepared?.name ?? existingPath}{asset ? ` · ${asset.width} × ${asset.height}` : ""}</p>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-alt`}>Image description</Label>
        <Input id={`${id}-alt`} value={alt} maxLength={2048} disabled={busy || decorative} onChange={(event) => { setAlt(event.target.value); setError(null) }} placeholder="Describe what the image shows" aria-describedby={`${id}-help`} />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">Screen readers use this description. Mark an image decorative when nearby text already explains it.</p>
        <Label className="leading-5"><input type="checkbox" checked={decorative} disabled={busy} onChange={(event) => { setDecorative(event.target.checked); setError(null) }} />Decorative image</Label>
      </div>
      {target === "note" && <div className="grid gap-2">
        <Label htmlFor={`${id}-caption`}>Caption (Markdown)</Label>
        <Textarea id={`${id}-caption`} value={caption} maxLength={4096} disabled={busy} rows={2} placeholder="Optional caption, with **bold**, *italics* or [links](https://example.com)" onChange={(event) => setCaption(event.target.value)} />
      </div>}
      {edit && <details className="rounded border border-border p-3">
        <summary className="cursor-pointer font-medium">Resize or crop a copy</summary>
        <p className="my-2 text-xs text-muted-foreground">Creates a new PNG copy. Existing project images stay unchanged. Animated images become a still copy when edited.</p>
        <div className="grid grid-cols-2 gap-3">
          {([['width', 'Output width'], ['height', 'Output height'], ['x', 'Crop left'], ['y', 'Crop top'], ['cropWidth', 'Crop width'], ['cropHeight', 'Crop height']] as const).map(([key, label]) => <div className="grid gap-1" key={key}>
            <Label htmlFor={`${id}-${key}`}>{label}</Label>
            <Input id={`${id}-${key}`} type="number" min={key === 'x' || key === 'y' ? 0 : 1} step={1} disabled={busy} value={edit[key]} onChange={(event) => {
              const value = event.target.value
              const next = { ...edit, [key]: value }
              if (edit.lock && Number(value) > 0 && Number(edit.cropWidth) > 0 && Number(edit.cropHeight) > 0) {
                if (key === 'width') next.height = String(Math.max(1, Math.round(Number(value) * Number(edit.cropHeight) / Number(edit.cropWidth))))
                if (key === 'height') next.width = String(Math.max(1, Math.round(Number(value) * Number(edit.cropWidth) / Number(edit.cropHeight))))
                if ((key === 'cropWidth' || key === 'cropHeight') && Number(next.cropWidth) > 0 && Number(next.cropHeight) > 0) next.height = String(Math.max(1, Math.round(Number(edit.width) * Number(next.cropHeight) / Number(next.cropWidth))))
              }
              setEdits(next)
            }} />
          </div>)}
        </div>
        <Label className="my-3 leading-5"><input type="checkbox" checked={edit.lock} disabled={busy} onChange={(event) => setEdits({ ...edit, lock: event.target.checked })} />Keep aspect ratio</Label>
        <Button variant="outline" disabled={busy} onClick={async () => {
          const run = ++generation.current
          setPending(true); setError(null)
          try {
            let image = prepared
            if (!image && existingPath && readImage) image = await prepareImage(new File([await readImage(existingPath)], existingPath), projectId)
            if (!image) throw new Error('Choose an image to edit.')
            const { transformImage } = await import('./transform')
            const transformed = await transformImage(image, { x: Number(edit.x), y: Number(edit.y), cropWidth: Number(edit.cropWidth), cropHeight: Number(edit.cropHeight), width: Number(edit.width), height: Number(edit.height) }, projectId, existingPath || undefined)
            if (run !== generation.current) return
            setQueue((items) => [transformed, ...items.slice(1)]); setExistingPath(''); setEdits(null)
          } catch (cause) { if (run === generation.current) setError(message(cause)) }
          finally { if (run === generation.current) setPending(false) }
        }}>Apply resize and crop</Button>
        {prepared?.original && <Button variant="ghost" disabled={busy} onClick={() => {
          if (prepared.originalPath) { setExistingPath(prepared.originalPath); setQueue([]) }
          else setQueue((items) => [prepared.original!, ...items.slice(1)])
          setEdits(null); setError(null)
        }}>Reset to original</Button>}
      </details>}
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {pending && <p role="status" className="text-muted-foreground">Preparing image…</p>}
    <DialogFooter>
      <Button variant="outline" disabled={inserting} onClick={() => { generation.current++; cancelOperation(); onOpenChange(false) }}>Cancel</Button>
      <Button disabled={busy || (!prepared && !existingPath)} onClick={() => void insert()}>{inserting ? "Inserting…" : queue.length > 1 ? "Next image" : confirmed.length ? `Insert ${confirmed.length + 1} images` : "Insert image"}</Button>
    </DialogFooter>
  </DialogContent>
}

async function prepareFiles(files: File[], projectId: string): Promise<PreparedImage[]> {
  if (files.length > MAX_IMAGE_INTENT_FILES) throw new Error("Choose up to eight images at a time.")
  if (files.some((file) => file.size > MAX_IMAGE_BYTES)) throw new Error("Choose images no larger than 5 MiB each.")
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_INTENT_BYTES) throw new Error("Choose up to 20 MiB of images at a time.")
  const prepared: PreparedImage[] = []
  for (const file of files) prepared.push(await prepareImage(file, projectId))
  return prepared
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
