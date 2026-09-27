import type { MenuEntry } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import type { ProjectEntry } from "@/features/project-storage/library"

/**
 * The start of the project menu: the person's projects that are not
 * archived, the open one marked current, then All projects for the home
 * page. `go` opens a path in the app.
 */
export function projectMenuEntries(entries: readonly ProjectEntry[], current: string, go: (href: string) => void): MenuEntry[] {
  return [
    ...entries
      .filter((entry) => !entry.archived)
      .map((entry): MenuEntry => ({
        id: entry.id,
        label: entry.title,
        group: "projects",
        current: entry.id === current,
        onSelect: () => go(projectHref(entry.id)),
      })),
    { label: "All projects", group: "home", onSelect: () => go("/") },
  ]
}
