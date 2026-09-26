import { encodeProseText, type DocumentFormat } from '../document';

export type CodeRegion = {
  value: string;
  language: string;
  opening: string;
  closing: string;
  marker: string;
  indent: string;
  newline: string;
};

/** Parser-owned ranges only. Indented code and quoted/list prefixes remain protected. */
export function codeRegion(source: string, from: number, to: number, value: string, language = ''): CodeRegion | undefined {
  const raw = source.slice(from, to);
  const open = /^(`{3,}|~{3,})([^\r\n]*)(\r?\n)/.exec(raw);
  if (!open) return undefined;
  const indent = source.slice(source.lastIndexOf('\n', from - 1) + 1, from);
  if (!/^[ \t]*$/.test(indent)) return undefined;
  const lastLine = raw.slice(raw.lastIndexOf('\n') + 1);
  const close = /^([ \t]*)(`{3,}|~{3,})([ \t]*)$/.exec(lastLine);
  const closed = close && close[2][0] === open[1][0] && close[2].length >= open[1].length;
  // Native textarea values normalize CRLF. Match that editing representation,
  // while keeping exact source bytes in the authoritative expected slice.
  return { value: value.replace(/\r\n?/g, '\n'), language, opening: open[0], closing: closed ? lastLine : '', marker: open[1], indent, newline: open[3] };
}

/** The parent chooses encoding from its own instrumentation, never from the frame. */
export function encodeTextLeaf(
  leaf: { expected: string; code?: CodeRegion },
  value: string,
  format: DocumentFormat,
): string {
  if (!leaf.code) return encodeProseText(value, format);
  const region = leaf.code;
  if (value === region.value) return leaf.expected;
  const normalized = value.replace(/\r\n?/g, '\n');
  const runs = normalized.split('\n').map(line => /^[ \t]*([`~]+)[ \t]*$/.exec(line)?.[1] ?? '');
  const needed = Math.max(region.marker.length, ...runs.filter(run => run[0] === region.marker[0]).map(run => run.length + 1));
  const marker = region.marker[0].repeat(needed);
  const opening = marker + region.opening.slice(region.marker.length);
  const body = normalized.split('\n').map(line => region.indent + line).join(region.newline);
  const closing = region.closing.replace(/[`~]{3,}/, original => original.length >= needed ? original : marker);
  return opening + body + (closing ? region.newline + closing : '');
}
