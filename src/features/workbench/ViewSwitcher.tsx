/** Shared presentation-only view switcher.
 *
 * All three file headers (MDX, native drawing, D2) render this same
 * token-styled segmented control at the native left placement. It owns no
 * state, selection, save or lifecycle behavior: the active value, labels,
 * disabled state and selection handler stay with each calling view.
 *
 * Internally this is a shadcn Toggle Group (single selection) so the group
 * gets arrow-key navigation and roving focus; the wb-mode tokens keep the
 * existing look. Exactly one mode stays selected: a group change that would
 * leave nothing pressed keeps the current mode.
 */
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

export type ViewSwitchOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  /** Tooltip, for example the name with its shortcut. */
  title?: string;
  /** The `aria-keyshortcuts` value. */
  keyShortcuts?: string;
};

/** Mandatory single selection: an empty pressed set keeps the current mode. */
export function resolveMandatorySelection<T extends string>(
  current: T,
  next: readonly T[],
): T {
  return next.length > 0 ? next[0] : current;
}

export function ViewSwitcher<T extends string>({
  ariaLabel,
  options,
  active,
  disabled = false,
  onSelect,
}: {
  ariaLabel: string;
  options: ReadonlyArray<ViewSwitchOption<T>>;
  active: T;
  disabled?: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className="wb-mode"
      value={[active]}
      onValueChange={(next) => {
        // Group values are strings at the boundary; accept only known
        // options so an unknown value can never become the mode.
        const known = next.filter((value): value is T =>
          options.some((option) => option.value === value),
        );
        const selected = resolveMandatorySelection(active, known);
        if (selected !== active) onSelect(selected);
      }}
      disabled={disabled}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
          aria-keyshortcuts={option.keyShortcuts}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
