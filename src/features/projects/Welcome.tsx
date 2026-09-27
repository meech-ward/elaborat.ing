import { Link } from "@tanstack/react-router"
import { buttonVariants } from "@/components/ui/button"
import { Callout, ScreenPreview } from "@/features/design-system"
import { projectHref } from "@/features/navigation"
import { LOCAL_PROJECT_ID } from "@/features/project-storage/localProject"

/**
 * The home page for someone signed out: what the app is in a line, a way to
 * start writing without an account (in the local project) and a way in, and
 * a picture of the app. `configured` is false when the build has no
 * Supabase project, so neither way works.
 */
export function Welcome({ configured = true }: { configured?: boolean }) {
  return (
    <section
      aria-labelledby="welcome-heading"
      className="mx-auto grid w-full max-w-[1240px] items-center gap-8 px-3 pt-4 pb-12 sm:px-6 sm:pt-8 lg:my-auto lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:gap-14 lg:pt-0 lg:pb-[76px]"
    >
      <div className="flex flex-col gap-5">
        <h1 id="welcome-heading" className="text-[32px] leading-[1.1] font-bold tracking-[-0.02em] text-balance sm:text-[44px]">
          Write, draw and diagram alongside your agents.
        </h1>
        <p className="text-[15.5px] leading-[1.6] text-body">
          Notes in MDX, drawings in Excalidraw, diagrams in D2, and your agents read and edit them over MCP.
        </p>
        {configured ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Link to={projectHref(LOCAL_PROJECT_ID)} className={buttonVariants({ size: "lg" })}>
                Start writing
              </Link>
              <Link to="/sign-in" className={buttonVariants({ size: "lg", variant: "secondary" })}>
                Sign in
              </Link>
            </div>
            <p className="text-[13px] leading-normal text-dim">
              No account needed: your work is saved in this browser only until you{" "}
              <Link to="/sign-up" className={buttonVariants({ variant: "link", size: "inline" })}>
                sign up
              </Link>
              .
            </p>
          </>
        ) : (
          <Callout>This copy of elaborat.ing is not connected to a Supabase project yet.</Callout>
        )}
      </div>
      <ScreenPreview />
    </section>
  )
}
