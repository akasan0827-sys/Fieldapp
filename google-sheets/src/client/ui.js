// Small UI toolkit: safe HTML templating, formatting, modals, toasts, charts, copy-to-Excel, navigation.
import { t, getLang } from './i18n.js';

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ''));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function part(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

/** Tagged template: every interpolated value is escaped unless wrapped in raw() or produced by html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- navigation (in-page; works inside Google's web-app frame and on claude.ai) ----------
export function go(path) {
  window.dispatchEvent(new CustomEvent('app:go', { detail: path }));
}

// ---- formatting ---------------------------------------------------------------

export function n(x, digits = 0) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '–';
  return Number(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const sqm = (x) => (x === null || x === undefined ? '–' : `${n(x, 2)} m²`);

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(s, k) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}
export function addMonths(s, k) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const locale = () => (getLang() === 'th' ? 'th-TH-u-ca-gregory' : 'en-GB');
export function fmtDate(s) {
  if (!s) return '–';
  return new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function relDays(s, today = todayStr()) {
  if (!s) return '';
  const k = daysBetween(today, s);
  if (k === 0) return t('today');
  if (k === 1) return t('tomorrow');
  if (k === -1) return t('yesterday');
  return k > 0 ? t('in {n} days', { n: k }) : t('{n} days ago', { n: -k });
}
export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
}

// ---- badges (icon + label, never colour alone) ---------------------------------

const BADGES = {
  ok: ['good', '✓', 'OK'],
  low: ['warn', '▲', 'Low'],
  out: ['bad', '✕', 'Out of stock'],
  overlocked: ['bad', '!', 'Over-locked'],
  pending: ['info', '…', 'Pending'],
  active: ['good', '🔒', 'Active'],
  expired: ['warn', '⌛', 'Expired'],
  expiring: ['warn', '⌛', 'Expiring'],
  fulfilled: ['muted', '✓', 'Delivered'],
  rejected: ['muted', '✕', 'Rejected'],
  released: ['muted', '↺', 'Released'],
  posted: ['good', '✓', 'Posted'],
  void: ['bad', '⊘', 'Void'],
  expected: ['info', '⛴', 'Incoming'],
  ordered: ['muted', '📝', 'Ordered'],
  on_board: ['info', '⛴', 'On board'],
  at_port: ['info', '⚓', 'At port'],
};
export function badge(key, label) {
  const [cls, icon, text] = BADGES[key] || ['muted', '•', key];
  return html`<span class="badge badge-${cls}"><span aria-hidden="true">${icon}</span> ${label || t(text)}</span>`;
}
export function swatch(hex) {
  return hex ? html`<span class="swatch" style="background:${hex}"></span>` : html`<span class="swatch swatch-empty"></span>`;
}

const DOC_TYPES = { opening: 'Initial stock', inbound: 'Receipt', outbound: 'Delivery', adjust: 'Adjustment', transfer: 'Rack move' };
export const docType = (type) => t(DOC_TYPES[type] || type);
export const DOC_TYPE_KEYS = Object.keys(DOC_TYPES);

// ---- toasts & modals -------------------------------------------------------------

export function toast(msg, type = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 6000 : 3000);
}

/**
 * Opens a modal. body is html; onSubmit(form) may return a promise; throw to keep it open
 * (the error message is shown inside the modal). Resolves with onSubmit's result or null.
 */
export function modal({ title, body, submit, cancel, danger = false, wide = false, onSubmit, onOpen }) {
  const submitLabel = submit === undefined ? t('Save') : submit;
  const cancelLabel = cancel === undefined ? t('Cancel') : cancel;
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = String(html`
      <form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
        <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="${t('Close')}">✕</button></header>
        <div class="modal-body">${body}<div class="form-error" hidden></div></div>
        <footer>
          ${cancelLabel ? html`<button type="button" class="btn" data-close>${cancelLabel}</button>` : ''}
          ${submitLabel ? html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>` : ''}
        </footer>
      </form>`);
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const err = wrap.querySelector('.form-error');
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = await onSubmit(form);
        close(r === undefined ? true : r);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    if (onOpen) onOpen(form);
    const first = form.querySelector('input:not([type=hidden]),select,textarea');
    if (first) first.focus();
  });
}

export function confirmBox(title, message, { submit, danger = false } = {}) {
  return modal({ title, body: html`<p>${message}</p>`, submit: submit || t('Confirm'), danger });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi) {
        out[el.name] = out[el.name] || [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

export function options(list, selected, { value = 'id', label = (x) => x.name, empty = null } = {}) {
  const sel = selected === undefined || selected === null ? '' : String(selected);
  return html`${empty !== null ? html`<option value="">${empty}</option>` : ''}${list.map((x) => {
    const v = typeof value === 'function' ? value(x) : x[value];
    return html`<option value="${v}" ${String(v) === sel ? raw('selected') : ''}>${label(x)}</option>`;
  })}`;
}

// ---- charts -------------------------------------------------------------------

/** Single-series vertical bar chart (SVG) with hover tooltip. data: [{ label, short, value, tip }] */
export function mountBarChart(el, data, { height = 220, fmt = (v) => n(v, 1), title = '' } = {}) {
  const W = Math.max(300, el.clientWidth || 640);
  const H = height;
  const m = { t: 12, r: 8, b: 26, l: 44 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const y = (v) => m.t + ih - (v / top) * ih;
  const bw = iw / Math.max(1, data.length);
  const gap = Math.min(8, Math.max(2, bw * 0.25));
  const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 56)));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(title)}">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
    svg += `<text x="${m.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${esc(n(v, step < 1 ? 1 : 0))}</text>`;
  }
  data.forEach((d, i) => {
    const x = m.l + i * bw + gap / 2;
    const w = Math.max(1, bw - gap);
    const h = Math.max(0, y(0) - y(d.value));
    const r = Math.min(4, w / 2, h);
    if (h > 0) svg += `<path class="bar" d="M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + w - r} Q${x + w},${y(0) - h} ${x + w},${y(0) - h + r} V${y(0)} Z"/>`;
    svg += `<rect class="hit" x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ih}" data-i="${i}"/>`;
    if (i % every === 0) svg += `<text x="${x + w / 2}" y="${H - 8}" class="axis" text-anchor="middle">${esc(d.short || d.label)}</text>`;
  });
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" class="baseline"/></svg>`;
  el.innerHTML = `<div class="chart">${svg}<div class="chart-tip" hidden></div></div>`;
  const tip = el.querySelector('.chart-tip');
  el.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('mouseenter', () => {
      const d = data[Number(h.dataset.i)];
      tip.innerHTML = `<strong>${esc(d.label)}</strong><br>${esc(fmt(d.value))}${d.tip ? `<br><span class="muted">${esc(d.tip)}</span>` : ''}`;
      tip.hidden = false;
      h.classList.add('on');
    });
    h.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 170)}px`;
      tip.style.top = `${e.clientY - r.top - 10}px`;
    });
    h.addEventListener('mouseleave', () => { tip.hidden = true; h.classList.remove('on'); });
  });
}
function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// ---- copy for Excel / Google Sheets (tab-separated, pastes into columns) -------------

export function copyTable(rows, columns) {
  const cell = (v) => {
    let s = String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    if (typeof v === 'string' && /^[=+@]/.test(s)) s = `'${s}`;
    return s;
  };
  const text = [columns.map((c) => cell(c.label)).join('\t'),
    ...rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join('\t'))].join('\n');
  const fallback = () => modal({
    title: t('Copy for Excel'), submit: null, cancel: t('Close'), wide: true,
    body: html`<p class="muted">${t('Select all (Ctrl+A), copy (Ctrl+C) and paste into Excel or Google Sheets.')}</p><textarea rows="12" readonly>${text}</textarea>`,
    onOpen: (f) => { const ta = f.querySelector('textarea'); ta.focus(); ta.select(); },
  });
  try {
    navigator.clipboard.writeText(text).then(
      () => toast(t('Copied {n} rows — paste into Excel or Google Sheets', { n: rows.length })),
      fallback,
    );
  } catch { fallback(); }
}

export function emptyState(text) {
  return html`<div class="empty">${text}</div>`;
}

/** Make table rows with data-href clickable (ignores clicks on links/buttons inside). */
export function bindRowLinks(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select')) return;
      go(tr.dataset.href.replace(/^#/, ''));
    });
  });
}

/** Adds data-label (from the header) to every cell so tables can stack into cards on phones. */
export function labelTables(root) {
  root.querySelectorAll('table.table:not(.compact):not(.closing)').forEach((tb) => {
    const heads = [...tb.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent.trim());
    tb.classList.add('stack');
    tb.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    });
  });
}
