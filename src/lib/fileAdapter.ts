import type { DocumentSnapshot } from "@/features/document"

/**
 * Local file open/save. No backend, no folder scanning, no hidden upload:
 * everything stays between the browser and the user's disk.
 *
 * Open always goes through a real <input type="file"> so it works
 * everywhere. Save prefers the File System Access picker where available
 * and falls back to an explicit download otherwise.
 */

export interface OpenedFile {
  name: string
  text: string
}

export function formatForFilename(name: string): DocumentSnapshot["format"] {
  return /\.mdx$/i.test(name) ? "mdx" : "md"
}

export function defaultFilename(format: DocumentSnapshot["format"]): string {
  return format === "md" ? "document.md" : "document.mdx"
}

/** Read a File/Blob chosen by the user into text. */
export async function readChosenFile(file: File): Promise<OpenedFile> {
  return { name: file.name || "document.mdx", text: await file.text() }
}

interface FileWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
}

interface SavePickerHandle {
  get name(): string
  createWritable(): Promise<FileWritable>
}

interface WindowWithFileAccess {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<SavePickerHandle>
}

function accessWindow(): WindowWithFileAccess {
  return window as unknown as WindowWithFileAccess
}

export type SaveOutcome =
  | { status: "saved"; method: "file-picker" | "download"; name: string }
  | { status: "cancelled" }

function downloadFallback(name: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on a later tick so the download has started.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Save the actual current source. Returns how it was saved, or "cancelled"
 * when the user dismissed the picker. Never throws on picker abort.
 */
export async function saveSourceText(name: string, text: string): Promise<SaveOutcome> {
  const showPicker = accessWindow().showSaveFilePicker
  if (showPicker) {
    try {
      const handle = await showPicker({
        suggestedName: name,
        types: [
          {
            description: "Markdown / MDX",
            accept: { "text/markdown": [".md", ".mdx"] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      return { status: "saved", method: "file-picker", name: handle.name || name }
    } catch (error) {
      // Dismissing the picker is routine, not a failure.
      if (error instanceof DOMException && error.name === "AbortError") {
        return { status: "cancelled" }
      }
      // A broken picker must not lose the save: fall through to download.
      downloadFallback(name, text)
      return { status: "saved", method: "download", name }
    }
  }
  downloadFallback(name, text)
  return { status: "saved", method: "download", name }
}
