// Fuzzy ranking for the command palette (pure). Order of preference:
//   title starts with the query > a word of the title starts with it > title contains it >
//   a keyword contains it > the letters appear in order (subsequence).
// Returns [{ item, score, titleOffsets }] best first; titleOffsets are the title character indexes to highlight.
const fold = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function subsequence(title, q) {
  const offsets = [];
  let from = 0;
  for (const ch of q) {
    const i = title.indexOf(ch, from);
    if (i < 0) return null;
    offsets.push(i);
    from = i + 1;
  }
  const span = offsets[offsets.length - 1] - offsets[0] + 1;
  return { offsets, span };
}

export function scoreItem(item, rawQuery) {
  const q = fold(rawQuery).trim();
  const title = fold(item.title);
  if (!q) return { score: item.boost || 0, titleOffsets: [] };
  const range = (start) => Array.from({ length: q.length }, (_, i) => start + i);
  if (title.startsWith(q)) return { score: 1000 + (item.boost || 0), titleOffsets: range(0) };
  const words = [...title.matchAll(/[^\s\-_/.:()]+/g)];
  const w = words.find((m) => m[0].startsWith(q));
  if (w) return { score: 800 - w.index + (item.boost || 0), titleOffsets: range(w.index) };
  const at = title.indexOf(q);
  if (at >= 0) return { score: 600 - at + (item.boost || 0), titleOffsets: range(at) };
  if ((item.keywords || []).some((k) => fold(k).includes(q)))
    return { score: 400 + (item.boost || 0), titleOffsets: [] };
  const sub = subsequence(title, q.replace(/\s+/g, ''));
  if (sub) return { score: 200 - Math.min(150, sub.span - q.length) + (item.boost || 0), titleOffsets: sub.offsets };
  return null;
}

export function rankItems(items, query) {
  const out = [];
  for (const item of items) {
    const s = scoreItem(item, query);
    if (s) out.push({ item, score: s.score, titleOffsets: s.titleOffsets });
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.item.title).localeCompare(String(b.item.title), undefined, { numeric: true, sensitivity: 'base' }),
  );
}

// Keep every action but cap navigation targets so a big workspace list doesn't bury the commands.
export function capNavigation(ranked, max = 12) {
  let nav = 0;
  return ranked.filter((r) => r.item.group !== 'navigation' || ++nav <= max);
}

export function highlight(title, offsets) {
  const set = new Set(offsets);
  const parts = [];
  let buf = '',
    on = false;
  for (let i = 0; i < title.length; i++) {
    const hit = set.has(i);
    if (hit !== on && buf) {
      parts.push({ text: buf, hit: on });
      buf = '';
    }
    on = hit;
    buf += title[i];
  }
  if (buf) parts.push({ text: buf, hit: on });
  return parts;
}
