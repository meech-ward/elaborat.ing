import { z } from "zod";

export const readingPreferencesSchema = z.object({
  width: z.enum(["standard", "wide", "full"]),
  textSize: z.enum(["default", "large", "larger"]),
  wideMedia: z.boolean(),
  wideTables: z.boolean(),
});
export type ReadingPreferences = z.infer<typeof readingPreferencesSchema>;
export const READING_STORAGE_KEY = "elaborating.reading.v1";
export const DEFAULT_READING: ReadingPreferences = {
  width: "standard",
  textSize: "default",
  wideMedia: false,
  wideTables: false,
};
export function parseReading(value: unknown): ReadingPreferences {
  const parsed = readingPreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : resetReading();
}
export function readReading(
  storage: Pick<Storage, "getItem">,
): ReadingPreferences {
  try {
    const raw = storage.getItem(READING_STORAGE_KEY);
    return raw == null ? resetReading() : parseReading(JSON.parse(raw));
  } catch {
    return resetReading();
  }
}
export function resetReading(): ReadingPreferences {
  return { ...DEFAULT_READING };
}

/** Finite presentation values, never arbitrary CSS from storage or a message. */
export function readingStyle(
  preferences: ReadingPreferences,
): Record<string, string> {
  const size =
    preferences.textSize === "large"
      ? 16
      : preferences.textSize === "larger"
        ? 18
        : 14;
  return {
    "--reading-width":
      preferences.width === "full"
        ? "100%"
        : preferences.width === "wide"
          ? "1040px"
          : "760px",
    "--reading-font-size": `${size}px`,
    "--reading-mobile-font-size": `${size - 1}px`,
    "--reading-scale": String(size / 14),
    "--reading-mobile-scale": String((size - 1) / 13),
  };
}
