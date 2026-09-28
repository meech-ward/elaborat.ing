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
 * are the app's banners and link buttons.
 */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { createClient } from '@/lib/supabase/client'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { EmailCodeStep, ProviderButtons, sendSignInEmail } from '@/features/auth'
import { Banner } from '@/features/design-system'

export function LoginForm({ next }: { next: string | null }) {
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
        const { error } = await createClient().auth.signInWithPassword({ email, password })
        if (error) throw error
        // Signed in: the sign-in page moves on once the session is confirmed
        // (routes/sign-in.tsx), so there is one navigation, not two racing.
        return
      }
      const { error } = await sendSignInEmail(email, next)
      if (error) throw error
      setSent(true)
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'An error occurred')
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
              <Link to="/forgot-password" className={cn(buttonVariants({ variant: 'link', size: 'inline' }), 'ml-auto')}>
                Forgot your password?
              </Link>
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
          {usePassword ? (isLoading ? 'Signing in...' : 'Sign in') : isLoading ? 'Sending...' : 'Email me a sign-in link'}
        </Button>
        {usePassword ? null : (
          <p className="text-[13px] leading-normal text-muted-foreground">
            No password needed. We&apos;ll email you a link that signs you in, and a code you can enter here instead.
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
          {usePassword ? 'Email me a link instead' : 'Use a password instead'}
        </Button>
      </form>
      <ProviderButtons next={next} />
      <p className="border-t border-border pt-4 text-center text-[13px] text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link to="/sign-up" className={buttonVariants({ variant: 'link', size: 'inline' })}>
          Sign up
        </Link>
      </p>
    </>
  )
}
