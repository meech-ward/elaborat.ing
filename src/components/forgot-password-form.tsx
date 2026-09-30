/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; the reset link returns to this site, and links point at `/sign-in`;
 * it sits in the sign-in pages' card, with the app's colours, banners and link
 * buttons; the card's description says what it does; the client loads on submit.
 */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/utils'
import { loadClient } from '@/lib/supabase/client'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Banner } from '@/features/design-system'

export function ForgotPasswordForm({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const supabase = await loadClient()
      // The url which will be included in the email. This URL needs to be configured in your redirect URLs in the Supabase dashboard at https://supabase.com/dashboard/project/_/auth/url-configuration
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/update-password`,
      })
      if (error) throw error
      setSuccess(true)
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-4', className)} {...props}>
      {success ? (
        <Banner tone="info">
          Check your email. If you registered using your email and password, you will receive a
          password reset email.
        </Banner>
      ) : (
        <form onSubmit={handleForgotPassword} className="flex flex-col gap-4">
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
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
            {isLoading ? 'Sending...' : 'Send reset email'}
          </Button>
          <p className="border-t border-border pt-4 text-center text-[13px] text-muted-foreground">
            Already have an account?{' '}
            <Link to="/sign-in" className={buttonVariants({ variant: 'link', size: 'inline' })}>
              Sign in
            </Link>
          </p>
        </form>
      )}
    </div>
  )
}
