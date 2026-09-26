import type { ReactNode } from "react"
import { supabaseConfigured } from "@/lib/supabase/client"

/** The frame around the sign-in pages. */
export function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <h1 className="sr-only">{title}</h1>
      <p className="text-center text-lg font-semibold tracking-tight">elaborat.ing</p>
      {supabaseConfigured() ? (
        children
      ) : (
        <p role="alert" className="text-sm">
          This copy of elaborat.ing is not connected to a Supabase project yet. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_PUBLISHABLE_KEY when you build it.
        </p>
      )}
    </main>
  )
}
