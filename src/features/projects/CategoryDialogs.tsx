import { useRef, useState, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProjectCategory } from "@/features/project-categories"
import type { ProjectEntry } from "@/features/project-storage/library"

export type CategoryDialog =
  | { kind: "new" }
  | { kind: "rename" | "archive" | "add-projects"; categoryId: string }
  | { kind: "archived" }
  | { kind: "project"; project: ProjectEntry }

type Props = {
  dialog: CategoryDialog
  categories: readonly ProjectCategory[]
  projects: readonly ProjectEntry[]
  disabled: boolean
  returnFocus: RefObject<HTMLHeadingElement | null>
  onClose: () => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onArchived: (id: string, archived: boolean) => Promise<void>
  onProjectCategories: (projectId: string, categoryIds: string[]) => Promise<void>
  onAddProject: (categoryId: string, projectId: string) => Promise<void>
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const errorText = "text-sm text-destructive"
const checkboxRow = "flex min-h-11 cursor-pointer items-center gap-3 rounded-tool px-2 py-2 text-sm leading-5 hover:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-60"

function NameDialog({ category, disabled, onClose, onSave, returnFocus }: {
  category?: ProjectCategory; disabled: boolean; onClose: () => void; onSave: (name: string) => Promise<void>; returnFocus?: Props["returnFocus"]
}) {
  const [name, setName] = useState(category?.name ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending || disabled || !name.trim()) return
    setPending(true)
    setError(null)
    try { await onSave(name); onClose() }
    catch (cause) { setError(message(cause)); setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent initialFocus={field} finalFocus={returnFocus} showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{category ? `Rename ${category.name}` : "New category"}</DialogTitle>
        <DialogDescription>Categories organize your projects for you. They do not change anyone’s access.</DialogDescription>
      </DialogHeader>
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="category-name">Category name</Label>
          <Input ref={field} id="category-name" aria-describedby="category-name-limit" value={name} disabled={pending || disabled} onChange={event => setName(event.target.value)} />
          <p id="category-name-limit" className="text-xs text-muted-foreground">Up to 160 characters.</p>
        </div>
        {error && <p role="alert" className={errorText}>{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || disabled || !name.trim()}>{pending ? "Saving…" : category ? "Save name" : "Create category"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function ArchiveDialog({ category, disabled, onClose, onArchived, returnFocus }: {
  category: ProjectCategory; disabled: boolean; onClose: () => void; onArchived: Props["onArchived"]; returnFocus: Props["returnFocus"]
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const archive = async () => {
    if (pending || disabled) return
    setPending(true)
    setError(null)
    try { await onArchived(category.id, true); onClose() }
    catch (cause) { setError(message(cause)); setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent finalFocus={returnFocus} showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Archive {category.name}</DialogTitle>
        <DialogDescription>This hides the category from your home page. Its projects and their sharing stay as they are. You can restore the category later.</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className={errorText}>{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={pending || disabled} onClick={() => void archive()}>{pending ? "Archiving…" : "Archive category"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function ArchivedDialog({ categories, disabled, onClose, onArchived, onRename, returnFocus }: Pick<Props, "categories" | "disabled" | "onClose" | "onArchived" | "onRename" | "returnFocus">) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<ProjectCategory | null>(null)
  const restore = async (category: ProjectCategory) => {
    if (pending || disabled) return
    setPending(category.id)
    setError(null)
    try { await onArchived(category.id, false) }
    catch (cause) { setError(message(cause)) }
    finally { setPending(null) }
  }
  const archived = categories.filter(category => category.archived_at !== null)
  return <><Dialog open onOpenChange={open => { if (!open && !pending && !renaming) onClose() }}>
    <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Archived categories</DialogTitle>
        <DialogDescription>Restore a category with its project choices. Restoring does not change project access.</DialogDescription>
      </DialogHeader>
      {archived.length === 0 ? <p>No archived categories.</p> : <ul className="max-h-80 overflow-y-auto divide-y divide-border">
        {archived.map(category => <li key={category.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
          <span className="min-w-0 break-words">{category.name}</span>
          <span className="flex shrink-0 flex-wrap gap-2">
            <Button variant="ghost" aria-label={`Rename archived category ${category.name}`} disabled={pending !== null || disabled || renaming !== null} onClick={() => setRenaming(category)}>Rename</Button>
            <Button variant="outline" aria-label={`Restore ${category.name}`} disabled={pending !== null || disabled || renaming !== null} onClick={() => void restore(category)}>{pending === category.id ? "Restoring…" : "Restore"}</Button>
          </span>
        </li>)}
      </ul>}
      {error && <p role="alert" className={errorText}>{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending !== null || renaming !== null} onClick={onClose}>Close</Button></DialogFooter>
    </DialogContent>
  </Dialog>{renaming && <NameDialog category={renaming} disabled={disabled} onClose={() => setRenaming(null)} onSave={name => onRename(renaming.id, name)} />}</>
}

function ProjectCategoriesDialog({ project, categories, disabled, onClose, onProjectCategories, returnFocus }: {
  project: ProjectEntry
} & Pick<Props, "categories" | "disabled" | "onClose" | "onProjectCategories" | "returnFocus">) {
  const active = categories.filter(category => category.archived_at === null)
  const [selected, setSelected] = useState(() => new Set(active.filter(category => category.project_ids.includes(project.id)).map(category => category.id)))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (pending || disabled) return
    setPending(true)
    setError(null)
    try { await onProjectCategories(project.id, [...selected].filter(id => active.some(category => category.id === id))); onClose() }
    catch (cause) { setError(message(cause)); setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Categories for {project.title}</DialogTitle>
        <DialogDescription>Choose any categories for your own project list. Other people’s categories and access stay as they are.</DialogDescription>
      </DialogHeader>
      {active.length === 0 ? <p>Create a category on the home page first.</p> : <fieldset className="max-h-80 overflow-y-auto">
        <legend className="sr-only">Categories</legend>
        {active.map(category => <Label key={category.id} className={checkboxRow}>
          <input type="checkbox" checked={selected.has(category.id)} disabled={pending || disabled} onChange={event => setSelected(current => {
            const next = new Set(current)
            if (event.target.checked) next.add(category.id); else next.delete(category.id)
            return next
          })} />
          <span className="min-w-0 break-words">{category.name}</span>
        </Label>)}
      </fieldset>}
      {error && <p role="alert" className={errorText}>{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={pending || disabled || active.length === 0} onClick={() => void save()}>{pending ? "Saving…" : "Save categories"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function AddProjectsDialog({ category, projects, disabled, onClose, onAddProject, returnFocus }: {
  category: ProjectCategory
} & Pick<Props, "projects" | "disabled" | "onClose" | "onAddProject" | "returnFocus">) {
  const [selected, setSelected] = useState(() => new Set<string>())
  const [filter, setFilter] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = projects.filter(project => !category.project_ids.includes(project.id))
  const visible = choices.filter(project => project.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const eligible = [...selected].filter(id => choices.some(project => project.id === id))
  const add = async () => {
    if (pending || disabled || eligible.length === 0) return
    setPending(true)
    setError(null)
    const remaining = new Set(eligible)
    try {
      for (const projectId of eligible) {
        await onAddProject(category.id, projectId)
        remaining.delete(projectId)
      }
      onClose()
    } catch (cause) {
      setSelected(remaining)
      setError(`${message(cause)} Projects already added are kept. You can retry the remaining choices.`)
      setPending(false)
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add projects to {category.name}</DialogTitle>
        <DialogDescription>Choose projects you can access. Adding one only organizes your own project list.</DialogDescription>
      </DialogHeader>
      {choices.length === 0 ? <p>All your projects are already in this category.</p> : <>
        <div className="grid gap-2"><Label htmlFor="category-project-search">Search projects</Label><Input id="category-project-search" type="search" value={filter} disabled={pending} onChange={event => setFilter(event.target.value)} /></div>
        <fieldset className="max-h-80 overflow-y-auto">
          <legend className="sr-only">Projects</legend>
          {visible.map(project => <Label key={project.id} className={checkboxRow}>
            <input type="checkbox" checked={selected.has(project.id)} disabled={pending || disabled} onChange={event => setSelected(current => {
              const next = new Set(current)
              if (event.target.checked) next.add(project.id); else next.delete(project.id)
              return next
            })} />
            <span className="min-w-0 break-words">{project.title}{project.archived ? <span className="text-muted-foreground"> (archived)</span> : null}</span>
          </Label>)}
        </fieldset>
        {visible.length === 0 && <p role="status">No projects match.</p>}
      </>}
      {error && <p role="alert" className={errorText}>{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={pending || disabled || eligible.length === 0} onClick={() => void add()}>{pending ? "Adding…" : "Add selected projects"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/** Loaded only when a category is managed; browsing the home stays light. */
export default function CategoryDialogs(props: Props) {
  const { dialog, categories, onClose } = props
  if (dialog.kind === "new") return <NameDialog disabled={props.disabled} returnFocus={props.returnFocus} onClose={onClose} onSave={props.onCreate} />
  if (dialog.kind === "archived") return <ArchivedDialog {...props} />
  if (dialog.kind === "project") return <ProjectCategoriesDialog {...props} project={dialog.project} />
  const category = categories.find(entry => entry.id === dialog.categoryId)
  if (!category) return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent finalFocus={props.returnFocus}><DialogHeader><DialogTitle>Category unavailable</DialogTitle><DialogDescription>This category is no longer in your project list.</DialogDescription></DialogHeader><DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter></DialogContent></Dialog>
  if (dialog.kind === "rename") return <NameDialog disabled={props.disabled} returnFocus={props.returnFocus} category={category} onClose={onClose} onSave={name => props.onRename(category.id, name)} />
  if (dialog.kind === "archive") return <ArchiveDialog {...props} category={category} />
  return <AddProjectsDialog {...props} category={category} />
}
