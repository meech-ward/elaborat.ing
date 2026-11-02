import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronLeft, Ellipsis } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ActionMenu, Banner, BannerAction, FloatingPanel, NewProjectCard, ProjectCard, ProjectGrid, StatusDot, type MenuEntry } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import type { Invitation, ProjectEntry } from "@/features/project-storage/library"
import { canEdit } from "@/features/project-storage/model"
import { embedded } from "@/features/embed/mode"
import { useProjectCategories, type ProjectCategory } from "@/features/project-categories"
import type { CategoryDialog } from "./CategoryDialogs"
import { libraryFor, moveLocalProjectTo, useLibraryState, type ProjectAccount } from "./account"
import { DeletedProjectBanner } from "./DeletedProject"
import { DeleteProjectDialog } from "./DeleteProjectDialog"
import { useProjectDownload } from "./DownloadProject"
import { ImportProjectButton, ImportReport, useProjectImport } from "./ImportProject"
import { LazyMembersDialog } from "./LazyMembersDialog"
import { statusLabel, syncDot } from "./statusLabel"
import { useBackgroundRefresh } from "./useBackgroundRefresh"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const CategoryDialogs = lazy(() => import("./CategoryDialogs"))
const countLabel = (count: number) => `${count} project${count === 1 ? "" : "s"}`

/**
 * A project's menu, by role: everyone sees its members and downloads it,
 * owners and editors archive and unarchive, the owner deletes permanently,
 * and anyone else can leave.
 */
function ProjectMenu({ entry, onMembers, onDownload, onArchive, onDelete, onLeave, onCategories, categoriesDisabled }: {
  entry: ProjectEntry
  onMembers: () => void
  onDownload: () => void
  /** Archive, or unarchive an archived project. */
  onArchive: () => void
  onDelete: () => void
  onLeave: () => void
  onCategories: () => void
  categoriesDisabled: boolean
}) {
  const items: MenuEntry[] = [
    { label: "Categories…", onSelect: onCategories, disabled: categoriesDisabled },
    ...(entry.role !== null ? [{ label: "Members", onSelect: onMembers }, { label: "Download project", onSelect: onDownload }] : []),
    ...(canEdit(entry.role) ? [{ label: entry.archived ? "Unarchive" : "Archive", onSelect: onArchive }] : []),
    ...(entry.role === null ? [] : entry.role === "owner" ? [{ label: "Delete permanently", onSelect: onDelete, destructive: true }] : [{ label: "Leave project", onSelect: onLeave }]),
  ]
  return (
    <ActionMenu
      entries={items}
      trigger={
        <Button variant="ghost" size="icon" aria-label={`Actions for ${entry.title}`} title={`Actions for ${entry.title}`}>
          <Ellipsis aria-hidden="true" />
        </Button>
      }
      contentProps={{ align: "end" }}
    />
  )
}

/**
 * The account's projects as cards, its invitations, and ways to start a new
 * one or import one. In a chat's panel a project is only opened or started
 * here: importing, members, downloads, archiving, deleting and leaving are on
 * the site.
 */
export function ProjectList({ account, categorySelection }: { account: ProjectAccount; categorySelection?: string }) {
  const library = libraryFor(account)
  const state = useLibraryState(library)
  const categories = useProjectCategories(account)
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The project to delete permanently, with how many of its files have changes not yet synced.
  const [deleting, setDeleting] = useState<{ entry: ProjectEntry; unsynced: number } | null>(null)
  // The project whose members are shown.
  const [membersOf, setMembersOf] = useState<ProjectEntry | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialog | null>(null)
  const categoryHeading = useRef<HTMLHeadingElement>(null)
  const lastSelection = useRef(categorySelection)
  useEffect(() => {
    if (lastSelection.current === categorySelection) return
    lastSelection.current = categorySelection
    categoryHeading.current?.focus({ preventScroll: true })
  }, [categorySelection])
  const manageCategory = (dialog: CategoryDialog) => {
    setError(null)
    setNotice(null)
    categories.store.clearError()
    setCategoryDialog(dialog)
  }
  const closeCategoryDialog = () => {
    categories.store.clearError()
    setCategoryDialog(null)
  }
  const importing = useProjectImport(library)
  const onError = useCallback((text: string) => setError(text), [])
  const download = useProjectDownload(library, onError, setNotice)
  useBackgroundRefresh(library, onError, { invitations: true })

  // Just signed in with work in the local project: it joins the account's projects and opens (the project page uploads it).
  useEffect(() => {
    if (!account.online) return
    let active = true
    moveLocalProjectTo(library, () => import("./welcomeNote"))
      .then((id) => (id && active ? navigate({ href: projectHref(id) }) : undefined))
      .catch((cause: unknown) => active && setError(`The local project did not move to your account: ${message(cause)}`))
    return () => {
      active = false
    }
  }, [account.online, library, navigate])

  const accept = async (invitation: Invitation) => {
    setError(null)
    setNotice(null)
    try {
      await library.accept(invitation.projectId)
      await navigate({ href: projectHref(invitation.projectId) })
    } catch (cause) {
      setError(`Not accepted: ${message(cause)}`)
    }
  }

  const setArchived = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      if (entry.archived) {
        await library.unarchive(entry.id)
        setNotice(`Unarchived ${entry.title}.`)
      } else {
        await library.archive(entry.id)
        setNotice(`Archived ${entry.title}. It refuses changes until it is unarchived.`)
      }
    } catch (cause) {
      setError(`${entry.archived ? "Not unarchived" : "Not archived"}: ${message(cause)}`)
    }
  }

  const askToDelete = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      setDeleting({ entry, unsynced: await library.unsyncedFiles(entry.id) })
    } catch (cause) {
      setError(message(cause))
    }
  }
  const deletePermanently = async (entry: ProjectEntry) => {
    await library.deletePermanently(entry.id)
    setDeleting(null)
    setNotice(`Deleted ${entry.title} permanently.`)
  }

  const leave = async (entry: ProjectEntry) => {
    setError(null)
    setNotice(null)
    try {
      // Say what would be lost before asking, and ask before anything changes.
      const problem = await library.leaveProblem(entry.id)
      if (problem) {
        setError(problem)
        return
      }
      if (!window.confirm(`Leave ${entry.title}? You lose access to it, and it is removed from this device. Its owner can invite you again.`)) return
      await library.leave(entry.id)
      setNotice(`Left ${entry.title}.`)
    } catch (cause) {
      setError(message(cause))
    }
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const id = await library.create(title)
      setTitle("")
      await navigate({ href: projectHref(id) })
      void library.syncProject(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const offline = !account.online || state.offline
  const activeCategories = categories.state.categories.filter(category => category.archived_at === null)
  const selectedCategory = categories.state.categories.find(category => category.id === categorySelection)
  const categoryIdSelected = categorySelection !== undefined && categorySelection !== "all" && categorySelection !== "uncategorized"
  const categoryUnavailable = categoryIdSelected && !selectedCategory && categories.state.loaded
  const overview = categorySelection === undefined && activeCategories.length > 0
  const categorized = new Set(activeCategories.flatMap(category => category.project_ids))
  const visibleEntries = state.entries.filter(entry => categorySelection === "uncategorized" ? !categorized.has(entry.id) : selectedCategory ? selectedCategory.project_ids.includes(entry.id) : true)
  const active = visibleEntries.filter((entry) => !entry.archived)
  const archived = visibleEntries.filter((entry) => entry.archived)
  const categoryEditsUnavailable = offline || categories.state.offline || !categories.state.loaded
  const categoryWritesDisabled = categoryEditsUnavailable || categories.state.busy
  const globalCreation = !categoryIdSelected
  const heading = selectedCategory?.name ?? (categorySelection === "uncategorized" ? "Uncategorized" : "All projects")
  const categoryMenu = (category: ProjectCategory) => !embedded && <ActionMenu
    entries={[
      { label: "Rename category", disabled: categoryWritesDisabled, onSelect: () => manageCategory({ kind: "rename", categoryId: category.id }) },
      { label: "Archive category", disabled: categoryWritesDisabled, onSelect: () => manageCategory({ kind: "archive", categoryId: category.id }) },
    ]}
    trigger={<Button variant="ghost" size="icon" aria-label={`Actions for category ${category.name}`}><Ellipsis aria-hidden="true" /></Button>}
    contentProps={{ align: "end" }}
  />
  const card = (entry: ProjectEntry) => (
    <ProjectCard
      key={entry.id}
      title={entry.title}
      link={<Link to={projectHref(entry.id)} />}
      meta={
        <StatusDot status={syncDot(entry, offline, state.syncing.includes(entry.id)).status}>{statusLabel(entry, state.syncing.includes(entry.id))}</StatusDot>
      }
      actions={
        !embedded ? (
          <ProjectMenu
            entry={entry}
            onMembers={() => {
              setError(null)
              setNotice(null)
              setMembersOf(entry)
            }}
            onDownload={() => {
              setError(null)
              setNotice(null)
              void download.start(entry.id, entry.title)
            }}
            onArchive={() => void setArchived(entry)}
            onDelete={() => void askToDelete(entry)}
            onLeave={() => void leave(entry)}
            onCategories={() => manageCategory({ kind: "project", project: entry })}
            categoriesDisabled={categoryWritesDisabled}
          />
        ) : null
      }
    />
  )

  return (
    <section aria-labelledby="projects-heading" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-3 pt-4 pb-16 sm:px-6 sm:pt-8">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1">
          <h1 id="projects-heading" className="text-[28px] leading-tight font-bold tracking-[-0.01em] sm:text-[32px]">
            Your projects
          </h1>
          {state.loaded && state.entries.length === 0 ? <p className="text-[15px] text-muted-foreground">No projects yet.</p> : null}
        </div>
        {embedded ? null : <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={categoryWritesDisabled} onClick={() => manageCategory({ kind: "new" })}>New category</Button>
          {categories.state.categories.some(category => category.archived_at !== null) && <Button variant="ghost" onClick={() => manageCategory({ kind: "archived" })}>Archived categories</Button>}
          {globalCreation && <ImportProjectButton state={importing.state} onChoose={(input, source) => void importing.choose(input, source)} />}
        </div>}
      </div>
      {offline || error || notice || categories.state.offline || categories.state.error || categories.state.cacheUnavailable || importing.state.kind !== "idle" || state.deleted.length > 0 ? (
        <div className="flex flex-col gap-2">
          {offline ? <Banner tone="info">Offline: showing the projects on this device. Changes sync when you are back online.</Banner> : null}
          {categories.state.offline && !offline ? <Banner tone="info">Organizing categories needs a connection. Your saved categories are still available.</Banner> : null}
          {state.deleted.map((project) => (
            <DeletedProjectBanner key={project.id} library={library} project={project} onError={onError} />
          ))}
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {categories.state.error && !categoryDialog ? <Banner tone={categories.state.offline ? "info" : "danger"}>{categories.state.error}</Banner> : null}
          {categories.state.cacheUnavailable ? <Banner tone="info">Categories cannot be kept on this device. They may not be available offline.</Banner> : null}
          {notice ? (
            <Banner tone="info" action={<BannerAction onClick={() => setNotice(null)}>Dismiss</BannerAction>}>
              {notice}
            </Banner>
          ) : null}
          <ImportReport state={importing.state} />
        </div>
      ) : null}
      {state.invitations.length > 0 ? (
        <FloatingPanel render={<section aria-labelledby="invitations-heading" />} className="flex flex-col gap-1 p-4">
          <h2 id="invitations-heading" className="text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
            Invitations
          </h2>
          <ul className="flex flex-col divide-y divide-border">
            {state.invitations.map((invitation) => (
              <li key={invitation.projectId} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">
                  <span className="font-semibold">{invitation.title}</span>
                  <span className="text-muted-foreground">, as {invitation.role}</span>
                </span>
                <Button aria-label={`Accept the invitation to ${invitation.title}`} onClick={() => void accept(invitation)}>
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        </FloatingPanel>
      ) : null}
      {overview ? <section aria-labelledby="categories-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1"><h2 ref={categoryHeading} tabIndex={-1} id="categories-heading" className="text-lg font-semibold outline-none">Categories</h2><p className="text-sm text-muted-foreground">Categories are only visible to you. Projects can be in more than one.</p></div>
        <ProjectGrid aria-labelledby="categories-heading">
          <NewProjectCard id="new-project-title" value={title} onValueChange={setTitle} onSubmit={event => void create(event)} />
          <ProjectCard title="All projects" link={<Link to="/" search={{ category: "all" }} />} meta={countLabel(state.entries.length)} />
          <ProjectCard title="Uncategorized" link={<Link to="/" search={{ category: "uncategorized" }} />} meta={countLabel(state.entries.filter(entry => !categorized.has(entry.id)).length)} />
          {activeCategories.map(category => <ProjectCard key={category.id} title={category.name} link={<Link to="/" search={{ category: category.id }} />} meta={countLabel(state.entries.filter(entry => category.project_ids.includes(entry.id)).length)} actions={categoryMenu(category)} />)}
        </ProjectGrid>
      </section> : <section aria-labelledby="category-projects-heading" className="flex flex-col gap-3">
        {(activeCategories.length > 0 || categoryIdSelected) && <Link to="/" search={{}} className="flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"><ChevronLeft className="size-4" aria-hidden="true" />Back to categories</Link>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 ref={categoryHeading} tabIndex={-1} id="category-projects-heading" className="min-w-0 text-lg font-semibold outline-none [overflow-wrap:anywhere]">{categoryUnavailable ? "Category unavailable" : heading}</h2>
          {selectedCategory && !embedded && selectedCategory.archived_at === null && <div className="flex items-center gap-2"><Button variant="outline" disabled={categoryWritesDisabled} onClick={() => manageCategory({ kind: "add-projects", categoryId: selectedCategory.id })}>Add projects</Button>{categoryMenu(selectedCategory)}</div>}
        </div>
        {categoryUnavailable ? <p className="text-sm text-muted-foreground">{categories.state.offline ? "This category is not available on this device while offline." : "This category is no longer available."} <Link to="/" search={{ category: "all" }} className="underline underline-offset-4">See all projects</Link>.</p> : <>
          {selectedCategory?.archived_at && <Banner tone="info">This category is archived. Restore it from Archived categories to organize its projects again.</Banner>}
          {categoryIdSelected && !categories.state.loaded ? <p role="status">Loading category…</p> : <>
            <ProjectGrid aria-labelledby="category-projects-heading">
              {globalCreation && <NewProjectCard id="new-project-title" value={title} onValueChange={setTitle} onSubmit={event => void create(event)} />}
              {active.map(card)}
            </ProjectGrid>
            {selectedCategory && visibleEntries.length === 0 && <p className="text-sm text-muted-foreground">No projects in this category yet.{!embedded && selectedCategory.archived_at === null ? " Choose Add projects to organize existing projects here." : ""}</p>}
            {categorySelection === "uncategorized" && visibleEntries.length === 0 && <p className="text-sm text-muted-foreground">All your projects are in categories.</p>}
          </>}
        </>}
      </section>}
      {!overview && !categoryUnavailable && (!categoryIdSelected || categories.state.loaded) && archived.length > 0 ? (
        <section aria-labelledby="archived-heading" className="flex flex-col gap-3">
          <h2 id="archived-heading" className="text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
            Archived
          </h2>
          <ProjectGrid aria-labelledby="archived-heading">{archived.map(card)}</ProjectGrid>
        </section>
      ) : null}
      {categoryDialog && <Suspense fallback={<p role="status">Loading category controls…</p>}><CategoryDialogs
        dialog={categoryDialog}
        categories={categories.state.categories}
        projects={state.entries}
        disabled={categoryEditsUnavailable}
        returnFocus={categoryHeading}
        onClose={closeCategoryDialog}
        onCreate={async name => { const category = await categories.store.create(name); setNotice(`Created ${category.name}.`) }}
        onRename={async (id, name) => { const category = await categories.store.rename(id, name); setNotice(`Renamed category to ${category.name}.`) }}
        onArchived={async (id, value) => { const category = await categories.store.setArchived(id, value); setNotice(`${value ? "Archived" : "Restored"} category ${category.name}.`) }}
        onProjectCategories={async (id, ids) => { await categories.store.setProjectCategories(id, ids); setNotice("Project categories saved.") }}
        onAddProject={async (id, projectId) => { await categories.store.setMembership(id, projectId, true); setNotice("Projects added to the category.") }}
      /></Suspense>}
      {membersOf ? (
        <LazyMembersDialog
          library={library}
          projectId={membersOf.id}
          title={membersOf.title}
          owner={membersOf.role === "owner"}
          you={account.userId}
          onClose={() => setMembersOf(null)}
        />
      ) : null}
      {download.dialog}
      {deleting ? (
        <DeleteProjectDialog
          title={deleting.entry.title}
          unsynced={deleting.unsynced}
          onDelete={() => deletePermanently(deleting.entry)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </section>
  )
}
