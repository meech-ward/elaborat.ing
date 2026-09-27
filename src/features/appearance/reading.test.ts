import { expect, test } from "bun:test";
import {
  DEFAULT_READING,
  READING_STORAGE_KEY,
  parseReading,
  readReading,
  resetReading,
} from "./reading";
import { APPEARANCE_STORAGE_KEY, parseAppearanceSetting } from "./tokens";
import { checkParentMessage } from "../rendered/protocol";

test("valid reading records round-trip; unknown and invalid settings recover to defaults", () => {
  const custom = {
    width: "full",
    textSize: "larger",
    wideMedia: true,
    wideTables: false,
  } as const;
  expect(parseReading(custom)).toEqual(custom);
  for (const invalid of [
    null,
    [],
    { ...custom, width: "120vw" },
    { ...custom, textSize: 99 },
    { ...custom, wideMedia: "yes" },
  ])
    expect(parseReading(invalid)).toEqual(DEFAULT_READING);
  expect(readReading({ getItem: () => "{broken" })).toEqual(DEFAULT_READING);
  expect(
    readReading({
      getItem: () => {
        throw new Error("storage denied");
      },
    }),
  ).toEqual(DEFAULT_READING);
});

test("old appearance records retain themes while reading preferences default independently", () => {
  const old = { theme: "pewter", scheme: "light" } as const;
  const storage = {
    getItem: (key: string) =>
      key === APPEARANCE_STORAGE_KEY ? JSON.stringify(old) : null,
  };
  expect(
    parseAppearanceSetting(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY)!)),
  ).toEqual({ theme: old.theme, mode: old.scheme });
  expect(readReading(storage)).toEqual(DEFAULT_READING);
  const custom = { ...DEFAULT_READING, width: "wide", wideTables: true } as const;
  expect(
    readReading({
      getItem: (key) =>
        key === READING_STORAGE_KEY ? JSON.stringify(custom) : null,
    }),
  ).toEqual(custom);
});

test("reset produces fresh reading defaults without touching the existing theme record", () => {
  const appearance = { theme: "circuit", scheme: "dark" };
  const result = { appearance, reading: resetReading() };
  expect(result).toEqual({ appearance, reading: DEFAULT_READING });
  expect(result.reading).not.toBe(DEFAULT_READING);
});

test("frame reading input rejects unknown enums and stale sessions without accepting CSS", () => {
  const message = {
    kind: "reading-preferences",
    session: "reading-session",
    preferences: DEFAULT_READING,
  };
  expect(
    checkParentMessage({
      data: message,
      source: {},
      activeSession: "reading-session",
    }).ok,
  ).toBe(true);
  expect(
    checkParentMessage({
      data: message,
      source: {},
      activeSession: "other-session",
    }).ok,
  ).toBe(false);
  expect(
    checkParentMessage({
      data: {
        ...message,
        preferences: { ...DEFAULT_READING, width: "calc(200vw)" },
      },
      source: {},
      activeSession: "reading-session",
    }).ok,
  ).toBe(false);
});
