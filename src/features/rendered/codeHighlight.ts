import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import javascript from '@shikijs/langs/javascript';
import typescript from '@shikijs/langs/typescript';
import jsx from '@shikijs/langs/jsx';
import tsx from '@shikijs/langs/tsx';
import json from '@shikijs/langs/json';
import css from '@shikijs/langs/css';
import html from '@shikijs/langs/html';
import bash from '@shikijs/langs/bash';
import sql from '@shikijs/langs/sql';
import python from '@shikijs/langs/python';
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from '@shikijs/transformers';

// Fine-grained, shipped grammars only. No network, WASM fetch or document-time
// package loader. Initialize once, only when a document actually contains code.
let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;
const cache = new Map<string, string>();
const maxCodeLength = 32_000;

/** Shiki escapes code text; only this trusted renderer may produce HTML here.
 * Unknown/oversized fences return null and are rendered as ordinary React text. */
export function highlightCode(code: string, language: string): string | null {
  if (code.length > maxCodeLength) return null;
  highlighter ??= createHighlighterCoreSync({
    themes: [createCssVariablesTheme({ name: 'document' })],
    langs: [javascript, typescript, jsx, tsx, json, css, html, bash, sql, python],
    engine: createJavaScriptRegexEngine(),
  });
  if (!highlighter.getLoadedLanguages().includes(language)) return null;
  const key = language + '\0' + code;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = highlighter.codeToHtml(code, {
    lang: language,
    theme: 'document',
    transformers: [
      transformerNotationHighlight(),
      transformerNotationFocus(),
      transformerNotationDiff(),
      transformerNotationWordHighlight(),
    ],
  });
  // Bounded per-frame cache: normal prose edits reuse the highlighted output.
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
