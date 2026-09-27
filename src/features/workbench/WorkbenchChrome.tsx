import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ButtonHTMLAttributes,
  type Ref,
} from "react";
import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";

/** Existing commands retain their handlers; Base UI owns keyboard/focus/dismissal. */
export function ActionMenu({
  children,
  label = "File actions",
  triggerRef,
  finalFocus,
  onClosed,
  trigger,
  triggerClassName = "wb-icon",
  align = "end",
}: {
  children: ReactNode;
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
    <Menu.Root
      onOpenChangeComplete={(open) => {
        if (!open) onClosed?.();
      }}
    >
      <Menu.Trigger ref={triggerRef} className={triggerClassName} aria-label={trigger ? undefined : label} title={trigger ? undefined : label}>
        {trigger ?? <MoreHorizontal size={18} />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={5} align={align} style={{ zIndex: 10000 }}>
          <Menu.Popup className="wb-menu" finalFocus={finalFocus}>
            {Children.toArray(children).map((child, index) =>
              isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child) ? (
                <Menu.Item
                  key={child.key ?? index}
                  className="wb-menu-item"
                  disabled={child.props.disabled}
                  render={child as ReactElement}
                />
              ) : null,
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
