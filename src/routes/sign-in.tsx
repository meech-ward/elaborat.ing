import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { z } from "zod"
import { LoginForm } from "@/components/login-form"
import { AuthPage, useAuth } from "@/features/auth"
import { safeNextPath } from "@/lib/safe-next-path"

export const Route = createFileRoute("/sign-in")({
  validateSearch: z.object({ next: z.string().optional() }),
  component: SignIn,
})

function SignIn() {
  const { next } = Route.useSearch()
  const auth = useAuth()
  // Already signed in (or just back from an emailed link): continue.
  useEffect(() => {
    if (auth.status === "ready") window.location.replace(safeNextPath(next, "/"))
  }, [auth.status, next])
  return (
    <AuthPage title="Sign in" description="Your projects, on any device, and the agents you connect.">
      <LoginForm next={next ?? null} />
    </AuthPage>
  )
}
