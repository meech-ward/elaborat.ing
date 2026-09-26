import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
// First-class MDX highlighting (markdown for .md files). Editor CSS arrives
// through the ESM modules themselves, so no CSS import is needed.
import "monaco-editor/languages/definitions/mdx/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import { createD2MonarchLanguage, D2_LANGUAGE_ID } from "./d2Language";

/**
 * What every Monaco editor here needs before it is created: the locally
 * bundled workers, and D2 highlighting.
 *
 * The editors use Markdown, MDX, JSON, plain text and D2 (see
 * `EditorLanguage`), so only the editor and JSON workers ever start. Monaco's
 * TypeScript, CSS and HTML workers are left out of the build; code embedded
 * in notes is only highlighted, which needs no worker.
 */
export function setupMonaco(): void {
  self.MonacoEnvironment = {
    getWorker(_workerId: unknown, label: string) {
      if (label === "json") return new JsonWorker();
      return new EditorWorker();
    },
  };
  // D2 has no built-in Monaco grammar: register the local highlighting
  // once (Monaco is the source of truth, so StrictMode remounts are safe).
  // A broken grammar must never take down the route: fall back to plain
  // text highlighting for .d2 files if registration throws.
  if (!monaco.languages.getLanguages().some((language) => language.id === D2_LANGUAGE_ID)) {
    monaco.languages.register({ id: D2_LANGUAGE_ID });
    try {
      monaco.languages.setMonarchTokensProvider(D2_LANGUAGE_ID, createD2MonarchLanguage());
    } catch {
      monaco.languages.setMonarchTokensProvider(D2_LANGUAGE_ID, { tokenizer: { root: [] } });
    }
  }
}
