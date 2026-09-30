import { Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { useEffect, type ReactNode } from "react"
import { buttonVariants } from "@/components/ui/button"
import { DottedPage } from "@/components/panel"
// Not the auth barrel: its sign-in frame links here (LegalLinks).
import { AccountHeader } from "@/features/auth/AccountHeader"
import { FloatingPanel, NoteProse } from "@/features/design-system"
import { cn } from "@/lib/utils"
import { LegalLinks } from "./LegalLinks"

/**
 * The public repository of this copy's code: the terms link its license, and
 * the pages send questions to its issues. A copy run by someone else points
 * this at its own repository (see docs/self-host.md).
 */
export const SOURCE_REPOSITORY = "https://github.com/meech-ward/elaborat.ing"

/** A date a page shows as "Last updated": for the page's code, and in the reader's words. */
export type UpdatedDate = { iso: string; text: string }

/** A link out of the page, in the note's link colour. */
export function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-(--accent-soft-text) underline underline-offset-4">
      {children}
    </a>
  )
}

/**
 * The frame of the privacy, terms and support pages: the top bar, then the
 * text in one panel on the dotted page, set like a rendered note, with the
 * date it last changed where it says, and the links to the pages under it.
 */
export function LegalPage({ title, updated, children }: { title: string; updated?: UpdatedDate; children: ReactNode }) {
  useEffect(() => {
    const before = document.title
    document.title = `${title} · elaborat.ing`
    return () => {
      document.title = before
    }
  }, [title])
  return (
    <DottedPage className="flex flex-col">
      <AccountHeader />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-4 px-4 pt-4 pb-6">
        <FloatingPanel render={<main />}>
          <NoteProse className="px-5 py-6 sm:px-10 sm:py-[30px] [&_ul]:m-0 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-[22px]">
            <Link to="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 self-start")}>
              <ChevronLeft aria-hidden="true" />
              Home
            </Link>
            <h1>{title}</h1>
            {updated && (
              <p className="text-[13px]! text-muted-foreground!">
                Last updated <time dateTime={updated.iso}>{updated.text}</time>
              </p>
            )}
            {children}
          </NoteProse>
        </FloatingPanel>
        <LegalLinks />
      </div>
    </DottedPage>
  )
}
