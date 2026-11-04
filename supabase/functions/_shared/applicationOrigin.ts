/** Application links use this deployment's HTTPS origin; production remains the default. */
export function applicationOrigin(configured: string | undefined): string {
  if (!configured?.trim()) return 'https://elaborat.ing'
  const value = configured.trim()
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error('ELABORATING_APP_ORIGIN must be an HTTPS origin') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ELABORATING_APP_ORIGIN must be an HTTPS origin')
  }
  return url.origin
}
