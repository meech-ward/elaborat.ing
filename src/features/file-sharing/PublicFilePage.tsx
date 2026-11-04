import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Banner, LoadingLine } from '@/features/design-system'
import { moduleLoader, useModule } from '@/lib/moduleLoader'
import { readSharedManifest, readSharedImage, sameSharedRevision, SharedFileUnavailable, ShareToken, type SharedBundle, type SharedFile } from './publicRemote'

const contentModule = moduleLoader(() => import('./PublicFileContent'))

export function PublicFilePage({token}: {token: string}) {
  const [state, setState] = useState<{token: string; bundle: SharedBundle} | null>(null)
  const bundle = state?.token === token ? state.bundle : null
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const current = useRef<{token: string; bundle: SharedBundle} | null>(null)
  const request = useRef<AbortController | null>(null)
  const assets = useRef<AbortController | null>(null)
  const assetJobs = useRef<((paths: string[]) => void) | null>(null)
  const waiting = useRef(new Map<string, Array<{resolve: (file: SharedFile) => void; reject: (error: Error) => void}>>())
  const readFile = useCallback((path: string): Promise<SharedFile> => {
    const snapshot = current.current?.token === token ? current.current.bundle : undefined
    const file = snapshot?.files.find(file => file.path === path)
    if (file) return Promise.resolve(file)
    if (!snapshot || snapshot.fileErrors?.includes(path) || snapshot.complete !== false || !snapshot.pendingPaths?.includes(path))
      return Promise.reject(new Error('This file is not included in the shared document.'))
    return new Promise((resolve, reject) => {waiting.current.set(path, [...(waiting.current.get(path) ?? []), {resolve, reject}])})
  }, [token])
  const rejectWaiting = useCallback(() => {
    for (const readers of waiting.current.values()) for (const reader of readers) reader.reject(new Error('This shared document is no longer available.'))
    waiting.current.clear()
  }, [])
  const requestImages = useCallback((paths: string[]) => assetJobs.current?.(paths), [])
  const {module, error: moduleError, retry} = useModule(contentModule, ShareToken.safeParse(token).success)
  const refresh = useCallback(async () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    const valid = () => !controller.signal.aborted
    try {
      if (!ShareToken.safeParse(token).success) throw new Error('This link is unavailable. Check that you copied the whole link.')
      const previous = current.current?.token === token ? current.current.bundle : undefined
      let streamed = false
      const next = await readSharedManifest(token, previous?.share, controller.signal, partial => {
        if (!valid()) return
        if (!streamed) {
          streamed = true
          assets.current?.abort()
          rejectWaiting()
          assets.current = controller
          assetJobs.current = null
          // A partial stream stays alive while independent focus/poll checks
          // revalidate its identity. An unchanged reply never replaces it.
          if (request.current === controller) request.current = null
        }
        const update = {token, bundle: partial}
        current.current = update
        setState(update)
        setLoading(false)
        setError(null)
        for (const [path, readers] of waiting.current) {
          const file = partial.files.find(file => file.path === path)
          if (!file && !partial.complete && !partial.fileErrors?.includes(path)) continue
          waiting.current.delete(path)
          for (const reader of readers) {
            if (file) reader.resolve(file)
            else reader.reject(new Error('This embedded file is unavailable.'))
          }
        }
      })
      if (!valid() || streamed) return
      // A cheap check may finish after the stream it checked has failed.
      // It carries no source with which to restore that discarded snapshot.
      if (!next) return
      const displayed = current.current?.token === token ? current.current.bundle : undefined
      if (previous && displayed && sameSharedRevision(previous.share, next.share) && sameSharedRevision(displayed.share, next.share)) return
      setError(null)
      setLoading(false)
      assets.current?.abort()
      const assetController = new AbortController()
      assets.current = assetController
      const initial = {token, bundle: next}
      current.current = initial
      setState(initial)
      const queue: number[] = []
      const requested = new Set<number>()
      let active = 0
      let total = new TextEncoder().encode(JSON.stringify(next)).length
      // Only visible notes enqueue images; collapsed children remain deferred.
      // Jobs are separate from refresh so blocked assets cannot postpone revocation.
      const worker = async () => {
        active++
        try {
          while (!assetController.signal.aborted && queue.length) {
            const wanted = queue.shift()!
            try {
              const image = await readSharedImage(token, next, wanted, assetController.signal)
              if (assetController.signal.aborted || current.current?.bundle.share !== next.share) return
              total += new TextEncoder().encode(JSON.stringify(image)).length
              if (total > 20 * 1024 * 1024) throw new Error('The shared file response is too large.')
              const update = {token, bundle: {...current.current.bundle, images: [...current.current.bundle.images, image]}}
              current.current = update
              setState(update)
            } catch (cause) {
              if (assetController.signal.aborted) return
              if (cause instanceof SharedFileUnavailable) {
                assetController.abort()
                current.current = null
                setState(null)
                setError(cause.message)
                return
              }
              if (current.current?.bundle.share === next.share) {
                const update = {token, bundle: {...current.current.bundle, imageErrors: [...(current.current.bundle.imageErrors ?? []), next.pendingImages![wanted].path]}}
                current.current = update
                setState(update)
              }
            }
          }
        } finally {active--}
      }
      assetJobs.current = paths => {
        for (const path of paths) {
          const index = next.pendingImages?.findIndex(image => image.path === path) ?? -1
          if (index < 0 || requested.has(index) || next.images.some(image => image.path === path)) continue
          requested.add(index)
          queue.push(index)
        }
        while (!assetController.signal.aborted && queue.length && active < 3) void worker()
      }

    } catch (cause) {
      if (!valid()) return
      assets.current?.abort()
      rejectWaiting()
      current.current = null
      setState(null)
      setError(cause instanceof Error ? cause.message : 'The shared file could not load.')
    } finally {
      if (request.current === controller) request.current = null
      if (valid()) setLoading(false)
    }
  }, [token, rejectWaiting])
  useEffect(() => {
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
      request.current?.abort()
      request.current = null
      assets.current?.abort()
      assets.current = null
      assetJobs.current = null
      current.current = null
      rejectWaiting()
      clearTimeout(initial)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      meta.remove()
      referrer.remove()
      document.title = oldTitle
    }
  }, [refresh, rejectWaiting])
  return <div className="h-dvh overflow-hidden bg-background text-foreground">
    {loading ? <main className="flex h-full items-center justify-center p-8"><LoadingLine label="Loading shared file" /></main> : null}
    {error ? <main className="mx-auto h-full max-w-3xl overflow-y-auto p-8"><Link to="/" className="mb-8 inline-block font-semibold">elaborat.ing</Link><h1 className="mb-4 text-xl font-semibold">Shared file unavailable</h1>
      <Banner tone="danger">{error}</Banner><Button className="mt-4" variant="secondary" onClick={() => {setLoading(true); void refresh()}}>Try again</Button>
    </main> : null}
    {bundle && module ? <module.PublicFileContent token={token} bundle={bundle} onReadFile={readFile} onRequestImages={requestImages} onUnavailable={() => void refresh()} /> : null}
    {bundle && !module ? <main className="flex h-full flex-col items-center justify-center gap-4 p-8">{moduleError
      ? <><Banner tone="danger">The file viewer could not load.</Banner><Button onClick={retry}>Try again</Button></>
      : <LoadingLine label="Loading file viewer" />}</main> : null}
  </div>
}
