import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { z } from "zod"
import { LoginForm } from "@/components/login-form"
import { AuthPage, MagicLinkForm, useSession } from "@/features/auth"
import { safeNextPath } from "@/lib/safe-next-path"

export const Route = createFileRoute("/sign-in")({
  validateSearch: z.object({ next: z.string().optional() }),
  component: SignIn,
})

function SignIn() {
  const { next } = Route.useSearch()
  const session = useSession()
  // Already signed in (or just back from an emailed link): continue.
  useEffect(() => {
    if (session.status === "signed-in") window.location.replace(safeNextPath(next, "/"))
  }, [session.status, next])
  return (
    <AuthPage title="Sign in">
      <LoginForm />
      <MagicLinkForm next={next ?? null} />
    </AuthPage>
  )
}
