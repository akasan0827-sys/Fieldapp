import { api, state, can, host } from '../api.js';
import { t } from '../i18n.js';
import {
  html, $, $$, n, fmtDate, fmtDateTime, relDays, badge, toast, modal, formData, emptyState, copyTable,
  docType, DOC_TYPE_KEYS, addDays, options, bindRowLinks, go,
} from '../ui.js';

const set = (el, h) => { el.innerHTML = String(h); };

/** Human description of one document line (works for doc lines and history rows). */
export function describeLine(l) {
  const at = l.location_code ? t(' · rack {rack}', { rack: l.location_code }) : '';
  const size = l.width_mm && l.length_mm ? ` (${n(l.width_mm)}×${n(l.length_mm)} mm)` : '';
  const left = l.new_remnant_code ? t('; leftover {code} {sqm} m²', { code: l.new_remnant_code, sqm: n(l.leftover_sqm, 2) }) + (l.to_location_code ? ` → ${l.to_location_code}` : '') : '';
  const waste = l.waste_sqm > 0.0005 ? t('; waste {sqm} m²', { sqm: n(l.waste_sqm, 2) }) : '';
  const lock = l.lock_id ? ` ${t('(lock #{id})', { id: l.lock_id })}` : '';
  const unit = l.glue_unit || 'pcs';
  switch (l.kind) {
    case 'slab_in': return t('{n} full slabs', { n: n(l.qty) }) + (l.location_code ? ` → ${t('rack {rack}', { rack: l.location_code })}` : '');
    case 'slab_out': return t('{n} full slabs from rack {rack}', { n: n(l.qty), rack: l.location_code }) + lock;
    case 'slab_cut': return t('Cut {sqm} m² from a full slab', { sqm: n(l.sqm, 2) }) + at + left + waste + lock;
    case 'remnant_cut': return t('Cut {sqm} m² from offcut {code}', { sqm: n(l.sqm, 2), code: l.remnant_code }) + left + waste;
    case 'remnant_out': return t('Whole offcut {code} · {sqm} m²', { code: l.remnant_code, sqm: n(l.sqm, 2) });
    case 'remnant_in': return t('Offcut {code} registered · {sqm} m²', { code: l.new_remnant_code || '', sqm: n(l.sqm, 2) }) + size + at;
    case 'remnant_scrap': return t('Offcut {code} scrapped · {sqm} m²', { code: l.remnant_code, sqm: n(l.sqm, 2) });
    case 'remnant_move': return t('Offcut {code} moved {from} → {to}', { code: l.remnant_code, from: l.location_code, to: l.to_location_code });
    case 'slab_adj': return `${l.qty > 0 ? '+' : ''}${t('{n} full slabs', { n: n(l.qty) })}${at}`;
    case 'slab_move': return t('{n} full slabs moved {from} → {to}', { n: n(l.qty), from: l.location_code, to: l.to_location_code });
    case 'glue_in': return `${n(l.qty)} ${unit} · ${t('lot {lot}', { lot: l.lot_no || '?' })}${l.expiry ? ` · ${t('exp. {date}', { date: fmtDate(l.expiry) })}` : ''}`;
    case 'glue_out': return `${n(l.qty)} ${unit} · ${t('lot {lot}', { lot: l.lot_no })} (${t('exp. {date}', { date: fmtDate(l.expiry) })})`;
    case 'glue_adj': return `${l.qty > 0 ? '+' : ''}${n(l.qty)} ${unit} · ${t('lot {lot}', { lot: l.lot_no })}`;
    default: return l.kind;
  }
}

function itemName(l) {
  if (l.slab_code) return `${l.slab_code} ${l.slab_name}`;
  if (l.glue_code) return `${t('Glue')} ${l.glue_code} ${l.glue_name}`;
  return '';
}

const docCopyColumns = () => [
  { label: t('Date'), value: 'date' }, { label: t('No.'), value: 'doc_no' }, { label: t('Type'), value: (d) => docType(d.type) },
  { label: t('Status'), value: 'status' }, { label: t('Customer'), value: 'customer_name' }, { label: t('Delivered to'), value: 'deliver_to' },
  { label: t('Supplier'), value: 'partner' }, { label: t('Reference'), value: 'reference' }, { label: t('Sales person'), value: 'sales_person' },
  { label: t('Slabs'), value: 'slab_pcs' }, { label: 'm²', value: 'sqm' }, { label: t('Glue'), value: 'glue_qty' }, { label: t('Note'), value: 'note' },
];

// ---- generic document list ---------------------------------------------------------
function docListPage({ title, type, newPath, newLabel, columns, filtersKey }) {
  const filter = { from: '', to: '', q: '', type: type || '' };
  return {
    title,
    live: true,
    async render(main) {
      if (!filter.from) filter.from = addDays(state.me.today, -30);
      const qs = new URLSearchParams({ from: filter.from, to: filter.to, q: filter.q, ...(filter.type ? { type: filter.type } : {}) });
      const list = await api.get(`/api/docs?${qs}`);
      const cols = columns();
      set(main, html`
        <div class="toolbar">
          <label class="inline">${t('From')} <input type="date" id="from" value="${filter.from}"></label>
          <label class="inline">${t('To')} <input type="date" id="to" value="${filter.to}"></label>
          ${filtersKey === 'history' ? html`<select id="type" aria-label="${t('Type')}">${options(DOC_TYPE_KEYS.map((k) => ({ id: k, name: docType(k) })), filter.type, { empty: t('All types') })}</select>` : ''}
          <input type="search" id="q" placeholder="${t('Search customer, site, no., reference…')}" value="${filter.q}" aria-label="${t('Search')}">
          <span class="spacer"></span>
          <button class="btn btn-sm" id="copy">⧉ ${t('Copy for Excel')}</button>
          ${newPath && can.edit() ? html`<a class="btn btn-primary" href="#${newPath}">${newLabel()}</a>` : ''}
        </div>
        ${list.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
          <tbody>${list.map((d) => html`<tr class="clickable ${d.status === 'void' ? 'is-void' : ''}" data-href="/doc/${d.id}">
            ${cols.map((c) => html`<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render(d)}</td>`)}</tr>`)}</tbody>
          ${cols.some((c) => c.total) ? html`<tfoot><tr>${cols.map((c, i) => html`<td class="${c.num ? 'num' : ''}">${i === 0 ? t('{n} documents', { n: list.filter((d) => d.status !== 'void').length }) : c.total ? c.total(list.filter((d) => d.status !== 'void')) : ''}</td>`)}</tr></tfoot>` : ''}
        </table></div>` : emptyState(t('Nothing found for this period.'))}`);
      bindRowLinks(main);
      const reload = () => this.render(main);
      $('#from', main).onchange = (e) => { filter.from = e.target.value; reload(); };
      $('#to', main).onchange = (e) => { filter.to = e.target.value; reload(); };
      if ($('#type', main)) $('#type', main).onchange = (e) => { filter.type = e.target.value; reload(); };
      let tm;
      $('#q', main).oninput = (e) => {
        clearTimeout(tm);
        tm = setTimeout(() => { filter.q = e.target.value; reload().then(() => { const q = $('#q', main); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 400);
      };
      $('#copy', main).onclick = () => copyTable(list, docCopyColumns());
    },
  };
}

const sum = (k, d = 0) => (list) => n(list.reduce((a, x) => a + (x[k] || 0), 0), d);
const statusCell = (d) => (d.status === 'posted' ? '' : badge(d.status));

export const deliveries = docListPage({
  title: () => t('Deliveries'),
  type: 'outbound',
  newPath: '/deliveries/new',
  newLabel: () => `+ ${t('New delivery')}`,
  filtersKey: 'deliveries',
  columns: () => [
    { label: t('Date'), render: (d) => fmtDate(d.date), cls: 'nowrap' },
    { label: t('No.'), render: (d) => html`<a href="#/doc/${d.id}">${d.doc_no}</a> ${statusCell(d)}`, cls: 'nowrap' },
    { label: t('Customer'), render: (d) => d.customer_name },
    { label: t('Delivered to'), render: (d) => d.deliver_to },
    { label: t('Ref.'), render: (d) => d.reference },
    { label: t('Sales'), render: (d) => d.sales_person },
    { label: t('Slabs used'), num: true, render: (d) => n(d.slab_pcs), total: sum('slab_pcs') },
    { label: 'm²', num: true, render: (d) => n(d.sqm, 2), total: sum('sqm', 2) },
    { label: t('Glue'), num: true, render: (d) => n(d.glue_qty), total: sum('glue_qty') },
  ],
});

export const history = docListPage({
  title: () => t('All movements'),
  filtersKey: 'history',
  columns: () => [
    { label: t('Date'), render: (d) => fmtDate(d.date), cls: 'nowrap' },
    { label: t('No.'), render: (d) => html`<a href="#/doc/${d.id}">${d.doc_no}</a> ${statusCell(d)}`, cls: 'nowrap' },
    { label: t('Type'), render: (d) => docType(d.type) },
    { label: t('Customer / supplier / reason'), render: (d) => d.customer_name || d.partner || d.reason },
    { label: t('Delivered to / reference'), render: (d) => d.deliver_to || d.reference },
    { label: t('Slabs'), num: true, render: (d) => n(d.slab_pcs) },
    { label: 'm²', num: true, render: (d) => n(d.sqm, 2) },
    { label: t('Glue'), num: true, render: (d) => n(d.glue_qty) },
    { label: t('By'), render: (d) => html`${d.created_by_name}<div class="muted small">${fmtDateTime(d.created_at)}</div>` },
  ],
});

// ---- receiving (incoming + received) ---------------------------------------------------
export const receiving = {
  title: () => t('Receiving & incoming'),
  live: true,
  async render(main) {
    const edit = can.edit();
    const [incoming, received] = await Promise.all([
      api.get('/api/docs?type=inbound&status=expected'),
      api.get(`/api/docs?type=inbound&status=posted&from=${addDays(state.me.today, -90)}`),
    ]);
    incoming.sort((a, b) => ((a.eta || '9999') < (b.eta || '9999') ? -1 : 1));
    set(main, html`
      <div class="actions-row">
        ${edit ? html`<a class="btn btn-primary" href="#/receiving/new">+ ${t('Receive stock now')}</a>
          <a class="btn" href="#/receiving/new?mode=expected">+ ${t('Register incoming shipment')}</a>` : ''}
      </div>
      <section class="card">
        <h2>${t('Incoming shipments (ordered / on board / at port)')}</h2>
        ${incoming.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>${t('ETA')}</th><th>${t('No.')}</th><th>${t('Supplier')}</th><th>${t('Reference')}</th><th>${t('Status')}</th><th class="num">${t('Slabs')}</th><th class="num">${t('Glue')}</th><th>${t('Note')}</th>${edit ? html`<th></th>` : ''}</tr></thead>
          <tbody>${incoming.map((d) => html`<tr>
            <td class="nowrap">${d.eta ? html`${fmtDate(d.eta)} <div class="small ${d.eta < state.me.today ? 'text-bad' : 'muted'}">${relDays(d.eta, state.me.today)}</div>` : html`<span class="muted">${t('not set')}</span>`}</td>
            <td><a href="#/doc/${d.id}">${d.doc_no}</a></td><td>${d.partner}</td><td>${d.reference}</td><td>${badge(d.ship_status)}</td>
            <td class="num">${n(d.slab_pcs)}</td><td class="num">${n(d.glue_qty)}</td><td class="small">${d.note}</td>
            ${edit ? html`<td class="nowrap actions"><a class="btn btn-sm btn-primary" href="#/doc/${d.id}/receive">${t('Receive')}</a>
              <button class="btn btn-sm" data-status="${d.id}">${t('ETA / status')}</button></td>` : ''}
          </tr>`)}</tbody></table></div>` : emptyState(t('No incoming shipments.'))}
      </section>
      <section class="card">
        <h2>${t('Received — last 90 days')}</h2>
        ${received.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>${t('Date')}</th><th>${t('No.')}</th><th>${t('Supplier')}</th><th>${t('Reference')}</th><th class="num">${t('Slabs')}</th><th class="num">m²</th><th class="num">${t('Glue')}</th></tr></thead>
          <tbody>${received.map((d) => html`<tr class="clickable" data-href="/doc/${d.id}"><td>${fmtDate(d.date)}</td><td><a href="#/doc/${d.id}">${d.doc_no}</a></td>
            <td>${d.partner}</td><td>${d.reference}</td><td class="num">${n(d.slab_pcs)}</td><td class="num">${n(d.sqm, 1)}</td><td class="num">${n(d.glue_qty)}</td></tr>`)}</tbody></table></div>`
          : emptyState(t('Nothing received in the last 90 days.'))}
      </section>`);
    bindRowLinks(main);
    $$('[data-status]', main).forEach((b) => b.addEventListener('click', async () => {
      const d = incoming.find((x) => x.id === Number(b.dataset.status));
      if (await shipmentStatusModal(d)) { toast(t('Shipment updated')); this.render(main); }
    }));
  },
};

function shipmentStatusModal(d) {
  return modal({
    title: t('Shipment {no}', { no: d.doc_no }),
    body: html`<div class="row-2">
        <label>${t('ETA')} <input type="date" name="eta" value="${d.eta || ''}"></label>
        <label>${t('Status')} <select name="ship_status">${options([{ id: 'ordered', name: t('Ordered') }, { id: 'on_board', name: t('On board') }, { id: 'at_port', name: t('At port') }], d.ship_status)}</select></label>
      </div>
      <label>${t('Reference (PO / BL / container)')} <input name="reference" value="${d.reference}"></label>
      <label>${t('Note')} <input name="note" value="${d.note}"></label>`,
    onSubmit: (f) => api.patch(`/api/docs/${d.id}`, formData(f)),
  });
}

// ---- document view / delivery note -----------------------------------------------------
export const docView = {
  title: () => t('Document'),
  live: true,
  async render(main, { params }) {
    const d = await api.get(`/api/docs/${params.id}`);
    const edit = can.edit();
    $('#pageTitle').textContent = `${docType(d.type)} ${d.doc_no}`;
    const totSqm = d.lines.filter((l) => l.slab_id && !['slab_move', 'remnant_move'].includes(l.kind)).reduce((a, l) => a + l.sqm, 0);
    const isOut = d.type === 'outbound';
    set(main, html`
      <div class="actions-row no-print">
        ${host.canPrint ? html`<button class="btn" id="print">🖨 ${isOut ? t('Print delivery note') : t('Print')}</button>` : ''}
        ${edit && d.status === 'posted' ? html`<button class="btn btn-danger-outline" id="void">${t('Void…')}</button>` : ''}
        ${edit && d.status === 'expected' ? html`<a class="btn btn-primary" href="#/doc/${d.id}/receive">${t('Receive this shipment')}</a>
          <a class="btn" href="#/doc/${d.id}/edit">${t('Edit lines')}</a>
          <button class="btn" id="status">${t('ETA / status')}</button>
          <button class="btn btn-danger-outline" id="del">${t('Delete')}</button>` : ''}
      </div>
      <article class="card doc">
        <header class="doc-head">
          <div>
            <div class="muted small print-only">${state.me.settings.company_name}</div>
            <h2 class="h-xl">${isOut ? t('Delivery note') : docType(d.type)} ${d.doc_no} ${badge(d.status === 'expected' ? d.ship_status : d.status)}</h2>
            <div class="muted">${d.status === 'expected' ? html`${t('ETA')} ${d.eta ? fmtDate(d.eta) : t('not set')}` : fmtDate(d.date)}</div>
          </div>
        </header>
        ${d.status === 'void' ? html`<div class="alert alert-error">${t('Voided by {name} on {date} — {reason}. This document no longer affects stock.', { name: d.voided_by_name, date: fmtDateTime(d.voided_at), reason: d.void_reason })}</div>` : ''}
        <dl class="doc-meta">
          ${d.customer_name ? html`<div><dt>${t('Customer')}</dt><dd>${d.customer_name}${d.customer_phone ? html` · ${d.customer_phone}` : ''}</dd></div>` : ''}
          ${d.deliver_to ? html`<div><dt>${t('Delivered to')}</dt><dd>${d.deliver_to}</dd></div>` : ''}
          ${d.contact ? html`<div><dt>${t('Contact on site')}</dt><dd>${d.contact}</dd></div>` : ''}
          ${d.partner ? html`<div><dt>${t('Supplier')}</dt><dd>${d.partner}</dd></div>` : ''}
          ${d.reference ? html`<div><dt>${t('Reference')}</dt><dd>${d.reference}</dd></div>` : ''}
          ${d.sales_person ? html`<div><dt>${t('Sales person')}</dt><dd>${d.sales_person}</dd></div>` : ''}
          ${d.reason ? html`<div><dt>${t('Reason')}</dt><dd>${t(d.reason)}</dd></div>` : ''}
          ${d.note ? html`<div><dt>${t('Note')}</dt><dd>${d.note}</dd></div>` : ''}
          <div class="no-print"><dt>${t('Entered by')}</dt><dd>${d.created_by_name} · ${fmtDateTime(d.created_at)}</dd></div>
        </dl>
        <table class="table">
          <thead><tr><th>#</th><th>${t('Item')}</th><th>${t('Details')}</th><th class="num">${t('Qty')}</th><th class="num">m²</th></tr></thead>
          <tbody>${d.lines.map((l, i) => html`<tr>
            <td>${i + 1}</td><td>${itemName(l)}</td><td>${describeLine(l)}${l.note ? html`<div class="muted small">${l.note}</div>` : ''}</td>
            <td class="num">${l.kind === 'slab_cut' ? t('1 (cut)') : ['remnant_cut', 'remnant_out', 'remnant_in', 'remnant_scrap', 'remnant_move'].includes(l.kind) ? '–' : n(l.qty)}</td>
            <td class="num">${l.slab_id && l.sqm ? n(l.sqm, 2) : ''}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="4">${t('Total slab area')}</td><td class="num">${n(totSqm, 2)} m²</td></tr></tfoot>
        </table>
        ${isOut ? html`<div class="signatures print-only"><div>${t('Delivered by')}</div><div>${t('Received by (name / signature)')}</div></div>` : ''}
      </article>`);
    if ($('#print', main)) $('#print', main).onclick = () => window.print();
    if ($('#void', main)) {
      $('#void', main).onclick = async () => {
        const ok = await modal({
          title: t('Void {no}?', { no: d.doc_no }), submit: t('Void document'), danger: true,
          body: html`<p>${t('Voiding reverses everything this document did to stock (slabs, offcuts, glue and locks). The document stays visible, marked as void.')}</p>
            <label>${t('Reason')} <input name="reason" required placeholder="${t('e.g. entered twice, wrong colour')}"></label>`,
          onSubmit: (f) => api.post(`/api/docs/${d.id}/void`, formData(f)),
        });
        if (ok) { toast(t('Document voided')); this.render(main, { params }); }
      };
    }
    if ($('#status', main)) $('#status', main).onclick = async () => { if (await shipmentStatusModal(d)) { toast(t('Shipment updated')); this.render(main, { params }); } };
    if ($('#del', main)) {
      $('#del', main).onclick = async () => {
        const ok = await modal({ title: t('Delete {no}?', { no: d.doc_no }), submit: t('Delete'), danger: true, body: html`<p>${t('The incoming shipment will be removed. Nothing in stock changes.')}</p>`, onSubmit: () => api.del(`/api/docs/${d.id}`) });
        if (ok) { toast(t('Shipment deleted')); go('/receiving'); }
      };
    }
  },
};
