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
}: {
  children: ReactNode;
  label?: string;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger ref={triggerRef} className="wb-icon" aria-label={label} title={label}>
        <MoreHorizontal size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={5} align="end" style={{ zIndex: 10000 }}>
          <Menu.Popup className="wb-menu">
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
