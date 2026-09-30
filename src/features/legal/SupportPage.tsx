import { Link } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOpenSettings } from "@/features/settings/SettingsDialog"
import { LegalPage, OutLink, SOURCE_REPOSITORY } from "./LegalPage"

/** How to get help with the hosted copy, and where to take your data or delete your account. */
export function SupportPage() {
  const openSettings = useOpenSettings()
  return (
    <LegalPage title="Support">
      <p>elaborat.ing is an open-source app run by one person. Here is how to get help.</p>

      <h2>Questions and problems</h2>
      <p>
        Open an issue on the <OutLink href={`${SOURCE_REPOSITORY}/issues`}>GitHub repository</OutLink>. Say what you did, what you expected and what
        happened. With an agent, say which one and where you use it, such as ChatGPT on the web or Claude on a phone. Issues are public, so leave out
        anything private.
      </p>

      <h2>Agents</h2>
      <p>
        Connect Claude, ChatGPT or another MCP client at <code>{`${window.location.origin}/mcp`}</code>. See and disconnect them on the{" "}
        <Link to="/agents" className="text-(--accent-soft-text) underline underline-offset-4">
          Connected agents
        </Link>{" "}
        page.
      </p>

      <h2>Your data and your account</h2>
      <ul>
        <li>Any project downloads as a .zip of its files: choose Download project in its menu.</li>
        <li>Delete your account in Settings, under Account, when you are signed in.</li>
      </ul>
      <Button variant="secondary" className="self-start" onClick={openSettings}>
        <Settings aria-hidden="true" data-icon="inline-start" />
        Open Settings
      </Button>
      <p>
        The <Link to="/privacy" className="text-(--accent-soft-text) underline underline-offset-4">privacy page</Link> says what is kept and for how long.
      </p>
    </LegalPage>
  )
}
