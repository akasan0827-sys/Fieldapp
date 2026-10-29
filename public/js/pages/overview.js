import { api, state, loadRef, can } from '../api.js';
import {
  html, $, $$, n, sqm, fmtDate, relDays, badge, swatch, toast, modal, confirmBox, formData, options,
  mountBarChart, emptyState, addDays, downloadCsv, DOC_TYPES, bindRowLinks,
} from '../ui.js';
import { describeLine } from './docs.js';

const set = (el, h) => { el.innerHTML = String(h); };

// =====================================================================================
// Dashboard
// =====================================================================================
export const dashboard = {
  title: 'Dashboard',
  live: true,
  async render(main) {
    const d = await api.get('/api/dashboard');
    const k = d.kpi;
    const edit = can.edit();
    const alertIcon = { red: '✕', amber: '▲', blue: '…' };
    set(main, html`
      <div class="actions-row">
        ${edit ? html`
          <a class="btn btn-primary" href="#/deliveries/new">+ New delivery</a>
          <a class="btn" href="#/receiving/new">+ Receive stock</a>
          <a class="btn" href="#/adjust">± Adjust / move</a>` : ''}
        <button class="btn ${edit ? '' : 'btn-primary'}" id="lockBtn">🔒 ${edit ? 'Lock stock' : 'Request a lock'}</button>
        <a class="btn" href="#/stock">Check stock</a>
      </div>

      <div class="tiles">
        <a class="tile" href="#/stock">
          <div class="tile-label">Available slabs</div>
          <div class="tile-value">${n(k.available)} <small>pcs</small></div>
          <div class="tile-sub">${n(k.on_hand)} on hand · ${n(k.locked)} locked</div>
        </a>
        <a class="tile" href="#/stock">
          <div class="tile-label">Total stock</div>
          <div class="tile-value">${n(k.total_sqm, 0)} <small>m²</small></div>
          <div class="tile-sub">${k.colors} colours · ${n(k.remnant_count)} offcuts = ${sqm(k.remnant_sqm)}</div>
        </a>
        <a class="tile" href="#/receiving">
          <div class="tile-label">Incoming</div>
          <div class="tile-value">${n(k.incoming_pcs)} <small>pcs</small></div>
          <div class="tile-sub">${d.incoming.length} shipment${d.incoming.length === 1 ? '' : 's'}${d.incoming[0]?.eta ? html` · next ETA ${fmtDate(d.incoming[0].eta)}` : ''}</div>
        </a>
        <a class="tile" href="#/glue">
          <div class="tile-label">Glue (usable)</div>
          <div class="tile-value">${n(k.glue_usable)} <small>pcs</small></div>
          <div class="tile-sub ${k.glue_expired ? 'text-bad' : ''}">${n(k.glue_expiring)} expiring soon · ${n(k.glue_expired)} expired</div>
        </a>
        <a class="tile" href="#/reports/sales?group=day">
          <div class="tile-label">Sold this week</div>
          <div class="tile-value">${n(d.sales_week.sqm, 1)} <small>m²</small></div>
          <div class="tile-sub">${d.sales_week.deliveries} deliveries · ${n(d.sales_week.full_pcs)} full slabs</div>
        </a>
        <a class="tile" href="#/reports/sales?group=week">
          <div class="tile-label">Sold this month</div>
          <div class="tile-value">${n(d.sales_month.sqm, 1)} <small>m²</small></div>
          <div class="tile-sub">${d.sales_month.deliveries} deliveries · ${n(d.sales_month.glue)} glue</div>
        </a>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2>Needs attention <span class="count">${d.alerts.length}</span></h2>
          ${d.alerts.length ? html`<ul class="alerts">${d.alerts.slice(0, 14).map((a) => html`
            <li class="alert-${a.level}"><span class="alert-icon" aria-hidden="true">${alertIcon[a.level]}</span><a href="${a.link}">${a.text}</a></li>`)}</ul>
            ${d.alerts.length > 14 ? html`<p class="muted small">+ ${d.alerts.length - 14} more</p>` : ''}`
            : emptyState('All good — nothing needs attention.')}
        </section>
        <section class="card">
          <h2>Sold per day — last 14 days (m²)</h2>
          <div id="salesChart"></div>
          <h3>Top colours, last 30 days</h3>
          ${d.top_colors_30d.length ? html`<table class="table compact">
            <thead><tr><th>Colour</th><th class="num">m²</th><th class="num">Full slabs</th><th class="num">Deliveries</th></tr></thead>
            <tbody>${d.top_colors_30d.map((c) => html`<tr><td><a href="#/stock/${c.slab_id}">${c.code}</a> ${c.name}</td>
              <td class="num">${n(c.sqm, 1)}</td><td class="num">${n(c.full_pcs)}</td><td class="num">${c.deliveries}</td></tr>`)}</tbody></table>`
            : emptyState('No deliveries in the last 30 days.')}
        </section>
      </div>

      <section class="card">
        <h2>Incoming shipments</h2>
        ${d.incoming.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>ETA</th><th>Shipment</th><th>Supplier</th><th>Reference</th><th>Status</th><th class="num">Slabs</th><th class="num">Glue</th></tr></thead>
          <tbody>${d.incoming.map((s) => html`<tr class="clickable" data-href="#/doc/${s.id}">
            <td>${s.eta ? html`${fmtDate(s.eta)} <span class="muted small">${relDays(s.eta, d.today)}</span>` : html`<span class="muted">not set</span>`}</td>
            <td><a href="#/doc/${s.id}">${s.doc_no}</a></td><td>${s.partner}</td><td>${s.reference}</td>
            <td>${badge(s.ship_status)}</td><td class="num">${n(s.slab_pcs)}</td><td class="num">${n(s.glue_qty)}</td></tr>`)}</tbody></table></div>`
          : emptyState('No incoming shipments registered.')}
      </section>`);
    mountBarChart($('#salesChart', main), d.sales_14d.map((p) => ({
      label: fmtDate(p.key), short: p.key.slice(8), value: p.sqm,
      tip: `${p.deliveries} deliveries · ${p.full_pcs} full slabs`,
    })), { height: 200, fmt: (v) => `${n(v, 2)} m²`, title: 'm² sold per day' });
    $('#lockBtn', main).onclick = () => lockModal();
    bindRowLinks(main);
  },
};

// =====================================================================================
// Stock list (live view for sales)
// =====================================================================================
const stockFilter = { q: '', show: 'all' };

export const stockList = {
  title: 'Slab stock',
  live: true,
  async render(main) {
    const { rows } = await api.get('/api/stock');
    set(main, html`
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search colour code or name…" value="${stockFilter.q}" aria-label="Search">
        <div class="chips" role="group" aria-label="Filter">
          ${[['all', 'All'], ['available', 'In stock'], ['low', 'Low / out'], ['locked', 'Locked'], ['offcuts', 'Has offcuts'], ['incoming', 'Incoming']]
            .map(([v, l]) => html`<button class="chip ${stockFilter.show === v ? 'on' : ''}" data-show="${v}">${l}</button>`)}
        </div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="csv">⇩ CSV</button>
      </div>
      <div id="stockTable"></div>
      <p class="muted small">Available = on hand − locked for customers. Total m² includes offcuts. Sold/month = average of the last 90 days.</p>`);
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
      const tot = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
      set($('#stockTable', main), list.length ? html`
        <div class="table-wrap"><table class="table sticky-first">
          <thead><tr>
            <th>Colour</th><th class="num">Available</th><th class="num">On hand</th><th class="num">Locked</th>
            <th class="num">Offcuts</th><th class="num">Total m²</th><th>Incoming</th><th class="num">Sold / month</th><th>Status</th>
          </tr></thead>
          <tbody>${list.map((r) => html`<tr class="clickable" data-href="#/stock/${r.id}">
            <td class="nowrap">${swatch(r.color_hex)}<a href="#/stock/${r.id}"><strong>${r.code}</strong></a> ${r.name}</td>
            <td class="num big ${r.available < 0 ? 'text-bad' : ''}">${n(r.available)}</td>
            <td class="num">${n(r.on_hand)}</td>
            <td class="num">${r.locked ? n(r.locked) : html`<span class="muted">0</span>`}${r.pending_lock ? html` <span class="muted small" title="Pending lock requests">(+${r.pending_lock}?)</span>` : ''}</td>
            <td class="num">${r.remnant_count ? html`${r.remnant_count} · ${n(r.remnant_sqm, 2)} m²` : html`<span class="muted">–</span>`}</td>
            <td class="num">${n(r.total_sqm, 1)}</td>
            <td class="nowrap">${r.incoming ? html`+${n(r.incoming)} ${r.next_eta ? html`<span class="muted small">ETA ${fmtDate(r.next_eta)}</span>` : ''}` : html`<span class="muted">–</span>`}</td>
            <td class="num">${r.avg_month_sqm ? html`${n(r.avg_month_sqm, 1)} m²` : html`<span class="muted">–</span>`}</td>
            <td>${badge(r.status)}</td>
          </tr>`)}</tbody>
          <tfoot><tr><td>${list.length} colours</td><td class="num">${n(tot('available'))}</td><td class="num">${n(tot('on_hand'))}</td>
            <td class="num">${n(tot('locked'))}</td><td class="num">${n(tot('remnant_sqm'), 2)} m²</td><td class="num">${n(tot('total_sqm'), 1)}</td>
            <td>+${n(tot('incoming'))}</td><td class="num">${n(tot('avg_month_sqm'), 1)} m²</td><td></td></tr></tfoot>
        </table></div>` : emptyState(rows.length ? 'No colours match the filter.' : 'No slab colours yet. Add them under Setup → Slab colours.'));
      bindRowLinks(main);
    };
    draw();
    $('#q', main).addEventListener('input', (e) => { stockFilter.q = e.target.value; draw(); });
    $$('.chip', main).forEach((b) => b.addEventListener('click', () => {
      stockFilter.show = b.dataset.show;
      $$('.chip', main).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }));
    $('#csv', main).onclick = () => downloadCsv(`stock-${state.me.today}.csv`, rows, [
      { label: 'Code', value: 'code' }, { label: 'Colour', value: 'name' }, { label: 'Available pcs', value: 'available' },
      { label: 'On hand pcs', value: 'on_hand' }, { label: 'Locked pcs', value: 'locked' }, { label: 'Offcuts', value: 'remnant_count' },
      { label: 'Offcut m2', value: 'remnant_sqm' }, { label: 'Total m2', value: 'total_sqm' }, { label: 'Incoming pcs', value: 'incoming' },
      { label: 'Next ETA', value: 'next_eta' }, { label: 'Sold per month m2 (90d avg)', value: 'avg_month_sqm' }, { label: 'Status', value: 'status' },
      { label: 'Racks', value: (r) => r.locations.map((l) => `${l.location_code}:${l.qty}`).join(' ') },
    ]);
  },
};

// =====================================================================================
// Colour detail
// =====================================================================================
export const stockDetail = {
  title: 'Colour detail',
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
          <div class="muted">${n(sl.thickness_mm)} × ${n(sl.width_mm)} × ${n(sl.length_mm)} mm · ${n(sl.area, 3)} m² per slab${sl.min_pcs ? html` · minimum ${sl.min_pcs} pcs` : ''}${sl.active ? '' : ' · inactive'}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn" id="lockBtn">🔒 ${can.edit() ? 'Lock for customer' : 'Request a lock'}</button>
        ${can.edit() ? html`<a class="btn btn-primary" href="#/deliveries/new?slab=${sl.id}">+ Deliver</a>` : ''}
      </div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Available</div><div class="tile-value ${s.available < 0 ? 'text-bad' : ''}">${n(s.available)} <small>pcs</small></div><div class="tile-sub">free to sell</div></div>
        <div class="tile"><div class="tile-label">On hand</div><div class="tile-value">${n(s.on_hand)} <small>pcs</small></div><div class="tile-sub">${n(s.locked)} locked</div></div>
        <div class="tile"><div class="tile-label">Offcuts</div><div class="tile-value">${n(s.remnant_sqm, 2)} <small>m²</small></div><div class="tile-sub">${s.remnant_count} pieces</div></div>
        <div class="tile"><div class="tile-label">Total</div><div class="tile-value">${n(s.total_sqm, 1)} <small>m²</small></div><div class="tile-sub">${s.months_cover ? `≈ ${n(s.months_cover, 1)} months of sales` : 'slabs + offcuts'}</div></div>
        <div class="tile"><div class="tile-label">Incoming</div><div class="tile-value">${n(s.incoming)} <small>pcs</small></div><div class="tile-sub">${s.next_eta ? `next ETA ${fmtDate(s.next_eta)}` : 'nothing ordered'}</div></div>
      </div>
      <div class="grid-2">
        <section class="card">
          <h2>Full slabs by rack</h2>
          ${s.locations.length ? html`<table class="table compact"><thead><tr><th>Rack</th><th class="num">Pieces</th><th class="num">m²</th></tr></thead>
            <tbody>${s.locations.map((l) => html`<tr><td>${l.location_code}</td><td class="num">${n(l.qty)}</td><td class="num">${n(l.qty * sl.area, 2)}</td></tr>`)}</tbody></table>`
            : emptyState('No full slabs in stock.')}
          <h2>Offcuts</h2>
          ${d.remnants.length ? html`<table class="table compact"><thead><tr><th>Offcut</th><th class="num">m²</th><th>Size (mm)</th><th>Rack</th><th>Since</th></tr></thead>
            <tbody>${d.remnants.map((r) => html`<tr><td>${r.code}</td><td class="num">${n(r.sqm, 2)}</td>
              <td>${r.width_mm && r.length_mm ? `${n(r.width_mm)} × ${n(r.length_mm)}` : '–'}</td><td>${r.location_code || '–'}</td><td>${fmtDate(r.created_date)}</td></tr>`)}</tbody></table>`
            : emptyState('No offcuts of this colour.')}
        </section>
        <section class="card">
          <h2>Locks</h2>
          ${d.locks.length ? html`<table class="table compact"><thead><tr><th>Customer</th><th class="num">Left</th><th>Until</th><th>Status</th></tr></thead>
            <tbody>${d.locks.map((k) => html`<tr><td>${k.key_account ? '★ ' : ''}${k.customer_name}${k.note ? html`<div class="muted small">${k.note}</div>` : ''}</td>
              <td class="num">${k.state === 'pending' ? k.pcs : k.remaining}</td><td>${k.expires_on ? fmtDate(k.expires_on) : 'no expiry'}</td><td>${badge(k.state)}</td></tr>`)}</tbody></table>`
            : emptyState('No locks.')}
          <h2>Incoming</h2>
          ${d.incoming.length ? html`<table class="table compact"><thead><tr><th>Shipment</th><th>ETA</th><th>Status</th><th class="num">Pcs</th></tr></thead>
            <tbody>${d.incoming.map((i) => html`<tr><td><a href="#/doc/${i.id}">${i.doc_no}</a> <span class="muted small">${i.reference}</span></td>
              <td>${i.eta ? fmtDate(i.eta) : '–'}</td><td>${badge(i.ship_status)}</td><td class="num">${n(i.qty)}</td></tr>`)}</tbody></table>`
            : emptyState('Nothing incoming.')}
          <h2>Matching glue</h2>
          ${d.glues.length ? html`<table class="table compact"><thead><tr><th>Glue</th><th class="num">Usable</th><th>Next expiry</th></tr></thead>
            <tbody>${d.glues.map((g) => html`<tr><td>${g.code} ${g.name}</td><td class="num">${n(g.usable)} ${g.unit}</td><td>${g.next_expiry ? fmtDate(g.next_expiry) : '–'}</td></tr>`)}</tbody></table>`
            : emptyState('No glue linked to this colour (Setup → Glue products).')}
        </section>
      </div>
      <section class="card">
        <h2>Sold per month (m²)</h2>
        <div id="monthChart"></div>
      </section>
      <section class="card">
        <h2>Recent movements</h2>
        ${d.history.length ? html`<div class="table-wrap"><table class="table compact">
          <thead><tr><th>Date</th><th>Document</th><th>Type</th><th>What</th><th>Customer / supplier</th><th>Delivered to</th></tr></thead>
          <tbody>${d.history.map((h) => html`<tr><td class="nowrap">${fmtDate(h.date)}</td><td class="nowrap"><a href="#/doc/${h.doc_id}">${h.doc_no}</a></td>
            <td>${DOC_TYPES[h.type]}</td><td>${describeLine(h)}</td><td>${h.customer_name || h.partner || h.reason}</td><td>${h.deliver_to}</td></tr>`)}</tbody></table></div>`
          : emptyState('No movements yet.')}
      </section>`);
    mountBarChart($('#monthChart', main), d.monthly.map((m) => ({
      label: m.key, short: m.key.slice(2).replace('-', '/'), value: m.sqm, tip: `${m.full_pcs} full slabs · ${n(m.cut_sqm, 2)} m² cut`,
    })), { height: 180, fmt: (v) => `${n(v, 2)} m²`, title: 'm² sold per month' });
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
    return `Free now: ${Math.max(0, r.available)} pcs${r.incoming ? ` (+${r.incoming} incoming${r.next_eta ? `, ETA ${fmtDate(r.next_eta)}` : ''})` : ''}`;
  };
  const saved = await modal({
    title: direct ? 'Lock stock for a customer' : 'Request a stock lock',
    submit: direct ? 'Lock' : 'Send request',
    body: html`
      ${direct ? '' : html`<p class="muted">SCM will approve the request. Until then the stock is not reserved.</p>`}
      <label>Customer
        <select name="customer_id">${options(ref.customers.filter((c) => c.active), customerId, { empty: '— choose —', label: (c) => `${c.key_account ? '★ ' : ''}${c.name}` })}</select>
      </label>
      <label>…or new customer <input name="new_customer" placeholder="Name of a new customer"></label>
      <label>Slab colour
        <select name="slab_id" id="lkSlab">${options(ref.slabs.filter((s) => s.active), slabId, { empty: '— choose —', label: (s) => `${s.code} ${s.name}` })}</select>
      </label>
      <p class="hint" id="lkFree">${freeText(slabId)}</p>
      <div class="row-2">
        <label>Pieces <input name="pcs" type="number" min="1" step="1" required></label>
        <label>Lock until <input name="expires_on" type="date" value="${addDays(state.me.today, days)}"></label>
      </div>
      <label>Note (project, reason) <input name="note" maxlength="500"></label>`,
    onOpen: (f) => { $('#lkSlab', f).onchange = (e) => { $('#lkFree', f).textContent = freeText(e.target.value); }; },
    async onSubmit(f) {
      const v = formData(f);
      let cid = v.customer_id;
      if (v.new_customer.trim()) cid = (await api.post('/api/customers', { name: v.new_customer.trim() })).id;
      if (!cid) throw new Error('Choose a customer');
      return api.post('/api/locks', { customer_id: cid, slab_id: v.slab_id, pcs: v.pcs, expires_on: v.expires_on, note: v.note });
    },
  });
  if (saved) {
    toast(direct ? 'Stock locked' : 'Lock request sent to SCM');
    window.dispatchEvent(new Event('app:refresh'));
  }
}

// =====================================================================================
// Locks
// =====================================================================================
let lockTab = 'active';
export const locks = {
  title: 'Locks',
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
    const cur = tabs.find((t) => t[0] === lockTab) || tabs[0];
    const list = all.filter(cur[2]);
    set(main, html`
      <div class="toolbar">
        <div class="tabs">${tabs.map(([key, label, f]) => html`<button class="tab ${key === cur[0] ? 'on' : ''}" data-tab="${key}">${label} <span class="count">${all.filter(f).length}</span></button>`)}</div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="newLock">🔒 ${edit ? 'New lock' : 'Request a lock'}</button>
      </div>
      <p class="muted small">Locked stock is reserved for that customer: other deliveries can't use it. When delivering, pick the lock on the delivery line and it is reduced automatically.</p>
      ${list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Customer</th><th>Colour</th><th class="num">Locked</th><th class="num">Delivered</th><th class="num">Left</th><th>Lock until</th><th>Status</th><th>Requested by</th><th></th></tr></thead>
        <tbody>${list.map((k) => html`<tr>
          <td>${k.id}</td>
          <td>${k.key_account ? html`<span title="Key account">★</span> ` : ''}${k.customer_name}${k.note ? html`<div class="muted small">${k.note}</div>` : ''}</td>
          <td class="nowrap"><a href="#/stock/${k.slab_id}">${k.slab_code}</a> ${k.slab_name}</td>
          <td class="num">${n(k.pcs)}</td><td class="num">${n(k.fulfilled)}</td><td class="num"><strong>${n(k.remaining)}</strong></td>
          <td class="nowrap">${k.expires_on ? html`${fmtDate(k.expires_on)} <span class="muted small">${relDays(k.expires_on, state.me.today)}</span>` : 'no expiry'}</td>
          <td>${badge(k.state)}${k.decision_note ? html`<div class="muted small">${k.decision_note}</div>` : ''}</td>
          <td>${k.requested_by_name}<div class="muted small">${fmtDate(k.created_at)}</div></td>
          <td class="nowrap actions">
            ${k.state === 'pending' && edit ? html`<button class="btn btn-sm btn-primary" data-act="approve" data-id="${k.id}">Approve</button>
              <button class="btn btn-sm" data-act="reject" data-id="${k.id}">Reject</button>` : ''}
            ${k.state === 'pending' && !edit && k.requested_by === me.id ? html`<button class="btn btn-sm" data-act="release" data-id="${k.id}">Cancel</button>` : ''}
            ${['active', 'expired'].includes(k.state) && edit ? html`<button class="btn btn-sm" data-act="update" data-id="${k.id}">Change</button>
              <button class="btn btn-sm" data-act="release" data-id="${k.id}">Release</button>` : ''}
          </td></tr>`)}</tbody></table></div>` : emptyState('No locks here.')}`);
    $$('.tab', main).forEach((b) => b.addEventListener('click', () => { lockTab = b.dataset.tab; this.render(main); }));
    $('#newLock', main).onclick = () => lockModal();
    $$('[data-act]', main).forEach((b) => b.addEventListener('click', async () => {
      const k = all.find((x) => x.id === Number(b.dataset.id));
      const act = b.dataset.act;
      let ok;
      if (act === 'update') {
        ok = await modal({
          title: `Change lock #${k.id}`,
          body: html`<p>${k.customer_name} · ${k.slab_code} ${k.slab_name} · ${k.fulfilled} pcs already delivered</p>
            <div class="row-2"><label>Pieces <input name="pcs" type="number" min="1" value="${k.pcs}"></label>
            <label>Lock until <input name="expires_on" type="date" value="${k.expires_on || ''}"></label></div>
            <label>Note <input name="note" value="${k.note}"></label>`,
          onSubmit: (f) => api.post(`/api/locks/${k.id}/update`, formData(f)),
        });
      } else {
        const label = { approve: 'Approve', reject: 'Reject', release: k.state === 'pending' ? 'Cancel request' : 'Release' }[act];
        ok = await modal({
          title: `${label} lock #${k.id}`,
          submit: label,
          danger: act !== 'approve',
          body: html`<p>${k.customer_name} · ${k.pcs} pcs ${k.slab_code} ${k.slab_name}${k.expires_on ? ` · until ${fmtDate(k.expires_on)}` : ''}</p>
            ${act === 'release' && k.remaining ? html`<p>${k.remaining} pcs will become free to sell again.</p>` : ''}
            <label>Note (optional) <input name="note"></label>`,
          onSubmit: (f) => api.post(`/api/locks/${k.id}/${act}`, formData(f)),
        });
      }
      if (ok) { toast('Saved'); this.render(main); }
    }));
  },
};

// =====================================================================================
// Offcuts
// =====================================================================================
const offFilter = { slab: '', rack: '', min: '' };
export const offcuts = {
  title: 'Offcuts (partial slabs)',
  live: true,
  async render(main) {
    const ref = await loadRef();
    const rems = await api.get('/api/remnants');
    const edit = can.edit();
    set(main, html`
      <div class="toolbar">
        <select id="fSlab" aria-label="Colour">${options(ref.slabs, offFilter.slab, { empty: 'All colours', label: (s) => `${s.code} ${s.name}` })}</select>
        <select id="fRack" aria-label="Rack">${options(ref.locations, offFilter.rack, { empty: 'All racks', label: (l) => l.code })}</select>
        <input id="fMin" type="number" step="0.1" min="0" placeholder="Min m²" value="${offFilter.min}" aria-label="Minimum m²" class="w-sm">
        <span class="spacer"></span>
        ${edit ? html`<a class="btn" href="#/adjust?tab=adjust&add=remnant_in">+ Register offcut</a>` : ''}
      </div>
      <div id="offTable"></div>
      <p class="muted small">Offcuts are created automatically when a slab is cut for a delivery by m² and the rest goes back to the rack.</p>`);
    const draw = () => {
      const list = rems.filter((r) => (!offFilter.slab || String(r.slab_id) === offFilter.slab)
        && (!offFilter.rack || String(r.location_id) === offFilter.rack) && (!offFilter.min || r.sqm >= Number(offFilter.min)));
      const total = list.reduce((a, r) => a + r.sqm, 0);
      set($('#offTable', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Offcut</th><th>Colour</th><th class="num">m²</th><th>Size (mm)</th><th>Rack</th><th>Since</th><th>From</th>${edit ? html`<th></th>` : ''}</tr></thead>
        <tbody>${list.map((r) => html`<tr>
          <td><strong>${r.code}</strong>${r.note ? html`<div class="muted small">${r.note}</div>` : ''}</td>
          <td class="nowrap"><a href="#/stock/${r.slab_id}">${r.slab_code}</a> ${r.slab_name}</td>
          <td class="num">${n(r.sqm, 2)}</td>
          <td>${r.width_mm && r.length_mm ? `${n(r.width_mm)} × ${n(r.length_mm)}` : '–'}</td>
          <td>${r.location_code || '–'}</td>
          <td class="nowrap">${fmtDate(r.created_date)} <span class="muted small">${relDays(r.created_date, state.me.today)}</span></td>
          <td><a href="#/doc/${r.created_doc_id}">${r.created_doc_no}</a></td>
          ${edit ? html`<td class="nowrap actions"><button class="btn btn-sm" data-move="${r.id}">Move</button> <button class="btn btn-sm" data-scrap="${r.id}">Scrap</button></td>` : ''}
        </tr>`)}</tbody>
        <tfoot><tr><td>${list.length} offcuts</td><td></td><td class="num">${n(total, 2)}</td><td colspan="${edit ? 5 : 4}"></td></tr></tfoot>
      </table></div>` : emptyState('No offcuts match.'));
      $$('[data-move]', main).forEach((b) => b.addEventListener('click', async () => {
        const r = rems.find((x) => x.id === Number(b.dataset.move));
        const ok = await modal({
          title: `Move offcut ${r.code}`,
          body: html`<label>New rack <select name="to">${options(ref.locations.filter((l) => l.active && l.id !== r.location_id), '', { empty: '— choose —', label: (l) => l.code })}</select></label>`,
          onSubmit: (f) => api.post('/api/docs', { type: 'transfer', lines: [{ kind: 'remnant_move', remnant_id: r.id, to_location_id: formData(f).to }] }),
        });
        if (ok) { toast('Offcut moved'); this.render(main); }
      }));
      $$('[data-scrap]', main).forEach((b) => b.addEventListener('click', async () => {
        const r = rems.find((x) => x.id === Number(b.dataset.scrap));
        const ok = await modal({
          title: `Scrap offcut ${r.code}`,
          submit: 'Scrap', danger: true,
          body: html`<p>${r.slab_code} ${r.slab_name} · ${n(r.sqm, 2)} m² will be removed from stock as waste.</p><label>Reason <input name="note" placeholder="e.g. broken, too small"></label>`,
          onSubmit: (f) => api.post('/api/docs', { type: 'adjust', reason: 'Offcut scrapped', note: formData(f).note, lines: [{ kind: 'remnant_scrap', remnant_id: r.id }] }),
        });
        if (ok) { toast('Offcut scrapped'); this.render(main); }
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
  title: 'Glue stock',
  live: true,
  async render(main) {
    const ref = await loadRef();
    const glues = await api.get('/api/glue');
    const edit = can.edit();
    const warn = ref.settings.expiry_warn_days;
    set(main, html`
      <div class="toolbar">
        <label class="inline">Glue for colour
          <select id="gSlab">${options(ref.slabs, glueSlab, { empty: 'All colours', label: (s) => `${s.code} ${s.name}` })}</select></label>
        <span class="spacer"></span>
        ${edit ? html`<a class="btn" href="#/receiving/new">+ Receive glue</a>` : ''}
      </div>
      <div id="glueList"></div>
      <p class="muted small">Deliveries take glue first-expiry-first-out and never use expired lots. Lots expiring within ${warn} days are flagged.</p>`);
    const draw = () => {
      const list = glues.filter((g) => !glueSlab || g.matches.some((m) => String(m.id) === glueSlab));
      set($('#glueList', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Glue</th><th>For colours</th><th class="num">Usable</th><th class="num">Expiring</th><th class="num">Expired</th><th>Lots (lot · expiry · qty)</th><th>Status</th></tr></thead>
        <tbody>${list.map((g) => html`<tr>
          <td><strong>${g.code}</strong> ${g.name}${g.color ? html`<div class="muted small">${g.color} · shelf life ${g.shelf_life_months} months</div>` : ''}</td>
          <td class="small">${g.matches.length ? g.matches.map((m, i) => html`${i ? ', ' : ''}<a href="#/stock/${m.id}">${m.code}</a>`) : html`<span class="muted">–</span>`}</td>
          <td class="num big">${n(g.usable)} <small>${g.unit}</small></td>
          <td class="num">${g.expiring ? html`<span class="text-warn">${n(g.expiring)}</span>` : html`<span class="muted">0</span>`}</td>
          <td class="num">${g.expired ? html`<span class="text-bad">${n(g.expired)}</span>` : html`<span class="muted">0</span>`}</td>
          <td>${g.lots.length ? html`<ul class="lots">${g.lots.map((l) => html`<li class="lot-${l.state}">
              <span>${l.lot_no}</span><span>${fmtDate(l.expiry)}</span><span class="num">${n(l.qty)}</span>
              ${badge(l.state === 'ok' ? 'ok' : l.state, l.state === 'ok' ? `${l.days_left} d` : l.state === 'expired' ? 'Expired' : `${l.days_left} d left`)}
              ${edit && l.state === 'expired' && l.qty > 0 ? html`<button class="btn btn-xs" data-dispose="${l.id}" data-glue="${g.id}">Dispose</button>` : ''}
            </li>`)}</ul>` : html`<span class="muted">no stock</span>`}</td>
          <td>${badge(g.status)}</td>
        </tr>`)}</tbody></table></div>` : emptyState(glues.length ? 'No glue linked to this colour.' : 'No glue products yet. Add them under Setup → Glue products.'));
      $$('[data-dispose]', main).forEach((b) => b.addEventListener('click', async () => {
        const g = glues.find((x) => x.id === Number(b.dataset.glue));
        const l = g.lots.find((x) => x.id === Number(b.dataset.dispose));
        const ok = await confirmBox('Dispose expired glue', `Remove ${l.qty} ${g.unit} of ${g.code} lot ${l.lot_no} (expired ${fmtDate(l.expiry)}) from stock?`, { submit: 'Dispose', danger: true });
        if (!ok) return;
        try {
          await api.post('/api/docs', { type: 'adjust', reason: 'Expired glue disposal', lines: [{ kind: 'glue_adj', lot_id: l.id, qty: -l.qty }] });
          toast('Expired glue removed');
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
  title: 'Racks',
  live: true,
  async render(main) {
    const list = await api.get('/api/racks');
    set(main, html`
      <div class="toolbar"><input type="search" id="rq" placeholder="Find rack or colour…" value="${rackQ}" aria-label="Search racks"></div>
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
          <div class="muted small">${n(pcsTotal)} slabs · ${r.remnants.length} offcuts${r.active ? '' : ' · inactive'}</div>
          ${r.slabs.length ? html`<table class="table compact"><tbody>${r.slabs.map((s) => html`<tr><td><a href="#/stock/${s.slab_id}">${s.code}</a> ${s.name}</td><td class="num">${n(s.qty)}</td></tr>`)}</tbody></table>` : ''}
          ${r.remnants.length ? html`<div class="small">${r.remnants.map((x, i) => html`${i ? ' · ' : ''}${x.code} ${x.slab_code} ${n(x.sqm, 2)} m²`)}</div>` : ''}
          ${!r.slabs.length && !r.remnants.length ? html`<p class="muted small">Empty</p>` : ''}
        </section>`;
      }) : emptyState('No racks found. Add rack locations under Setup → Rack locations.'));
    };
    draw();
    $('#rq', main).oninput = (e) => { rackQ = e.target.value; draw(); };
  },
};
