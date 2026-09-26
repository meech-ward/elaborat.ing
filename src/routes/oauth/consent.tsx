import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { OAuthConsent } from "@/components/oauth-consent"
import { AuthPage } from "@/features/auth"

// Supabase Auth's OAuth server sends an agent's authorization request here
// (`authorization_url_path` in supabase/config.toml). A signed-out visitor is
// sent to /sign-in and brought back.
export const Route = createFileRoute("/oauth/consent")({
  validateSearch: z.object({ authorization_id: z.string().optional() }),
  component: Consent,
})

function Consent() {
  const { authorization_id } = Route.useSearch()
  return (
    <AuthPage title="Allow an app to use your account">
      <OAuthConsent authorizationId={authorization_id ?? null} signInPath="/sign-in" productName="elaborat.ing" />
    </AuthPage>
  )
}
