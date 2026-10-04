/** Minimal unified diff (line based, 3 lines of context). `before === null` means a new file. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === ' ') { i++; continue; }
    // Extend the hunk while changes are within 2*context lines of each other.
    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].t !== ' ') { end++; continue; }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === ' ') run++;
      if (end + run >= ops.length || run > context * 2) { end = Math.min(ops.length, end + context); break; }
      end += run;
    }
    const slice = ops.slice(start, end);
    const aStart = ops[start].ai, bStart = ops[start].bi;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) hunks.push(`${o.t}${o.line}`);
    i = end;
  }
  const from = before === null ? '/dev/null' : `a/${path}`;
  return [`--- ${from}`, `+++ b/${path}`, ...hunks].join('\n');
}

interface Op { t: ' ' | '-' | '+'; line: string; ai: number; bi: number }

const splitLines = (s: string): string[] => {
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** LCS on the region between the common prefix and suffix (edits are small insertions). */
/** How many lines a and b share at the start, and then at the end. */
function commonEnds(a: string[], b: string[]): { pre: number; suf: number } {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** L[x][y] is the length of the longest common subsequence of am[x..] and bm[y..]. */
function lcsTable(am: string[], bm: string[]): number[][] {
  const n = am.length, m = bm.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x][y] = am[x] === bm[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
  return L;
}

/** Walks the table from the start, preferring an insertion when both choices keep the LCS. Indexes are offset by `pre`. */
function middleOps(am: string[], bm: string[], pre: number): Op[] {
  const L = lcsTable(am, bm);
  const n = am.length, m = bm.length;
  const ops: Op[] = [];
  let x = 0, y = 0;
  while (x < n || y < m) {
    if (x < n && y < m && am[x] === bm[y]) { ops.push({ t: ' ', line: am[x], ai: pre + x, bi: pre + y }); x++; y++; }
    else if (y < m && (x >= n || L[x][y + 1] >= L[x + 1][y])) { ops.push({ t: '+', line: bm[y], ai: pre + x, bi: pre + y }); y++; }
    else { ops.push({ t: '-', line: am[x], ai: pre + x, bi: pre + y }); x++; }
  }
  return ops;
}

function diffLines(a: string[], b: string[]): Op[] {
  const { pre, suf } = commonEnds(a, b);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', line: a[k], ai: k, bi: k });
  ops.push(...middleOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), pre));
  for (let k = suf; k > 0; k--) ops.push({ t: ' ', line: a[a.length - k], ai: a.length - k, bi: b.length - k });
  return ops;
}
