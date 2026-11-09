// Minimal i18n: the English source text is the key; pt-BR is the default UI language.
// Agent-facing CLI output (omaestri) is intentionally NOT translated: agents and skills parse it.
import { PT } from './pt-br.js';

let lang = 'pt-BR';
export const getLang = () => lang;
export function setLang(l) {
  lang = l || 'pt-BR';
  document.documentElement.lang = lang;
}

export function t(s, vars) {
  let r = lang.toLowerCase().startsWith('pt') ? (PT[s] ?? s) : s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return r;
}

// Static markup: data-i18n (text), data-i18n-title (tooltip), data-i18n-ph (placeholder).
export function hydrate(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => {
    n.textContent = t(n.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => {
    n.title = t(n.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => {
    n.placeholder = t(n.dataset.i18nPh);
  });
}
