/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; links point at `/sign-in`; it sits in the sign-in pages' card, with
 * the app's colours, banners and link buttons; it says what a password needs,
 * and its errors in plain words; the confirmation link returns to the sign-in
 * page with `next`, and once sent the form asks for the email's code
 * instead (EmailCodeStep); the client loads on submit.
 */
import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/utils'
import { loadClient } from '@/lib/supabase/client'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Banner } from '@/features/design-system'
import { EmailCodeStep, emailLinkRedirect, PASSWORD_RULE, passwordErrorMessage } from '@/features/auth'

export function SignUpForm({ next, className, ...props }: React.ComponentPropsWithoutRef<'div'> & { next: string | null }) {
  const hintId = useId()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== repeatPassword) {
      setError('Passwords do not match')
      return
    }
    setIsLoading(true)

    try {
      const supabase = await loadClient()
      // An email that already has an account gets the same answer, and no email.
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: emailLinkRedirect(window.location.origin, next) },
      })
      if (error) throw error
      setSuccess(true)
    } catch (error: unknown) {
      setError(error instanceof Error ? passwordErrorMessage(error) : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-4', className)} {...props}>
      {success ? (
        <EmailCodeStep
          email={email}
          next={next}
          sentMessage={`Check ${email} for a link that confirms your account and signs you in. The email also has a code you can enter here.`}
          onBack={() => {
            setSuccess(false)
            setPassword('')
            setRepeatPassword('')
          }}
        />
      ) : (
        <form onSubmit={handleSignUp} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby={hintId}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              {PASSWORD_RULE}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="repeat-password">Repeat password</Label>
            <Input
              id="repeat-password"
              type="password"
              autoComplete="new-password"
              required
              value={repeatPassword}
              onChange={(e) => setRepeatPassword(e.target.value)}
            />
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
            {isLoading ? 'Creating an account...' : 'Sign up'}
          </Button>
          <p className="border-t border-border pt-4 text-center text-[13px] text-muted-foreground">
            Already have an account?{' '}
            <Link to="/sign-in" search={next ? { next } : {}} className={buttonVariants({ variant: 'link', size: 'inline' })}>
              Sign in
            </Link>
          </p>
        </form>
      )}
    </div>
  )
}
