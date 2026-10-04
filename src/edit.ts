/** Text-level insertion helpers that keep the file's indentation. */

const lineStart = (s: string, idx: number): number => s.lastIndexOf('\n', idx - 1) + 1;
const indentOf = (s: string, idx: number): string => /^[ \t]*/.exec(s.slice(lineStart(s, idx)))![0];

/**
 * Insert `lines` on their own lines just before position `idx`. Indented like the line at `idx`,
 * or, before a closing tag, like the previous non-blank line (its last child).
 */
export function insertBefore(src: string, idx: number, lines: string[]): string {
  const ls = lineStart(src, idx);
  const before = src.slice(ls, idx);
  if (before.trim() === '') {
    const prev = src.slice(0, ls).replace(/\s+$/, '');
    const indent = src.startsWith('</', idx) && prev ? indentOf(prev, prev.length) : before;
    const block = lines.map((l) => indent + l).join('\n');
    return `${src.slice(0, ls)}${block}\n${src.slice(ls)}`;
  }
  // Something precedes idx on the same line (e.g. minified HTML): insert inline.
  return `${src.slice(0, idx)}${lines.join('')}${src.slice(idx)}`;
}

/** Insert `lines` on the lines following the tag that ends at `tagEnd`, indented one level deeper. */
export function insertAfterTag(src: string, tagStart: number, tagEnd: number, lines: string[]): string {
  const nl = src.indexOf('\n', tagEnd);
  const restOfLine = nl < 0 ? src.slice(tagEnd) : src.slice(tagEnd, nl);
  if (nl < 0 || restOfLine.trim() !== '') return `${src.slice(0, tagEnd)}${lines.join('')}${src.slice(tagEnd)}`;
  const tagIndent = indentOf(src, tagStart);
  const unit = /\t/.test(tagIndent) ? '\t' : '  ';
  const indent = tagIndent + unit;
  const block = lines.map((l) => indent + l).join('\n');
  return `${src.slice(0, nl + 1)}${block}\n${src.slice(nl + 1)}`;
}

/** Position after the last top-level import statement (0 if none; after directives like 'use client'). */
export function afterImports(src: string): number {
  const lines = src.split('\n');
  let offset = 0, inImport = false, lastEnd = -1, directiveEnd = 0;
  for (const line of lines) {
    const t = line.trim();
    const next = offset + line.length + 1;
    if (inImport) {
      if (/from\s*['"][^'"]+['"]/.test(t) || /^['"][^'"]+['"];?$/.test(t)) { inImport = false; lastEnd = next; }
    } else if (/^import\b/.test(t)) {
      if (/from\s*['"][^'"]+['"]|^import\s*['"][^'"]+['"]/.test(t)) lastEnd = next;
      else inImport = true;
    } else if (/^['"]use [a-z]+['"];?$/.test(t) && lastEnd < 0) {
      directiveEnd = next;
    }
    offset = next;
  }
  return Math.min(lastEnd >= 0 ? lastEnd : directiveEnd, src.length);
}

export const insertLine = (src: string, idx: number, line: string): string => `${src.slice(0, idx)}${line}\n${src.slice(idx)}`;

/**
 * HTML head insertion point: before the first <script> in <head> (so the stub precedes other
 * tags), else before a framework head placeholder / wp_head(), else before </head>.
 */
export function htmlHeadIndex(src: string): number {
  const open = /<head\b[^>]*>/i.exec(src);
  const close = src.search(/<\/head\s*>/i);
  if (!open && close < 0) return -1;
  const from = open ? open.index + open[0].length : 0;
  const to = close >= 0 ? close : src.length;
  const rel = src.slice(from, to).search(/<script\b|%sveltekit\.head%|<\?php\s+wp_head\s*\(/i);
  return rel >= 0 ? from + rel : to;
}
