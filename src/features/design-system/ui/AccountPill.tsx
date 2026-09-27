import { ChevronDown } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { initialFor } from "./AccountRows"
import { ActionMenu, type ActionMenuProps, type MenuEntry } from "./ActionMenu"

/**
 * Who is signed in, at a glance, in the top bar: shadcn's Avatar (the
 * picture, or the initial in accentSoft) and the email at 600, with a
 * chevron, as a ghost Button with a pill radius that opens an ActionMenu
 * with `menu` as its entries (Settings, Connected agents, Sign out). Its
 * accessible name reads "Signed in as" and the email. At most 300 wide; the
 * email truncates when there is less room.
 */
export function AccountPill({
  email,
  name = "",
  image,
  menu,
  menuProps,
  className,
}: {
  email: string
  /** Shown for the initial when there is one; the email otherwise. */
  name?: string
  image?: string
  menu: readonly MenuEntry[]
  menuProps?: ActionMenuProps
  className?: string
}) {
  return (
    <ActionMenu
      {...menuProps}
      entries={menu}
      contentProps={{ align: "end", ...menuProps?.contentProps }}
      trigger={
        <Button
          variant="ghost"
          data-slot="account-pill"
          className={cn("h-8 max-w-[300px] min-w-0 shrink gap-2 rounded-pill pr-2.5 pl-1 text-foreground pointer-coarse:h-10", className)}
        >
          <Avatar aria-hidden="true" size="sm" className="after:hidden pointer-coarse:size-8">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback>{initialFor(name, email)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate">
            <span className="sr-only">Signed in as </span>
            {email}
          </span>
          <ChevronDown aria-hidden="true" className="text-dim" />
        </Button>
      }
    />
  )
}
