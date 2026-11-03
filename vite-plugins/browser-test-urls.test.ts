import {expect, test} from 'bun:test'
import {browserTestUrls} from '../tests/browser/urls'

test('browser test ports keep their defaults and shift the app, harness and sandbox together', () => {
  expect(browserTestUrls()).toEqual({APP_URL: 'http://127.0.0.1:4173/', HARNESS_URL: 'http://127.0.0.1:4174/', SANDBOX_URL: 'http://127.0.0.1:4175/'})
  expect(browserTestUrls('100')).toEqual({APP_URL: 'http://127.0.0.1:4273/', HARNESS_URL: 'http://127.0.0.1:4274/', SANDBOX_URL: 'http://127.0.0.1:4275/'})
  expect(browserTestUrls('60000').SANDBOX_URL).toBe('http://127.0.0.1:64175/')
})

test('port offsets reject malformed or out-of-range Node environment values', () => {
  for (const raw of ['', '-1', '1.2', '1e2', '001', ' 100', 'Infinity', 'NaN', '60001', '9007199254740993', '100; echo bad'])
    expect(() => browserTestUrls(raw)).toThrow('integer from 0 to 60000')
})
