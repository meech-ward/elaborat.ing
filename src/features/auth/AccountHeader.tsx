import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"
import { useSession } from "./useSession"

/** Who is signed in, with a way out; or a way in. Nothing when the build has no Supabase project. */
export function AccountHeader() {
  const session = useSession()
  if (session.status === "unconfigured" || session.status === "loading") return null
  return (
    <header className="flex items-center justify-end gap-3 px-6 py-3 text-sm">
      {session.status === "signed-in" ? (
        <>
          <span>
            Signed in as <strong>{session.session.user.email}</strong>
          </span>
          <Button variant="outline" size="sm" onClick={() => void createClient().auth.signOut()}>
            Sign out
          </Button>
        </>
      ) : (
        <Link to="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>
      )}
    </header>
  )
}
