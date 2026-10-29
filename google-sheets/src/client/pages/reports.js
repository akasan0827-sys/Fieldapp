import { api, state, can, host } from '../api.js';
import { t } from '../i18n.js';
import {
  html, $, $$, n, fmtDate, fmtDateTime, monthLabel, toast, modal, mountBarChart, emptyState, copyTable, addDays, addMonths,
} from '../ui.js';

const set = (el, h) => { el.innerHTML = String(h); };
const COPY = () => `⧉ ${t('Copy for Excel')}`;

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

const GROUP = { day: 'Per day', week: 'Per week', month: 'Per month' };
const UNIT = { day: 'Day', week: 'Week', month: 'Month' };
const PER = { day: 'm² sold per day', week: 'm² sold per week', month: 'm² sold per month' };

export const sales = {
  title: () => t('Sales report'),
  live: true,
  async render(main, { query }) {
    const today = state.me.today;
    if (query.group && !sf.from) {
      sf.group = query.group;
      sf.from = query.group === 'week' ? addDays(today, -55) : `${today.slice(0, 7)}-01`;
      if (query.group === 'day') { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; sf.from = addDays(today, -dow); }
    }
    if (!sf.from) { sf.from = addDays(today, -13); sf.to = today; }
    if (!sf.to) sf.to = today;
    const r = await api.get(`/api/reports/sales?from=${sf.from}&to=${sf.to}&group=${sf.group}`);
    const periodName = (p) => (sf.group === 'day' ? fmtDate(p.key) : sf.group === 'month' ? monthLabel(p.key) : p.label);
    set(main, html`
      <div class="toolbar wrap">
        <label class="inline">${t('From')} <input type="date" id="from" value="${sf.from}"></label>
        <label class="inline">${t('To')} <input type="date" id="to" value="${sf.to}"></label>
        <div class="seg-btns" role="group" aria-label="${t('Group by')}">
          ${['day', 'week', 'month'].map((g) => html`<button class="chip ${sf.group === g ? 'on' : ''}" data-group="${g}">${t(GROUP[g])}</button>`)}
        </div>
        <span class="spacer"></span>
        <select id="preset" aria-label="${t('Quick range')}"><option value="">${t('Quick range…')}</option>${presets(today).map(([l], i) => html`<option value="${i}">${t(l)}</option>`)}</select>
      </div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">${t('Sold')}</div><div class="tile-value">${n(r.total.sqm, 1)} <small>m²</small></div><div class="tile-sub">${fmtDate(r.from)} – ${fmtDate(r.to)}</div></div>
        <div class="tile"><div class="tile-label">${t('Deliveries')}</div><div class="tile-value">${n(r.total.deliveries)}</div><div class="tile-sub">${t('{n} customers', { n: r.by_customer.length })}</div></div>
        <div class="tile"><div class="tile-label">${t('Full slabs')}</div><div class="tile-value">${n(r.total.full_pcs)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('delivered uncut')}</div></div>
        <div class="tile"><div class="tile-label">${t('Cut / offcuts')}</div><div class="tile-value">${n(r.total.cut_sqm, 1)} <small>m²</small></div><div class="tile-sub">${t('sold by m²')}</div></div>
        <div class="tile"><div class="tile-label">${t('Glue')}</div><div class="tile-value">${n(r.total.glue)} <small>${t('pcs')}</small></div><div class="tile-sub">&nbsp;</div></div>
      </div>
      <section class="card">
        <div class="card-head"><h2>${t(PER[sf.group])}</h2><button class="btn btn-sm" id="copyP">${COPY()}</button></div>
        <div id="chart"></div>
        <details><summary class="small">${t('Show as table')}</summary>
          <table class="table compact"><thead><tr><th>${t(UNIT[sf.group])}</th><th class="num">${t('Deliveries')}</th><th class="num">${t('Full slabs')}</th><th class="num">${t('Cut m²')}</th><th class="num">${t('Total m²')}</th><th class="num">${t('Glue')}</th></tr></thead>
          <tbody>${r.periods.map((p) => html`<tr><td>${periodName(p)}</td><td class="num">${p.deliveries}</td><td class="num">${n(p.full_pcs)}</td><td class="num">${n(p.cut_sqm, 2)}</td><td class="num">${n(p.sqm, 2)}</td><td class="num">${n(p.glue)}</td></tr>`)}</tbody></table>
        </details>
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2>${t('By colour')}</h2><button class="btn btn-sm" id="copyC">${COPY()}</button></div>
          ${r.by_color.length ? html`<div class="table-wrap"><table class="table compact"><thead><tr><th>${t('Colour')}</th><th class="num">m²</th><th class="num">${t('Full slabs')}</th><th class="num">${t('Cut m²')}</th><th class="num">${t('Deliveries')}</th></tr></thead>
            <tbody>${r.by_color.map((c) => html`<tr><td><a href="#/stock/${c.slab_id}">${c.code}</a> ${c.name}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${n(c.cut_sqm, 2)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table></div>` : emptyState(t('No sales in this period.'))}
          ${r.by_glue.length ? html`<h3>${t('Glue')}</h3><table class="table compact"><thead><tr><th>${t('Glue')}</th><th class="num">${t('Qty')}</th><th class="num">${t('Deliveries')}</th></tr></thead>
            <tbody>${r.by_glue.map((g) => html`<tr><td>${g.code} ${g.name}</td><td class="num">${n(g.glue)}</td><td class="num">${g.deliveries}</td></tr>`)}</tbody></table>` : ''}
        </section>
        <section class="card">
          <div class="card-head"><h2>${t('By customer')}</h2><button class="btn btn-sm" id="copyU">${COPY()}</button></div>
          ${r.by_customer.length ? html`<div class="table-wrap"><table class="table compact"><thead><tr><th>${t('Customer')}</th><th class="num">m²</th><th class="num">${t('Full slabs')}</th><th class="num">${t('Glue')}</th><th class="num">${t('Deliveries')}</th></tr></thead>
            <tbody>${r.by_customer.map((c) => html`<tr><td>${c.name}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${n(c.glue)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table></div>` : emptyState(t('No sales in this period.'))}
          <h3>${t('By sales person')}</h3>
          ${r.by_sales.length ? html`<table class="table compact"><thead><tr><th>${t('Sales person')}</th><th class="num">m²</th><th class="num">${t('Deliveries')}</th></tr></thead>
            <tbody>${r.by_sales.map((c) => html`<tr><td>${c.name || t('(not entered)')}</td><td class="num">${n(c.sqm, 2)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>` : emptyState('–')}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h2>${t('Deliveries in this period')}</h2><button class="btn btn-sm" id="copyD">${COPY()}</button></div>
        ${r.deliveries.length ? html`<div class="table-wrap"><table class="table compact"><thead><tr><th>${t('Date')}</th><th>${t('No.')}</th><th>${t('Customer')}</th><th>${t('Delivered to')}</th><th>${t('Sales')}</th><th class="num">${t('Full slabs')}</th><th class="num">m²</th><th class="num">${t('Glue')}</th></tr></thead>
          <tbody>${r.deliveries.map((d) => html`<tr><td class="nowrap">${fmtDate(d.date)}</td><td><a href="#/doc/${d.doc_id}">${d.doc_no}</a></td><td>${d.customer_name}</td><td>${d.deliver_to}</td><td>${d.sales_person}</td>
            <td class="num">${n(d.full_pcs)}</td><td class="num">${n(d.sqm, 2)}</td><td class="num">${n(d.glue)}</td></tr>`)}</tbody></table></div>` : emptyState(t('No deliveries.'))}
      </section>`);
    mountBarChart($('#chart', main), r.periods.map((p) => ({
      label: periodName(p),
      short: sf.group === 'day' ? p.key.slice(5).replace('-', '/') : sf.group === 'month' ? p.key.slice(2).replace('-', '/') : p.label.split(' ')[0],
      value: p.sqm,
      tip: t('{d} deliveries · {f} full slabs · {c} m² cut · {g} glue', { d: p.deliveries, f: p.full_pcs, c: n(p.cut_sqm, 2), g: p.glue }),
    })), { height: 240, fmt: (v) => `${n(v, 2)} m²`, title: t(PER[sf.group]) });

    const reload = () => this.render(main, { query: {} });
    $('#from', main).onchange = (e) => { sf.from = e.target.value; reload(); };
    $('#to', main).onchange = (e) => { sf.to = e.target.value; reload(); };
    $$('[data-group]', main).forEach((b) => b.addEventListener('click', () => { sf.group = b.dataset.group; reload(); }));
    $('#preset', main).onchange = (e) => {
      const p = presets(today)[Number(e.target.value)];
      if (!p) return;
      [, sf.from, sf.to, sf.group] = p;
      reload();
    };
    $('#copyP', main).onclick = () => copyTable(r.periods, [
      { label: t(UNIT[sf.group]), value: (p) => (sf.group === 'week' ? `${p.key} (${p.label})` : p.key) }, { label: t('Deliveries'), value: 'deliveries' },
      { label: t('Full slabs'), value: 'full_pcs' }, { label: t('Cut m²'), value: 'cut_sqm' }, { label: t('Total m²'), value: 'sqm' }, { label: t('Glue'), value: 'glue' }]);
    $('#copyC', main).onclick = () => copyTable(r.by_color, [
      { label: t('Code'), value: 'code' }, { label: t('Colour'), value: 'name' }, { label: 'm²', value: 'sqm' }, { label: t('Full slabs'), value: 'full_pcs' },
      { label: t('Cut m²'), value: 'cut_sqm' }, { label: t('Deliveries'), value: 'deliveries' }]);
    $('#copyU', main).onclick = () => copyTable(r.by_customer, [
      { label: t('Customer'), value: 'name' }, { label: 'm²', value: 'sqm' }, { label: t('Full slabs'), value: 'full_pcs' }, { label: t('Glue'), value: 'glue' }, { label: t('Deliveries'), value: 'deliveries' }]);
    $('#copyD', main).onclick = () => copyTable(r.deliveries, [
      { label: t('Date'), value: 'date' }, { label: t('No.'), value: 'doc_no' }, { label: t('Customer'), value: 'customer_name' }, { label: t('Delivered to'), value: 'deliver_to' },
      { label: t('Sales person'), value: 'sales_person' }, { label: t('Full slabs'), value: 'full_pcs' }, { label: 'm²', value: 'sqm' }, { label: t('Glue'), value: 'glue' }]);
  },
};

// =====================================================================================
// Monthly closing
// =====================================================================================
let closingMonth = '';

export const closing = {
  title: () => t('Monthly closing'),
  live: true,
  async render(main) {
    const info = await api.get('/api/closing');
    const today = state.me.today;
    if (!closingMonth) closingMonth = addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const c = await api.get(`/api/closing/${closingMonth}`);
    const T = c.totals;
    const prev = addMonths(`${closingMonth}-01`, -1).slice(0, 7);
    const next = addMonths(`${closingMonth}-01`, 1).slice(0, 7);
    const ended = addMonths(`${closingMonth}-01`, 1) <= today;
    const nextToClose = info.closed_through ? addMonths(`${info.closed_through}-01`, 1).slice(0, 7) : null;
    const canClose = can.admin() && !c.closed && ended && (!nextToClose || nextToClose === closingMonth);
    const canReopen = can.admin() && c.closed && info.closed_through === closingMonth;
    const ml = monthLabel(closingMonth);
    set(main, html`
      <div class="toolbar wrap">
        <button class="btn" id="prev" aria-label="${t('Previous month')}">◀</button>
        <input type="month" id="month" value="${closingMonth}" aria-label="${t('Month')}">
        <button class="btn" id="next" aria-label="${t('Next month')}" ${next > today.slice(0, 7) ? 'disabled' : ''}>▶</button>
        <h2 class="inline-h">${ml}</h2>
        ${c.closed ? html`<span class="badge badge-good">🔒 ${t('Closed by {name} · {when}', { name: c.closed_by_name, when: fmtDateTime(c.closed_at) })}</span>` : html`<span class="badge badge-info">${ended ? t('Open') : t('Open — month not finished')}</span>`}
        <span class="spacer"></span>
        ${host.canPrint ? html`<button class="btn btn-sm" id="print">🖨 ${t('Print')}</button>` : ''}
        <button class="btn btn-sm" id="copy">${COPY()}</button>
        ${canClose ? html`<button class="btn btn-primary" id="close">${t('Close {month}', { month: ml })}</button>` : ''}
        ${canReopen ? html`<button class="btn btn-danger-outline" id="reopen">${t('Reopen')}</button>` : ''}
      </div>
      ${!c.closed && can.admin() && ended && nextToClose && nextToClose !== closingMonth ? html`<div class="alert alert-info">${t('Months are closed in order — close {month} first.', { month: monthLabel(nextToClose) })}</div>` : ''}
      <p class="muted small">${t('Closing a month freezes these numbers and blocks any new, back-dated or voided movement in that month.')} ${info.closed_through ? t('Closed through {month}.', { month: monthLabel(info.closed_through) }) : t('No month closed yet.')}</p>
      <div class="tiles">
        <div class="tile"><div class="tile-label">${t('Opening stock')}</div><div class="tile-value">${n(T.open_pcs)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('{n} m² incl. offcuts', { n: n(T.open_sqm, 1) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Received')}</div><div class="tile-value">+${n(T.in_pcs)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('{n} receipts', { n: n(c.doc_counts.inbound || 0) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Delivered')}</div><div class="tile-value">−${n(T.out_pcs)} <small>${t('pcs used')}</small></div><div class="tile-sub">${t('{s} m² sold · {d} deliveries', { s: n(T.sold_sqm, 1), d: n(c.doc_counts.outbound || 0) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Adjustments')}</div><div class="tile-value">${T.adj_pcs > 0 ? '+' : ''}${n(T.adj_pcs)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('waste {n} m²', { n: n(T.waste_sqm, 2) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Closing stock')}</div><div class="tile-value">${n(T.close_pcs)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('{a} m² · offcuts {o} m²', { a: n(T.close_sqm, 1), o: n(T.close_offcut_sqm, 1) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Glue')}</div><div class="tile-value">${n(T.glue_close)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('in {i} · out {o} · expired {e}', { i: n(T.glue_in), o: n(T.glue_out), e: n(T.glue_expired) })}</div></div>
      </div>
      <section class="card">
        <h2>${t('Slabs')}</h2>
        ${c.slabs.length ? html`<div class="table-wrap"><table class="table compact closing">
          <thead>
            <tr><th rowspan="2">${t('Colour')}</th><th colspan="5" class="grp">${t('Full slabs (pcs)')}</th><th colspan="4" class="grp">${t('Offcuts (m²)')}</th><th colspan="2" class="grp">${t('Sold')}</th><th rowspan="2" class="num">${t('Closing total m²')}</th></tr>
            <tr><th class="num">${t('Open')}</th><th class="num">${t('In')}</th><th class="num">${t('Out')}</th><th class="num">${t('Adj.')}</th><th class="num">${t('Close')}</th>
              <th class="num">${t('Open')}</th><th class="num">${t('New')}</th><th class="num">${t('Used')}</th><th class="num">${t('Close')}</th><th class="num">m²</th><th class="num">${t('Full pcs')}</th></tr>
          </thead>
          <tbody>${c.slabs.map((s) => html`<tr><td class="nowrap"><strong>${s.code}</strong> ${s.name}</td>
            <td class="num">${n(s.open_pcs)}</td><td class="num">${s.in_pcs ? `+${n(s.in_pcs)}` : '–'}</td><td class="num">${s.out_pcs ? `−${n(s.out_pcs)}` : '–'}</td>
            <td class="num">${s.adj_pcs ? (s.adj_pcs > 0 ? `+${s.adj_pcs}` : s.adj_pcs) : '–'}</td><td class="num"><strong>${n(s.close_pcs)}</strong></td>
            <td class="num">${n(s.open_offcut_sqm, 2)}</td><td class="num">${n(s.new_offcut_sqm, 2)}</td><td class="num">${n(s.used_offcut_sqm, 2)}</td><td class="num">${n(s.close_offcut_sqm, 2)}</td>
            <td class="num">${n(s.sold_sqm, 2)}</td><td class="num">${n(s.sold_full_pcs)}</td><td class="num"><strong>${n(s.close_sqm, 1)}</strong></td></tr>`)}</tbody>
          <tfoot><tr><td>${t('Total')}</td><td class="num">${n(T.open_pcs)}</td><td class="num">+${n(T.in_pcs)}</td><td class="num">−${n(T.out_pcs)}</td><td class="num">${n(T.adj_pcs)}</td><td class="num">${n(T.close_pcs)}</td>
            <td class="num">${n(T.open_offcut_sqm, 2)}</td><td class="num">${n(T.new_offcut_sqm, 2)}</td><td class="num">${n(T.used_offcut_sqm, 2)}</td><td class="num">${n(T.close_offcut_sqm, 2)}</td>
            <td class="num">${n(T.sold_sqm, 2)}</td><td class="num">${n(T.sold_full_pcs)}</td><td class="num">${n(T.close_sqm, 1)}</td></tr></tfoot>
        </table></div>` : emptyState(t('No slab stock or movements in this month.'))}
      </section>
      <section class="card">
        <h2>${t('Glue')}</h2>
        ${c.glues.length ? html`<div class="table-wrap"><table class="table compact"><thead><tr><th>${t('Glue')}</th><th class="num">${t('Open')}</th><th class="num">${t('In')}</th><th class="num">${t('Out')}</th><th class="num">${t('Adj.')}</th><th class="num">${t('Close')}</th><th class="num">${t('Expired at month end')}</th></tr></thead>
          <tbody>${c.glues.map((g) => html`<tr><td><strong>${g.code}</strong> ${g.name}</td><td class="num">${n(g.open)}</td><td class="num">${n(g.in)}</td><td class="num">${n(g.out)}</td><td class="num">${n(g.adj)}</td><td class="num"><strong>${n(g.close)}</strong></td><td class="num ${g.expired_at_close ? 'text-bad' : ''}">${n(g.expired_at_close)}</td></tr>`)}</tbody></table></div>`
          : emptyState(t('No glue stock or movements in this month.'))}
      </section>`);
    const show = (m) => { closingMonth = m; this.render(main); };
    $('#prev', main).onclick = () => show(prev);
    $('#next', main).onclick = () => show(next);
    $('#month', main).onchange = (e) => { if (e.target.value) show(e.target.value); };
    if ($('#print', main)) $('#print', main).onclick = () => window.print();
    $('#copy', main).onclick = () => copyTable(c.slabs, [
      { label: t('Code'), value: 'code' }, { label: t('Colour'), value: 'name' }, { label: t('Open pcs'), value: 'open_pcs' }, { label: t('In pcs'), value: 'in_pcs' },
      { label: t('Out pcs'), value: 'out_pcs' }, { label: t('Adj. pcs'), value: 'adj_pcs' }, { label: t('Close pcs'), value: 'close_pcs' },
      { label: t('Open offcut m²'), value: 'open_offcut_sqm' }, { label: t('New offcut m²'), value: 'new_offcut_sqm' }, { label: t('Used offcut m²'), value: 'used_offcut_sqm' },
      { label: t('Close offcut m²'), value: 'close_offcut_sqm' }, { label: t('Sold m²'), value: 'sold_sqm' }, { label: t('Sold full pcs'), value: 'sold_full_pcs' },
      { label: t('Waste m²'), value: 'waste_sqm' }, { label: t('Closing total m²'), value: 'close_sqm' }]);
    if ($('#close', main)) {
      $('#close', main).onclick = async () => {
        const ok = await modal({
          title: t('Close {month}?', { month: ml }), submit: t('Close month'),
          body: html`<p>${t('The numbers on this page will be frozen and nobody can add, back-date or void movements in {month} any more. An admin can reopen the last closed month if needed.', { month: ml })}</p>`,
          onSubmit: () => api.post(`/api/closing/${closingMonth}/close`),
        });
        if (ok) { toast(t('Month closed')); this.render(main); }
      };
    }
    if ($('#reopen', main)) {
      $('#reopen', main).onclick = async () => {
        const ok = await modal({ title: t('Reopen {month}?', { month: ml }), submit: t('Reopen'), danger: true, body: html`<p>${t('The frozen snapshot is removed and movements in this month can be changed again.')}</p>`, onSubmit: () => api.post(`/api/closing/${closingMonth}/reopen`) });
        if (ok) { toast(t('Month reopened')); this.render(main); }
      };
    }
  },
};
