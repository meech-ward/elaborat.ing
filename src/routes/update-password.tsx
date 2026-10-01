import { createFileRoute, Link } from "@tanstack/react-router"
import { buttonVariants } from "@/components/ui/button"
import { UpdatePasswordForm } from "@/components/update-password-form"
import { AuthPage, useAuth } from "@/features/auth"
import { Banner } from "@/features/design-system"

// The emailed reset link signs in and lands here (forgot-password-form.tsx).
export const Route = createFileRoute("/update-password")({
  component: UpdatePassword,
})

function UpdatePassword() {
  const auth = useAuth()
  return (
    <AuthPage title="Choose a new password" description="Save a new password to use from now on.">
      {auth.status === "signed-out" ? (
        <>
          <Banner tone="danger">This link has expired or was already used. Send yourself a new one.</Banner>
          <Link to="/forgot-password" className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}>
            Send a new link
          </Link>
        </>
      ) : (
        <UpdatePasswordForm />
      )}
    </AuthPage>
  )
}
