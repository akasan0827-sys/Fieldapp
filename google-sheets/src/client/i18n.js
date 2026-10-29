// Language: English text is the key; Thai comes from the TH dictionary (th.js).
import { TH } from './th.js';

const KEY = 'stock_lang';
let lang = 'en';
try { lang = localStorage.getItem(KEY) === 'th' ? 'th' : 'en'; } catch { /* storage blocked */ }

export const getLang = () => lang;
export function setLang(l) {
  lang = l === 'th' ? 'th' : 'en';
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked */ }
  document.documentElement.lang = lang;
}
document.documentElement.lang = lang;

const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && p[k] !== undefined && p[k] !== null ? p[k] : ''));

const TRANSLATED_PARAMS = ['field', 'unit', 'status'];

/** Translate an English text (with optional {params}). Field names, units and statuses inside params are translated too. */
export function t(text, params) {
  const s = lang === 'th' && TH[text] ? TH[text] : text;
  if (!params) return s;
  if (lang === 'th') {
    params = { ...params };
    for (const k of TRANSLATED_PARAMS) if (typeof params[k] === 'string' && TH[params[k]]) params[k] = TH[params[k]];
  }
  return fill(s, params);
}

/** Translate an error coming from the server: { error, params, line }. Field names are translated too. */
export function tError(body) {
  if (!body || !body.error) return t('Something went wrong. Please try again.');
  const msg = t(body.error, body.params || {});
  return body.line ? `${t('Line {n}', { n: body.line })}: ${msg}` : msg;
}
