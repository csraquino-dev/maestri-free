// Ranking used by the prompter's saved-prompt menu (same order as Maestri):
// 0 name starts with the query · 1 name contains it · 2 description contains it · 3 text contains it;
// workspace prompts come before global ones, then rank, then name (natural order).
const fold = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const contains = (h, n) => fold(h).includes(fold(n));

export function rankSavedPrompts(visible, rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) return [...visible];
  const spaced = (s) => String(s).replaceAll('-', ' ');
  const nameQuery = spaced(query);
  const rank = (p) => {
    const name = spaced(p.name);
    if (fold(name).startsWith(fold(nameQuery))) return 0;
    if (contains(name, nameQuery)) return 1;
    if (contains(p.description, query)) return 2;
    if (contains(p.text, query)) return 3;
    return null;
  };
  return visible
    .flatMap((p) => {
      const r = rank(p);
      return r === null ? [] : [{ p, r }];
    })
    .sort((a, b) => {
      const ag = a.p.workspaceId === null,
        bg = b.p.workspaceId === null;
      if (ag !== bg) return ag ? 1 : -1;
      if (a.r !== b.r) return a.r - b.r;
      return a.p.name.localeCompare(b.p.name, undefined, { numeric: true, sensitivity: 'base' });
    })
    .map((e) => e.p);
}

// First row is always "create"; opening a prompt's options swaps the rows for edit/delete.
export function savedPromptRows(matches, query, optionsFor = null) {
  if (optionsFor)
    return [
      { kind: 'edit', prompt: optionsFor },
      { kind: 'delete', prompt: optionsFor },
    ];
  if (matches.length === 0 && query !== '') return [];
  return [{ kind: 'create' }, ...matches.map((prompt) => ({ kind: 'prompt', prompt }))];
}
