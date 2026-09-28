import { cva } from "class-variance-authority"
import { Settings } from "lucide-react"
import { useId, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { SidebarMenuBadge, SidebarMenuItem } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { ActionMenu, type ActionMenuProps, type MenuEntry } from "./ActionMenu"
import { PanelRow, type PanelRowProps, type PanelRowSize } from "./PanelRow"

// The account panel at the foot of the sidebar: IconRows ("Connected
// agents", "Look and theme") in a SidebarMenu, then the PersonRow.

/**
 * The account panel's rows are PanelRows in the muted text colour: 32 high,
 * radius 8, a 9px gap (`touch`: 44 high, 15px, 20px icons, a 12px gap).
 */
const iconRowVariants = cva("text-muted-foreground", {
  variants: {
    size: {
      default: "h-8 gap-[9px] rounded-tool pointer-coarse:h-10",
      touch: "h-11 gap-3 [&_svg]:size-5",
    },
  },
  defaultVariants: { size: "default" },
})

/**
 * A row with an icon and a label, and an optional count at the end
 * (shadcn's SidebarMenuBadge in 11px mono, dim), which describes the row to
 * screen readers.
 */
export function IconRow({
  icon,
  label,
  count,
  size = "default",
  className,
  ...props
}: Omit<PanelRowProps, "children"> & {
  /** A Lucide icon element, e.g. <Bot />. */
  icon: ReactNode
  label: ReactNode
  count?: ReactNode
}) {
  const countId = useId()
  const hasCount = count !== undefined && count !== null
  return (
    <SidebarMenuItem>
      <PanelRow
        size={size}
        aria-describedby={hasCount ? countId : undefined}
        className={cn(iconRowVariants({ size }), className)}
        {...props}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </PanelRow>
      {hasCount && (
        <SidebarMenuBadge
          id={countId}
          className="top-1/2 right-2 h-auto min-w-0 -translate-y-1/2 px-0 font-mono text-[11px] font-normal text-dim peer-data-[size=default]/menu-button:top-1/2 peer-hover/menu-button:text-dim"
        >
          {count}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

/** The letter shown in place of a picture: the name's first letter, else the email's. */
export function initialFor(name: string, email = ""): string {
  const first = Array.from(name.trim() || email.trim())[0]
  return first ? first.toLocaleUpperCase() : "?"
}

const personSizes: Record<PanelRowSize, { row: string; avatar: string; fallback: string; name: string; email: string }> = {
  default: {
    row: "gap-2.5 px-2 pt-2 pb-0.5",
    avatar: "size-[30px]",
    fallback: "text-xs",
    name: "text-[13px]",
    email: "text-xs",
  },
  touch: {
    row: "gap-3 px-2.5 pt-2",
    avatar: "size-9",
    fallback: "text-sm",
    name: "text-[15px]",
    email: "text-[13px]",
  },
}

// No primitive fits the row itself: it is layout around shadcn's Avatar and
// an ActionMenu, not a control. On phones, where the sync status takes the
// gear's place, the whole row is the menu's Button instead.

/**
 * The signed-in person: Avatar (the picture, or the initial in accentSoft),
 * the name at 600 and the email in dim, then a gear button that opens an
 * ActionMenu with `menu` as its entries. `status` (a StatusDot, such as the
 * sync state) sits at the end of the name's line. `trailing` replaces the
 * gear (the phone shows the sync status there); with a `menu` too, the whole
 * row opens the menu, so it keeps a way in.
 */
export function PersonRow({
  name,
  email,
  image,
  menu,
  menuLabel = "Settings, help and terms",
  menuProps,
  status,
  trailing,
  size = "default",
  className,
}: {
  name: string
  email: string
  /** A picture URL; without one the initial shows. */
  image?: string
  /** The gear menu's entries. */
  menu?: readonly MenuEntry[]
  menuLabel?: string
  /** Passed to the menu: onOpenChangeComplete, and contentProps such as finalFocus. */
  menuProps?: ActionMenuProps
  /** Shown at the end of the name's line, e.g. <StatusDot status="synced" />. */
  status?: ReactNode
  trailing?: ReactNode
  size?: PanelRowSize
  className?: string
}) {
  const s = personSizes[size]
  const person = (
    <>
      <Avatar aria-hidden="true" className={cn("after:hidden", s.avatar)}>
        {image && <AvatarImage src={image} alt="" />}
        <AvatarFallback className={s.fallback}>{initialFor(name, email)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col leading-[normal]">
        {status ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate font-semibold text-foreground", s.name)}>{name}</span>
            <span className={cn("shrink-0 text-dim", s.email)}>{status}</span>
          </span>
        ) : (
          <span className={cn("truncate font-semibold text-foreground", s.name)}>{name}</span>
        )}
        {/* Without a name of their own, the name is the email: it shows once. */}
        {email !== name && <span className={cn("truncate text-dim", s.email)}>{email}</span>}
      </span>
    </>
  )
  if (trailing && menu) {
    // The row's text names the button; the menu says what it holds.
    return (
      <ActionMenu
        {...menuProps}
        entries={menu}
        contentProps={{ align: "end", side: "top", "aria-label": menuLabel, ...menuProps?.contentProps }}
        trigger={
          <Button
            variant="ghost"
            data-slot="person-row"
            className={cn(
              "h-auto w-full justify-start py-[5px] text-left font-normal",
              size === "touch" ? "gap-3 px-2.5" : "gap-2.5 px-2",
              className,
            )}
          >
            {person}
            {trailing}
          </Button>
        }
      />
    )
  }
  return (
    <div data-slot="person-row" className={cn("flex items-center", s.row, className)}>
      {person}
      {trailing ??
        (menu && (
          <ActionMenu
            {...menuProps}
            entries={menu}
            // Narrower than a menu's usual 254, so it opens inside the account panel.
            contentProps={{ align: "end", side: "top", className: "min-w-56", ...menuProps?.contentProps }}
            trigger={
              <Button variant="ghost" size={size === "touch" ? "icon-lg" : "icon"} aria-label={menuLabel} title={menuLabel}>
                <Settings aria-hidden="true" />
              </Button>
            }
          />
        ))}
    </div>
  )
}
