// Fuzzy matching for the command palette: every query character in order, scored so that word
// starts, consecutive runs and earlier matches rank first.

export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  let first = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return undefined;
    if (first < 0) first = i;
    const wordStart = i === 0 || /[\s\-_/·.:@(]/.test(t[i - 1]);
    score += 1 + (i === previous + 1 ? 3 : 0) + (wordStart ? 4 : 0) - Math.min(3, (i - from) * 0.05);
    previous = i;
    from = i + 1;
  }
  // A contiguous substring beats a scattered match of the same letters; letters strewn across
  // a long label ("glass" in "Fix Playtest Log Upload Errors") aren't a match at all.
  if (t.includes(query.toLowerCase().trim())) score += 10;
  else if (previous - first > q.length * 4 + 4) return undefined;
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((r): r is { item: T; index: number; score: number } => r.score !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.item);
}
