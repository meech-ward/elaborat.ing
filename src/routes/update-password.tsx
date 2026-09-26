import { createFileRoute } from "@tanstack/react-router"
import { UpdatePasswordForm } from "@/components/update-password-form"
import { AuthPage } from "@/features/auth"

export const Route = createFileRoute("/update-password")({
  component: () => (
    <AuthPage title="Choose a new password">
      <UpdatePasswordForm />
    </AuthPage>
  ),
})
