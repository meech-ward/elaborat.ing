import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"

/** Something that needs an account, shown locked: its reason links to sign-up. */
export function SignUpTo({ children }: { children: string }) {
  return (
    <Link to="/sign-up" className="inline-flex items-center gap-1.5 text-(--link) underline underline-offset-4">
      <Lock size={13} aria-hidden="true" />
      {children}
    </Link>
  )
}

/** The local project's header: where the work is kept, and what an account adds. */
export function LocalProjectHeader({ error }: { error: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <Link to="/" className="underline underline-offset-4">
          Home
        </Link>
        <h1 className="truncate font-semibold">Local project</h1>
      </div>
      <p className="text-muted-foreground">Saved in this browser only. It is lost if the browser clears this site's data. Sign up to keep it in an account.</p>
      <ul aria-label="Needs an account" className="flex flex-wrap gap-x-3 gap-y-1">
        <li>
          <SignUpTo>Sign up to create projects</SignUpTo>
        </li>
        <li>
          <SignUpTo>Sign up to share</SignUpTo>
        </li>
        <li>
          <SignUpTo>Sign up to comment</SignUpTo>
        </li>
      </ul>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
