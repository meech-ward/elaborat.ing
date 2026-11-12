import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { signUpsEnabled } from "@/features/auth/signupPolicy"

/** Something that needs an account, shown locked with a way to create one or sign in. */
export function AccountRequiredLink({ action }: { action: string }) {
  return (
    <Link to={signUpsEnabled ? "/sign-up" : "/sign-in"} className={cn(buttonVariants({ variant: "link", size: "inline" }), "inline-flex items-center gap-1.5 underline")}>
      <Lock aria-hidden="true" className="size-3.5" />
      {signUpsEnabled ? "Sign up" : "Sign in"} to {action}
    </Link>
  )
}
