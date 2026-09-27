import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge knows Tailwind's own radius and shadow names; these are the
// style guide's (index.css @theme), so a later rounded-tool replaces an
// earlier rounded-button as rounded-lg would replace rounded-md. Without
// them both classes stay and the stylesheet's order picks one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["row", "tool", "button", "tile", "menu", "panel", "pill"],
      shadow: ["panel", "island"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
