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

test("the browser's own WebAuthn errors get a plain message, not the library's text", () => {
  const unsupported = { name: "WebAuthnUnknownError", code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", message: "a Non-Webauthn related error has occurred" }
  expect(passkeyErrorMessage(unsupported, "sign-in")).toBe("This browser or device could not use a passkey. Sign in another way.")
  expect(passkeyErrorMessage(unsupported, "add")).toBe("This browser or device could not add a passkey.")
  expect(passkeyErrorMessage({ name: "NotSupportedError", message: "Resident credentials or empty allowCredentials lists are not supported" }, "sign-in")).toBe(
    "This browser or device could not use a passkey. Sign in another way.",
  )
})

test("each common WebAuthn error, as the library passes it on, gets its own plain sentence", () => {
  // name: the browser's DOMException; code: the library's reading of it.
  const cases: [name: string, code: string, during: "sign-in" | "add", message: string][] = [
    ["NotAllowedError", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "sign-in", "No passkey was used. Try again, or sign in another way."],
    ["AbortError", "ERROR_CEREMONY_ABORTED", "add", "No passkey was added."],
    ["NotSupportedError", "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG", "add", "This browser or device could not add a passkey."],
    ["NotSupportedError", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "sign-in", "This browser or device could not use a passkey. Sign in another way."],
    ["InvalidStateError", "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "add", "This device already has a passkey for your account."],
    ["InvalidStateError", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "sign-in", "This browser or device could not use a passkey. Sign in another way."],
    ["SecurityError", "ERROR_INVALID_RP_ID", "sign-in", "Passkeys do not work at this web address. Sign in another way."],
    ["SecurityError", "ERROR_INVALID_DOMAIN", "add", "Passkeys do not work at this web address."],
  ]
  for (const [name, code, during, message] of cases) {
    expect(passkeyErrorMessage({ name, code, message: "library text" }, during)).toBe(message)
  }
})
