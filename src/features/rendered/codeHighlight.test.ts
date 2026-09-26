import { expect, test } from 'bun:test';
import { highlightCode } from './codeHighlight';

test('ordinary language fences tokenize with live theme variables', () => {
  const html = highlightCode('const count = 3', 'ts');
  expect(html).toContain('var(--shiki-token-keyword)');
  expect(html).toContain('const');
});
test('comment annotations highlight ranges, focus and show diffs without changing input', () => {
  const code = '// [!code highlight:2]\nconst a = 1\nconst b = 2\nconst c = 3 // [!code focus]\nconst d = 4 // [!code ++]\nconst e = 5 // [!code --]\n';
  const html = highlightCode(code, 'js')!;
  expect((html.match(/class="line highlighted"/g) ?? []).length).toBe(2);
  expect(html).toContain('line focused');
  expect(html).toContain('diff add');
  expect(html).toContain('diff remove');
  expect(html).not.toContain('[!code');
  expect(code).toContain('// [!code highlight:2]');
  expect(highlightCode(code, 'js')).toBe(html);
});
test('unknown and very large code uses the plain escaped React fallback', () => {
  expect(highlightCode('<unsafe>', 'unshipped-language')).toBeNull();
  expect(highlightCode('x'.repeat(32_001), 'js')).toBeNull();
});
test('HTML and script-looking text is escaped, never injected as document markup', () => {
  const html = highlightCode('<script>alert("x")</script><img src=x onerror=alert(1)>', 'html')!;
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toMatch(/&(?:lt|#x3C);/);
});
