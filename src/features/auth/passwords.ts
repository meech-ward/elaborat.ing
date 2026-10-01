/**
 * What a new password needs, as `minimum_password_length` and
 * `password_requirements` in supabase/config.toml set it. Auth checks it;
 * the forms that set a password say it. Change both together.
 */
export const PASSWORD_RULE = "At least 10 characters, with letters and digits."

/** Auth's password errors in plain words; any other error keeps Auth's message. */
export function passwordErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match. Try again, or reset your password."
    case "email_not_confirmed":
      return "Confirm your email first, with the link we sent when you signed up. Or email yourself a sign-in link instead."
    case "weak_password":
      return `Choose a stronger password. ${PASSWORD_RULE}`
    case "same_password":
      return "That is already your password."
    case "reauthentication_not_valid":
      return "That code did not work. Check it, or send a new one."
    default:
      return error.message
  }
}
