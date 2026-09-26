import { createFileRoute, Link } from "@tanstack/react-router"
import { ConnectedAgents } from "@/features/agents"
import { AccountHeader, AuthGate } from "@/features/auth"

// The agents connected to your account, and disconnecting them.
export const Route = createFileRoute("/agents")({
  component: Agents,
})

function Agents() {
  return (
    <>
      <AccountHeader />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-10">
        <Link to="/" className="text-sm underline underline-offset-4">
          Your projects
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Connected agents</h1>
        <AuthGate
          signedOut={
            <p className="text-sm">
              <Link to="/sign-in" search={{ next: "/agents" }} className="underline underline-offset-4">
                Sign in
              </Link>{" "}
              to see the agents connected to your account.
            </p>
          }
        >
          <ConnectedAgents />
        </AuthGate>
      </main>
    </>
  )
}
