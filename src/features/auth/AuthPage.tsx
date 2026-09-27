import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Brand, DottedPage, panel } from "@/components/panel"
import { cn } from "@/lib/utils"
import { supabaseConfigured } from "@/lib/supabase/client"

/**
 * The frame around the sign-in pages: one card on the dotted background.
 * `hideTitle` keeps the h1 for screen readers only, for a card that shows its
 * own heading.
 */
export function AuthPage({ title, hideTitle = false, children }: { title: string; hideTitle?: boolean; children: ReactNode }) {
  return (
    <DottedPage className="flex flex-col items-center justify-center px-4 py-10">
      <main className="flex w-full max-w-[400px] flex-col gap-5">
        <Link to="/" className="self-center text-xl">
          <Brand />
        </Link>
        <div className={cn(panel, "flex flex-col gap-5 p-6")}>
          <h1 className={hideTitle ? "sr-only" : "text-[21px] leading-tight font-semibold"}>{title}</h1>
          {supabaseConfigured() ? (
            children
          ) : (
            <p role="alert" className="text-sm">
              This copy of elaborat.ing is not connected to a Supabase project yet. Set VITE_SUPABASE_URL and
              VITE_SUPABASE_PUBLISHABLE_KEY when you build it.
            </p>
          )}
        </div>
      </main>
    </DottedPage>
  )
}
