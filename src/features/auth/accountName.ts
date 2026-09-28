/** The longest name an account shows under; the database cuts names to the same length. */
export const NAME_MAX_LENGTH = 80

/** Where Settings keeps the name a person sets, in their Auth user metadata. */
export const DISPLAY_NAME_KEY = "display_name"

/**
 * The name an account goes by, from its Auth user metadata: the one its
 * person set in Settings (`display_name`), else the one a sign-in provider
 * gave (`full_name`, then `name`). Spaces are collapsed and the name cut to
 * NAME_MAX_LENGTH. Null when there is none. The database reads the same keys
 * the same way for comments and members (private.person_name).
 */
export function accountName(metadata: Record<string, unknown> | undefined | null): string | null {
  for (const key of [DISPLAY_NAME_KEY, "full_name", "name"]) {
    const value = metadata?.[key]
    if (typeof value !== "string") continue
    const name = value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH)
    if (name) return name
  }
  return null
}

/**
 * What the app calls a person everywhere it names one (the account panel,
 * comments, the members list): their account's name, else their email. Null
 * when they have neither.
 */
export function personName(name: string | null | undefined, email: string | null | undefined): string | null {
  return name?.trim() || email?.trim() || null
}
