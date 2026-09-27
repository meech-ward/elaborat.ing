import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { DottedPage } from "@/components/panel"
import { ConnectedAgents } from "@/features/agents"
import { AccountHeader, AuthGate } from "@/features/auth"
import { FloatingPanel } from "@/features/design-system"
import { cn } from "@/lib/utils"

// The agents connected to your account, and disconnecting them.
export const Route = createFileRoute("/agents")({
  component: Agents,
})

function Agents() {
  return (
    <DottedPage>
      <AccountHeader />
      <div className="mx-auto flex max-w-[640px] flex-col gap-4 px-4 pt-4 pb-10 sm:pb-16">
        <FloatingPanel render={<main />} className="flex flex-col gap-4 p-5">
          <Link to="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 self-start")}>
            <ChevronLeft aria-hidden="true" />
            Your projects
          </Link>
          <h1 className="text-[21px] leading-tight font-semibold">Connected agents</h1>
          <AuthGate
            signedOut={
              <p className="text-sm">
                <Link to="/sign-in" search={{ next: "/agents" }} className={buttonVariants({ variant: "link", size: "inline" })}>
                  Sign in
                </Link>{" "}
                to see the agents connected to your account.
              </p>
            }
          >
            <ConnectedAgents />
          </AuthGate>
        </FloatingPanel>
      </div>
    </DottedPage>
  )
}
