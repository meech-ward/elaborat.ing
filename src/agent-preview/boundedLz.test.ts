import { expect, test } from 'bun:test'
import LZString from 'lz-string'
import { decompressDrawingBase64 } from './boundedLz'

test('bounded decoder matches lz-string for Unicode, repetitive text and wrapped Obsidian payloads', () => {
  const samples = ['', 'a', 'hello', '🙂 café 漢字\u0000\ud800', 'abc'.repeat(20000)]
  let seed = 42
  for (let sample = 0; sample < 50; sample++) {
    let source = ''
    for (let index = 0; index < sample * 17; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; source += String.fromCharCode(seed % 65536) }
    samples.push(source)
  }
  for (const source of samples) {
    const compressed = LZString.compressToBase64(source).replace(/(.{20})/g, '$1\n')
    expect(decompressDrawingBase64(compressed, Math.max(64, source.length * 8))).toBe(source)
  }
})

test('output and dictionary growth are rejected while compressed input remains small', () => {
  const bomb = LZString.compressToBase64('x'.repeat(100000))
  expect(bomb.length).toBeLessThan(1024)
  expect(() => decompressDrawingBase64(bomb, 1024)).toThrow('limit')
  for (const source of ['', '%%%=', 'AAAA', 'A', '==', 'abc===x']) expect(() => decompressDrawingBase64(source, 1024)).toThrow()
})

test('exact decoded character limits accept complete streams and reject the next character', () => {
  const source = 'long repeated drawing label '.repeat(1000)
  const compressed = LZString.compressToBase64(source)
  expect(decompressDrawingBase64(compressed, source.length)).toBe(source)
  expect(() => decompressDrawingBase64(compressed, source.length - 1)).toThrow('limit')
})
