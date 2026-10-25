import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import apache from '@shikijs/langs/apache';
import asm from '@shikijs/langs/asm';
import astro from '@shikijs/langs/astro';
import bat from '@shikijs/langs/bat';
import c from '@shikijs/langs/c';
import clojure from '@shikijs/langs/clojure';
import cmake from '@shikijs/langs/cmake';
import cpp from '@shikijs/langs/cpp';
import csharp from '@shikijs/langs/csharp';
import css from '@shikijs/langs/css';
import dart from '@shikijs/langs/dart';
import diff from '@shikijs/langs/diff';
import docker from '@shikijs/langs/docker';
import dotenv from '@shikijs/langs/dotenv';
import elixir from '@shikijs/langs/elixir';
import erlang from '@shikijs/langs/erlang';
import fish from '@shikijs/langs/fish';
import fsharp from '@shikijs/langs/fsharp';
import go from '@shikijs/langs/go';
import graphql from '@shikijs/langs/graphql';
import groovy from '@shikijs/langs/groovy';
import haskell from '@shikijs/langs/haskell';
import hcl from '@shikijs/langs/hcl';
import html from '@shikijs/langs/html';
import http from '@shikijs/langs/http';
import ini from '@shikijs/langs/ini';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import json5 from '@shikijs/langs/json5';
import jsonc from '@shikijs/langs/jsonc';
import jsx from '@shikijs/langs/jsx';
import julia from '@shikijs/langs/julia';
import kotlin from '@shikijs/langs/kotlin';
import latex from '@shikijs/langs/latex';
import less from '@shikijs/langs/less';
import lua from '@shikijs/langs/lua';
import make from '@shikijs/langs/make';
import markdown from '@shikijs/langs/markdown';
import matlab from '@shikijs/langs/matlab';
import mdx from '@shikijs/langs/mdx';
import nginx from '@shikijs/langs/nginx';
import nim from '@shikijs/langs/nim';
import objectiveC from '@shikijs/langs/objective-c';
import perl from '@shikijs/langs/perl';
import php from '@shikijs/langs/php';
import powershell from '@shikijs/langs/powershell';
import prisma from '@shikijs/langs/prisma';
import proto from '@shikijs/langs/proto';
import python from '@shikijs/langs/python';
import r from '@shikijs/langs/r';
import ruby from '@shikijs/langs/ruby';
import rust from '@shikijs/langs/rust';
import sass from '@shikijs/langs/sass';
import scala from '@shikijs/langs/scala';
import scss from '@shikijs/langs/scss';
import shellscript from '@shikijs/langs/shellscript';
import shellsession from '@shikijs/langs/shellsession';
import solidity from '@shikijs/langs/solidity';
import sql from '@shikijs/langs/sql';
import svelte from '@shikijs/langs/svelte';
import swift from '@shikijs/langs/swift';
import terraform from '@shikijs/langs/terraform';
import toml from '@shikijs/langs/toml';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import vb from '@shikijs/langs/vb';
import vue from '@shikijs/langs/vue';
import wasm from '@shikijs/langs/wasm';
import xml from '@shikijs/langs/xml';
import yaml from '@shikijs/langs/yaml';
import zig from '@shikijs/langs/zig';
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from '@shikijs/transformers';

// Every fine-grained import includes its embedded-language dependencies. Keep
// the documented aliases with the primary grammar. Register the shipped set
// together: optional embedded grammars in Markdown/MDX must be available before
// tokenization so cached output cannot depend on earlier fences. This entire
// module still loads only when a document shows a code block with a language.
const languageGroups = {
  apache,
  asm,
  astro,
  bat,
  c,
  clojure,
  cmake,
  cpp,
  csharp,
  css,
  dart,
  diff,
  docker,
  dotenv,
  elixir,
  erlang,
  fish,
  fsharp,
  go,
  graphql,
  groovy,
  haskell,
  hcl,
  html,
  http,
  ini,
  java,
  javascript,
  json,
  json5,
  jsonc,
  jsx,
  julia,
  kotlin,
  latex,
  less,
  lua,
  make,
  markdown,
  matlab,
  mdx,
  nginx,
  nim,
  'objective-c': objectiveC,
  perl,
  php,
  powershell,
  prisma,
  proto,
  python,
  r,
  ruby,
  rust,
  sass,
  scala,
  scss,
  shellscript,
  shellsession,
  solidity,
  sql,
  svelte,
  swift,
  terraform,
  toml,
  tsx,
  typescript,
  vb,
  vue,
  wasm,
  xml,
  yaml,
  zig,
};

const languages = new Map<string, string>();
for (const [name, grammars] of Object.entries(languageGroups)) {
  const grammar = grammars.find(grammar => grammar.name === name)!;
  for (const alias of [name, ...(grammar.aliases ?? [])]) {
    languages.set(alias, name);
  }
}
for (const [alias, name] of Object.entries({
  cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'h++': 'cpp',
  golang: 'go', python3: 'python', py3: 'python', svg: 'xml',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
})) languages.set(alias, languages.get(name)!);

// No network, WASM fetch or document-time package loader.
let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;
const cache = new Map<string, string>();
const maxCodeLength = 32_000;

/** Shiki escapes code text; only this trusted renderer may produce HTML here.
 * Unknown/oversized fences return null and are rendered as ordinary React text. */
export function highlightCode(code: string, language: string): string | null {
  if (code.length > maxCodeLength) return null;
  const name = languages.get(language.trim().toLowerCase());
  if (!name) return null;
  highlighter ??= createHighlighterCoreSync({
    themes: [createCssVariablesTheme({ name: 'document' })],
    langs: Object.values(languageGroups),
    engine: createJavaScriptRegexEngine(),
  });
  const key = name + '\0' + code;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = highlighter.codeToHtml(code, {
    lang: name,
    theme: 'document',
    // Cold C++ and embedded grammars can exceed Shiki's 500 ms default,
    // especially in Firefox. Keep a bounded budget without caching a line
    // cut short by normal first-use regex compilation.
    tokenizeTimeLimit: 2_000,
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
