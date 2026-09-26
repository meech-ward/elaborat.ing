import path from "node:path"
import { mergeConfig, type Plugin } from "vite"
import app from "../../../vite.config.ts"

// The app built again with one visible change, as the next version for the
// update journey in offline.spec.ts: the projects home heading reads
// "Your projects, updated". Build it with `bun run build:next-version`.
const heading = path.resolve(import.meta.dirname, "../../../src/features/projects/ProjectList.tsx")

function visibleChange(): Plugin {
  return {
    name: "next-version-change",
    enforce: "pre",
    transform(code, id) {
      if (id !== heading) return
      if (!code.includes("Your projects")) this.error(`The projects heading is no longer in ${heading}.`)
      return code.replace("Your projects", "Your projects, updated")
    },
  }
}

export default mergeConfig(app, {
  plugins: [visibleChange()],
  build: { outDir: "dist-next" },
})
