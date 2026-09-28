import { expect, test } from "bun:test"
import { passkeyErrorMessage } from "./passkeys"

test("a closed or cancelled passkey prompt reads as nothing happening, not as a failure", () => {
  const closed = { name: "NotAllowedError", code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", message: "The operation either timed out or was not allowed." }
  expect(passkeyErrorMessage(closed, "sign-in")).toBe("No passkey was used. Try again, or sign in another way.")
  expect(passkeyErrorMessage(closed, "add")).toBe("No passkey was added.")
  expect(passkeyErrorMessage({ name: "AbortError", code: "ERROR_CEREMONY_ABORTED", message: "aborted" }, "sign-in")).toBe(
    "No passkey was used. Try again, or sign in another way.",
  )
})

test("Auth's passkey error codes get plain messages, and anything else keeps its own", () => {
  for (const code of ["webauthn_credential_not_found", "webauthn_verification_failed"]) {
    expect(passkeyErrorMessage({ code, message: "Credential verification failed" }, "sign-in")).toBe(
      "That passkey is not linked to an account here. Sign in another way, then add a passkey in Settings.",
    )
  }
  expect(passkeyErrorMessage({ code: "webauthn_verification_failed", message: "Credential verification failed" }, "add")).toBe(
    "The passkey could not be checked. Try again.",
  )
  expect(passkeyErrorMessage({ name: "InvalidStateError", code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", message: "x" }, "add")).toBe(
    "This device already has a passkey for your account.",
  )
  expect(passkeyErrorMessage({ code: "too_many_passkeys", message: "x" }, "add")).toBe("Your account has as many passkeys as it can hold. Remove one first.")
  expect(passkeyErrorMessage({ code: "unexpected_failure", message: "Something broke" }, "add")).toBe("Something broke")
})
