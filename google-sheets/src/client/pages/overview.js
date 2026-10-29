import { api, state, loadRef, can } from '../api.js';
import { t } from '../i18n.js';
import {
  html, $, $$, n, sqm, fmtDate, relDays, badge, swatch, toast, modal, confirmBox, formData, options,
  mountBarChart, emptyState, addDays, copyTable, docType, bindRowLinks,
} from '../ui.js';
import { describeLine } from './docs.js';

const set = (el, h) => { el.innerHTML = String(h); };

// =====================================================================================
// Dashboard
// =====================================================================================
export const dashboard = {
  title: () => t('Dashboard'),
  live: true,
  async render(main) {
    const d = await api.get('/api/dashboard');
    const k = d.kpi;
    const edit = can.edit();
    const alertIcon = { red: '✕', amber: '▲', blue: '…' };
    set(main, html`
      <div class="actions-row">
        ${edit ? html`
          <a class="btn btn-primary" href="#/deliveries/new">+ ${t('New delivery')}</a>
          <a class="btn" href="#/receiving/new">+ ${t('Receive stock')}</a>
          <a class="btn" href="#/adjust">± ${t('Adjust / move')}</a>` : ''}
        <button class="btn ${edit ? '' : 'btn-primary'}" id="lockBtn">🔒 ${edit ? t('Lock stock') : t('Request a lock')}</button>
        <a class="btn" href="#/stock">${t('Check stock')}</a>
      </div>

      <div class="tiles">
        <a class="tile" href="#/stock">
          <div class="tile-label">${t('Available slabs')}</div>
          <div class="tile-value">${n(k.available)} <small>${t('pcs')}</small></div>
          <div class="tile-sub">${t('{a} on hand · {b} locked', { a: n(k.on_hand), b: n(k.locked) })}</div>
        </a>
        <a class="tile" href="#/stock">
          <div class="tile-label">${t('Total stock')}</div>
          <div class="tile-value">${n(k.total_sqm, 0)} <small>m²</small></div>
          <div class="tile-sub">${t('{c} colours · {n} offcuts = {sqm}', { c: k.colors, n: n(k.remnant_count), sqm: sqm(k.remnant_sqm) })}</div>
        </a>
        <a class="tile" href="#/receiving">
          <div class="tile-label">${t('Incoming')}</div>
          <div class="tile-value">${n(k.incoming_pcs)} <small>${t('pcs')}</small></div>
          <div class="tile-sub">${t('{n} shipments', { n: d.incoming.length })}${d.incoming[0]?.eta ? ` · ${t('next ETA {date}', { date: fmtDate(d.incoming[0].eta) })}` : ''}</div>
        </a>
        <a class="tile" href="#/glue">
          <div class="tile-label">${t('Glue (usable)')}</div>
          <div class="tile-value">${n(k.glue_usable)} <small>${t('pcs')}</small></div>
          <div class="tile-sub ${k.glue_expired ? 'text-bad' : ''}">${t('{a} expiring soon · {b} expired', { a: n(k.glue_expiring), b: n(k.glue_expired) })}</div>
        </a>
        <a class="tile" href="#/reports/sales?group=day">
          <div class="tile-label">${t('Sold this week')}</div>
          <div class="tile-value">${n(d.sales_week.sqm, 1)} <small>m²</small></div>
          <div class="tile-sub">${t('{a} deliveries · {b} full slabs', { a: d.sales_week.deliveries, b: n(d.sales_week.full_pcs) })}</div>
        </a>
        <a class="tile" href="#/reports/sales?group=week">
          <div class="tile-label">${t('Sold this month')}</div>
          <div class="tile-value">${n(d.sales_month.sqm, 1)} <small>m²</small></div>
          <div class="tile-sub">${t('{a} deliveries · {b} glue', { a: d.sales_month.deliveries, b: n(d.sales_month.glue) })}</div>
        </a>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2>${t('Needs attention')} <span class="count">${d.alerts.length}</span></h2>
          ${d.alerts.length ? html`<ul class="alerts">${d.alerts.slice(0, 14).map((a) => html`
            <li class="alert-${a.level}"><span class="alert-icon" aria-hidden="true">${alertIcon[a.level]}</span><a href="#${a.link}">${t(a.text, a.params.date ? { ...a.params, date: fmtDate(a.params.date) } : a.params)}</a></li>`)}</ul>
            ${d.alerts.length > 14 ? html`<p class="muted small">${t('+ {n} more', { n: d.alerts.length - 14 })}</p>` : ''}`
            : emptyState(t('All good — nothing needs attention.'))}
        </section>
        <section class="card">
          <h2>${t('Sold per day — last 14 days (m²)')}</h2>
          <div id="salesChart"></div>
          <h3>${t('Top colours, last 30 days')}</h3>
          ${d.top_colors_30d.length ? html`<table class="table compact">
            <thead><tr><th>${t('Colour')}</th><th class="num">m²</th><th class="num">${t('Full slabs')}</th><th class="num">${t('Deliveries')}</th></tr></thead>
            <tbody>${d.top_colors_30d.map((c) => html`<tr><td><a href="#/stock/${c.slab_id}">${c.code}</a> ${c.name}</td>
              <td class="num">${n(c.sqm, 1)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>`
            : emptyState(t('No deliveries in the last 30 days.'))}
        </section>
      </div>

      <section class="card">
        <h2>${t('Incoming shipments')}</h2>
        ${d.incoming.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>${t('ETA')}</th><th>${t('Shipment')}</th><th>${t('Supplier')}</th><th>${t('Reference')}</th><th>${t('Status')}</th><th class="num">${t('Slabs')}</th><th class="num">${t('Glue')}</th></tr></thead>
          <tbody>${d.incoming.map((s) => html`<tr class="clickable" data-href="/doc/${s.id}">
            <td>${s.eta ? html`${fmtDate(s.eta)} <span class="muted small">${relDays(s.eta, d.today)}</span>` : html`<span class="muted">${t('not set')}</span>`}</td>
            <td><a href="#/doc/${s.id}">${s.doc_no}</a></td><td>${s.partner}</td><td>${s.reference}</td>
            <td>${badge(s.ship_status)}</td><td class="num">${n(s.slab_pcs)}</td><td class="num">${n(s.glue_qty)}</td></tr>`)}</tbody></table></div>`
          : emptyState(t('No incoming shipments registered.'))}
      </section>`);
    mountBarChart($('#salesChart', main), d.sales_14d.map((p) => ({
      label: fmtDate(p.key), short: p.key.slice(8), value: p.sqm,
      tip: t('{a} deliveries · {b} full slabs', { a: p.deliveries, b: p.full_pcs }),
    })), { height: 200, fmt: (v) => `${n(v, 2)} m²`, title: t('Sold per day — last 14 days (m²)') });
    $('#lockBtn', main).onclick = () => lockModal();
    bindRowLinks(main);
  },
};

// =====================================================================================
// Stock list (live view for sales)
// =====================================================================================
const stockFilter = { q: '', show: 'all' };

export const stockList = {
  title: () => t('Slab stock'),
  live: true,
  async render(main) {
    const { rows } = await api.get('/api/stock');
    set(main, html`
      <div class="toolbar">
        <input type="search" id="q" placeholder="${t('Search colour code or name…')}" value="${stockFilter.q}" aria-label="${t('Search')}">
        <div class="chips" role="group" aria-label="${t('Filter')}">
          ${[['all', 'All'], ['available', 'In stock'], ['low', 'Low / out'], ['locked', 'Locked'], ['offcuts', 'Has offcuts'], ['incoming', 'Incoming']]
            .map(([v, l]) => html`<button class="chip ${stockFilter.show === v ? 'on' : ''}" data-show="${v}">${t(l)}</button>`)}
        </div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="copy">⧉ ${t('Copy for Excel')}</button>
      </div>
      <div id="stockTable"></div>
      <p class="muted small">${t('Available = on hand − locked for customers. Total m² includes offcuts. Sold/month = average of the last 90 days.')}</p>`);
    const draw = () => {
      const q = stockFilter.q.trim().toLowerCase();
      const list = rows.filter((r) => {
        if (q && !`${r.code} ${r.name}`.toLowerCase().includes(q)) return false;
        switch (stockFilter.show) {
          case 'available': return r.available > 0;
          case 'low': return ['low', 'out', 'overlocked'].includes(r.status);
          case 'locked': return r.locked > 0 || r.pending_lock > 0;
          case 'offcuts': return r.remnant_count > 0;
          case 'incoming': return r.incoming > 0;
          default: return true;
        }
      });
      const tot = (key) => list.reduce((a, r) => a + (r[key] || 0), 0);
      set($('#stockTable', main), list.length ? html`
        <div class="table-wrap"><table class="table sticky-first">
          <thead><tr>
            <th>${t('Colour')}</th><th class="num">${t('Available')}</th><th class="num">${t('On hand')}</th><th class="num">${t('Locked')}</th>
            <th class="num">${t('Offcuts')}</th><th class="num">${t('Total m²')}</th><th>${t('Incoming')}</th><th class="num">${t('Sold / month')}</th><th>${t('Status')}</th>
          </tr></thead>
          <tbody>${list.map((r) => html`<tr class="clickable" data-href="/stock/${r.id}">
            <td class="nowrap">${swatch(r.color_hex)}<a href="#/stock/${r.id}"><strong>${r.code}</strong></a> ${r.name}</td>
            <td class="num big ${r.available < 0 ? 'text-bad' : ''}">${n(r.available)}</td>
            <td class="num">${n(r.on_hand)}</td>
            <td class="num">${r.locked ? n(r.locked) : html`<span class="muted">0</span>`}${r.pending_lock ? html` <span class="muted small" title="${t('Pending lock requests')}">(+${r.pending_lock}?)</span>` : ''}</td>
            <td class="num">${r.remnant_count ? html`${r.remnant_count} · ${n(r.remnant_sqm, 2)} m²` : html`<span class="muted">–</span>`}</td>
            <td class="num">${n(r.total_sqm, 1)}</td>
            <td class="nowrap">${r.incoming ? html`+${n(r.incoming)} ${r.next_eta ? html`<span class="muted small">${t('ETA')} ${fmtDate(r.next_eta)}</span>` : ''}` : html`<span class="muted">–</span>`}</td>
            <td class="num">${r.avg_month_sqm ? html`${n(r.avg_month_sqm, 1)} m²` : html`<span class="muted">–</span>`}</td>
            <td>${badge(r.status)}</td>
          </tr>`)}</tbody>
          <tfoot><tr><td>${t('{n} colours', { n: list.length })}</td><td class="num">${n(tot('available'))}</td><td class="num">${n(tot('on_hand'))}</td>
            <td class="num">${n(tot('locked'))}</td><td class="num">${n(tot('remnant_sqm'), 2)} m²</td><td class="num">${n(tot('total_sqm'), 1)}</td>
            <td>+${n(tot('incoming'))}</td><td class="num">${n(tot('avg_month_sqm'), 1)} m²</td><td></td></tr></tfoot>
        </table></div>` : emptyState(rows.length ? t('No colours match the filter.') : t('No slab colours yet. Add them under Setup → Slab colours.')));
      bindRowLinks(main);
    };
    draw();
    $('#q', main).addEventListener('input', (e) => { stockFilter.q = e.target.value; draw(); });
    $$('.chip', main).forEach((b) => b.addEventListener('click', () => {
      stockFilter.show = b.dataset.show;
      $$('.chip', main).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }));
    $('#copy', main).onclick = () => copyTable(rows, [
      { label: t('Code'), value: 'code' }, { label: t('Colour'), value: 'name' }, { label: t('Available'), value: 'available' },
      { label: t('On hand'), value: 'on_hand' }, { label: t('Locked'), value: 'locked' }, { label: t('Offcuts'), value: 'remnant_count' },
      { label: `${t('Offcuts')} m²`, value: 'remnant_sqm' }, { label: t('Total m²'), value: 'total_sqm' }, { label: t('Incoming'), value: 'incoming' },
      { label: t('Next ETA'), value: 'next_eta' }, { label: t('Sold / month'), value: 'avg_month_sqm' }, { label: t('Status'), value: (r) => t({ ok: 'OK', low: 'Low', out: 'Out of stock', overlocked: 'Over-locked' }[r.status]) },
      { label: t('Racks'), value: (r) => r.locations.map((l) => `${l.location_code}:${l.qty}`).join(' ') },
    ]);
  },
};

// =====================================================================================
// Colour detail
// =====================================================================================
export const stockDetail = {
  title: () => t('Colour detail'),
  live: true,
  async render(main, { params }) {
    const d = await api.get(`/api/stock/${params.id}`);
    const s = d.stock || { on_hand: 0, locked: 0, available: 0, remnant_sqm: 0, remnant_count: 0, total_sqm: 0, incoming: 0, locations: [], status: 'out' };
    const sl = d.slab;
    $('#pageTitle').textContent = `${sl.code} ${sl.name}`;
    set(main, html`
      <div class="detail-head">
        <div class="swatch-lg" style="background:${sl.color_hex || 'transparent'}"></div>
        <div>
          <h2 class="h-xl">${sl.code} · ${sl.name} ${badge(s.status)}</h2>
          <div class="muted">${n(sl.thickness_mm)} × ${n(sl.width_mm)} × ${n(sl.length_mm)} mm · ${t('{sqm} m² per slab', { sqm: n(sl.area, 3) })}${sl.min_pcs ? ` · ${t('minimum {n} pcs', { n: sl.min_pcs })}` : ''}${sl.active ? '' : ` · ${t('inactive')}`}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn" id="lockBtn">🔒 ${can.edit() ? t('Lock for customer') : t('Request a lock')}</button>
        ${can.edit() ? html`<a class="btn btn-primary" href="#/deliveries/new?slab=${sl.id}">+ ${t('Deliver')}</a>` : ''}
      </div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">${t('Available')}</div><div class="tile-value ${s.available < 0 ? 'text-bad' : ''}">${n(s.available)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('free to sell')}</div></div>
        <div class="tile"><div class="tile-label">${t('On hand')}</div><div class="tile-value">${n(s.on_hand)} <small>${t('pcs')}</small></div><div class="tile-sub">${t('{n} locked', { n: n(s.locked) })}</div></div>
        <div class="tile"><div class="tile-label">${t('Offcuts')}</div><div class="tile-value">${n(s.remnant_sqm, 2)} <small>m²</small></div><div class="tile-sub">${t('{n} pieces', { n: s.remnant_count })}</div></div>
        <div class="tile"><div class="tile-label">${t('Total')}</div><div class="tile-value">${n(s.total_sqm, 1)} <small>m²</small></div><div class="tile-sub">${s.months_cover ? t('≈ {n} months of sales', { n: n(s.months_cover, 1) }) : t('slabs + offcuts')}</div></div>
        <div class="tile"><div class="tile-label">${t('Incoming')}</div><div class="tile-value">${n(s.incoming)} <small>${t('pcs')}</small></div><div class="tile-sub">${s.next_eta ? t('next ETA {date}', { date: fmtDate(s.next_eta) }) : t('nothing ordered')}</div></div>
      </div>
      <div class="grid-2">
        <section class="card">
          <h2>${t('Full slabs by rack')}</h2>
          ${s.locations.length ? html`<table class="table compact"><thead><tr><th>${t('Rack')}</th><th class="num">${t('Pieces')}</th><th class="num">m²</th></tr></thead>
            <tbody>${s.locations.map((l) => html`<tr><td>${l.location_code}</td><td class="num">${n(l.qty)}</td><td class="num">${n(l.qty * sl.area, 2)}</td></tr>`)}</tbody></table>`
            : emptyState(t('No full slabs in stock.'))}
          <h2>${t('Offcuts')}</h2>
          ${d.remnants.length ? html`<table class="table compact"><thead><tr><th>${t('Offcut')}</th><th class="num">m²</th><th>${t('Size (mm)')}</th><th>${t('Rack')}</th><th>${t('Since')}</th></tr></thead>
            <tbody>${d.remnants.map((r) => html`<tr><td>${r.code}</td><td class="num">${n(r.sqm, 2)}</td>
              <td>${r.width_mm && r.length_mm ? `${n(r.width_mm)} × ${n(r.length_mm)}` : '–'}</td><td>${r.location_code || '–'}</td><td>${fmtDate(r.created_date)}</td></tr>`)}</tbody></table>`
            : emptyState(t('No offcuts of this colour.'))}
        </section>
        <section class="card">
          <h2>${t('Locks')}</h2>
          ${d.locks.length ? html`<table class="table compact"><thead><tr><th>${t('Customer')}</th><th class="num">${t('Left')}</th><th>${t('Until')}</th><th>${t('Status')}</th></tr></thead>
            <tbody>${d.locks.map((k) => html`<tr><td>${k.key_account ? '★ ' : ''}${k.customer_name}${k.note ? html`<div class="muted small">${k.note}</div>` : ''}</td>
              <td class="num">${k.state === 'pending' ? k.pcs : k.remaining}</td><td>${k.expires_on ? fmtDate(k.expires_on) : t('no expiry')}</td><td>${badge(k.state)}</td></tr>`)}</tbody></table>`
            : emptyState(t('No locks.'))}
          <h2>${t('Incoming')}</h2>
          ${d.incoming.length ? html`<table class="table compact"><thead><tr><th>${t('Shipment')}</th><th>${t('ETA')}</th><th>${t('Status')}</th><th class="num">${t('pcs')}</th></tr></thead>
            <tbody>${d.incoming.map((i) => html`<tr><td><a href="#/doc/${i.id}">${i.doc_no}</a> <span class="muted small">${i.reference}</span></td>
              <td>${i.eta ? fmtDate(i.eta) : '–'}</td><td>${badge(i.ship_status)}</td><td class="num">${n(i.qty)}</td></tr>`)}</tbody></table>`
            : emptyState(t('Nothing incoming.'))}
          <h2>${t('Matching glue')}</h2>
          ${d.glues.length ? html`<table class="table compact"><thead><tr><th>${t('Glue')}</th><th class="num">${t('Usable')}</th><th>${t('Next expiry')}</th></tr></thead>
            <tbody>${d.glues.map((g) => html`<tr><td>${g.code} ${g.name}</td><td class="num">${n(g.usable)} ${g.unit}</td><td>${g.next_expiry ? fmtDate(g.next_expiry) : '–'}</td></tr>`)}</tbody></table>`
            : emptyState(t('No glue linked to this colour (Setup → Glue products).'))}
        </section>
      </div>
      <section class="card">
        <h2>${t('Sold per month (m²)')}</h2>
        <div id="monthChart"></div>
      </section>
      <section class="card">
        <h2>${t('Recent movements')}</h2>
        ${d.history.length ? html`<div class="table-wrap"><table class="table compact">
          <thead><tr><th>${t('Date')}</th><th>${t('Document')}</th><th>${t('Type')}</th><th>${t('What')}</th><th>${t('Customer / supplier')}</th><th>${t('Delivered to')}</th></tr></thead>
          <tbody>${d.history.map((h) => html`<tr><td class="nowrap">${fmtDate(h.date)}</td><td class="nowrap"><a href="#/doc/${h.doc_id}">${h.doc_no}</a></td>
            <td>${docType(h.type)}</td><td>${describeLine(h)}</td><td>${h.customer_name || h.partner || t(h.reason)}</td><td>${h.deliver_to}</td></tr>`)}</tbody></table></div>`
          : emptyState(t('No movements yet.'))}
      </section>`);
    mountBarChart($('#monthChart', main), d.monthly.map((m) => ({
      label: m.key, short: m.key.slice(2).replace('-', '/'), value: m.sqm, tip: t('{a} full slabs · {b} m² cut', { a: m.full_pcs, b: n(m.cut_sqm, 2) }),
    })), { height: 180, fmt: (v) => `${n(v, 2)} m²`, title: t('Sold per month (m²)') });
    $('#lockBtn', main).onclick = () => lockModal({ slabId: sl.id });
  },
};

// =====================================================================================
// Lock modal (create directly for SCM/admin, request for sales)
// =====================================================================================
export async function lockModal({ slabId = '', customerId = '' } = {}) {
  const ref = await loadRef(true);
  const { rows } = await api.get('/api/stock');
  const direct = can.edit();
  const days = Number(ref.settings.lock_default_days) || 14;
  const freeText = (sid) => {
    const r = rows.find((x) => String(x.id) === String(sid));
    if (!r) return '';
    let s = t('Free now: {n} pcs', { n: Math.max(0, r.available) });
    if (r.incoming) s += ` (+${t('{n} incoming', { n: r.incoming })}${r.next_eta ? `, ${t('ETA')} ${fmtDate(r.next_eta)}` : ''})`;
    return s;
  };
  const saved = await modal({
    title: direct ? t('Lock stock for a customer') : t('Request a stock lock'),
    submit: direct ? t('Lock') : t('Send request'),
    body: html`
      ${direct ? '' : html`<p class="muted">${t('SCM will approve the request. Until then the stock is not reserved.')}</p>`}
      <label>${t('Customer')}
        <select name="customer_id">${options(ref.customers.filter((c) => c.active), customerId, { empty: t('— choose —'), label: (c) => `${c.key_account ? '★ ' : ''}${c.name}` })}</select>
      </label>
      <label>${t('…or new customer')} <input name="new_customer" placeholder="${t('Name of a new customer')}"></label>
      <label>${t('Slab colour')}
        <select name="slab_id" id="lkSlab">${options(ref.slabs.filter((s) => s.active), slabId, { empty: t('— choose —'), label: (s) => `${s.code} ${s.name}` })}</select>
      </label>
      <p class="hint" id="lkFree">${freeText(slabId)}</p>
      <div class="row-2">
        <label>${t('Pieces')} <input name="pcs" type="number" min="1" step="1" required></label>
        <label>${t('Lock until')} <input name="expires_on" type="date" value="${addDays(state.me.today, days)}"></label>
      </div>
      <label>${t('Note (project, reason)')} <input name="note" maxlength="500"></label>`,
    onOpen: (f) => { $('#lkSlab', f).onchange = (e) => { $('#lkFree', f).textContent = freeText(e.target.value); }; },
    async onSubmit(f) {
      const v = formData(f);
      let cid = v.customer_id;
      if (v.new_customer.trim()) cid = (await api.post('/api/customers', { name: v.new_customer.trim() })).id;
      if (!cid) throw new Error(t('Choose a customer'));
      return api.post('/api/locks', { customer_id: cid, slab_id: v.slab_id, pcs: v.pcs, expires_on: v.expires_on, note: v.note });
    },
  });
  if (saved) {
    toast(direct ? t('Stock locked') : t('Lock request sent to SCM'));
    window.dispatchEvent(new Event('app:refresh'));
  }
}

// =====================================================================================
// Locks
// =====================================================================================
let lockTab = 'active';
export const locks = {
  title: () => t('Locks'),
  live: true,
  async render(main) {
    const all = await api.get('/api/locks');
    const me = state.me.user;
    const edit = can.edit();
    const tabs = [
      ['active', 'Active', (k) => k.state === 'active'],
      ['pending', 'Waiting approval', (k) => k.state === 'pending'],
      ['expired', 'Expired', (k) => k.state === 'expired'],
      ['closed', 'Closed', (k) => ['fulfilled', 'released', 'rejected'].includes(k.state)],
    ];
    const cur = tabs.find((x) => x[0] === lockTab) || tabs[0];
    const list = all.filter(cur[2]);
    set(main, html`
      <div class="toolbar">
        <div class="tabs">${tabs.map(([key, label, f]) => html`<button class="tab ${key === cur[0] ? 'on' : ''}" data-tab="${key}">${t(label)} <span class="count">${all.filter(f).length}</span></button>`)}</div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="newLock">🔒 ${edit ? t('New lock') : t('Request a lock')}</button>
      </div>
      <p class="muted small">${t("Locked stock is reserved for that customer: other deliveries can't use it. When delivering, pick the lock on the delivery line and it is reduced automatically.")}</p>
      ${list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>${t('Customer')}</th><th>${t('Colour')}</th><th class="num">${t('Locked')}</th><th class="num">${t('Delivered')}</th><th class="num">${t('Left')}</th><th>${t('Lock until')}</th><th>${t('Status')}</th><th>${t('Requested by')}</th><th></th></tr></thead>
        <tbody>${list.map((k) => html`<tr>
          <td>${k.id}</td>
          <td>${k.key_account ? html`<span title="${t('Key account')}">★</span> ` : ''}${k.customer_name}${k.note ? html`<div class="muted small">${k.note}</div>` : ''}</td>
          <td class="nowrap"><a href="#/stock/${k.slab_id}">${k.slab_code}</a> ${k.slab_name}</td>
          <td class="num">${n(k.pcs)}</td><td class="num">${n(k.fulfilled)}</td><td class="num"><strong>${n(k.remaining)}</strong></td>
          <td class="nowrap">${k.expires_on ? html`${fmtDate(k.expires_on)} <span class="muted small">${relDays(k.expires_on, state.me.today)}</span>` : t('no expiry')}</td>
          <td>${badge(k.state)}${k.decision_note ? html`<div class="muted small">${t(k.decision_note)}</div>` : ''}</td>
          <td>${k.requested_by_name}<div class="muted small">${fmtDate(k.created_at)}</div></td>
          <td class="nowrap actions">
            ${k.state === 'pending' && edit ? html`<button class="btn btn-sm btn-primary" data-act="approve" data-id="${k.id}">${t('Approve')}</button>
              <button class="btn btn-sm" data-act="reject" data-id="${k.id}">${t('Reject')}</button>` : ''}
            ${k.state === 'pending' && !edit && k.requested_by === me.id ? html`<button class="btn btn-sm" data-act="release" data-id="${k.id}">${t('Cancel')}</button>` : ''}
            ${['active', 'expired'].includes(k.state) && edit ? html`<button class="btn btn-sm" data-act="update" data-id="${k.id}">${t('Change')}</button>
              <button class="btn btn-sm" data-act="release" data-id="${k.id}">${t('Release')}</button>` : ''}
          </td></tr>`)}</tbody></table></div>` : emptyState(t('No locks here.'))}`);
    $$('.tab', main).forEach((b) => b.addEventListener('click', () => { lockTab = b.dataset.tab; this.render(main); }));
    $('#newLock', main).onclick = () => lockModal();
    $$('[data-act]', main).forEach((b) => b.addEventListener('click', async () => {
      const k = all.find((x) => x.id === Number(b.dataset.id));
      const act = b.dataset.act;
      let ok;
      if (act === 'update') {
        ok = await modal({
          title: t('Change lock #{id}', { id: k.id }),
          body: html`<p>${k.customer_name} · ${k.slab_code} ${k.slab_name} · ${t('{n} pcs already delivered', { n: k.fulfilled })}</p>
            <div class="row-2"><label>${t('Pieces')} <input name="pcs" type="number" min="1" value="${k.pcs}"></label>
            <label>${t('Lock until')} <input name="expires_on" type="date" value="${k.expires_on || ''}"></label></div>
            <label>${t('Note')} <input name="note" value="${k.note}"></label>`,
          onSubmit: (f) => api.post(`/api/locks/${k.id}/update`, formData(f)),
        });
      } else {
        const label = { approve: t('Approve'), reject: t('Reject'), release: k.state === 'pending' ? t('Cancel request') : t('Release') }[act];
        ok = await modal({
          title: `${label} · ${t('Lock')} #${k.id}`,
          submit: label,
          danger: act !== 'approve',
          body: html`<p>${k.customer_name} · ${k.pcs} ${t('pcs')} ${k.slab_code} ${k.slab_name}${k.expires_on ? ` · ${t('until {date}', { date: fmtDate(k.expires_on) })}` : ''}</p>
            ${act === 'release' && k.remaining ? html`<p>${t('{n} pcs will become free to sell again.', { n: k.remaining })}</p>` : ''}
            <label>${t('Note (optional)')} <input name="note"></label>`,
          onSubmit: (f) => api.post(`/api/locks/${k.id}/${act}`, formData(f)),
        });
      }
      if (ok) { toast(t('Saved')); this.render(main); }
    }));
  },
};

// =====================================================================================
// Offcuts
// =====================================================================================
const offFilter = { slab: '', rack: '', min: '' };
export const offcuts = {
  title: () => t('Offcuts (partial slabs)'),
  live: true,
  async render(main) {
    const ref = await loadRef();
    const rems = await api.get('/api/remnants');
    const edit = can.edit();
    set(main, html`
      <div class="toolbar">
        <select id="fSlab" aria-label="${t('Colour')}">${options(ref.slabs, offFilter.slab, { empty: t('All colours'), label: (s) => `${s.code} ${s.name}` })}</select>
        <select id="fRack" aria-label="${t('Rack')}">${options(ref.locations, offFilter.rack, { empty: t('All racks'), label: (l) => l.code })}</select>
        <input id="fMin" type="number" step="0.1" min="0" placeholder="${t('Min m²')}" value="${offFilter.min}" aria-label="${t('Min m²')}" class="w-sm">
        <span class="spacer"></span>
        ${edit ? html`<a class="btn" href="#/adjust?tab=adjust&add=remnant_in">+ ${t('Register offcut')}</a>` : ''}
      </div>
      <div id="offTable"></div>
      <p class="muted small">${t('Offcuts are created automatically when a slab is cut for a delivery by m² and the rest goes back to the rack.')}</p>`);
    const draw = () => {
      const list = rems.filter((r) => (!offFilter.slab || String(r.slab_id) === offFilter.slab)
        && (!offFilter.rack || String(r.location_id) === offFilter.rack) && (!offFilter.min || r.sqm >= Number(offFilter.min)));
      const total = list.reduce((a, r) => a + r.sqm, 0);
      set($('#offTable', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Offcut')}</th><th>${t('Colour')}</th><th class="num">m²</th><th>${t('Size (mm)')}</th><th>${t('Rack')}</th><th>${t('Since')}</th><th>${t('From')}</th>${edit ? html`<th></th>` : ''}</tr></thead>
        <tbody>${list.map((r) => html`<tr>
          <td><strong>${r.code}</strong>${r.note ? html`<div class="muted small">${r.note}</div>` : ''}</td>
          <td class="nowrap"><a href="#/stock/${r.slab_id}">${r.slab_code}</a> ${r.slab_name}</td>
          <td class="num">${n(r.sqm, 2)}</td>
          <td>${r.width_mm && r.length_mm ? `${n(r.width_mm)} × ${n(r.length_mm)}` : '–'}</td>
          <td>${r.location_code || '–'}</td>
          <td class="nowrap">${fmtDate(r.created_date)} <span class="muted small">${relDays(r.created_date, state.me.today)}</span></td>
          <td><a href="#/doc/${r.created_doc_id}">${r.created_doc_no}</a></td>
          ${edit ? html`<td class="nowrap actions"><button class="btn btn-sm" data-move="${r.id}">${t('Move')}</button> <button class="btn btn-sm" data-scrap="${r.id}">${t('Scrap')}</button></td>` : ''}
        </tr>`)}</tbody>
        <tfoot><tr><td>${t('{n} offcuts', { n: list.length })}</td><td></td><td class="num">${n(total, 2)}</td><td colspan="${edit ? 5 : 4}"></td></tr></tfoot>
      </table></div>` : emptyState(t('No offcuts match.')));
      $$('[data-move]', main).forEach((b) => b.addEventListener('click', async () => {
        const r = rems.find((x) => x.id === Number(b.dataset.move));
        const ok = await modal({
          title: t('Move offcut {code}', { code: r.code }),
          body: html`<label>${t('New rack')} <select name="to">${options(ref.locations.filter((l) => l.active && l.id !== r.location_id), '', { empty: t('— choose —'), label: (l) => l.code })}</select></label>`,
          onSubmit: (f) => api.post('/api/docs', { type: 'transfer', lines: [{ kind: 'remnant_move', remnant_id: r.id, to_location_id: formData(f).to }] }),
        });
        if (ok) { toast(t('Offcut moved')); this.render(main); }
      }));
      $$('[data-scrap]', main).forEach((b) => b.addEventListener('click', async () => {
        const r = rems.find((x) => x.id === Number(b.dataset.scrap));
        const ok = await modal({
          title: t('Scrap offcut {code}', { code: r.code }), submit: t('Scrap'), danger: true,
          body: html`<p>${t('{code} {name} · {sqm} m² will be removed from stock as waste.', { code: r.slab_code, name: r.slab_name, sqm: n(r.sqm, 2) })}</p><label>${t('Reason')} <input name="note" placeholder="${t('e.g. broken, too small')}"></label>`,
          onSubmit: (f) => api.post('/api/docs', { type: 'adjust', reason: 'Offcut scrapped', note: formData(f).note, lines: [{ kind: 'remnant_scrap', remnant_id: r.id }] }),
        });
        if (ok) { toast(t('Offcut scrapped')); this.render(main); }
      }));
    };
    draw();
    $('#fSlab', main).onchange = (e) => { offFilter.slab = e.target.value; draw(); };
    $('#fRack', main).onchange = (e) => { offFilter.rack = e.target.value; draw(); };
    $('#fMin', main).oninput = (e) => { offFilter.min = e.target.value; draw(); };
  },
};

// =====================================================================================
// Glue
// =====================================================================================
let glueSlab = '';
export const glue = {
  title: () => t('Glue stock'),
  live: true,
  async render(main) {
    const ref = await loadRef();
    const glues = await api.get('/api/glue');
    const edit = can.edit();
    set(main, html`
      <div class="toolbar">
        <label class="inline">${t('Glue for colour')}
          <select id="gSlab">${options(ref.slabs, glueSlab, { empty: t('All colours'), label: (s) => `${s.code} ${s.name}` })}</select></label>
        <span class="spacer"></span>
        ${edit ? html`<a class="btn" href="#/receiving/new">+ ${t('Receive glue')}</a>` : ''}
      </div>
      <div id="glueList"></div>
      <p class="muted small">${t('Deliveries take glue first-expiry-first-out and never use expired lots. Lots expiring within {n} days are flagged.', { n: ref.settings.expiry_warn_days })}</p>`);
    const draw = () => {
      const list = glues.filter((g) => !glueSlab || g.matches.some((m) => String(m.id) === glueSlab));
      set($('#glueList', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Glue')}</th><th>${t('For colours')}</th><th class="num">${t('Usable')}</th><th class="num">${t('Expiring')}</th><th class="num">${t('Expired')}</th><th>${t('Lots (lot · expiry · qty)')}</th><th>${t('Status')}</th></tr></thead>
        <tbody>${list.map((g) => html`<tr>
          <td><strong>${g.code}</strong> ${g.name}${g.color ? html`<div class="muted small">${g.color} · ${t('shelf life {n} months', { n: g.shelf_life_months })}</div>` : ''}</td>
          <td class="small">${g.matches.length ? g.matches.map((m, i) => html`${i ? ', ' : ''}<a href="#/stock/${m.id}">${m.code}</a>`) : html`<span class="muted">–</span>`}</td>
          <td class="num big">${n(g.usable)} <small>${g.unit}</small></td>
          <td class="num">${g.expiring ? html`<span class="text-warn">${n(g.expiring)}</span>` : html`<span class="muted">0</span>`}</td>
          <td class="num">${g.expired ? html`<span class="text-bad">${n(g.expired)}</span>` : html`<span class="muted">0</span>`}</td>
          <td>${g.lots.length ? html`<ul class="lots">${g.lots.map((l) => html`<li class="lot-${l.state}">
              <span>${l.lot_no}</span><span>${fmtDate(l.expiry)}</span><span class="num">${n(l.qty)}</span>
              ${badge(l.state === 'ok' ? 'ok' : l.state, l.state === 'ok' ? t('{n} d', { n: l.days_left }) : l.state === 'expired' ? t('Expired') : t('{n} d left', { n: l.days_left }))}
              ${edit && l.state === 'expired' && l.qty > 0 ? html`<button class="btn btn-xs" data-dispose="${l.id}" data-glue="${g.id}">${t('Dispose')}</button>` : ''}
            </li>`)}</ul>` : html`<span class="muted">${t('no stock')}</span>`}</td>
          <td>${badge(g.status)}</td>
        </tr>`)}</tbody></table></div>` : emptyState(glues.length ? t('No glue linked to this colour.') : t('No glue products yet. Add them under Setup → Glue products.')));
      $$('[data-dispose]', main).forEach((b) => b.addEventListener('click', async () => {
        const g = glues.find((x) => x.id === Number(b.dataset.glue));
        const l = g.lots.find((x) => x.id === Number(b.dataset.dispose));
        const ok = await confirmBox(t('Dispose expired glue'), t('Remove {qty} {unit} of {code} lot {lot} (expired {date}) from stock?', { qty: l.qty, unit: g.unit, code: g.code, lot: l.lot_no, date: fmtDate(l.expiry) }), { submit: t('Dispose'), danger: true });
        if (!ok) return;
        try {
          await api.post('/api/docs', { type: 'adjust', reason: 'Expired glue disposal', lines: [{ kind: 'glue_adj', lot_id: l.id, qty: -l.qty }] });
          toast(t('Expired glue removed'));
          this.render(main);
        } catch (e) { toast(e.message, 'error'); }
      }));
    };
    draw();
    $('#gSlab', main).onchange = (e) => { glueSlab = e.target.value; draw(); };
  },
};

// =====================================================================================
// Racks
// =====================================================================================
let rackQ = '';
export const racks = {
  title: () => t('Racks'),
  live: true,
  async render(main) {
    const list = await api.get('/api/racks');
    set(main, html`
      <div class="toolbar"><input type="search" id="rq" placeholder="${t('Find rack or colour…')}" value="${rackQ}" aria-label="${t('Search')}"></div>
      <div class="rack-grid" id="rackGrid"></div>`);
    const draw = () => {
      const q = rackQ.trim().toLowerCase();
      const shown = list.filter((r) => !q || r.code.toLowerCase().includes(q)
        || r.slabs.some((s) => `${s.code} ${s.name}`.toLowerCase().includes(q))
        || r.remnants.some((x) => `${x.code} ${x.slab_code}`.toLowerCase().includes(q)));
      set($('#rackGrid', main), shown.length ? shown.map((r) => {
        const pcsTotal = r.slabs.reduce((a, s) => a + s.qty, 0);
        return html`<section class="card rack">
          <h2>${r.code} <span class="muted small">${r.name}</span></h2>
          <div class="muted small">${t('{a} slabs · {b} offcuts', { a: n(pcsTotal), b: r.remnants.length })}${r.active ? '' : ` · ${t('inactive')}`}</div>
          ${r.slabs.length ? html`<table class="table compact"><tbody>${r.slabs.map((s) => html`<tr><td><a href="#/stock/${s.slab_id}">${s.code}</a> ${s.name}</td><td class="num">${n(s.qty)}</td></tr>`)}</tbody></table>` : ''}
          ${r.remnants.length ? html`<div class="small">${r.remnants.map((x, i) => html`${i ? ' · ' : ''}${x.code} ${x.slab_code} ${n(x.sqm, 2)} m²`)}</div>` : ''}
          ${!r.slabs.length && !r.remnants.length ? html`<p class="muted small">${t('Empty')}</p>` : ''}
        </section>`;
      }) : emptyState(t('No racks found. Add rack locations under Setup → Rack locations.')));
    };
    draw();
    $('#rq', main).oninput = (e) => { rackQ = e.target.value; draw(); };
  },
};
