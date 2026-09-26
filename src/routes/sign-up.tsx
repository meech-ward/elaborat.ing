import { createFileRoute } from "@tanstack/react-router"
import { SignUpForm } from "@/components/sign-up-form"
import { AuthPage } from "@/features/auth"

export const Route = createFileRoute("/sign-up")({
  component: () => (
    <AuthPage title="Sign up">
      <SignUpForm />
    </AuthPage>
  ),
})
