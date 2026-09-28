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
 * both pages send questions to its issues. A copy run by someone else points
 * this at its own repository (see docs/self-host.md).
 */
export const SOURCE_REPOSITORY = "https://github.com/meech-ward/elaborat.ing"

/** The date both pages show as "Last updated", in the reader's words. */
export const LAST_UPDATED = { iso: "2026-09-28", text: "September 28, 2026" }

/** A link out of the page, in the note's link colour. */
export function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-(--accent-soft-text) underline underline-offset-4">
      {children}
    </a>
  )
}

/**
 * The frame of the privacy and terms pages: the top bar, then the text in
 * one panel on the dotted page, set like a rendered note, and the links to
 * both pages under it.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
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
            <p className="text-[13px]! text-muted-foreground!">
              Last updated <time dateTime={LAST_UPDATED.iso}>{LAST_UPDATED.text}</time>
            </p>
            {children}
          </NoteProse>
        </FloatingPanel>
        <LegalLinks />
      </div>
    </DottedPage>
  )
}
