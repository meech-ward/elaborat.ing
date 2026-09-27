import { createFileRoute } from "@tanstack/react-router"
import { ForgotPasswordForm } from "@/components/forgot-password-form"
import { AuthPage } from "@/features/auth"

export const Route = createFileRoute("/forgot-password")({
  component: () => (
    <AuthPage title="Reset your password" description="Type in your email and we'll send you a link to reset your password.">
      <ForgotPasswordForm />
    </AuthPage>
  ),
})
