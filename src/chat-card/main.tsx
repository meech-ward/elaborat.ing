/**
 * The chat card's page script: the MCP Apps view of show_file, which
 * `bun run build:chat-card` builds into one script that the view inlines
 * (supabase/functions/mcp-server/tools/cardEditorScript.ts), with its
 * stylesheet. No code here uses eval or new Function, and nothing loads from
 * the network, so it runs under the MCP Apps default Content Security Policy.
 */
// First, before any module makes a schema.
import "./jitless"
import "./tailwind.css"
import { createRoot } from "react-dom/client"
import { connectHost } from "./bridge"
import { ChatCard } from "./ChatCard"
import { addCardFonts } from "./fonts"

addCardFonts()
const host = connectHost("2.0.0")
createRoot(document.getElementById("root")!).render(<ChatCard host={host} />)
