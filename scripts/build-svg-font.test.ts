import {expect,test} from 'bun:test'
import {buildSVGFont} from './build-svg-font'

test('the bundled SVG fallback font exactly reproduces the pinned licensed package',async () => {
  const bundled = await Bun.file(new URL('../supabase/functions/_shared/svgFont.json',import.meta.url)).json()
  expect(await buildSVGFont()).toEqual(bundled)
  expect(bundled.license).toContain('SIL OPEN FONT LICENSE Version 1.1')
  expect(bundled.license).toContain('Copyright 2020 The Space Grotesk Project Authors')
})
