import type { editor } from "monaco-editor";
import type { PaletteColors } from "../appearance/palettes";

/**
 * The code editor's colours from a palette, as C5's source pane draws them:
 * the panel as the page, the palette's four code colours for Markdown, MDX,
 * D2 and JSON, the current line in lineHi, faint line numbers, the
 * selection in accentSoft.
 *
 * Monaco's Markdown and MDX grammars give headings, list bullets and
 * `import`/`export` one token (`keyword`), so all three take the heading
 * colour. Only the rules below colour text; everything else is `text`
 * (the theme inherits no rules from Monaco's own).
 */
export function monacoTheme(colors: PaletteColors, scheme: "light" | "dark"): editor.IStandaloneThemeData {
  const rule = (token: string, color: string, fontStyle?: string): editor.ITokenThemeRule => ({
    token,
    foreground: sixDigits(color).slice(1),
    ...(fontStyle ? { fontStyle } : {}),
  });
  return {
    base: scheme === "dark" ? "vs-dark" : "vs",
    inherit: false,
    rules: [
      rule("", colors.text),
      // Headings (and the bullets and imports that share their token).
      rule("keyword.md", colors.codeHead),
      rule("keyword.mdx", colors.codeHead),
      // Keys: JSX and HTML tags, link text and addresses, JSON keys, D2 shapes.
      rule("type", colors.codeKey),
      rule("tag", colors.codeKey),
      rule("string.link", colors.codeKey),
      rule("string.key.json", colors.codeKey),
      // Strings and code.
      rule("string", colors.codeStr),
      rule("variable", colors.codeStr),
      // Keywords, numbers (ordered lists), D2 arrows and emphasis.
      rule("keyword", colors.codeKw),
      rule("number", colors.codeKw),
      rule("operator", colors.codeKw),
      rule("emphasis", colors.codeKw, "italic"),
      rule("strong", colors.codeKw, "bold"),
      // Frontmatter fences, quotes and comments.
      rule("meta.content", colors.dim),
      rule("meta.separator", colors.dim),
      rule("comment", colors.dim),
      rule("attribute.name", colors.text),
      // A JSX attribute's = reads as plain text (D2's arrows keep the keyword colour).
      rule("operator.mdx", colors.text),
      rule("delimiter", colors.text),
    ],
    colors: {
      "editor.background": sixDigits(colors.panel),
      "editor.foreground": sixDigits(colors.text),
      "editorGutter.background": sixDigits(colors.panel),
      "editorLineNumber.foreground": sixDigits(colors.faint),
      "editorLineNumber.activeForeground": sixDigits(colors.faint),
      "editor.lineHighlightBackground": sixDigits(colors.lineHi),
      "editor.lineHighlightBorder": sixDigits(colors.lineHi),
      "editor.selectionBackground": sixDigits(colors.accentSoft),
      "editorCursor.foreground": sixDigits(cursorColor(colors)),
      "editorWidget.background": sixDigits(colors.panel),
      "editorWidget.border": sixDigits(colors.panelBorder),
      "editorSuggestWidget.background": sixDigits(colors.panel),
      "editorSuggestWidget.border": sixDigits(colors.panelBorder),
      "editorSuggestWidget.foreground": sixDigits(colors.text),
      // The suggestions list as the library's menus draw theirs: the chosen
      // row in accentSoft with its own text colour, matches in accentSoftText.
      "editorSuggestWidget.selectedBackground": sixDigits(colors.accentSoft),
      "editorSuggestWidget.selectedForeground": sixDigits(colors.accentSoftText),
      "editorSuggestWidget.selectedIconForeground": sixDigits(colors.accentSoftText),
      "editorSuggestWidget.highlightForeground": sixDigits(colors.accentSoftText),
      "editorSuggestWidget.focusHighlightForeground": sixDigits(colors.accentSoftText),
      "editorSuggestWidget.hoverBackground": sixDigits(colors.seg),
    },
  };
}

/** Monaco needs `#rrggbb`; CSS also accepts `#rgb`. */
function sixDigits(color: string): string {
  return color.replace(/^#([\da-f])([\da-f])([\da-f])$/i, "#$1$1$2$2$3$3");
}

/**
 * The accent, unless it is too faint to find on the page or the current
 * line (Ink and Volt light's volt is 1.2:1 on white): then the palette's
 * readable accent text colour.
 */
function cursorColor(colors: PaletteColors): string {
  const visible = [colors.panel, colors.lineHi].every((background) => contrast(colors.accent, background) >= 3);
  return visible ? colors.accent : colors.accentSoftText;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(color: string): number {
  const hex = sixDigits(color).slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
