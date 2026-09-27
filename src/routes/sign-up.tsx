import { createFileRoute } from "@tanstack/react-router"
import { SignUpForm } from "@/components/sign-up-form"
import { AuthPage } from "@/features/auth"

export const Route = createFileRoute("/sign-up")({
  component: () => (
    <AuthPage title="Sign up" description="An account keeps your projects in sync across devices and lets you share them and connect agents.">
      <SignUpForm />
    </AuthPage>
  ),
})
