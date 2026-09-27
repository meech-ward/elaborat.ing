import { createFileRoute, Link } from "@tanstack/react-router"
import { DottedPage, panel } from "@/components/panel"
import { ConnectedAgents } from "@/features/agents"
import { AccountHeader, AuthGate } from "@/features/auth"
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
        <main className={cn(panel, "flex flex-col gap-4 p-5")}>
          <Link to="/" className="self-start text-sm text-(--accent-soft-text) underline underline-offset-4">
            Your projects
          </Link>
          <h1 className="text-[21px] leading-tight font-semibold">Connected agents</h1>
          <AuthGate
            signedOut={
              <p className="text-sm">
                <Link to="/sign-in" search={{ next: "/agents" }} className="text-(--accent-soft-text) underline underline-offset-4">
                  Sign in
                </Link>{" "}
                to see the agents connected to your account.
              </p>
            }
          >
            <ConnectedAgents />
          </AuthGate>
        </main>
      </div>
    </DottedPage>
  )
}
