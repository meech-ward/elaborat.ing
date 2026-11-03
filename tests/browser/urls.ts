// Node-only test configuration. An isolated checkout can choose another
// three ports without touching a running checkout's preview servers.
export function browserTestUrls(rawOffset?: string) {
  const raw = rawOffset ?? '0'
  if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 60_000)
    throw new Error('ELABORATING_BROWSER_TEST_PORT_OFFSET must be an integer from 0 to 60000.')
  const offset = Number(raw)
  return {
    APP_URL: `http://127.0.0.1:${4173 + offset}/`,
    HARNESS_URL: `http://127.0.0.1:${4174 + offset}/`,
    SANDBOX_URL: `http://127.0.0.1:${4175 + offset}/`,
  }
}

export const {APP_URL, HARNESS_URL, SANDBOX_URL} = browserTestUrls(process.env.ELABORATING_BROWSER_TEST_PORT_OFFSET)
