import { createFileRoute } from "@tanstack/react-router"
import { ForgotPasswordForm } from "@/components/forgot-password-form"
import { AuthPage } from "@/features/auth"

export const Route = createFileRoute("/forgot-password")({
  component: () => (
    <AuthPage title="Reset your password">
      <ForgotPasswordForm />
    </AuthPage>
  ),
})
