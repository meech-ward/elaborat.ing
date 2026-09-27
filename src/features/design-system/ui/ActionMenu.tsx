import type { ComponentProps, ReactElement, ReactNode } from "react"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { menuRows, type MenuEntry } from "./menuRows"

export type { MenuEntry } from "./menuRows"

/** What a component that opens an ActionMenu passes on to it: when it has closed, and where focus goes. */
export type ActionMenuProps = Pick<ComponentProps<typeof ActionMenu>, "onOpenChangeComplete" | "contentProps">

// The app's menus, from one list of entries: ActionMenu opens from a button,
// ActionContextMenu on right-click (or a long press on touch screens). Both
// are the shadcn dropdown and context menus, so Base UI owns keyboard, focus,
// typeahead and dismissal; destructive entries go last, in the danger
// colour, after a separator. An entry with `checked` is a checkbox item.

type DropdownRootProps = Pick<ComponentProps<typeof DropdownMenu>, "open" | "defaultOpen" | "onOpenChange" | "onOpenChangeComplete" | "modal">
type DropdownContentProps = Omit<ComponentProps<typeof DropdownMenuContent>, "children">

/**
 * A menu that opens from its trigger (a Button, usually), with the entries as
 * items. An entry that moves focus elsewhere (a dialog, a name field) can run
 * from `onOpenChangeComplete` once the menu has closed, with `finalFocus`
 * (in `contentProps`) keeping the menu from taking focus back.
 */
export function ActionMenu({
  entries,
  trigger,
  contentProps,
  ...root
}: DropdownRootProps & {
  entries: readonly MenuEntry[]
  /** The element that opens the menu; Base UI renders it as the trigger. */
  trigger: ReactElement
  /** Placement and extra props for the popup (align, side, className, aria-label, finalFocus ...). */
  contentProps?: DropdownContentProps
}) {
  return (
    <DropdownMenu {...root}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent {...contentProps}>
        {menuRows(entries).map((row) =>
          row.kind === "separator" ? (
            <DropdownMenuSeparator key={row.key} />
          ) : row.entry.checked !== undefined ? (
            <DropdownMenuCheckboxItem
              key={row.entry.id ?? row.entry.label}
              checked={row.entry.checked}
              closeOnClick
              disabled={row.entry.disabled}
              aria-keyshortcuts={row.entry.keyShortcuts}
              onClick={row.entry.onSelect}
            >
              {row.entry.label}
              {row.entry.shortcut && <DropdownMenuShortcut>{row.entry.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuItem
              key={row.entry.id ?? row.entry.label}
              variant={row.entry.destructive ? "destructive" : "default"}
              disabled={row.entry.disabled}
              aria-keyshortcuts={row.entry.keyShortcuts}
              aria-current={row.entry.current ? "page" : undefined}
              className={cn(row.entry.current && "font-semibold")}
              onClick={row.entry.onSelect}
            >
              {row.entry.label}
              {row.entry.shortcut && <DropdownMenuShortcut>{row.entry.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type ContextRootProps = Pick<ComponentProps<typeof ContextMenu>, "open" | "onOpenChange">

/**
 * The same entries as a right-click menu on its children (a long press on
 * touch screens), or on `render`, an element that becomes the trigger itself
 * (such as a tab, which may not sit inside another element).
 */
export function ActionContextMenu({
  entries,
  children,
  render,
  className,
  "aria-label": ariaLabel,
  contentProps,
  ...root
}: ContextRootProps & {
  entries: readonly MenuEntry[]
  children?: ReactNode
  render?: ReactElement
  className?: string
  /** A name for the menu popup, such as "File actions". */
  "aria-label"?: string
  /** Placement and extra props for the popup (container, side, className ...). */
  contentProps?: Omit<ComponentProps<typeof ContextMenuContent>, "children">
}) {
  return (
    <ContextMenu {...root}>
      {render ? (
        <ContextMenuTrigger render={render} className={className} />
      ) : (
        <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      )}
      <ContextMenuContent aria-label={ariaLabel} {...contentProps}>
        {menuRows(entries).map((row) =>
          row.kind === "separator" ? (
            <ContextMenuSeparator key={row.key} />
          ) : row.entry.checked !== undefined ? (
            <ContextMenuCheckboxItem
              key={row.entry.id ?? row.entry.label}
              checked={row.entry.checked}
              closeOnClick
              disabled={row.entry.disabled}
              aria-keyshortcuts={row.entry.keyShortcuts}
              onClick={row.entry.onSelect}
            >
              {row.entry.label}
              {row.entry.shortcut && <ContextMenuShortcut>{row.entry.shortcut}</ContextMenuShortcut>}
            </ContextMenuCheckboxItem>
          ) : (
            <ContextMenuItem
              key={row.entry.id ?? row.entry.label}
              variant={row.entry.destructive ? "destructive" : "default"}
              disabled={row.entry.disabled}
              aria-keyshortcuts={row.entry.keyShortcuts}
              aria-current={row.entry.current ? "page" : undefined}
              className={cn(row.entry.current && "font-semibold")}
              onClick={row.entry.onSelect}
            >
              {row.entry.label}
              {row.entry.shortcut && <ContextMenuShortcut>{row.entry.shortcut}</ContextMenuShortcut>}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
