import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import { thirdPartyNotices } from "./vite-plugins/third-party-notices.ts"

// The TanStack Router plugin must come before react().
// React Compiler uses the stable documented Babel preset; plugin-react's
// `compiler: true` option is experimental.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    thirdPartyNotices(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The minifier drops license comments, so the build lists the licenses of
  // the third-party code it includes in one file, served at this path.
  build: { license: { fileName: "third-party-notices.txt" } },
})
