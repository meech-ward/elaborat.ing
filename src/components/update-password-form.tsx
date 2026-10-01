/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; after updating it goes to the home page; it sits in the sign-in
 * pages' card, with the app's colours and banners; it says what a password
 * needs, and its errors in plain words; the client loads on submit.
 */
import { useId, useState } from 'react'

import { cn } from '@/lib/utils'
import { loadClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Banner } from '@/features/design-system'
import { PASSWORD_RULE, passwordErrorMessage } from '@/features/auth'

export function UpdatePasswordForm({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  const hintId = useId()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const supabase = await loadClient()
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      // The reset link signed in, so the new password is saved and the person carries on, signed in.
      location.href = '/'
    } catch (error: unknown) {
      setError(error instanceof Error ? passwordErrorMessage(error) : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-4', className)} {...props}>
      <form onSubmit={handleForgotPassword} className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="password">New password</Label>
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
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" size="lg" className="w-full" disabled={isLoading}>
          {isLoading ? 'Saving...' : 'Save new password'}
        </Button>
      </form>
    </div>
  )
}
