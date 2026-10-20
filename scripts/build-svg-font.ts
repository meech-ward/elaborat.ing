import { readFile, writeFile } from 'node:fs/promises'

const PACKAGE = '@fontsource-variable/space-grotesk'
const VERSION = '5.3.0'
const FILE = 'files/space-grotesk-latin-wght-normal.woff2'
const packageRoot = new URL(`../node_modules/${PACKAGE}/`,import.meta.url)
const output = new URL('../supabase/functions/_shared/svgFont.json',import.meta.url)

/** Embed the existing OFL font so Edge previews need no filesystem or font host. */
export async function buildSVGFont() {
  const manifest = JSON.parse(await readFile(new URL('package.json',packageRoot),'utf8')) as {version:string}
  if (manifest.version !== VERSION) throw new Error(`Expected ${PACKAGE}@${VERSION}.`)
  const bytes = await readFile(new URL(FILE,packageRoot))
  const digest = await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)
  return {
    source:`${PACKAGE}@${VERSION}/${FILE}`,
    family:'Space Grotesk',
    sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),
    license:(await readFile(new URL('LICENSE',packageRoot),'utf8')).replace(/\r\n/g,'\n'),
    woff2Base64:bytes.toString('base64'),
  }
}

if (import.meta.main) await writeFile(output,JSON.stringify(await buildSVGFont(),null,2)+'\n')
