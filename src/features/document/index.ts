export type DocumentFormat = 'md' | 'mdx';

export type DocumentSnapshot = {
  text: string;
  revision: number;
  format: DocumentFormat;
};

export type SourcePatch = {
  from: number;
  to: number;
  insert: string;
  expected: string;
};

// Offsets are UTF-16 code units (plain JS string indices), so surrogate pairs
// such as emoji count as two units. Callers must derive them from the exact
// snapshot text (e.g. via indexOf on parser-reported content).

function isValidFormat(format: unknown): format is DocumentFormat {
  return format === 'md' || format === 'mdx';
}

function assertSnapshot(document: DocumentSnapshot): void {
  if (
    typeof document !== 'object' ||
    document === null ||
    typeof document.text !== 'string' ||
    !Number.isInteger(document.revision) ||
    document.revision < 0 ||
    !isValidFormat(document.format)
  ) {
    throw new Error('invalid document snapshot: expected { text: string, revision: integer >= 0, format: "md" | "mdx" }');
  }
}

function assertPatchShape(patch: SourcePatch, index: number): void {
  if (typeof patch !== 'object' || patch === null) {
    throw new Error(`invalid patch at index ${index}: expected an object`);
  }
  const { from, to, insert, expected } = patch;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error(
      `invalid patch range at index ${index}: expected integers with 0 <= from <= to, got from=${String(from)} to=${String(to)}`,
    );
  }
  if (typeof insert !== 'string' || typeof expected !== 'string') {
    throw new Error(`invalid patch at index ${index}: insert and expected must be strings`);
  }
}

export function applySourcePatches(
  document: DocumentSnapshot,
  revision: number,
  patches: SourcePatch[],
): DocumentSnapshot {
  assertSnapshot(document);
  if (!Number.isInteger(revision)) {
    throw new Error(`invalid revision: expected an integer, got ${String(revision)}`);
  }
  if (revision !== document.revision) {
    throw new Error(
      `stale revision: patch targets revision ${revision} but document is at revision ${document.revision}`,
    );
  }
  if (!Array.isArray(patches)) {
    throw new Error('invalid patches: expected an array of SourcePatch');
  }

  const length = document.text.length;
  patches.forEach((patch, index) => {
    assertPatchShape(patch, index);
    if (patch.to > length) {
      throw new Error(
        `invalid patch range at index ${index}: [${patch.from}, ${patch.to}) exceeds document length ${length}`,
      );
    }
  });

  const sorted = [...patches].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].from < sorted[i - 1].to) {
      throw new Error(
        `overlapping patches: [${sorted[i - 1].from}, ${sorted[i - 1].to}) overlaps [${sorted[i].from}, ${sorted[i].to})`,
      );
    }
  }

  for (const patch of sorted) {
    const actual = document.text.slice(patch.from, patch.to);
    if (actual !== patch.expected) {
      throw new Error(
        `expected-text mismatch at [${patch.from}, ${patch.to}): expected ${JSON.stringify(patch.expected)} but found ${JSON.stringify(actual)}`,
      );
    }
  }

  if (sorted.length === 0) {
    return document;
  }

  let next = '';
  let cursor = 0;
  for (const patch of sorted) {
    next += document.text.slice(cursor, patch.from) + patch.insert;
    cursor = patch.to;
  }
  next += document.text.slice(cursor);

  // Blank or no-op patches must not mint artificial revisions.
  if (next === document.text) {
    return document;
  }
  return { text: next, revision: document.revision + 1, format: document.format };
}

// Characters escaped inline so edited prose cannot become formatting, links,
// images, code, tables, strikethrough, or (in MDX) expressions/components.
const MD_INLINE_ESCAPES = new Set(['\\', '`', '*', '_', '[', ']', '!', '<', '|', '~']);
// Note: ">" is deliberately not in the inline set. A mid-line ">" is inert,
// and a line-leading ">" is neutralised by the BLOCK_MARKER pass below;
// escaping it in both passes would produce a double backslash.
const MDX_EXTRA_ESCAPES = new Set(['{', '}']);

// A line consisting only of hyphens (---) is a thematic break or setext
// underline; all-equals (===) is a setext underline. Escape the first char.
const BREAK_RUN = /^(\s{0,3})([-=])[-=\s]*$/;
// Block starters that survive inline escaping: quote, heading, bullet, ordered list.
const BLOCK_MARKER = /^(\s{0,3})(>|#{1,6}|[-+]|\d{1,9}[.)])/;

export function encodeProseText(value: string, format: DocumentFormat): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid prose value: expected a string, got ${typeof value}`);
  }
  if (!isValidFormat(format)) {
    throw new Error(`invalid format: expected "md" or "mdx", got ${String(format)}`);
  }

  const escapes = format === 'mdx' ? new Set([...MD_INLINE_ESCAPES, ...MDX_EXTRA_ESCAPES]) : MD_INLINE_ESCAPES;
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => {
      const run = BREAK_RUN.exec(line);
      const marked = run ?? BLOCK_MARKER.exec(line);
      const escaped = [...line].map((ch) => ch === '&' ? '&amp;' : (escapes.has(ch) ? `\\${ch}` : ch)).join('');
      // A character reference keeps the visible whitespace without creating
      // an indented code block when this text leaf starts a paragraph.
      if (/^( {4}|\t)/.test(line)) {
        return (line[0] === '\t' ? '&#9;' : '&#32;') + escaped.slice(1);
      }
      if (!marked) {
        return escaped;
      }
      // The marker's leading whitespace is unaffected by escaping, so the
      // insertion index survives verbatim.
      // Digits are not Markdown-escapable. Escape the list delimiter itself.
      const insertAt = marked[1].length + (/^\d/.test(marked[2]) ? marked[2].length - 1 : 0);
      return `${escaped.slice(0, insertAt)}\\${escaped.slice(insertAt)}`;
    })
    .join('\n');
}
