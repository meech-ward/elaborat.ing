import { describe, expect, test } from "bun:test";
import { duplicateShortcutLabel, viewShortcutDigit } from "./viewShortcuts";

const key = (overrides: Partial<Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>) => ({
  code: "Digit1",
  key: "1",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("viewShortcutDigit", () => {
  test("Cmd+Option+digit on Apple, whatever character Option makes", () => {
    expect(viewShortcutDigit(key({ metaKey: true, altKey: true, key: "¡" }), true)).toBe(1);
    expect(viewShortcutDigit(key({ code: "Digit3", metaKey: true, altKey: true, key: "£" }), true)).toBe(3);
  });
  test("Ctrl+Alt+digit elsewhere", () => {
    expect(viewShortcutDigit(key({ code: "Digit2", key: "2", ctrlKey: true, altKey: true }), false)).toBe(2);
  });
  test("AltGr typing a character wins outside Apple platforms", () => {
    expect(viewShortcutDigit(key({ code: "Digit2", key: "@", ctrlKey: true, altKey: true }), false)).toBeNull();
  });
  test("other keys and modifiers are not view shortcuts", () => {
    expect(viewShortcutDigit(key({ metaKey: true }), true)).toBeNull();
    expect(viewShortcutDigit(key({ ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(viewShortcutDigit(key({ metaKey: true, altKey: true }), false)).toBeNull();
    expect(viewShortcutDigit(key({ code: "Digit4", key: "4", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(viewShortcutDigit(key({ code: "Numpad1", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(viewShortcutDigit(key({ ctrlKey: true, altKey: true, shiftKey: true }), false)).toBeNull();
  });
});

describe("duplicateShortcutLabel", () => {
  test("reads per platform", () => {
    expect(duplicateShortcutLabel(true)).toBe("⌘D");
    expect(duplicateShortcutLabel(false)).toBe("Ctrl+D");
  });
});
