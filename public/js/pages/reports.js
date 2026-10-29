import { api, state, can } from '../api.js';
import {
  html, $, $$, n, fmtDate, fmtDateTime, monthLabel, toast, modal, mountBarChart, emptyState, downloadCsv, addDays, addMonths,
} from '../ui.js';

const set = (el, h) => { el.innerHTML = String(h); };

// =====================================================================================
// Sales report: per day / week / month
// =====================================================================================
const sf = { from: '', to: '', group: 'day' };

function presets(today) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const m1 = `${today.slice(0, 7)}-01`;
  return [
    ['This week', monday, today, 'day'],
    ['Last 14 days', addDays(today, -13), today, 'day'],
    ['Last 8 weeks', addDays(monday, -49), today, 'week'],
    ['This month', m1, today, 'day'],
    ['Last month', addMonths(m1, -1), addDays(m1, -1), 'day'],
    ['Last 12 months', addMonths(m1, -11), today, 'month'],
  ];
}

export const sales = {
  title: 'Sales report',
  live: true,
  async render(main, { query }) {
    const t = state.me.today;
    if (query.group && !sf.from) {
      sf.group = query.group;
      sf.from = query.group === 'week' ? addDays(t, -55) : `${t.slice(0, 7)}-01`;
      if (query.group === 'day') { const dow = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7; sf.from = addDays(t, -dow); }
    }
    if (!sf.from) { sf.from = addDays(t, -13); sf.to = t; }
    if (!sf.to) sf.to = t;
    const r = await api.get(`/api/reports/sales?from=${sf.from}&to=${sf.to}&group=${sf.group}`);
    const unit = { day: 'day', week: 'week', month: 'month' }[sf.group];
    set(main, html`
      <div class="toolbar wrap">
        <label class="inline">From <input type="date" id="from" value="${sf.from}"></label>
        <label class="inline">To <input type="date" id="to" value="${sf.to}"></label>
        <div class="seg-btns" role="group" aria-label="Group by">
          ${['day', 'week', 'month'].map((g) => html`<button class="chip ${sf.group === g ? 'on' : ''}" data-group="${g}">Per ${g}</button>`)}
        </div>
        <span class="spacer"></span>
        <select id="preset" aria-label="Quick range"><option value="">Quick range…</option>${presets(t).map(([l], i) => html`<option value="${i}">${l}</option>`)}</select>
      </div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Sold</div><div class="tile-value">${n(r.total.sqm, 1)} <small>m²</small></div><div class="tile-sub">${fmtDate(r.from)} – ${fmtDate(r.to)}</div></div>
        <div class="tile"><div class="tile-label">Deliveries</div><div class="tile-value">${n(r.total.deliveries)}</div><div class="tile-sub">${r.by_customer.length} customers</div></div>
        <div class="tile"><div class="tile-label">Full slabs</div><div class="tile-value">${n(r.total.full_pcs)} <small>pcs</small></div><div class="tile-sub">delivered uncut</div></div>
        <div class="tile"><div class="tile-label">Cut / offcuts</div><div class="tile-value">${n(r.total.cut_sqm, 1)} <small>m²</small></div><div class="tile-sub">sold by m²</div></div>
        <div class="tile"><div class="tile-label">Glue</div><div class="tile-value">${n(r.total.glue)} <small>pcs</small></div><div class="tile-sub">&nbsp;</div></div>
      </div>
      <section class="card">
        <div class="card-head"><h2>m² sold per ${unit}</h2><button class="btn btn-sm" id="csvP">⇩ CSV</button></div>
        <div id="chart"></div>
        <details><summary class="small">Show as table</summary>
          <table class="table compact"><thead><tr><th>${unit[0].toUpperCase() + unit.slice(1)}</th><th class="num">Deliveries</th><th class="num">Full slabs</th><th class="num">Cut m²</th><th class="num">Total m²</th><th class="num">Glue</th></tr></thead>
          <tbody>${r.periods.map((p) => html`<tr><td>${sf.group === 'day' ? fmtDate(p.key) : sf.group === 'month' ? monthLabel(p.key) : p.label}</td><td class="num">${p.deliveries}</td><td class="num">${n(p.full_pcs)}</td><td class="num">${n(p.cut_sqm, 2)}</td><td class="num">${n(p.sqm, 2)}</td><td class="num">${n(p.glue)}</td></tr>`)}</tbody></table>
        </details>
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2>By colour</h2><button class="btn btn-sm" id="csvC">⇩ CSV</button></div>
          ${r.by_color.length ? html`<table class="table compact"><thead><tr><th>Colour</th><th class="num">m²</th><th class="num">Full slabs</th><th class="num">Cut m²</th><th class="num">Deliveries</th></tr></thead>
            <tbody>${r.by_color.map((c) => html`<tr><td><a href="#/stock/${c.slab_id}">${c.code}</a> ${c.name}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${n(c.cut_sqm, 2)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>` : emptyState('No sales in this period.')}
          ${r.by_glue.length ? html`<h3>Glue</h3><table class="table compact"><thead><tr><th>Glue</th><th class="num">Qty</th><th class="num">Deliveries</th></tr></thead>
            <tbody>${r.by_glue.map((g) => html`<tr><td>${g.code} ${g.name}</td><td class="num">${n(g.glue)}</td><td class="num">${g.deliveries}</td></tr>`)}</tbody></table>` : ''}
        </section>
        <section class="card">
          <div class="card-head"><h2>By customer</h2><button class="btn btn-sm" id="csvU">⇩ CSV</button></div>
          ${r.by_customer.length ? html`<table class="table compact"><thead><tr><th>Customer</th><th class="num">m²</th><th class="num">Full slabs</th><th class="num">Glue</th><th class="num">Deliveries</th></tr></thead>
            <tbody>${r.by_customer.map((c) => html`<tr><td>${c.name}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${n(c.glue)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>` : emptyState('No sales in this period.')}
          <h3>By sales person</h3>
          ${r.by_sales.length ? html`<table class="table compact"><thead><tr><th>Sales person</th><th class="num">m²</th><th class="num">Deliveries</th></tr></thead>
            <tbody>${r.by_sales.map((c) => html`<tr><td>${c.name}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>` : emptyState('–')}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h2>Deliveries in this period</h2><button class="btn btn-sm" id="csvD">⇩ CSV</button></div>
        ${r.deliveries.length ? html`<div class="table-wrap"><table class="table compact"><thead><tr><th>Date</th><th>No.</th><th>Customer</th><th>Delivered to</th><th>Sales</th><th class="num">Full slabs</th><th class="num">m²</th><th class="num">Glue</th></tr></thead>
          <tbody>${r.deliveries.map((d) => html`<tr><td class="nowrap">${fmtDate(d.date)}</td><td><a href="#/doc/${d.doc_id}">${d.doc_no}</a></td><td>${d.customer_name}</td><td>${d.deliver_to}</td><td>${d.sales_person}</td>
            <td class="num">${n(d.full_pcs)}</td><td class="num">${n(d.sqm, 2)}</td><td class="num">${n(d.glue)}</td></tr>`)}</tbody></table></div>` : emptyState('No deliveries.')}
      </section>`);
    mountBarChart($('#chart', main), r.periods.map((p) => ({
      label: sf.group === 'day' ? fmtDate(p.key) : sf.group === 'month' ? monthLabel(p.key) : p.label,
      short: sf.group === 'day' ? p.key.slice(5).replace('-', '/') : sf.group === 'month' ? p.key.slice(2).replace('-', '/') : p.label.split(' ')[0],
      value: p.sqm,
      tip: `${p.deliveries} deliveries · ${p.full_pcs} full slabs · ${n(p.cut_sqm, 2)} m² cut · ${p.glue} glue`,
    })), { height: 240, fmt: (v) => `${n(v, 2)} m²`, title: `m² sold per ${unit}` });

    const reload = () => this.render(main, { query: {} });
    $('#from', main).onchange = (e) => { sf.from = e.target.value; reload(); };
    $('#to', main).onchange = (e) => { sf.to = e.target.value; reload(); };
    $$('[data-group]', main).forEach((b) => b.addEventListener('click', () => { sf.group = b.dataset.group; reload(); }));
    $('#preset', main).onchange = (e) => {
      const p = presets(t)[Number(e.target.value)];
      if (!p) return;
      [, sf.from, sf.to, sf.group] = p;
      reload();
    };
    const tag = `${sf.from}_${sf.to}`;
    $('#csvP', main).onclick = () => downloadCsv(`sales-per-${sf.group}-${tag}.csv`, r.periods, [
      { label: sf.group, value: (p) => (sf.group === 'week' ? `${p.key} (${p.label})` : p.key) }, { label: 'Deliveries', value: 'deliveries' },
      { label: 'Full slabs', value: 'full_pcs' }, { label: 'Cut m2', value: 'cut_sqm' }, { label: 'Total m2', value: 'sqm' }, { label: 'Glue', value: 'glue' }]);
    $('#csvC', main).onclick = () => downloadCsv(`sales-by-colour-${tag}.csv`, r.by_color, [
      { label: 'Code', value: 'code' }, { label: 'Colour', value: 'name' }, { label: 'm2', value: 'sqm' }, { label: 'Full slabs', value: 'full_pcs' },
      { label: 'Cut m2', value: 'cut_sqm' }, { label: 'Deliveries', value: 'deliveries' }]);
    $('#csvU', main).onclick = () => downloadCsv(`sales-by-customer-${tag}.csv`, r.by_customer, [
      { label: 'Customer', value: 'name' }, { label: 'm2', value: 'sqm' }, { label: 'Full slabs', value: 'full_pcs' }, { label: 'Glue', value: 'glue' }, { label: 'Deliveries', value: 'deliveries' }]);
    $('#csvD', main).onclick = () => downloadCsv(`deliveries-${tag}.csv`, r.deliveries, [
      { label: 'Date', value: 'date' }, { label: 'No', value: 'doc_no' }, { label: 'Customer', value: 'customer_name' }, { label: 'Delivered to', value: 'deliver_to' },
      { label: 'Sales person', value: 'sales_person' }, { label: 'Full slabs', value: 'full_pcs' }, { label: 'm2', value: 'sqm' }, { label: 'Glue', value: 'glue' }]);
  },
};

// =====================================================================================
// Monthly closing
// =====================================================================================
let closingMonth = '';

export const closing = {
  title: 'Monthly closing',
  live: true,
  async render(main) {
    const info = await api.get('/api/closing');
    const t = state.me.today;
    if (!closingMonth) closingMonth = addMonths(`${t.slice(0, 7)}-01`, -1).slice(0, 7);
    const c = await api.get(`/api/closing/${closingMonth}`);
    const T = c.totals;
    const prev = addMonths(`${closingMonth}-01`, -1).slice(0, 7);
    const next = addMonths(`${closingMonth}-01`, 1).slice(0, 7);
    const ended = addMonths(`${closingMonth}-01`, 1) <= t;
    const nextToClose = info.closed_through ? addMonths(`${info.closed_through}-01`, 1).slice(0, 7) : null;
    const canClose = can.admin() && !c.closed && ended && (!nextToClose || nextToClose === closingMonth);
    const canReopen = can.admin() && c.closed && info.closed_through === closingMonth;
    set(main, html`
      <div class="toolbar">
        <button class="btn" id="prev" aria-label="Previous month">◀</button>
        <input type="month" id="month" value="${closingMonth}" aria-label="Month">
        <button class="btn" id="next" aria-label="Next month" ${next > t.slice(0, 7) ? 'disabled' : ''}>▶</button>
        <h2 class="inline-h">${monthLabel(closingMonth)}</h2>
        ${c.closed ? html`<span class="badge badge-good">🔒 Closed by ${c.closed_by_name} · ${fmtDateTime(c.closed_at)}</span>` : html`<span class="badge badge-info">Open${ended ? '' : ' — month not finished'}</span>`}
        <span class="spacer"></span>
        <button class="btn btn-sm" id="print">🖨 Print</button>
        <button class="btn btn-sm" id="csv">⇩ CSV</button>
        ${canClose ? html`<button class="btn btn-primary" id="close">Close ${monthLabel(closingMonth)}</button>` : ''}
        ${canReopen ? html`<button class="btn btn-danger-outline" id="reopen">Reopen</button>` : ''}
      </div>
      ${!c.closed && can.admin() && ended && nextToClose && nextToClose !== closingMonth ? html`<div class="alert alert-info">Months are closed in order — close ${monthLabel(nextToClose)} first.</div>` : ''}
      <p class="muted small">Closing a month freezes these numbers and blocks any new, back-dated or voided movement in that month. ${info.closed_through ? `Closed through ${monthLabel(info.closed_through)}.` : 'No month closed yet.'}</p>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Opening stock</div><div class="tile-value">${n(T.open_pcs)} <small>pcs</small></div><div class="tile-sub">${n(T.open_sqm, 1)} m² incl. offcuts</div></div>
        <div class="tile"><div class="tile-label">Received</div><div class="tile-value">+${n(T.in_pcs)} <small>pcs</small></div><div class="tile-sub">${n(c.doc_counts.inbound || 0)} receipts</div></div>
        <div class="tile"><div class="tile-label">Delivered</div><div class="tile-value">−${n(T.out_pcs)} <small>pcs used</small></div><div class="tile-sub">${n(T.sold_sqm, 1)} m² sold · ${n(c.doc_counts.outbound || 0)} deliveries</div></div>
        <div class="tile"><div class="tile-label">Adjustments</div><div class="tile-value">${T.adj_pcs > 0 ? '+' : ''}${n(T.adj_pcs)} <small>pcs</small></div><div class="tile-sub">waste ${n(T.waste_sqm, 2)} m²</div></div>
        <div class="tile"><div class="tile-label">Closing stock</div><div class="tile-value">${n(T.close_pcs)} <small>pcs</small></div><div class="tile-sub">${n(T.close_sqm, 1)} m² · offcuts ${n(T.close_offcut_sqm, 1)} m²</div></div>
        <div class="tile"><div class="tile-label">Glue</div><div class="tile-value">${n(T.glue_close)} <small>pcs</small></div><div class="tile-sub">in ${n(T.glue_in)} · out ${n(T.glue_out)} · expired ${n(T.glue_expired)}</div></div>
      </div>
      <section class="card">
        <h2>Slabs</h2>
        ${c.slabs.length ? html`<div class="table-wrap"><table class="table compact closing">
          <thead>
            <tr><th rowspan="2">Colour</th><th colspan="5" class="grp">Full slabs (pcs)</th><th colspan="4" class="grp">Offcuts (m²)</th><th colspan="2" class="grp">Sold</th><th rowspan="2" class="num">Closing total m²</th></tr>
            <tr><th class="num">Open</th><th class="num">In</th><th class="num">Out</th><th class="num">Adj.</th><th class="num">Close</th>
              <th class="num">Open</th><th class="num">New</th><th class="num">Used</th><th class="num">Close</th><th class="num">m²</th><th class="num">Full pcs</th></tr>
          </thead>
          <tbody>${c.slabs.map((s) => html`<tr><td class="nowrap"><strong>${s.code}</strong> ${s.name}</td>
            <td class="num">${n(s.open_pcs)}</td><td class="num">${s.in_pcs ? `+${n(s.in_pcs)}` : '–'}</td><td class="num">${s.out_pcs ? `−${n(s.out_pcs)}` : '–'}</td>
            <td class="num">${s.adj_pcs ? (s.adj_pcs > 0 ? `+${s.adj_pcs}` : s.adj_pcs) : '–'}</td><td class="num"><strong>${n(s.close_pcs)}</strong></td>
            <td class="num">${n(s.open_offcut_sqm, 2)}</td><td class="num">${n(s.new_offcut_sqm, 2)}</td><td class="num">${n(s.used_offcut_sqm, 2)}</td><td class="num">${n(s.close_offcut_sqm, 2)}</td>
            <td class="num">${n(s.sold_sqm, 2)}</td><td class="num">${n(s.sold_full_pcs)}</td><td class="num"><strong>${n(s.close_sqm, 1)}</strong></td></tr>`)}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${n(T.open_pcs)}</td><td class="num">+${n(T.in_pcs)}</td><td class="num">−${n(T.out_pcs)}</td><td class="num">${n(T.adj_pcs)}</td><td class="num">${n(T.close_pcs)}</td>
            <td class="num">${n(T.open_offcut_sqm, 2)}</td><td class="num">${n(T.new_offcut_sqm, 2)}</td><td class="num">${n(T.used_offcut_sqm, 2)}</td><td class="num">${n(T.close_offcut_sqm, 2)}</td>
            <td class="num">${n(T.sold_sqm, 2)}</td><td class="num">${n(T.sold_full_pcs)}</td><td class="num">${n(T.close_sqm, 1)}</td></tr></tfoot>
        </table></div>` : emptyState('No slab stock or movements in this month.')}
      </section>
      <section class="card">
        <h2>Glue</h2>
        ${c.glues.length ? html`<table class="table compact"><thead><tr><th>Glue</th><th class="num">Open</th><th class="num">In</th><th class="num">Out</th><th class="num">Adj.</th><th class="num">Close</th><th class="num">Expired at month end</th></tr></thead>
          <tbody>${c.glues.map((g) => html`<tr><td><strong>${g.code}</strong> ${g.name}</td><td class="num">${n(g.open)}</td><td class="num">${n(g.in)}</td><td class="num">${n(g.out)}</td><td class="num">${n(g.adj)}</td><td class="num"><strong>${n(g.close)}</strong></td><td class="num ${g.expired_at_close ? 'text-bad' : ''}">${n(g.expired_at_close)}</td></tr>`)}</tbody></table>`
          : emptyState('No glue stock or movements in this month.')}
      </section>`);
    const go = (m) => { closingMonth = m; this.render(main); };
    $('#prev', main).onclick = () => go(prev);
    $('#next', main).onclick = () => go(next);
    $('#month', main).onchange = (e) => { if (e.target.value) go(e.target.value); };
    $('#print', main).onclick = () => window.print();
    $('#csv', main).onclick = () => downloadCsv(`closing-${closingMonth}.csv`, c.slabs, [
      { label: 'Code', value: 'code' }, { label: 'Colour', value: 'name' }, { label: 'Open pcs', value: 'open_pcs' }, { label: 'In pcs', value: 'in_pcs' },
      { label: 'Out pcs', value: 'out_pcs' }, { label: 'Adj pcs', value: 'adj_pcs' }, { label: 'Close pcs', value: 'close_pcs' },
      { label: 'Open offcut m2', value: 'open_offcut_sqm' }, { label: 'New offcut m2', value: 'new_offcut_sqm' }, { label: 'Used offcut m2', value: 'used_offcut_sqm' },
      { label: 'Close offcut m2', value: 'close_offcut_sqm' }, { label: 'Sold m2', value: 'sold_sqm' }, { label: 'Sold full pcs', value: 'sold_full_pcs' },
      { label: 'Waste m2', value: 'waste_sqm' }, { label: 'Close total m2', value: 'close_sqm' }]);
    if ($('#close', main)) {
      $('#close', main).onclick = async () => {
        const ok = await modal({
          title: `Close ${monthLabel(closingMonth)}?`, submit: 'Close month',
          body: html`<p>The numbers on this page will be frozen and nobody can add, back-date or void movements in ${monthLabel(closingMonth)} any more. An admin can reopen the last closed month if needed.</p>`,
          onSubmit: () => api.post(`/api/closing/${closingMonth}/close`),
        });
        if (ok) { toast('Month closed'); this.render(main); }
      };
    }
    if ($('#reopen', main)) {
      $('#reopen', main).onclick = async () => {
        const ok = await modal({ title: `Reopen ${monthLabel(closingMonth)}?`, submit: 'Reopen', danger: true, body: html`<p>The frozen snapshot is removed and movements in this month can be changed again.</p>`, onSubmit: () => api.post(`/api/closing/${closingMonth}/reopen`) });
        if (ok) { toast('Month reopened'); this.render(main); }
      };
    }
  },
};
