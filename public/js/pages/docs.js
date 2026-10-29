import { api, state, can } from '../api.js';
import {
  html, $, $$, n, fmtDate, fmtDateTime, relDays, badge, toast, modal, formData, emptyState, downloadCsv,
  DOC_TYPES, addDays, options, bindRowLinks,
} from '../ui.js';

const set = (el, h) => { el.innerHTML = String(h); };

/** Human description of one document line (works for doc lines and history rows). */
export function describeLine(l) {
  const at = l.location_code ? ` · rack ${l.location_code}` : '';
  const size = l.width_mm && l.length_mm ? ` (${n(l.width_mm)}×${n(l.length_mm)} mm)` : '';
  const left = l.new_remnant_code ? `; leftover ${l.new_remnant_code} ${n(l.leftover_sqm, 2)} m²${l.to_location_code ? ` → ${l.to_location_code}` : ''}` : '';
  const waste = l.waste_sqm > 0.0005 ? `; waste ${n(l.waste_sqm, 2)} m²` : '';
  switch (l.kind) {
    case 'slab_in': return `${n(l.qty)} full slabs${l.location_code ? ` → rack ${l.location_code}` : ''}`;
    case 'slab_out': return `${n(l.qty)} full slabs from rack ${l.location_code}${l.lock_id ? ` (lock #${l.lock_id})` : ''}`;
    case 'slab_cut': return `Cut ${n(l.sqm, 2)} m² from a full slab${at}${left}${waste}${l.lock_id ? ` (lock #${l.lock_id})` : ''}`;
    case 'remnant_cut': return `Cut ${n(l.sqm, 2)} m² from offcut ${l.remnant_code}${left}${waste}`;
    case 'remnant_out': return `Whole offcut ${l.remnant_code} · ${n(l.sqm, 2)} m²`;
    case 'remnant_in': return `Offcut ${l.new_remnant_code || ''} registered · ${n(l.sqm, 2)} m²${size}${at}`;
    case 'remnant_scrap': return `Offcut ${l.remnant_code} scrapped · ${n(l.sqm, 2)} m²`;
    case 'remnant_move': return `Offcut ${l.remnant_code} moved ${l.location_code} → ${l.to_location_code}`;
    case 'slab_adj': return `${l.qty > 0 ? '+' : ''}${n(l.qty)} full slabs${at}`;
    case 'slab_move': return `${n(l.qty)} full slabs moved ${l.location_code} → ${l.to_location_code}`;
    case 'glue_in': return `${n(l.qty)} ${l.glue_unit || 'pcs'} · lot ${l.lot_no || '?'}${l.expiry ? ` · exp. ${fmtDate(l.expiry)}` : ''}`;
    case 'glue_out': return `${n(l.qty)} ${l.glue_unit || 'pcs'} · lot ${l.lot_no} (exp. ${fmtDate(l.expiry)})`;
    case 'glue_adj': return `${l.qty > 0 ? '+' : ''}${n(l.qty)} ${l.glue_unit || 'pcs'} · lot ${l.lot_no}`;
    default: return l.kind;
  }
}

function itemName(l) {
  if (l.slab_code) return `${l.slab_code} ${l.slab_name}`;
  if (l.glue_code) return `Glue ${l.glue_code} ${l.glue_name}`;
  return '';
}

// ---- generic document list ---------------------------------------------------------
function docListPage({ title, type, status, newHref, newLabel, columns, filtersKey }) {
  const filter = { from: '', to: '', q: '', type: type || '' };
  return {
    title,
    live: true,
    async render(main, { query }) {
      if (!filter.from) filter.from = addDays(state.me.today, -30);
      if (query.q !== undefined) filter.q = query.q;
      const qs = new URLSearchParams({ from: filter.from, to: filter.to, q: filter.q, ...(filter.type ? { type: filter.type } : {}), ...(status ? { status } : {}) });
      const list = await api.get(`/api/docs?${qs}`);
      set(main, html`
        <div class="toolbar">
          <label class="inline">From <input type="date" id="from" value="${filter.from}"></label>
          <label class="inline">To <input type="date" id="to" value="${filter.to}"></label>
          ${filtersKey === 'history' ? html`<select id="type" aria-label="Type">${options(Object.entries(DOC_TYPES).map(([k, v]) => ({ id: k, name: v })), filter.type, { empty: 'All types' })}</select>` : ''}
          <input type="search" id="q" placeholder="Search customer, site, no., reference…" value="${filter.q}" aria-label="Search">
          <span class="spacer"></span>
          <button class="btn btn-sm" id="csv">⇩ CSV</button>
          ${newHref && can.edit() ? html`<a class="btn btn-primary" href="${newHref}">${newLabel}</a>` : ''}
        </div>
        ${list.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr>${columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
          <tbody>${list.map((d) => html`<tr class="clickable ${d.status === 'void' ? 'is-void' : ''}" data-href="#/doc/${d.id}">
            ${columns.map((c) => html`<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render(d)}</td>`)}</tr>`)}</tbody>
          ${columns.some((c) => c.total) ? html`<tfoot><tr>${columns.map((c, i) => html`<td class="${c.num ? 'num' : ''}">${i === 0 ? `${list.filter((d) => d.status !== 'void').length} documents` : c.total ? c.total(list.filter((d) => d.status !== 'void')) : ''}</td>`)}</tr></tfoot>` : ''}
        </table></div>` : emptyState('Nothing found for this period.')}`);
      bindRowLinks(main);
      const reload = () => this.render(main, { query: {} });
      $('#from', main).onchange = (e) => { filter.from = e.target.value; reload(); };
      $('#to', main).onchange = (e) => { filter.to = e.target.value; reload(); };
      if ($('#type', main)) $('#type', main).onchange = (e) => { filter.type = e.target.value; reload(); };
      let t;
      $('#q', main).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { filter.q = e.target.value; reload().then(() => { const q = $('#q', main); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 350); };
      $('#csv', main).onclick = () => downloadCsv(`${filtersKey}-${state.me.today}.csv`, list, [
        { label: 'Date', value: 'date' }, { label: 'No', value: 'doc_no' }, { label: 'Type', value: (d) => DOC_TYPES[d.type] },
        { label: 'Status', value: 'status' }, { label: 'Customer', value: 'customer_name' }, { label: 'Delivered to', value: 'deliver_to' },
        { label: 'Supplier', value: 'partner' }, { label: 'Reference', value: 'reference' }, { label: 'Sales person', value: 'sales_person' },
        { label: 'Slab pcs', value: 'slab_pcs' }, { label: 'm2', value: 'sqm' }, { label: 'Glue', value: 'glue_qty' }, { label: 'Note', value: 'note' },
      ]);
    },
  };
}

const sum = (k, d = 0) => (list) => n(list.reduce((a, x) => a + (x[k] || 0), 0), d);
const statusCell = (d) => (d.status === 'posted' ? '' : badge(d.status));

export const deliveries = docListPage({
  title: 'Deliveries',
  type: 'outbound',
  newHref: '#/deliveries/new',
  newLabel: '+ New delivery',
  filtersKey: 'deliveries',
  columns: [
    { label: 'Date', render: (d) => fmtDate(d.date), cls: 'nowrap' },
    { label: 'No.', render: (d) => html`<a href="#/doc/${d.id}">${d.doc_no}</a> ${statusCell(d)}`, cls: 'nowrap' },
    { label: 'Customer', render: (d) => d.customer_name },
    { label: 'Delivered to', render: (d) => d.deliver_to },
    { label: 'Ref.', render: (d) => d.reference },
    { label: 'Sales', render: (d) => d.sales_person },
    { label: 'Slabs used', num: true, render: (d) => n(d.slab_pcs), total: sum('slab_pcs') },
    { label: 'm²', num: true, render: (d) => n(d.sqm, 2), total: sum('sqm', 2) },
    { label: 'Glue', num: true, render: (d) => n(d.glue_qty), total: sum('glue_qty') },
  ],
});

export const history = docListPage({
  title: 'All movements',
  filtersKey: 'history',
  columns: [
    { label: 'Date', render: (d) => fmtDate(d.date), cls: 'nowrap' },
    { label: 'No.', render: (d) => html`<a href="#/doc/${d.id}">${d.doc_no}</a> ${statusCell(d)}`, cls: 'nowrap' },
    { label: 'Type', render: (d) => DOC_TYPES[d.type] },
    { label: 'Customer / supplier / reason', render: (d) => d.customer_name || d.partner || d.reason },
    { label: 'Delivered to / reference', render: (d) => d.deliver_to || d.reference },
    { label: 'Slabs', num: true, render: (d) => n(d.slab_pcs) },
    { label: 'm²', num: true, render: (d) => n(d.sqm, 2) },
    { label: 'Glue', num: true, render: (d) => n(d.glue_qty) },
    { label: 'By', render: (d) => html`${d.created_by_name}<div class="muted small">${fmtDateTime(d.created_at)}</div>` },
  ],
});

// ---- receiving (incoming + received) ---------------------------------------------------
export const receiving = {
  title: 'Receiving & incoming',
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
        ${edit ? html`<a class="btn btn-primary" href="#/receiving/new">+ Receive stock now</a>
          <a class="btn" href="#/receiving/new?mode=expected">+ Register incoming shipment</a>` : ''}
      </div>
      <section class="card">
        <h2>Incoming shipments (ordered / on board / at port)</h2>
        ${incoming.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>ETA</th><th>No.</th><th>Supplier</th><th>Reference</th><th>Status</th><th class="num">Slabs</th><th class="num">Glue</th><th>Note</th>${edit ? html`<th></th>` : ''}</tr></thead>
          <tbody>${incoming.map((d) => html`<tr>
            <td class="nowrap">${d.eta ? html`${fmtDate(d.eta)} <div class="small ${d.eta < state.me.today ? 'text-bad' : 'muted'}">${relDays(d.eta, state.me.today)}</div>` : html`<span class="muted">not set</span>`}</td>
            <td><a href="#/doc/${d.id}">${d.doc_no}</a></td><td>${d.partner}</td><td>${d.reference}</td><td>${badge(d.ship_status)}</td>
            <td class="num">${n(d.slab_pcs)}</td><td class="num">${n(d.glue_qty)}</td><td class="small">${d.note}</td>
            ${edit ? html`<td class="nowrap actions"><a class="btn btn-sm btn-primary" href="#/doc/${d.id}/receive">Receive</a>
              <button class="btn btn-sm" data-status="${d.id}">ETA / status</button></td>` : ''}
          </tr>`)}</tbody></table></div>` : emptyState('No incoming shipments.')}
      </section>
      <section class="card">
        <h2>Received — last 90 days</h2>
        ${received.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>No.</th><th>Supplier</th><th>Reference</th><th class="num">Slabs</th><th class="num">m²</th><th class="num">Glue</th></tr></thead>
          <tbody>${received.map((d) => html`<tr class="clickable" data-href="#/doc/${d.id}"><td>${fmtDate(d.date)}</td><td><a href="#/doc/${d.id}">${d.doc_no}</a></td>
            <td>${d.partner}</td><td>${d.reference}</td><td class="num">${n(d.slab_pcs)}</td><td class="num">${n(d.sqm, 1)}</td><td class="num">${n(d.glue_qty)}</td></tr>`)}</tbody></table></div>`
          : emptyState('Nothing received in the last 90 days.')}
      </section>`);
    bindRowLinks(main);
    $$('[data-status]', main).forEach((b) => b.addEventListener('click', async () => {
      const d = incoming.find((x) => x.id === Number(b.dataset.status));
      const ok = await shipmentStatusModal(d);
      if (ok) { toast('Shipment updated'); this.render(main); }
    }));
  },
};

function shipmentStatusModal(d) {
  return modal({
    title: `Shipment ${d.doc_no}`,
    body: html`<div class="row-2">
        <label>ETA <input type="date" name="eta" value="${d.eta || ''}"></label>
        <label>Status <select name="ship_status">${options([{ id: 'ordered', name: 'Ordered' }, { id: 'on_board', name: 'On board' }, { id: 'at_port', name: 'At port' }], d.ship_status)}</select></label>
      </div>
      <label>Reference (PO / BL / container) <input name="reference" value="${d.reference}"></label>
      <label>Note <input name="note" value="${d.note}"></label>`,
    onSubmit: (f) => api.patch(`/api/docs/${d.id}`, formData(f)),
  });
}

// ---- document view / delivery note -----------------------------------------------------
export const docView = {
  title: 'Document',
  live: true,
  async render(main, { params }) {
    const d = await api.get(`/api/docs/${params.id}`);
    const edit = can.edit();
    $('#pageTitle').textContent = `${DOC_TYPES[d.type]} ${d.doc_no}`;
    const slabLines = d.lines.filter((l) => l.slab_id);
    const totSqm = slabLines.filter((l) => !['slab_move', 'remnant_move'].includes(l.kind)).reduce((a, l) => a + l.sqm, 0);
    const isOut = d.type === 'outbound';
    set(main, html`
      <div class="actions-row no-print">
        <button class="btn" id="print">🖨 Print${isOut ? ' delivery note' : ''}</button>
        ${edit && d.status === 'posted' ? html`<button class="btn btn-danger-outline" id="void">Void…</button>` : ''}
        ${edit && d.status === 'expected' ? html`<a class="btn btn-primary" href="#/doc/${d.id}/receive">Receive this shipment</a>
          <a class="btn" href="#/doc/${d.id}/edit">Edit lines</a>
          <button class="btn" id="status">ETA / status</button>
          <button class="btn btn-danger-outline" id="del">Delete</button>` : ''}
      </div>
      <article class="card doc">
        <header class="doc-head">
          <div>
            <div class="muted small print-only">${state.me.settings.company_name}</div>
            <h2 class="h-xl">${isOut ? 'Delivery note' : DOC_TYPES[d.type]} ${d.doc_no} ${badge(d.status === 'expected' ? d.ship_status : d.status)}</h2>
            <div class="muted">${d.status === 'expected' ? html`ETA ${d.eta ? fmtDate(d.eta) : 'not set'}` : fmtDate(d.date)}</div>
          </div>
        </header>
        ${d.status === 'void' ? html`<div class="alert alert-error">Voided by ${d.voided_by_name} on ${fmtDateTime(d.voided_at)} — ${d.void_reason}. This document no longer affects stock.</div>` : ''}
        <dl class="doc-meta">
          ${d.customer_name ? html`<div><dt>Customer</dt><dd>${d.customer_name}${d.customer_phone ? html` · ${d.customer_phone}` : ''}</dd></div>` : ''}
          ${d.deliver_to ? html`<div><dt>Delivered to</dt><dd>${d.deliver_to}</dd></div>` : ''}
          ${d.contact ? html`<div><dt>Contact on site</dt><dd>${d.contact}</dd></div>` : ''}
          ${d.partner ? html`<div><dt>Supplier</dt><dd>${d.partner}</dd></div>` : ''}
          ${d.reference ? html`<div><dt>Reference</dt><dd>${d.reference}</dd></div>` : ''}
          ${d.sales_person ? html`<div><dt>Sales person</dt><dd>${d.sales_person}</dd></div>` : ''}
          ${d.reason ? html`<div><dt>Reason</dt><dd>${d.reason}</dd></div>` : ''}
          ${d.note ? html`<div><dt>Note</dt><dd>${d.note}</dd></div>` : ''}
          <div class="no-print"><dt>Entered by</dt><dd>${d.created_by_name} · ${fmtDateTime(d.created_at)}</dd></div>
        </dl>
        <table class="table">
          <thead><tr><th>#</th><th>Item</th><th>Details</th><th class="num">Qty</th><th class="num">m²</th></tr></thead>
          <tbody>${d.lines.map((l, i) => html`<tr>
            <td>${i + 1}</td><td>${itemName(l)}</td><td>${describeLine(l)}${l.note ? html`<div class="muted small">${l.note}</div>` : ''}</td>
            <td class="num">${l.kind === 'slab_cut' ? '1 (cut)' : ['remnant_cut', 'remnant_out', 'remnant_in', 'remnant_scrap', 'remnant_move'].includes(l.kind) ? '–' : n(l.qty)}</td>
            <td class="num">${l.slab_id && l.sqm ? n(l.sqm, 2) : ''}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="4">Total slab area</td><td class="num">${n(totSqm, 2)} m²</td></tr></tfoot>
        </table>
        ${isOut ? html`<div class="signatures print-only"><div>Delivered by</div><div>Received by (name / signature)</div></div>` : ''}
      </article>`);
    $('#print', main).onclick = () => window.print();
    if ($('#void', main)) {
      $('#void', main).onclick = async () => {
        const ok = await modal({
          title: `Void ${d.doc_no}?`, submit: 'Void document', danger: true,
          body: html`<p>Voiding reverses everything this document did to stock (slabs, offcuts, glue and locks). The document stays visible, marked as void.</p>
            <label>Reason <input name="reason" required placeholder="e.g. entered twice, wrong colour"></label>`,
          onSubmit: (f) => api.post(`/api/docs/${d.id}/void`, formData(f)),
        });
        if (ok) { toast('Document voided'); this.render(main, { params }); }
      };
    }
    if ($('#status', main)) $('#status', main).onclick = async () => { if (await shipmentStatusModal(d)) { toast('Shipment updated'); this.render(main, { params }); } };
    if ($('#del', main)) {
      $('#del', main).onclick = async () => {
        const ok = await modal({ title: `Delete ${d.doc_no}?`, submit: 'Delete', danger: true, body: html`<p>The incoming shipment will be removed. Nothing in stock changes.</p>`, onSubmit: () => api.del(`/api/docs/${d.id}`) });
        if (ok) { toast('Shipment deleted'); location.hash = '#/receiving'; }
      };
    }
  },
};
