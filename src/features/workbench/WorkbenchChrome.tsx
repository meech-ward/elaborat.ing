import {
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ButtonHTMLAttributes,
  type Ref,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuItems, MenuTrigger, type MenuEntry } from "@/components/ui/menu";

/**
 * A button that opens a menu. Existing commands retain their handlers; Base
 * UI owns keyboard/focus/dismissal. The items come from `items`, or from
 * `children` buttons, which take the menu's look in place of their own.
 */
export function ActionMenu({
  children,
  items,
  label = "File actions",
  triggerRef,
  finalFocus,
  onClosed,
  trigger,
  triggerClassName = "wb-icon",
  align = "end",
}: {
  children?: ReactNode;
  /** The menu's entries; the same list can feed a right-click menu. */
  items?: readonly MenuEntry[];
  label?: string;
  /** What the button shows; by default a "more" icon, named by `label`. */
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
  triggerRef?: Ref<HTMLButtonElement>;
  /** Where focus goes when the menu closes; by default, back to its button. */
  finalFocus?: () => boolean;
  /** Runs once the menu has finished closing. */
  onClosed?: () => void;
}) {
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (!open) onClosed?.();
      }}
    >
      <MenuTrigger ref={triggerRef} className={triggerClassName} aria-label={trigger ? undefined : label} title={trigger ? undefined : label}>
        {trigger ?? <MoreHorizontal size={18} />}
      </MenuTrigger>
      <MenuContent align={align} finalFocus={finalFocus}>
        {items ? (
          <MenuItems items={items} />
        ) : (
          Children.toArray(children).map((child, index) =>
            isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child) ? (
              <MenuItem
                key={child.key ?? index}
                disabled={child.props.disabled}
                render={cloneElement(child as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>, { className: undefined })}
              />
            ) : null,
          )
        )}
      </MenuContent>
    </Menu>
  );
}
