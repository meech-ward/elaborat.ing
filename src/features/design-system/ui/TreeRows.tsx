import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react"
import { useId, type ComponentProps, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { SidebarMenuAction, SidebarMenuItem } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { ActionContextMenu, ActionMenu, type MenuEntry } from "./ActionMenu"
import { KindBadge, type FileKind } from "./KindBadge"
import { PanelRow, type PanelRowProps, type PanelRowSize } from "./PanelRow"
import { DirtyDot } from "./StatusDot"

// The file tree's rows: PanelRows in shadcn SidebarMenuItems (put them in a
// SidebarMenu). A row is indented by `depth` (0 at the top of the project):
// 16px a level on the desktop, 18px on phones. The tree keeps which folders
// are open itself (open and onClick here), so a folder row does not wrap its
// children in a Collapsible.

type TreeRowProps = Omit<PanelRowProps, "children" | "isActive" | "contextMenu"> & {
  name: ReactNode
  /** How deep the row sits: 0 at the top of the project. */
  depth?: number
  selected?: boolean
  /**
   * Shown at the end of the row on hover and focus: a TreeRowMenu. On a
   * phone's rows (`touch`) only the selected row shows it, as C5's files
   * screen draws the tree; every row opens the same entries on a long
   * press (`rowMenu`).
   */
  actions?: ReactNode
  /**
   * The same entries as a right-click menu on the row (a long press on
   * touch screens), usually the ones its TreeRowMenu holds.
   */
  rowMenu?: { label: string; entries: readonly MenuEntry[] }
}

/** The row's button, or the row as its right-click menu's trigger. */
function withContextMenu(row: ReactElement, menu: TreeRowProps["rowMenu"]) {
  return menu ? <ActionContextMenu entries={menu.entries} aria-label={menu.label} render={row} /> : row
}

// The depth is a number, not a colour, so it goes in as a CSS variable.
const depthStyle = (depth: number, style: CSSProperties | undefined) =>
  ({ ...style, "--tree-depth": depth }) as CSSProperties

// Indents from the C5 screens: a folder's chevron starts 8px in (10 on
// phones), a file's badge 15 (18), plus one step a level.
const folderIndent: Record<PanelRowSize, string> = {
  default: "pl-[calc(8px+var(--tree-depth)*16px)]",
  touch: "pl-[calc(10px+var(--tree-depth)*18px)]",
}
const fileIndent: Record<PanelRowSize, string> = {
  default: "pl-[calc(15px+var(--tree-depth)*16px)]",
  touch: "pl-[calc(18px+var(--tree-depth)*18px)]",
}

// From the md breakpoint up, SidebarMenuAction shows a row's actions only on
// hover or focus, so the row keeps the design's padding and the actions
// cover its end; on narrower screens they always show, and the row makes
// room for them (a phone row's 32 wide button, 40 with its gap). A phone's
// rows have them only while selected (TreeRowProps.actions).
const roomForActions: Record<PanelRowSize, string> = {
  default: "md:group-has-data-[sidebar=menu-action]/menu-item:pr-2",
  touch: "group-has-data-[sidebar=menu-action]/menu-item:pr-10 md:group-has-data-[sidebar=menu-action]/menu-item:pr-2.5",
}

/** A folder: a chevron on the left (down when open), then the name. No folder icon. */
export function TreeFolderRow({
  name,
  open,
  depth = 0,
  selected = false,
  actions,
  rowMenu,
  size = "default",
  className,
  style,
  ...props
}: TreeRowProps & { open: boolean }) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <SidebarMenuItem data-tree-row="folder">
      {withContextMenu(
        <PanelRow
          size={size}
          isActive={selected}
          aria-expanded={open}
          style={depthStyle(depth, style)}
          className={cn(folderIndent[size], roomForActions[size], className)}
          {...props}
        >
          <Chevron aria-hidden="true" className="text-dim" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </PanelRow>,
        rowMenu,
      )}
      {(size !== "touch" || selected) && actions}
    </SidebarMenuItem>
  )
}

/**
 * A file: its KindBadge, the name, and a dot in the dirty colour while it
 * has unsaved changes. The row's name stays the file name; the dot is its
 * description ("Unsaved changes").
 */
export function TreeFileRow({
  name,
  kind,
  dirty = false,
  depth = 0,
  selected = false,
  actions,
  rowMenu,
  size = "default",
  className,
  style,
  "aria-describedby": describedBy,
  ...props
}: TreeRowProps & { kind: FileKind; dirty?: boolean }) {
  const dirtyId = useId()
  return (
    <SidebarMenuItem data-tree-row="file">
      {withContextMenu(
        <PanelRow
          size={size}
          isActive={selected}
          aria-current={selected ? "true" : undefined}
          aria-describedby={[describedBy, dirty ? dirtyId : undefined].filter(Boolean).join(" ") || undefined}
          style={depthStyle(depth, style)}
          className={cn(fileIndent[size], roomForActions[size], className)}
          {...props}
        >
          <KindBadge kind={kind} size={size} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {dirty && <DirtyDot id={dirtyId} aria-hidden="true" label="Unsaved changes" className={cn(size === "touch" && "size-2")} />}
        </PanelRow>,
        rowMenu,
      )}
      {(size !== "touch" || selected) && actions}
    </SidebarMenuItem>
  )
}

/**
 * A new file's or folder's name, typed where it will appear: the field
 * (shadcn's Input) at the depth of the rows in that folder, 28 high with the
 * row's radius and 13px text (40 high and 15px on phones), and what is wrong
 * with the name under it, in the danger colour. Every prop but `depth`,
 * `size` and `error` goes on the input; give it an aria-label.
 */
export function TreeNameField({
  depth = 0,
  size = "default",
  error,
  className,
  style,
  "aria-describedby": describedBy,
  ...props
}: Omit<ComponentProps<"input">, "size"> & {
  depth?: number
  size?: PanelRowSize
  /** Why the name cannot be used; shown under the field and announced. */
  error?: string | null
}) {
  const errorId = useId()
  return (
    <SidebarMenuItem data-tree-row="name-field" style={depthStyle(depth, style)} className="flex flex-col gap-1 py-0.5">
      <Input
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          size === "touch"
            ? "ml-[calc(8px+var(--tree-depth)*18px)] h-10 w-[calc(100%-8px-var(--tree-depth)*18px)] rounded-button px-2.5 md:text-[15px]"
            : "ml-[calc(7px+var(--tree-depth)*16px)] h-7 w-[calc(100%-7px-var(--tree-depth)*16px)] rounded-row px-2 pointer-coarse:h-10",
          className,
        )}
        {...props}
      />
      {error ? (
        <p
          id={errorId}
          role="alert"
          className={cn(
            "text-xs leading-snug text-destructive [overflow-wrap:anywhere]",
            size === "touch" ? "ml-[calc(8px+var(--tree-depth)*18px)] text-[13px]" : "ml-[calc(7px+var(--tree-depth)*16px)]",
          )}
        >
          {error}
        </p>
      ) : null}
    </SidebarMenuItem>
  )
}

/**
 * A row's actions: an ellipsis button at the end of the row (shadcn's
 * SidebarMenuAction) that opens the entries as an ActionMenu. It shows on
 * hover and focus, while its menu is open, and always on phones. Its fill
 * matches the row under it, so it covers the dirty dot. On a phone's rows
 * (`touch`) it is a quiet dim ellipsis with no fill, beside the dot.
 */
export function TreeRowMenu({
  label,
  entries,
  size = "default",
}: {
  /** The button's accessible name, e.g. "Actions for docs/pricing.md". */
  label: string
  entries: readonly MenuEntry[]
  size?: PanelRowSize
}) {
  return (
    <ActionMenu
      entries={entries}
      contentProps={{ align: "end", "aria-label": label }}
      trigger={
        <SidebarMenuAction
          showOnHover
          aria-label={label}
          title={label}
          className={cn(
            "top-1/2 right-1 -translate-y-1/2 rounded-[6px] bg-seg text-muted-foreground peer-data-[size=default]/menu-button:top-1/2 hover:bg-panel hover:text-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid peer-data-active/menu-button:bg-accent-soft peer-data-active/menu-button:hover:bg-panel",
            size === "touch"
              ? "w-8 rounded-row bg-transparent text-dim peer-data-active/menu-button:bg-transparent peer-data-active/menu-button:text-accent-soft-text"
              : "w-5 pointer-coarse:w-8",
          )}
        >
          <Ellipsis aria-hidden="true" />
        </SidebarMenuAction>
      }
    />
  )
}
