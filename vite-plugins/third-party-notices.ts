import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

// Vite's build.license option writes the licenses of the npm packages in the
// JavaScript bundle. This plugin appends what that misses:
// - packages that stylesheets pull in with @import or @plugin, such as
//   tailwindcss, whose CSS is compiled into the stylesheet;
// - code adapted from other projects, from its /*! ... */ license comment.
// It reads every stylesheet and source file under src/, bundled or not.
export function thirdPartyNotices(): Plugin {
  return {
    name: "third-party-notices",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const { root, build } = this.environment.config
        if (!build.license) this.error("thirdPartyNotices needs build.license")
        const fileName = build.license === true ? ".vite/license.md" : build.license.fileName
        const notices = bundle[fileName]
        if (notices?.type !== "asset") this.error(`build.license did not write ${fileName}`)

        let text =
          typeof notices.source === "string" ? notices.source : new TextDecoder().decode(notices.source)

        // Packages Vite listed without a license text, because they ship none.
        text = text.replace(/^## ((?:@[^/\s]+\/)?[^\s]+) - [^\n]+\n(?!\n?[^\n#])/gm, (heading, name: string) => {
          const license = supplementalLicense(name)
          return license ? `${heading}\n${license}\n\n` : heading
        })
        const srcDir = path.join(root, "src")
        const files = fs.readdirSync(srcDir, { recursive: true, encoding: "utf8" }).sort()

        for (const name of stylesheetPackages(srcDir, files)) {
          const dir = path.join(root, "node_modules", name)
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
          const heading = `## ${pkg.name} - ${pkg.version}`
          if (text.includes(`\n${heading}`)) continue
          const license = licenseFileText(dir)
          text += `\n${heading}${pkg.license ? ` (${pkg.license})` : ""}\n${license ? `\n${license}\n` : ""}`
        }

        for (const file of files) {
          if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue
          const source = fs.readFileSync(path.join(srcDir, file), "utf8")
          for (const [, comment] of source.matchAll(/\/\*!([\s\S]*?)\*\//g)) {
            const notice = comment.replace(/^[ \t]*\* ?/gm, "").trim()
            text += `\n## src/${file.split(path.sep).join("/")} (adapted code)\n\n${notice}\n`
          }
        }

        notices.source = text
      },
    },
  }
}

/**
 * Packages named by bare @import or @plugin specifiers in stylesheets, leaving
 * out relative paths and URLs.
 */
function stylesheetPackages(srcDir: string, files: string[]): string[] {
  const names = new Set<string>()
  for (const file of files) {
    if (!file.endsWith(".css")) continue
    const css = fs.readFileSync(path.join(srcDir, file), "utf8")
    for (const [, specifier] of css.matchAll(/@(?:import|plugin)\s+["']([^"'./:][^"':]*)["']/g)) {
      const parts = specifier.split("/")
      names.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
    }
  }
  return [...names].sort()
}

/**
 * The text of a package's LICENSE, LICENCE or COPYING file, found the way Vite
 * finds it; for a package that ships none, the copy in vite-plugins/licenses/.
 */
export function licenseFileText(packageDir: string): string | undefined {
  const file = fs.readdirSync(packageDir).find((name) => /^(licen[cs]e|copying)/i.test(name))
  if (file !== undefined) return fs.readFileSync(path.join(packageDir, file), "utf8").trim()
  return supplementalLicense(JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).name)
}

const SUPPLEMENTS = path.join(import.meta.dirname, "licenses")

/**
 * A checked-in license text for a package that ships without one: the
 * package's own file, or its scope's when every package in the scope comes
 * from one repository under one license.
 */
function supplementalLicense(name: string): string | undefined {
  const names = [name.replace("/", "__"), ...(name.startsWith("@") ? [name.split("/")[0]] : [])]
  for (const candidate of names) {
    const file = path.join(SUPPLEMENTS, `${candidate}.txt`)
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim()
  }
  return undefined
}
