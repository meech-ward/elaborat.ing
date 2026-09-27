import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Something that needs an account, shown locked: its reason links to sign-up, in the link button's look with a lock. */
export function SignUpTo({ children }: { children: string }) {
  return (
    <Link to="/sign-up" className={cn(buttonVariants({ variant: "link", size: "inline" }), "inline-flex items-center gap-1.5 underline")}>
      <Lock aria-hidden="true" className="size-3.5" />
      {children}
    </Link>
  )
}
