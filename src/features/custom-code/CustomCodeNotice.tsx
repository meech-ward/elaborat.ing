import { Puzzle } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/features/design-system"
import type { CodeFile } from "./approvals"
import { useCustomCodePolicy } from "./context"

/**
 * What a note from a shared project shows in place of its rendered view
 * until the person chooses to run its custom components: the files the code
 * comes from and who last changed them (when the server says), where the
 * code runs, and Run components or Show as text (the Source view).
 */
export function CustomCodeNotice({ files, onRun, onShowSource }: { files: readonly CodeFile[]; onRun: () => void; onShowSource: () => void }) {
  const policy = useCustomCodePolicy()
  const paths = files.map((file) => file.path)
  const wanted = paths.join("\0")
  const [editors, setEditors] = useState<{ for: string; names: ReadonlyMap<string, string> } | null>(null)
  useEffect(() => {
    if (!policy) return
    let stale = false
    policy.editors(wanted.split("\0")).then(
      (names) => {
        if (!stale) setEditors({ for: wanted, names })
      },
      () => {
        // Offline, or the server could not say: the files show without names.
      },
    )
    return () => {
      stale = true
    }
  }, [policy, wanted])
  const names = editors?.for === wanted ? editors.names : null

  return (
    <EmptyState
      className="h-full"
      icon={<Puzzle />}
      title="This note runs custom components"
      description={
        <>
          <p>Their code comes from files in this shared project:</p>
          <ul aria-label="Files with component code" className="my-2 flex flex-col gap-1 text-foreground">
            {files.map((file) => {
              const name = names?.get(file.path)
              return (
                <li key={file.path} className="wrap-anywhere">
                  <span className="font-mono text-xs">{file.path}</span>
                  {file.own ? " (this note)" : ""}
                  {name ? <span className="text-muted-foreground">, last changed by {name}</span> : null}
                </li>
              )
            })}
          </ul>
          <p>They run in an isolated frame, with no network and no access to your account. A new version of a file asks again.</p>
        </>
      }
      actions={
        <>
          <Button variant="secondary" onClick={onShowSource}>
            Show as text
          </Button>
          <Button onClick={onRun}>Run components</Button>
        </>
      }
    />
  )
}
