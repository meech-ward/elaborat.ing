// Every menu in the app: the button menus (Base UI Menu) and the right-click
// menus (Base UI ContextMenu) share one popup, one item and one separator,
// so they look the same everywhere. Base UI owns keyboard, focus and
// dismissal; this file only adds the look and a way to feed both kinds of
// menu from one list of entries.
//
// The look: a 240px panel with a 1px line border, radius 12 and a soft
// shadow; items 30 high (40 on touch screens and phones) in 13px text; the
// highlighted item (pointer or keyboard) in the selection colour with link
// text; destructive items in the danger colour, after a separator, last;
// disabled items faded. Menus show no icons.
import type * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@/lib/utils";

const positionerClass = "z-[10000] outline-none";
const popupClass =
  "min-w-[240px] max-w-[min(500px,calc(100vw-20px))] max-h-[min(70dvh,var(--available-height,70dvh))] overflow-y-auto rounded-[12px] border border-[var(--line)] bg-[var(--bg)] p-1.5 text-[var(--text)] shadow-[0_16px_40px_var(--shadow)] outline-none";

function Menu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root {...props} />;
}

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger {...props} />;
}

function MenuContent({
  className,
  align = "end",
  sideOffset = 5,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className={positionerClass} align={align} sideOffset={sideOffset}>
        <MenuPrimitive.Popup className={cn(popupClass, className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger className={cn("select-none", className)} {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className={positionerClass} align="start" alignOffset={4} side="right">
        <ContextMenuPrimitive.Popup className={cn(popupClass, className)} {...props} />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/** One item, in a button menu or a right-click menu. */
function MenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-variant={variant}
      className={cn(
        "group flex min-h-[30px] w-full cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] leading-5 outline-none select-none",
        "pointer-coarse:min-h-10 max-[650px]:min-h-10 [&>svg]:hidden",
        variant === "destructive" ? "text-[var(--danger)]" : "text-[var(--text)]",
        "data-highlighted:bg-[var(--selection)] data-highlighted:text-[var(--link)] data-disabled:cursor-default data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** A keyboard shortcut at the right end of an item. Screen readers skip it. */
function MenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ml-auto pl-4 font-[family-name:var(--code-font)] text-[11px] text-[var(--muted)] group-data-highlighted:text-[var(--link)]",
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn("mx-1 my-[5px] h-px bg-[var(--line)]", className)} {...props} />;
}

/** One entry in a menu. The same list can feed a button menu and a right-click menu. */
interface MenuEntry {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A keyboard shortcut shown at the item's right end, such as ⌘D. */
  shortcut?: string;
  /** Removes something: shown in the danger colour, after a separator, last. */
  destructive?: boolean;
}

/** The items for a list of entries, destructive ones last. Works inside either kind of menu. */
function MenuItems({ items }: { items: readonly MenuEntry[] }) {
  const safe = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  const render = (item: MenuEntry) => (
    <MenuItem
      key={item.label}
      variant={item.destructive ? "destructive" : "default"}
      disabled={item.disabled}
      onClick={item.onSelect}
    >
      {item.label}
      {item.shortcut && <MenuShortcut>{item.shortcut}</MenuShortcut>}
    </MenuItem>
  );
  return (
    <>
      {safe.map(render)}
      {safe.length > 0 && destructive.length > 0 && <MenuSeparator />}
      {destructive.map(render)}
    </>
  );
}

export {
  Menu,
  MenuTrigger,
  MenuContent,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  MenuItem,
  MenuItems,
  MenuShortcut,
  MenuSeparator,
  type MenuEntry,
};
