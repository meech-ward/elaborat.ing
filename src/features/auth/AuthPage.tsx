import type { ReactNode } from "react"
import { DottedPage } from "@/components/panel"
import { Callout } from "@/features/design-system"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseConfigured } from "@/lib/supabase/client"
import { AccountHeader } from "./AccountHeader"

/**
 * The frame around the sign-in pages: the top bar, then one card 400 wide
 * in the middle of the dotted page, with the title at 21/600 and an
 * optional line under it. `hideTitle` keeps the h1 for screen readers only,
 * for a card that shows its own heading.
 */
export function AuthPage({
  title,
  description,
  hideTitle = false,
  children,
}: {
  title: string
  description?: ReactNode
  hideTitle?: boolean
  children: ReactNode
}) {
  return (
    <DottedPage className="flex flex-col">
      <AccountHeader />
      <main className="flex flex-1 justify-center px-3 pt-[6vh] pb-12 sm:px-4 sm:pt-[10vh]">
        <Card className="h-fit w-full max-w-[400px] gap-5">
          <CardHeader className={hideTitle ? "sr-only" : undefined}>
            <CardTitle>
              <h1 className="text-[21px] leading-tight font-semibold">{title}</h1>
            </CardTitle>
            {description && !hideTitle && <CardDescription className="text-[13px] leading-normal">{description}</CardDescription>}
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {supabaseConfigured() ? (
              children
            ) : (
              <Callout>
                This copy of elaborat.ing is not connected to a Supabase project yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY when you
                build it.
              </Callout>
            )}
          </CardContent>
        </Card>
      </main>
    </DottedPage>
  )
}
