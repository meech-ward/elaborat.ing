import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.19'
import { applicationOrigin } from './applicationOrigin.ts'

Deno.test('application links keep the production default unless an origin is configured', () => {
  for (const empty of [undefined, '', '  ']) assertEquals(applicationOrigin(empty), 'https://elaborat.ing')
  assertEquals(applicationOrigin('https://elaborating-staging.example.workers.dev'), 'https://elaborating-staging.example.workers.dev')
  assertEquals(applicationOrigin(' https://elaborating-staging.example.workers.dev/ '), 'https://elaborating-staging.example.workers.dev')
})

Deno.test('application origins cannot carry credentials, paths, parameters or a different protocol', () => {
  for (const invalid of ['not a url', 'http://localhost:5173', 'javascript:alert(1)', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?next=elsewhere', 'https://example.test#fragment']) {
    assertThrows(() => applicationOrigin(invalid), Error, 'HTTPS origin')
  }
})
