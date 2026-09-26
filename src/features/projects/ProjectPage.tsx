import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { parseProjectLocation, projectHref } from "@/features/navigation"
import { ProjectChanges } from "@/features/project-storage/changes"
import type { FileRef } from "@/features/project-storage/fileStore"
import { createClient } from "@/lib/supabase/client"
import { fileStoreFor, libraryFor, useLibraryState, type ProjectAccount } from "./account"
import { statusLabel } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

/**
 * One project at its URL: downloaded on first open, kept in sync, with its
 * files listed. A file's URL selects it. (Files open in the editor from
 * roadmap phase 2 step 10; until then a selected file is shown as text.)
 */
export function ProjectPage({ account }: { account: ProjectAccount }) {
  const href = useLocation({ select: (location) => location.href })
  const location = parseProjectLocation(href)
  if (location.kind === "invalid") {
    return (
      <p role="alert" className="p-6 text-sm">
        {location.message} <Link to="/">Go to your projects</Link>.
      </p>
    )
  }
  return <OpenProject key={location.projectId} account={account} projectId={location.projectId} path={location.path} />
}

function OpenProject({ account, projectId, path }: { account: ProjectAccount; projectId: string; path: string | null }) {
  const library = libraryFor(account)
  const state = useLibraryState(library)
  const navigate = useNavigate()
  const [opened, setOpened] = useState<"opening" | "open" | "missing">("opening")
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<FileRef[]>([])
  const [content, setContent] = useState<string | null>(null)
  const onError = useCallback((message: string) => setError(message), [])
  useBackgroundRefresh(library, onError)
  const entry = state.entries.find((candidate) => candidate.id === projectId)

  const syncNow = useCallback(async () => {
    setError(null)
    try {
      const outcome = await library.syncProject(projectId)
      if (outcome.projectId !== projectId) await navigate({ href: projectHref(outcome.projectId, path), replace: true })
      else if (outcome.status === "stopped" || outcome.status === "incomplete") setError(outcome.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [library, navigate, path, projectId])

  // Download on first open, then sync.
  useEffect(() => {
    let active = true
    library
      .open(projectId)
      .then((found) => {
        if (!active) return
        setOpened(found ? "open" : "missing")
        if (found && account.online) void syncNow()
      })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      active = false
    }
  }, [account.online, library, projectId, syncNow])

  // Hear about changes made elsewhere while the project is open.
  useEffect(() => {
    if (!account.online || opened !== "open") return
    const changes = new ProjectChanges(createClient(), projectId, 0, () => void syncNow())
    return () => {
      void changes.close()
    }
  }, [account.online, opened, projectId, syncNow])

  // The file list and the selected file follow every change on this device.
  useEffect(() => {
    if (opened !== "open") return
    const store = fileStoreFor(library, projectId)
    let active = true
    const load = async () => {
      const entries = await store.listEntries()
      const selected = path ? await store.read(path).catch(() => null) : null
      if (!active) return
      setFiles(entries.files)
      setContent(selected ? selected.content : null)
    }
    void load()
    const unsubscribe = library.subscribe(() => void load())
    return () => {
      active = false
      unsubscribe()
    }
  }, [library, opened, path, projectId])

  if (opened === "missing") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-2xl font-semibold">Project not found</h1>
        <p className="mt-2 text-sm">
          This project is not on this device, and {account.online ? "you do not have access to it on the server" : "you are offline"}.{" "}
          <Link to="/" className="underline underline-offset-4">
            Go to your projects
          </Link>
          .
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <p>
        <Link to="/" className="text-sm underline underline-offset-4">
          Your projects
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{entry?.title ?? "Opening project..."}</h1>
      <div className="flex items-center gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {opened === "opening" ? "Opening..." : entry ? statusLabel(entry) : ""}
          {!account.online || state.offline ? " (offline)" : ""}
        </p>
        {account.online ? (
          <Button variant="outline" size="sm" onClick={() => void syncNow()} disabled={opened !== "open"}>
            Sync now
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <section aria-labelledby="files-heading">
        <h2 id="files-heading" className="text-lg font-semibold">
          Files
        </h2>
        {opened === "open" && files.length === 0 ? <p className="text-sm">No files yet.</p> : null}
        <ul className="mt-2 flex flex-col gap-1">
          {files.map((file) => (
            <li key={file.path}>
              <Link to={projectHref(projectId, file.path)} aria-current={file.path === path ? "page" : undefined} className="text-sm underline-offset-4 hover:underline">
                {file.path}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {path ? (
        <section aria-labelledby="file-heading">
          <h2 id="file-heading" className="text-lg font-semibold">
            {path}
          </h2>
          {content === null ? (
            <p className="text-sm">{opened === "open" ? "This file is not in the project." : ""}</p>
          ) : (
            <pre className="mt-2 overflow-auto rounded-lg border p-4 text-sm whitespace-pre-wrap">{content}</pre>
          )}
        </section>
      ) : null}
    </main>
  )
}
