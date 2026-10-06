/** String helpers that stay linear on untrusted input, where a backtracking regex would not. */

/**
 * `text` without any run of `char` at its end. A loop instead of `/x+$/`, which backtracks quadratically on a long run
 * of `char` that is not at the end.
 */
export function trimTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return text.slice(0, end);
}

/** `text` as a literal inside a RegExp: backslashes and every other metacharacter escaped. */
export const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
