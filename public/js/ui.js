// Small UI toolkit: safe HTML templating, formatting, modals, toasts, charts, CSV.

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

// ---- formatting ---------------------------------------------------------------

export function n(x, digits = 0) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '–';
  return Number(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const sqm = (x) => (x === null || x === undefined ? '–' : `${n(x, 2)} m²`);
export const pcs = (x) => `${n(x)} pcs`;
export const signed = (x) => (x > 0 ? `+${n(x)}` : n(x));

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(s, k) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + k));
  return dt.toISOString().slice(0, 10);
}
export function addMonths(s, k) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
export function fmtDate(s) {
  if (!s) return '–';
  const d = new Date(`${s.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function relDays(s, today = todayStr()) {
  if (!s) return '';
  const k = daysBetween(today, s);
  if (k === 0) return 'today';
  if (k === 1) return 'tomorrow';
  if (k === -1) return 'yesterday';
  return k > 0 ? `in ${k} days` : `${-k} days ago`;
}
export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
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
  return html`<span class="badge badge-${cls}"><span aria-hidden="true">${icon}</span> ${label || text}</span>`;
}
export function swatch(hex) {
  return hex ? html`<span class="swatch" style="background:${hex}"></span>` : html`<span class="swatch swatch-empty"></span>`;
}

export const DOC_TYPES = {
  opening: 'Initial stock',
  inbound: 'Receipt',
  outbound: 'Delivery',
  adjust: 'Adjustment',
  transfer: 'Rack move',
};

// ---- toasts & modals -------------------------------------------------------------

export function toast(msg, type = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 6000 : 3000);
}

/**
 * Opens a modal. body is html; onSubmit(form) may return a promise; throw to keep it open
 * (the error message is shown inside the modal). Resolves with onSubmit's result or null.
 */
export function modal({ title, body, submit = 'Save', cancel = 'Cancel', danger = false, wide = false, onSubmit, onOpen }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = String(html`
      <form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
        <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
        <div class="modal-body">${body}<div class="form-error" hidden></div></div>
        <footer>
          ${cancel ? html`<button type="button" class="btn" data-close>${cancel}</button>` : ''}
          ${submit ? html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submit}</button>` : ''}
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

export function confirmBox(title, message, { submit = 'Confirm', danger = false } = {}) {
  return modal({ title, body: html`<p>${message}</p>`, submit, danger });
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

/**
 * Single-series vertical bar chart (SVG) with hover tooltip.
 * data: [{ label, short, value, tip }]
 */
export function mountBarChart(el, data, { height = 220, fmt = (v) => n(v, 1), title = '' } = {}) {
  const W = Math.max(320, el.clientWidth || 640);
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
  const every = Math.ceil(data.length / Math.floor(iw / 56));
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
    if (h > 0) {
      svg += `<path class="bar" d="M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + w - r} Q${x + w},${y(0) - h} ${x + w},${y(0) - h + r} V${y(0)} Z"/>`;
    }
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
      const x = e.clientX - r.left;
      tip.style.left = `${Math.min(x + 12, r.width - 170)}px`;
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

// ---- CSV ------------------------------------------------------------------------

export function downloadCsv(filename, rows, columns) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+@\t\r]/.test(s)) s = `'${s}`; // no formulas from text fields
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  // BOM so Excel opens UTF-8 (Korean names) correctly
  const blob = new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function emptyState(text) {
  return html`<div class="empty">${text}</div>`;
}

/** Make table rows with data-href clickable (ignores clicks on links/buttons inside). */
export function bindRowLinks(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select')) return;
      location.hash = tr.dataset.href;
    });
  });
}

/** Adds data-label (from the header) to every cell so tables can stack into cards on phones. */
export function labelTables(root) {
  root.querySelectorAll('table.table:not(.compact):not(.closing)').forEach((t) => {
    const heads = [...t.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent.trim());
    t.classList.add('stack');
    t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    });
  });
}
