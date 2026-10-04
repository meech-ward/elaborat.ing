/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; after signing in the sign-in page goes on to the home page unless a
 * `next` path is given;
 * it is one card that emails a sign-in link and code first, with the password
 * as the other option and the enabled providers below; messages and links
 * are the app's banners and link buttons, with password errors in plain
 * words; Sign up keeps `next`; the client loads on submit; and an `embedded`
 * variant for the app in a chat's panel.
 */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { loadClient } from '@/lib/supabase/client'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { EmailCodeStep, passwordErrorMessage, ProviderButtons, sendSignInEmail } from '@/features/auth'
import { Banner } from '@/features/design-system'

/** A page of the site in a new tab: the app in a chat's panel sends these through the panel (src/features/embed). */
function SiteLink({ path, className, children }: { path: string; className: string; children: React.ReactNode }) {
  return (
    <a href={new URL(path, window.location.origin).href} target="_blank" rel="noopener" className={className}>
      {children}
    </a>
  )
}

/**
 * Sign in with an emailed link and code, or a password. `embedded` is the
 * form in a chat's panel, which keeps a sign-in of its own: the code is
 * entered there (the emailed link signs in on the site), with no passkey or
 * provider buttons, which a frame cannot use, and Forgot your password? and
 * Sign up open the site in a new tab.
 */
export function LoginForm({ next, embedded = false }: { next: string | null; embedded?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  if (sent) {
    return (
      <EmailCodeStep
        email={email}
        next={next}
        sentMessage={embedded ? `Check ${email} for a code and enter it here. The link in the email signs you in on the site, not in this panel.` : undefined}
        onBack={() => {
          setSent(false)
          setError(null)
        }}
      />
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      if (usePassword) {
        const { error } = await (await loadClient()).auth.signInWithPassword({ email, password })
        if (error) throw error
        // Signed in: the sign-in page moves on once the session is confirmed
        // (routes/sign-in.tsx), so there is one navigation, not two racing.
        return
      }
      const { error } = await sendSignInEmail(email, next)
      if (error) throw error
      setSent(true)
    } catch (error: unknown) {
      setError(error instanceof Error ? (usePassword ? passwordErrorMessage(error) : error.message) : 'An error occurred')
    }
    setIsLoading(false)
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete={usePassword ? 'username' : 'email'}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {usePassword ? (
          <div className="grid gap-2">
            <div className="flex items-center">
              <Label htmlFor="password">Password</Label>
              {embedded ? (
                <SiteLink path="/forgot-password" className={cn(buttonVariants({ variant: 'link', size: 'inline' }), 'ml-auto')}>
                  Forgot your password?
                </SiteLink>
              ) : (
                <Link to="/forgot-password" className={cn(buttonVariants({ variant: 'link', size: 'inline' }), 'ml-auto')}>
                  Forgot your password?
                </Link>
              )}
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        ) : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
          {usePassword ? (isLoading ? 'Signing in...' : 'Sign in') : isLoading ? 'Sending...' : embedded ? 'Email me a code' : 'Email me a sign-in link'}
        </Button>
        {usePassword ? null : (
          <p className="text-[13px] leading-normal text-muted-foreground">
            {embedded
              ? 'No password needed. We\'ll email you a code to enter here.'
              : 'No password needed. We\'ll email you a link that signs you in, and a code you can enter here instead.'}
          </p>
        )}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-my-1 self-start px-0"
          onClick={() => {
            setUsePassword(!usePassword)
            setError(null)
          }}
        >
          {usePassword ? (embedded ? 'Email me a code instead' : 'Email me a link instead') : 'Use a password instead'}
        </Button>
      </form>
      {embedded ? null : <ProviderButtons next={next} />}
      <p className="border-t border-border pt-4 text-center text-[13px] text-muted-foreground">
        Don&apos;t have an account?{' '}
        {embedded ? (
          <SiteLink path="/sign-up" className={buttonVariants({ variant: 'link', size: 'inline' })}>
            Sign up
          </SiteLink>
        ) : (
          <Link to="/sign-up" search={next ? { next } : {}} className={buttonVariants({ variant: 'link', size: 'inline' })}>
            Sign up
          </Link>
        )}
      </p>
    </>
  )
}
