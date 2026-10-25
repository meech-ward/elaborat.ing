import { expect, test } from 'bun:test'
import { assertCardModulePolicy } from './card-module-policy'

test('the card policy ignores grammar strings, regular expressions and comments', () => {
  const code = String.raw`
    const php = { match: "(?:refresh|fetch(_(object|fields|field(_direct)?|assoc|all))?)" };
    const grammar = JSON.parse('{"tokens":"eval( new Function fetch( XMLHttpRequest"}');
    const pattern = /\b(?:fetch|eval)\(|new Function|XMLHttpRequest/;
    const label = 'fetch(';
    const template = \`eval( new Function fetch( XMLHttpRequest\`;
    const keys = { 'fetch': 'token', 'XMLHttpRequest': 'token' };
    // eval('code'); fetch('/'); new Function('code'); new XMLHttpRequest();
    /* globalThis.fetch('/'); */
  `.replaceAll('\\`', '`')
  expect(() => assertCardModulePolicy('highlight.js', code)).not.toThrow()
})

for (const code of [
  "eval('code')",
  "new Function('return 1')",
  "fetch('/image')",
  'new XMLHttpRequest()',
  "globalThis.fetch('/image')",
  'new window.XMLHttpRequest()',
  'const xhr = globalThis.XMLHttpRequest; new xhr()',
  "`result: ${fetch('/image')}`",
  "`result: ${eval('code')}`",
  "`outer ${`inner ${fetch('/image')}`}`",
  'const pattern = /[/][/]/; const ratio = value / other; fetch("/image")',
]) {
  test(`the card policy rejects executable APIs: ${code}`, () => {
    expect(() => assertCardModulePolicy('unsafe.js', code)).toThrow('evaluates strings or makes requests')
  })
}

test('the card policy rejects malformed JavaScript instead of trusting a partial tree', () => {
  expect(() => assertCardModulePolicy('broken.js', 'const value = (')).toThrow('not valid JavaScript')
})
