import { expect, test } from 'bun:test';
import { evaluate } from '@mdx-js/mdx';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import { encodeProseText } from './index';

const html = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// Check meaning with the real parser, not merely our preferred escaping syntax.
for (const format of ['md', 'mdx'] as const) {
  for (const text of ['1. first', '2) second', '&copy; &#123;', '    indented prose', '\tindented prose', '*bold* and `code`', '<Counter /> {2 + 2}', '# title', '> quote']) {
    test(`${format} edited prose renders literally: ${JSON.stringify(text)}`, async () => {
      const module = await evaluate(encodeProseText(text, format), { ...runtime, format });
      expect(renderToStaticMarkup(createElement(module.default))).toBe(`<p>${html(text)}</p>`);
    });
  }
}
