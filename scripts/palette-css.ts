// Writes the palettes as CSS variables (src/features/appearance/palettes.css)
// from palettes.ts and tokens.ts. A unit test fails when the file is out of
// date. Run it after changing a palette or a derived token:
//
//   bun run palette-css
import { writeFileSync } from "node:fs"
import path from "node:path"
import { buildPaletteCss } from "../src/features/appearance/paletteCss"

const OUT = path.resolve(import.meta.dirname, "../src/features/appearance/palettes.css")
writeFileSync(OUT, buildPaletteCss())
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`)
