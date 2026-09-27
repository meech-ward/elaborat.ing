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

/**
 * Finite presentation values, never arbitrary CSS from storage or a message.
 * The defaults are C5's note: a 680px column, body text 15.5px (16 on a
 * phone); headings scale with the text.
 */
export function readingStyle(
  preferences: ReadingPreferences,
): Record<string, string> {
  const size =
    preferences.textSize === "large"
      ? 17
      : preferences.textSize === "larger"
        ? 19
        : 15.5;
  return {
    "--reading-width":
      preferences.width === "full"
        ? "100%"
        : preferences.width === "wide"
          ? "1040px"
          : "680px",
    "--reading-font-size": `${size}px`,
    "--reading-mobile-font-size": `${size + 0.5}px`,
    "--reading-scale": String(size / 15.5),
    "--reading-mobile-scale": String((size + 0.5) / 16),
  };
}
