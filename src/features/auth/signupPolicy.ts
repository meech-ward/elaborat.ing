/** A public build setting; Supabase Auth enforces account creation separately. */
export const signUpsEnabled = import.meta.env.VITE_SIGNUPS_DISABLED !== "1"
