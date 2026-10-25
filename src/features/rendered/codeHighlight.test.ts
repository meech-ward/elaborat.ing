import { expect, test } from 'bun:test';
import { highlightCode } from './codeHighlight';

test('ordinary language fences tokenize with live theme variables', () => {
  const html = highlightCode('const count = 3', 'ts');
  expect(html).toContain('var(--shiki-token-keyword)');
  expect(html).toContain('const');
}, 15_000);
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

/** A fresh frame must not depend on another fence having loaded its grammar. */
async function highlightFirstFence(code: string, language: string): Promise<string | null> {
  const source = `
    import { highlightCode } from ${JSON.stringify(new URL('./codeHighlight.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(highlightCode(${JSON.stringify(code)}, ${JSON.stringify(language)})));
  `;
  const child = Bun.spawn([process.execPath, '--eval', source], { stdout: 'pipe', stderr: 'pipe' });
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(error);
  return JSON.parse(output) as string | null;
}

test('a first Markdown fence highlights its nested JavaScript', async () => {
  const html = await highlightFirstFence('```javascript\nconst message = "hello";\n```', 'markdown');
  expect(html).toContain('style="color:var(--shiki-token-keyword)">const</span>');
}, 15_000);

test('a first MDX fence highlights its nested JavaScript', async () => {
  const html = await highlightFirstFence('```javascript\nconst message = "hello";\n```', 'mdx');
  expect(html).toContain('style="color:var(--shiki-token-keyword)">const</span>');
}, 15_000);

test('a cold MDX expression has time to compile its embedded grammar', async () => {
  const html = await highlightFirstFence('{(() => { const value = 42; return value; })()}', 'mdx');
  expect(html).toContain('style="color:var(--shiki-token-keyword)">const</span>');
  expect(html).toContain('style="color:var(--shiki-token-keyword)">return</span>');
}, 15_000);

const commonLanguages: Array<[string, string]> = [
  ['javascript', 'const message = "hello";'],
  ['typescript', 'const message: string = "hello";'],
  ['jsx', 'const message = <p title="hello">Hello</p>;'],
  ['tsx', 'const message: ReactNode = <p title="hello">Hello</p>;'],
  ['json', '{ "message": "hello" }'],
  ['css', 'p { color: red; }'],
  ['html', '<p title="hello">Hello</p>'],
  ['bash', 'echo "hello"'],
  ['sql', "SELECT 'hello' AS message;"],
  ['python', 'print("hello")'],
  ['cpp', '#include <iostream>\nint main() { std::cout << "hello"; return 0; }'],
  ['c', 'int main(void) { return 0; }'],
  ['csharp', 'public class Hello { string value = "hello"; }'],
  ['java', 'public class Hello { public static void main(String[] args) {} }'],
  ['go', 'package main\nfunc main() { println("hello") }'],
  ['rust', 'fn main() { let value = "hello"; }'],
  ['ruby', 'def hello\n  puts "hello"\nend'],
  ['php', '<?php echo "hello"; ?>'],
  ['swift', 'let message = "hello"'],
  ['kotlin', 'fun main() { println("hello") }'],
  ['scala', 'object Hello { val message = "hello" }'],
  ['dart', 'void main() { print("hello"); }'],
  ['objective-c', '@interface Hello : NSObject\n@end'],
  ['lua', 'local message = "hello"'],
  ['perl', 'my $message = "hello";'],
  ['r', 'message <- "hello"'],
  ['haskell', 'main = putStrLn "hello"'],
  ['elixir', 'defmodule Hello do\n  def message, do: "hello"\nend'],
  ['erlang', '-module(hello).\nhello() -> "hello".'],
  ['clojure', '(defn hello [] "hello")'],
  ['julia', 'function hello()\n  println("hello")\nend'],
  ['groovy', 'def message = "hello"'],
  ['powershell', 'Write-Host "hello"'],
  ['fish', 'set message "hello"'],
  ['bat', '@echo off\necho hello'],
  ['fsharp', 'let message = "hello"'],
  ['vb', 'Dim message As String = "hello"'],
  ['zig', 'const message = "hello";'],
  ['xml', '<message value="hello" />'],
  ['vue', '<template><p>{{ message }}</p></template>'],
  ['svelte', '<script>let message = "hello";</script>'],
  ['astro', '---\nconst message = "hello";\n---\n<p>{message}</p>'],
  ['markdown', '# Hello\n**world**\n`code`'],
  ['mdx', '# Hello\n<Component value="hello" />'],
  ['yaml', 'message: "hello"'],
  ['toml', 'message = "hello"'],
  ['ini', '[hello]\nmessage=world'],
  ['dockerfile', 'FROM node:22\nRUN echo hello'],
  ['makefile', 'all:\n\techo "hello"'],
  ['cmake', 'cmake_minimum_required(VERSION 3.20)'],
  ['diff', '-old\n+new'],
  ['graphql', 'query Hello { user { name } }'],
  ['proto', 'syntax = "proto3";\nmessage Hello { string name = 1; }'],
  ['terraform', 'resource "example" "hello" { name = "world" }'],
  ['nginx', 'server { listen 80; }'],
  ['scss', '$color: #fff;\np { color: $color; }'],
  ['less', '@color: #fff;\np { color: @color; }'],
  ['jsonc', '// message\n{ "hello": true }'],
  ['json5', '{ message: "hello", }'],
  ['http', 'GET /hello HTTP/1.1\nAccept: application/json'],
  ['latex', '\\section{Hello}'],
  ['solidity', 'pragma solidity ^0.8.0;\ncontract Hello {}'],
  ['hcl', 'variable "message" { default = "hello" }'],
  ['asm', 'mov eax, 1'],
  ['wasm', '(module (func (result i32) i32.const 1))'],
  ['shellsession', '$ echo "hello"\nhello'],
  ['apache', '<VirtualHost *:80>\n  ServerName example.com\n</VirtualHost>'],
  ['dotenv', 'MESSAGE="hello"'],
  ['matlab', "message = 'hello';"],
  ['nim', 'let message = "hello"'],
  ['prisma', 'model Hello {\n  id Int @id\n}'],
  ['sass', '$color: #fff\np\n  color: $color'],
];

for (const [language, code] of commonLanguages) {
  test(`common ${language} fences produce syntax-colored tokens`, () => {
    const html = highlightCode(code, language);
    expect(html).not.toBeNull();
    expect(html!).toMatch(/style="color:var\(--shiki-token-/);
  }, 15_000);
}

test('common aliases and case variants use their canonical grammar', () => {
  for (const [language, aliases, code] of [
    ['cpp', ['c++', 'CPP', 'C++', 'cc', 'cxx', 'hpp', 'h++'], 'int main() { return 0; }'],
    ['csharp', ['c#', 'cs', 'CSharp'], 'public class Hello {}'],
    ['rust', ['rs'], 'fn main() {}'],
    ['python', ['py', 'Python', 'python3', 'py3'], 'print("hello")'],
    ['go', ['golang'], 'func main() {}'],
    ['typescript', ['ts'], 'const message: string = "hello"'],
    ['javascript', ['js'], 'const message = "hello"'],
    ['yaml', ['yml', 'YAML'], 'message: "hello"'],
    ['bash', ['sh', 'shell', 'shellscript', 'zsh'], 'echo "hello"'],
    ['powershell', ['ps1', 'pwsh'], 'Write-Host "hello"'],
    ['dockerfile', ['docker', 'Dockerfile'], 'FROM node:22'],
    ['makefile', ['make', 'Makefile'], 'all:\n\techo "hello"'],
    ['fsharp', ['f#', 'fs'], 'let message = "hello"'],
    ['objective-c', ['objc'], '@interface Hello : NSObject\n@end'],
    ['graphql', ['gql'], 'query Hello { user { name } }'],
    ['proto', ['protobuf'], 'syntax = "proto3";'],
    ['terraform', ['tf', 'tfvars'], 'variable "message" { default = "hello" }'],
    ['ini', ['properties'], '[hello]\nmessage=world'],
    ['xml', ['svg'], '<svg viewBox="0 0 10 10" />'],
    ['sql', ['postgres', 'postgresql', 'mysql', 'sqlite'], 'SELECT 1;'],
  ] as Array<[string, string[], string]>) {
    const expected = highlightCode(code, language);
    expect(expected).not.toBeNull();
    for (const alias of aliases) expect(highlightCode(code, alias)).toBe(expected);
  }
});
