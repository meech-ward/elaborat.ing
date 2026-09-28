/**
 * The chat card's page script: the MCP Apps view of show_file, which
 * `bun run build:chat-card` builds into one script that the view inlines
 * (supabase/functions/mcp-server/tools/cardEditorScript.ts), with its
 * stylesheet. No code here uses eval or new Function. It shows the server's
 * HTML and drawings with nothing from the network; the editor and component
 * previews load from elaborat.ing when first needed (modules.ts), which the
 * view's policy allows where the host accepts the origin it declares.
 */
// First, before any module makes a schema.
import "./jitless"
import "./tailwind.css"
import { createRoot } from "react-dom/client"
import { connectHost } from "./bridge"
import { ChatCard } from "./ChatCard"

const host = connectHost("2.0.0")
createRoot(document.getElementById("root")!).render(<ChatCard host={host} />)
