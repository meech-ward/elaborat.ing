import ts from 'typescript'

const stringsOrRequests = /\beval\(|new Function\b|\bfetch\(|XMLHttpRequest/

type Range = { start: number; end: number }

function blankRanges(code: string, ranges: Range[]): string {
  const pieces: string[] = []
  let end = 0
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    pieces.push(code.slice(end, range.start), code.slice(range.start, range.end).replace(/[^\r\n]/g, ' '))
    end = range.end
  }
  pieces.push(code.slice(end))
  return pieces.join('')
}

/** Audit emitted JavaScript, not the grammar strings it carries. Keep the
 * existing API detection scope; the host's CSP is the runtime boundary. */
export function assertCardModulePolicy(fileName: string, code: string): void {
  const virtualName = '/card.js'
  const source = ts.createSourceFile(virtualName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const program = ts.createProgram([virtualName], { allowJs: true, noLib: true, noResolve: true }, {
    getSourceFile: name => name === virtualName ? source : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: name => name === virtualName,
    readFile: name => name === virtualName ? code : undefined,
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  })
  if (program.getSyntacticDiagnostics(source).length) {
    throw new Error(`The chat card module ${fileName} is not valid JavaScript.`)
  }

  const literals: Range[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral
      || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail) {
      literals.push({ start: node.getStart(source), end: node.end })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // AST spans distinguish regex literals from division and leave template
  // interpolation expressions in place. Scan trivia only after literals are
  // blanked, so comment-looking text inside a regex cannot hide actual code.
  const withoutLiterals = blankRanges(code, literals)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, withoutLiterals)
  const comments: Range[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({ start: scanner.getTokenPos(), end: scanner.getTextPos() })
    }
  }
  if (stringsOrRequests.test(blankRanges(withoutLiterals, comments))) {
    throw new Error(`The chat card module ${fileName} evaluates strings or makes requests.`)
  }
}
