import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Banner, LoadingLine } from '@/features/design-system'
import { moduleLoader, useModule } from '@/lib/moduleLoader'
import { readSharedFile, ShareToken, type SharedBundle } from './publicRemote'

const contentModule = moduleLoader(() => import('./PublicFileContent'))

export function PublicFilePage({token}: {token: string}) {
  const [bundle, setBundle] = useState<SharedBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const pending = useRef(false)
  const alive = useRef(true)
  const {module, error: moduleError, retry} = useModule(contentModule, bundle !== null)
  const refresh = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    try {
      if (!ShareToken.safeParse(token).success) throw new Error('This link is unavailable. Check that you copied the whole link.')
      const next = await readSharedFile(token)
      if (!alive.current) return
      setBundle(previous => previous && previous.share.id === next.share.id && previous.share.revision === next.share.revision &&
        previous.share.path === next.share.path && previous.share.archived === next.share.archived ? previous : next)
      setError(null)
    } catch (cause) {
      if (!alive.current) return
      setBundle(null)
      setError(cause instanceof Error ? cause.message : 'The shared file could not load.')
    } finally {
      pending.current = false
      if (alive.current) setLoading(false)
    }
  }, [token])
  useEffect(() => {
    alive.current = true
    const initial = window.setTimeout(() => void refresh(), 0)
    const onFocus = () => { if (!document.hidden) void refresh() }
    const interval = window.setInterval(onFocus, 30_000)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const meta = document.createElement('meta')
    meta.name = 'robots'; meta.content = 'noindex, nofollow, noarchive'
    document.head.append(meta)
    const referrer = document.createElement('meta')
    referrer.name = 'referrer'; referrer.content = 'no-referrer'; document.head.append(referrer)
    const oldTitle = document.title
    document.title = 'Shared file | elaborat.ing'
    return () => {
      alive.current = false
      clearTimeout(initial)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      meta.remove()
      referrer.remove()
      document.title = oldTitle
    }
  }, [refresh])
  return <div className="h-dvh overflow-hidden bg-background text-foreground">
    {loading ? <main className="flex h-full items-center justify-center p-8"><LoadingLine label="Loading shared file" /></main> : null}
    {error ? <main className="mx-auto h-full max-w-3xl overflow-y-auto p-8"><Link to="/" className="mb-8 inline-block font-semibold">elaborat.ing</Link><h1 className="mb-4 text-xl font-semibold">Shared file unavailable</h1>
      <Banner tone="danger">{error}</Banner><Button className="mt-4" variant="secondary" onClick={() => {setLoading(true); void refresh()}}>Try again</Button>
    </main> : null}
    {bundle && module ? <module.PublicFileContent token={token} bundle={bundle} onUnavailable={() => void refresh()} /> : null}
    {bundle && !module ? <main className="flex h-full flex-col items-center justify-center gap-4 p-8">{moduleError
      ? <><Banner tone="danger">The file viewer could not load.</Banner><Button onClick={retry}>Try again</Button></>
      : <LoadingLine label="Loading file viewer" />}</main> : null}
  </div>
}
