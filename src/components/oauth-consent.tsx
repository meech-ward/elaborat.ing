/*!
 * Adapted from the Supabase UI Library (https://supabase.com/ui), part of
 * https://github.com/supabase/supabase. Copyright (c) Supabase, Inc.
 * Licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0).
 * Changes: installed with the shadcn CLI, which rewrote the imports to this
 * app's modules; the Next.js `'use client'` directive is removed; it sits in the
 * sign-in pages' card, says what an approved app can do, and uses the app's colours.
 */
import { cn } from '@/lib/utils'
import {
  useOAuthConsent,
  type OAuthConsentDecision,
} from '@/hooks/use-oauth-consent'
import { Button } from '@/components/ui/button'

const getInitial = (value: string) => value.trim().charAt(0).toUpperCase() || '?'

interface ConsentCardShellProps extends React.ComponentPropsWithoutRef<'div'> {
  clientName: string
  productName: string
}

function ConsentCardShell({
  clientName,
  productName,
  className,
  children,
  ...props
}: ConsentCardShellProps) {
  return (
    <div className={cn('flex flex-col gap-5', className)} {...props}>
      <div className="flex flex-col items-center gap-4 text-center">
        <div
          role="img"
          className="flex items-center justify-center"
          aria-label={`${clientName} connecting to ${productName}`}
        >
          <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted font-semibold">
            {getInitial(clientName)}
          </div>
          <div className="h-px w-8 bg-border" aria-hidden="true" />
          <div className="flex size-12 items-center justify-center rounded-full bg-accent font-semibold text-(--accent-soft-text)">
            {getInitial(productName)}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[21px] leading-tight font-semibold [overflow-wrap:anywhere]">Authorize {clientName}</h2>
          <p className="text-sm text-muted-foreground">
            {clientName} is asking to use your {productName} account.
          </p>
        </div>
      </div>
      {children}
    </div>
  )
}

export interface OAuthConsentCardProps extends React.ComponentPropsWithoutRef<'div'> {
  clientName: string
  productName?: string
  redirectUri: string
  email: string
  scopes?: string[]
  error?: string | null
  decision?: OAuthConsentDecision | null
  onApprove?: () => void
  onDeny?: () => void
}

export function OAuthConsentCard({
  clientName,
  productName = 'Your product',
  redirectUri,
  email,
  scopes = [],
  error = null,
  decision = null,
  onApprove,
  onDeny,
  ...props
}: OAuthConsentCardProps) {
  return (
    <ConsentCardShell clientName={clientName} productName={productName} {...props}>
      <dl className="divide-y divide-border rounded-tile border border-border text-sm">
        <div className="flex items-center justify-between gap-6 px-3 py-2.5">
          <dt className="shrink-0 text-muted-foreground">Client</dt>
          <dd className="min-w-0 break-all text-right font-medium">{clientName}</dd>
        </div>
        <div className="flex items-center justify-between gap-6 px-3 py-2.5">
          <dt className="shrink-0 text-muted-foreground">Redirects to</dt>
          <dd className="min-w-0 break-all text-right font-medium">{redirectUri}</dd>
        </div>
        <div className="flex items-center justify-between gap-6 px-3 py-2.5">
          <dt className="shrink-0 text-muted-foreground">Signed in as</dt>
          <dd className="min-w-0 break-all text-right font-medium">{email}</dd>
        </div>
        {scopes.length > 0 && (
          <div className="flex items-center justify-between gap-6 px-3 py-2.5">
            <dt className="shrink-0 text-muted-foreground">Scopes</dt>
            <dd className="min-w-0 break-all text-right font-medium">{scopes.join(', ')}</dd>
          </div>
        )}
      </dl>
      <p className="text-sm">
        If you allow it, {clientName} acts as you: it can open and change every project you can. You
        can disconnect it at any time from Connected agents.
      </p>
      <p className="text-sm text-muted-foreground">Allow access only if you recognize this app.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" size="lg" disabled={decision !== null} onClick={onDeny}>
          {decision === 'deny' ? 'Denying...' : 'Deny'}
        </Button>
        <Button type="button" size="lg" disabled={decision !== null} onClick={onApprove}>
          {decision === 'approve' ? 'Allowing...' : 'Allow access'}
        </Button>
      </div>
    </ConsentCardShell>
  )
}

interface OAuthConsentProps extends React.ComponentPropsWithoutRef<'div'> {
  authorizationId?: string | null
  signInPath?: string
  productName?: string
}

export function OAuthConsent({
  authorizationId,
  signInPath = '/auth/login',
  productName = 'Your product',
  ...props
}: OAuthConsentProps) {
  const { details, email, error, isLoading, decision, approve, deny } = useOAuthConsent({
    authorizationId,
    signInPath,
  })

  if (isLoading || !details || !email) {
    return (
      <ConsentCardShell clientName="OAuth client" productName={productName} {...props}>
        {isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading authorization request...
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {error ??
              'Unable to load the authorization request. Start again from your OAuth client.'}
          </p>
        )}
      </ConsentCardShell>
    )
  }

  return (
    <OAuthConsentCard
      clientName={details.client.name}
      productName={productName}
      redirectUri={details.redirect_uri}
      email={email}
      scopes={details.scope.split(' ').filter(Boolean)}
      error={error}
      decision={decision}
      onApprove={() => void approve()}
      onDeny={() => void deny()}
      {...props}
    />
  )
}
