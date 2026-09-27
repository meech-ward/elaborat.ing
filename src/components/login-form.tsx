/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; after signing in it goes to the home page unless a `next` path is given;
 * it is one card that emails a sign-in link and code first, with the password
 * as the other option and the enabled providers below.
 */
import { useState } from 'react'

import { safeNextPath } from '@/lib/safe-next-path'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmailCodeStep, ProviderButtons, sendSignInEmail } from '@/features/auth'

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
        location.href = safeNextPath(next, '/')
      } else {
        const { error } = await sendSignInEmail(email, next)
        if (error) throw error
        setSent(true)
      }
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
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
              <a href="/forgot-password" className="ml-auto text-sm text-(--accent-soft-text) underline-offset-4 hover:underline">
                Forgot your password?
              </a>
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
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
          {usePassword ? (isLoading ? 'Signing in...' : 'Sign in') : isLoading ? 'Sending...' : 'Email me a sign-in link'}
        </Button>
        {usePassword ? null : (
          <p className="text-sm text-muted-foreground">
            No password needed. We&apos;ll email you a link that signs you in, and a code you can enter here instead.
          </p>
        )}
        <button
          type="button"
          className="self-start text-sm text-(--accent-soft-text) underline underline-offset-4"
          onClick={() => {
            setUsePassword(!usePassword)
            setError(null)
          }}
        >
          {usePassword ? 'Email me a link instead' : 'Use a password instead'}
        </button>
      </form>
      <ProviderButtons next={next} />
      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <a href="/sign-up" className="text-(--accent-soft-text) underline underline-offset-4">
          Sign up
        </a>
      </p>
    </>
  )
}
