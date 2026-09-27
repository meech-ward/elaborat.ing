import { cva } from "class-variance-authority"
import { Search, X } from "lucide-react"
import type { ComponentProps } from "react"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

/**
 * The search field at the top of the files panel: shadcn's InputGroup with a
 * search icon and the input. 34 high (the design's 32 plus its border),
 * radius 9, the field fill, a dim icon 8px from the text, 13px. `touch` is
 * the phone field: 46 high, radius 12, 15px text and a 10px gap. (On touch
 * screens the app sets every field to 16px, so iOS does not zoom.)
 * `className` goes on the group (for margins); every other prop on the input.
 * With `onClear`, a Clear search button (an x) ends the field while it has
 * text, in place of the browser's own, which never shows.
 */
const searchFieldVariants = cva("", {
  variants: {
    size: {
      default: "h-[34px]",
      touch: "h-[46px] rounded-menu has-[>[data-align=inline-start]]:[&>input]:pl-2.5",
    },
  },
  defaultVariants: { size: "default" },
})

export type SearchFieldProps = Omit<ComponentProps<"input">, "size"> & {
  size?: "default" | "touch"
  /** Empties the field: shown as the Clear search button while there is text. */
  onClear?: () => void
}

export function SearchField({ size = "default", className, type = "search", onClear, ...props }: SearchFieldProps) {
  const filled = typeof props.value === "string" ? props.value !== "" : false
  return (
    <InputGroup data-size={size} className={cn(searchFieldVariants({ size }), className)}>
      <InputGroupAddon className={cn(size === "touch" && "pl-3")}>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type={type}
        className={cn("[&::-webkit-search-cancel-button]:appearance-none", size === "touch" && "md:text-[15px]")}
        {...props}
      />
      {onClear && filled && (
        <InputGroupAddon align="inline-end" className={cn(size === "touch" && "pr-2")}>
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            title="Clear search"
            className={cn("text-dim hover:text-foreground", size === "touch" && "size-8")}
            onClick={onClear}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}
