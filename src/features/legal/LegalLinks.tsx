import { Link } from "@tanstack/react-router"
import { cn } from "@/lib/utils"

const link = "inline-flex min-h-10 items-center px-2 underline-offset-4 hover:text-foreground hover:underline"

/** The links to the support, privacy and terms pages, for the foot of the pages outside a project. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Support, privacy and terms" className={cn("flex justify-center gap-2 text-[12.5px] text-dim", className)}>
      <Link to="/support" className={link}>
        Support
      </Link>
      <Link to="/privacy" className={link}>
        Privacy
      </Link>
      <Link to="/terms" className={link}>
        Terms
      </Link>
    </nav>
  )
}
