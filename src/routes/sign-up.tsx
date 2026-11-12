import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect } from "react"
import { z } from "zod/mini"
import { SignUpForm } from "@/components/sign-up-form"
import { AuthPage, useAuth } from "@/features/auth"
import { safeNextPath } from "@/lib/safe-next-path"
import { signUpsEnabled } from "@/features/auth/signupPolicy"
import { buttonVariants } from "@/components/ui/button"

export const Route = createFileRoute("/sign-up")({
  validateSearch: z.object({ next: z.optional(z.string()) }),
  component: SignUp,
})

function SignUp() {
  const { next } = Route.useSearch()
  const auth = useAuth()
  // Signed in (with the emailed code, or already): continue.
  useEffect(() => {
    if (auth.status === "ready") window.location.replace(safeNextPath(next, "/"))
  }, [auth.status, next])
  if (!signUpsEnabled) {
    return (
      <AuthPage title="Accounts are created by an administrator">
        <Link to="/sign-in" search={next ? { next } : {}} className={buttonVariants({ variant: "link", size: "inline" })}>
          Sign in
        </Link>
      </AuthPage>
    )
  }
  return (
    <AuthPage title="Sign up" description="An account keeps your projects in sync across devices and lets you share them and connect agents.">
      <SignUpForm next={next ?? null} />
    </AuthPage>
  )
}
