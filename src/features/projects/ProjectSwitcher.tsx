import { Link } from "@tanstack/react-router"
import { ChevronsUpDown } from "lucide-react"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { projectHref } from "@/features/navigation"
import type { ProjectEntry } from "@/features/project-storage/library"

/**
 * The project panel's way to another project: the person's projects that are
 * not archived, the open one marked current, and "All projects" for the home
 * page.
 */
export function ProjectSwitcher({ entries, current }: { entries: ProjectEntry[]; current: string }) {
  return (
    <Menu>
      <MenuTrigger className="inline-flex items-center gap-1 underline underline-offset-4">
        Switch project <ChevronsUpDown size={13} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start">
        {entries
          .filter((entry) => !entry.archived)
          .map((entry) => (
            <MenuItem
              key={entry.id}
              className={entry.id === current ? "font-semibold" : undefined}
              aria-current={entry.id === current ? "page" : undefined}
              render={<Link to={projectHref(entry.id)} />}
            >
              <span className="truncate">{entry.title}</span>
            </MenuItem>
          ))}
        <MenuSeparator />
        <MenuItem render={<Link to="/" />}>All projects</MenuItem>
      </MenuContent>
    </Menu>
  )
}
