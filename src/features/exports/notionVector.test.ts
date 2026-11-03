import {expect, test} from 'bun:test'
import {notionVector} from './notionVector'

test('captured SVG refuses network references, scripts and excessive dimensions before accessing a browser decoder', async () => {
  let copies = 0
  const copy = async () => {copies++; return 'assets/never.png'}
  for (const source of [
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/private.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000000" height="1000000"/>',
  ]) await expect(notionVector(source, copy)).rejects.toThrow()
  expect(copies).toBe(0)
})

test('canceled vector conversion does not invoke the image packager', async () => {
  const controller = new AbortController(); controller.abort()
  let copies = 0
  await expect(notionVector('', async () => {copies++; return ''}, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(copies).toBe(0)
})
