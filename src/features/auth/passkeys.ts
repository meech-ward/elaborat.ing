/** Whether this browser can use passkeys (WebAuthn). */
export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function"
}

/**
 * What to tell the person when signing in with a passkey, or adding one,
 * fails. `error` is what Supabase Auth's client returned: an Auth error with
 * Auth's code, or a WebAuthn error from the browser, named after its cause.
 */
export function passkeyErrorMessage(error: { message: string; code?: string; name?: string }, during: "sign-in" | "add"): string {
  if (error.name === "NotAllowedError" || error.name === "AbortError" || error.code === "ERROR_CEREMONY_ABORTED") {
    return during === "sign-in" ? "No passkey was used. Try again, or sign in another way." : "No passkey was added."
  }
  switch (error.code) {
    // Auth answers a passkey it has no record of (one removed in Settings,
    // say) as a failed verification.
    case "webauthn_credential_not_found":
    case "webauthn_verification_failed":
      return during === "sign-in"
        ? "That passkey is not linked to an account here. Sign in another way, then add a passkey in Settings."
        : "The passkey could not be checked. Try again."
    case "webauthn_credential_exists":
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This device already has a passkey for your account."
    case "too_many_passkeys":
      return "Your account has as many passkeys as it can hold. Remove one first."
    case "webauthn_challenge_expired":
      return "The passkey prompt timed out. Try again."
    case "passkey_disabled":
      return "Passkeys are turned off for this site."
    default:
      return error.message
  }
}
