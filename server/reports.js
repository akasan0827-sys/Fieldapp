'use strict';
const { getSettings } = require('./db');
const U = require('./util');
const { r3, today, addDays, addMonths, monthStart, monthEnd, weekStart, isoWeek } = U;
const S = require('./stock');

// ---- sales ------------------------------------------------------------------

function salesLines(db, from, to) {
  return db.prepare(`
    SELECT d.id AS doc_id, d.doc_no, d.date, d.customer_id, c.name AS customer_name, d.deliver_to, d.sales_person,
           l.kind, l.slab_id, s.code AS slab_code, s.name AS slab_name, l.glue_id, g.code AS glue_code, g.name AS glue_name,
           l.qty, l.sqm
      FROM lines l
      JOIN docs d ON d.id = l.doc_id
      LEFT JOIN customers c ON c.id = d.customer_id
      LEFT JOIN slabs s ON s.id = l.slab_id
      LEFT JOIN glues g ON g.id = l.glue_id
     WHERE d.type = 'outbound' AND d.status = 'posted' AND d.date BETWEEN ? AND ?
     ORDER BY d.date, d.id, l.id`).all(from, to);
}

function blank() {
  return { deliveries: new Set(), full_pcs: 0, cut_sqm: 0, sqm: 0, glue: 0 };
}
function add(acc, l) {
  acc.deliveries.add(l.doc_id);
  if (l.kind === 'slab_out') acc.full_pcs += l.qty;
  if (['slab_cut', 'remnant_cut', 'remnant_out'].includes(l.kind)) acc.cut_sqm += l.sqm;
  if (l.slab_id) acc.sqm += l.sqm;
  if (l.kind === 'glue_out') acc.glue += l.qty;
}
function fin(acc) {
  return { deliveries: acc.deliveries.size, full_pcs: acc.full_pcs, cut_sqm: r3(acc.cut_sqm), sqm: r3(acc.sqm), glue: acc.glue };
}

function periodKey(d, group) {
  if (group === 'week') return weekStart(d);
  if (group === 'month') return d.slice(0, 7);
  return d;
}
function periodLabel(key, group) {
  if (group === 'week') {
    const w = isoWeek(key);
    return `W${String(w.week).padStart(2, '0')} · ${key.slice(5)}–${addDays(key, 6).slice(5)}`;
  }
  return key;
}

function salesReport(db, { from, to, group = 'day' }) {
  const lines = salesLines(db, from, to);
  const periods = new Map();
  // continuous axis so empty days/weeks show as zero
  let cur = group === 'week' ? weekStart(from) : group === 'month' ? from.slice(0, 7) : from;
  for (let i = 0; i < 800; i++) {
    const end = group === 'month' ? `${cur}-01` : cur;
    if (end > to) break;
    periods.set(cur, blank());
    if (group === 'day') cur = addDays(cur, 1);
    else if (group === 'week') cur = addDays(cur, 7);
    else cur = addMonths(`${cur}-01`, 1).slice(0, 7);
  }
  const byColor = new Map();
  const byCustomer = new Map();
  const bySales = new Map();
  const byGlue = new Map();
  const total = blank();
  const deliveries = new Map();
  for (const l of lines) {
    const k = periodKey(l.date, group);
    if (!periods.has(k)) periods.set(k, blank());
    add(periods.get(k), l);
    add(total, l);
    if (l.slab_id) {
      if (!byColor.has(l.slab_id)) byColor.set(l.slab_id, { slab_id: l.slab_id, code: l.slab_code, name: l.slab_name, acc: blank() });
      add(byColor.get(l.slab_id).acc, l);
    }
    if (l.glue_id) {
      if (!byGlue.has(l.glue_id)) byGlue.set(l.glue_id, { glue_id: l.glue_id, code: l.glue_code, name: l.glue_name, acc: blank() });
      add(byGlue.get(l.glue_id).acc, l);
    }
    const ck = l.customer_id;
    if (!byCustomer.has(ck)) byCustomer.set(ck, { customer_id: ck, name: l.customer_name, acc: blank() });
    add(byCustomer.get(ck).acc, l);
    const sk = l.sales_person || '(not set)';
    if (!bySales.has(sk)) bySales.set(sk, { name: sk, acc: blank() });
    add(bySales.get(sk).acc, l);
    if (!deliveries.has(l.doc_id)) {
      deliveries.set(l.doc_id, { doc_id: l.doc_id, doc_no: l.doc_no, date: l.date, customer_name: l.customer_name, deliver_to: l.deliver_to, sales_person: l.sales_person, acc: blank() });
    }
    add(deliveries.get(l.doc_id).acc, l);
  }
  const flat = (m) => [...m.values()].map(({ acc, ...rest }) => ({ ...rest, ...fin(acc) })).sort((a, b) => b.sqm - a.sqm || b.glue - a.glue);
  return {
    from, to, group,
    total: fin(total),
    periods: [...periods.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, acc]) => ({ key, label: periodLabel(key, group), ...fin(acc) })),
    by_color: flat(byColor),
    by_glue: flat(byGlue),
    by_customer: flat(byCustomer),
    by_sales: flat(bySales),
    deliveries: [...deliveries.values()].map(({ acc, ...rest }) => ({ ...rest, ...fin(acc) })).reverse(),
  };
}

// ---- monthly closing ---------------------------------------------------------

function computeClosing(db, month) {
  const start = monthStart(month);
  const end = monthEnd(month);
  const slabs = db.prepare('SELECT * FROM slabs ORDER BY code').all();
  const glues = db.prepare('SELECT * FROM glues ORDER BY code').all();

  const sumBy = (sql, ...args) => {
    const m = new Map();
    for (const r of db.prepare(sql).all(...args)) m.set(r.k, r.v || 0);
    return m;
  };
  const mvSlab = (types, sign = '') => sumBy(`
      SELECT m.slab_id AS k, SUM(${sign}m.qty) AS v FROM moves m JOIN docs d ON d.id = m.doc_id
       WHERE m.item = 'slab' AND m.date BETWEEN ? AND ? AND d.type IN (${types}) GROUP BY m.slab_id`, start, end);
  const pcsOpen = sumBy(`SELECT slab_id AS k, SUM(qty) AS v FROM moves WHERE item = 'slab' AND date < ? GROUP BY slab_id`, start);
  const pcsIn = mvSlab(`'opening','inbound'`);
  const pcsOut = mvSlab(`'outbound'`, '-');
  const pcsAdj = mvSlab(`'adjust','transfer'`);
  const remOpen = sumBy(`SELECT slab_id AS k, SUM(sqm) AS v FROM remnants WHERE status <> 'void'
                          AND created_date < ? AND (closed_date IS NULL OR closed_date >= ?) GROUP BY slab_id`, start, start);
  const remNew = sumBy(`SELECT slab_id AS k, SUM(sqm) AS v FROM remnants WHERE status <> 'void'
                         AND created_date BETWEEN ? AND ? GROUP BY slab_id`, start, end);
  const remGone = sumBy(`SELECT slab_id AS k, SUM(sqm) AS v FROM remnants WHERE status IN ('used','scrapped')
                          AND closed_date BETWEEN ? AND ? GROUP BY slab_id`, start, end);
  const remClose = sumBy(`SELECT slab_id AS k, SUM(sqm) AS v FROM remnants WHERE status <> 'void'
                           AND created_date <= ? AND (closed_date IS NULL OR closed_date > ?) GROUP BY slab_id`, end, end);
  const remCount = sumBy(`SELECT slab_id AS k, COUNT(*) AS v FROM remnants WHERE status <> 'void'
                           AND created_date <= ? AND (closed_date IS NULL OR closed_date > ?) GROUP BY slab_id`, end, end);
  const sold = new Map();
  for (const r of db.prepare(`
      SELECT l.slab_id, SUM(l.sqm) AS sqm, SUM(CASE WHEN l.kind = 'slab_out' THEN l.qty ELSE 0 END) AS full_pcs,
             SUM(l.waste_sqm) AS waste, COUNT(DISTINCT d.id) AS deliveries
        FROM lines l JOIN docs d ON d.id = l.doc_id
       WHERE d.type = 'outbound' AND d.status = 'posted' AND d.date BETWEEN ? AND ? AND l.slab_id IS NOT NULL
       GROUP BY l.slab_id`).all(start, end)) sold.set(r.slab_id, r);
  const scrapped = sumBy(`SELECT l.slab_id AS k, SUM(l.waste_sqm) AS v FROM lines l JOIN docs d ON d.id = l.doc_id
                           WHERE d.status = 'posted' AND d.type = 'adjust' AND d.date BETWEEN ? AND ? GROUP BY l.slab_id`, start, end);

  const slabRows = slabs.map((s) => {
    const area = S.slabArea(s);
    const o = pcsOpen.get(s.id) || 0;
    const i = pcsIn.get(s.id) || 0;
    const out = pcsOut.get(s.id) || 0;
    const a = pcsAdj.get(s.id) || 0;
    const c = o + i - out + a;
    const sd = sold.get(s.id) || {};
    const row = {
      slab_id: s.id, code: s.code, name: s.name, area,
      open_pcs: o, in_pcs: i, out_pcs: out, adj_pcs: a, close_pcs: c,
      open_offcut_sqm: r3(remOpen.get(s.id) || 0), new_offcut_sqm: r3(remNew.get(s.id) || 0),
      used_offcut_sqm: r3(remGone.get(s.id) || 0), close_offcut_sqm: r3(remClose.get(s.id) || 0),
      close_offcut_count: remCount.get(s.id) || 0,
      sold_sqm: r3(sd.sqm || 0), sold_full_pcs: sd.full_pcs || 0, deliveries: sd.deliveries || 0,
      waste_sqm: r3((sd.waste || 0) + (scrapped.get(s.id) || 0)),
    };
    row.open_sqm = r3(o * area + row.open_offcut_sqm);
    row.close_sqm = r3(c * area + row.close_offcut_sqm);
    return row;
  }).filter((r) => r.open_pcs || r.in_pcs || r.out_pcs || r.adj_pcs || r.close_pcs || r.open_offcut_sqm || r.close_offcut_sqm || r.new_offcut_sqm);

  const mvGlue = (types, sign = '') => sumBy(`
      SELECT m.glue_id AS k, SUM(${sign}m.qty) AS v FROM moves m JOIN docs d ON d.id = m.doc_id
       WHERE m.item = 'glue' AND m.date BETWEEN ? AND ? AND d.type IN (${types}) GROUP BY m.glue_id`, start, end);
  const gOpen = sumBy(`SELECT glue_id AS k, SUM(qty) AS v FROM moves WHERE item = 'glue' AND date < ? GROUP BY glue_id`, start);
  const gIn = mvGlue(`'opening','inbound'`);
  const gOut = mvGlue(`'outbound'`, '-');
  const gAdj = mvGlue(`'adjust','transfer'`);
  const gExpired = sumBy(`
      SELECT gl.glue_id AS k, SUM(b.q) AS v FROM glue_lots gl
        JOIN (SELECT lot_id, SUM(qty) AS q FROM moves WHERE item = 'glue' AND date <= ? GROUP BY lot_id) b ON b.lot_id = gl.id
       WHERE gl.expiry <= ? AND b.q > 0 GROUP BY gl.glue_id`, end, end);
  const glueRows = glues.map((g) => {
    const o = gOpen.get(g.id) || 0;
    const i = gIn.get(g.id) || 0;
    const out = gOut.get(g.id) || 0;
    const a = gAdj.get(g.id) || 0;
    return { glue_id: g.id, code: g.code, name: g.name, color: g.color, unit: g.unit, open: o, in: i, out, adj: a, close: o + i - out + a, expired_at_close: gExpired.get(g.id) || 0 };
  }).filter((r) => r.open || r.in || r.out || r.adj || r.close);

  const sum = (rows, k) => r3(rows.reduce((a, r) => a + (r[k] || 0), 0));
  const docs = db.prepare(`SELECT type, COUNT(*) AS n FROM docs WHERE status = 'posted' AND date BETWEEN ? AND ? GROUP BY type`).all(start, end);
  return {
    month, start, end,
    slabs: slabRows,
    glues: glueRows,
    totals: {
      open_pcs: sum(slabRows, 'open_pcs'), in_pcs: sum(slabRows, 'in_pcs'), out_pcs: sum(slabRows, 'out_pcs'),
      adj_pcs: sum(slabRows, 'adj_pcs'), close_pcs: sum(slabRows, 'close_pcs'),
      open_sqm: sum(slabRows, 'open_sqm'), close_sqm: sum(slabRows, 'close_sqm'),
      open_offcut_sqm: sum(slabRows, 'open_offcut_sqm'), close_offcut_sqm: sum(slabRows, 'close_offcut_sqm'),
      new_offcut_sqm: sum(slabRows, 'new_offcut_sqm'), used_offcut_sqm: sum(slabRows, 'used_offcut_sqm'),
      sold_sqm: sum(slabRows, 'sold_sqm'), sold_full_pcs: sum(slabRows, 'sold_full_pcs'), waste_sqm: sum(slabRows, 'waste_sqm'),
      glue_open: sum(glueRows, 'open'), glue_in: sum(glueRows, 'in'), glue_out: sum(glueRows, 'out'),
      glue_adj: sum(glueRows, 'adj'), glue_close: sum(glueRows, 'close'), glue_expired: sum(glueRows, 'expired_at_close'),
    },
    doc_counts: Object.fromEntries(docs.map((d) => [d.type, d.n])),
  };
}

function closing(db, month) {
  const row = db.prepare(`SELECT mc.*, u.name AS closed_by_name FROM month_closings mc LEFT JOIN users u ON u.id = mc.closed_by WHERE month = ?`).get(month);
  if (row) return { ...JSON.parse(row.snapshot), closed: true, closed_at: row.closed_at, closed_by_name: row.closed_by_name };
  return { ...computeClosing(db, month), closed: false };
}

// ---- dashboard ---------------------------------------------------------------

function dashboard(db) {
  const t = today();
  const settings = getSettings(db);
  const stock = S.stockOverview(db);
  const glue = S.glueOverview(db);
  const locks = S.listLocks(db);
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

  const todayDocs = db.prepare(`SELECT type, COUNT(*) AS n FROM docs WHERE status = 'posted' AND date = ? GROUP BY type`).all(t);
  const last14 = salesReport(db, { from: addDays(t, -13), to: t, group: 'day' });
  const week = salesReport(db, { from: weekStart(t), to: t, group: 'week' });
  const month = salesReport(db, { from: `${t.slice(0, 7)}-01`, to: t, group: 'month' });
  const top30 = salesReport(db, { from: addDays(t, -29), to: t, group: 'month' }).by_color.slice(0, 8);

  const incoming = db.prepare(`
    SELECT d.id, d.doc_no, d.partner, d.reference, d.eta, d.ship_status,
           SUM(CASE WHEN l.kind = 'slab_in' THEN l.qty ELSE 0 END) AS slab_pcs,
           SUM(CASE WHEN l.kind = 'glue_in' THEN l.qty ELSE 0 END) AS glue_qty
      FROM docs d JOIN lines l ON l.doc_id = d.id
     WHERE d.type = 'inbound' AND d.status = 'expected'
     GROUP BY d.id ORDER BY d.eta IS NULL, d.eta`).all();

  const lockDays = 3;
  const alerts = [];
  for (const s of stock) {
    if (s.status === 'overlocked') alerts.push({ level: 'red', kind: 'stock', text: `${s.code} ${s.name}: ${-s.available} pcs more locked than in stock`, link: `#/stock/${s.id}` });
    else if (s.status === 'out' && s.active) alerts.push({ level: 'red', kind: 'stock', text: `${s.code} ${s.name} is out of stock`, link: `#/stock/${s.id}` });
    else if (s.status === 'low') alerts.push({ level: 'amber', kind: 'stock', text: `${s.code} ${s.name}: ${s.available} pcs available (min ${s.min_pcs})`, link: `#/stock/${s.id}` });
  }
  for (const g of glue) {
    for (const l of g.lots) {
      if (l.state === 'expired') alerts.push({ level: 'red', kind: 'glue', text: `Glue ${g.code} lot ${l.lot_no}: ${l.qty} ${g.unit} expired on ${l.expiry}`, link: '#/glue' });
      else if (l.state === 'expiring') alerts.push({ level: 'amber', kind: 'glue', text: `Glue ${g.code} lot ${l.lot_no}: ${l.qty} ${g.unit} expire on ${l.expiry} (${l.days_left} days)`, link: '#/glue' });
    }
    if (g.status === 'low' || (g.status === 'out' && g.active)) alerts.push({ level: g.status === 'out' ? 'red' : 'amber', kind: 'glue', text: `Glue ${g.code} ${g.name}: ${g.usable} usable ${g.unit}${g.min_qty ? ` (min ${g.min_qty})` : ''}`, link: '#/glue' });
  }
  for (const k of locks) {
    if (k.state === 'pending') alerts.push({ level: 'blue', kind: 'lock', text: `Lock request #${k.id}: ${k.customer_name} wants ${k.pcs} pcs ${k.slab_code} — waiting for approval`, link: '#/locks' });
    if (k.state === 'expired') alerts.push({ level: 'amber', kind: 'lock', text: `Lock #${k.id} (${k.customer_name}, ${k.remaining} pcs ${k.slab_code}) expired on ${k.expires_on} — release or extend`, link: '#/locks' });
    if (k.state === 'active' && k.expires_on && k.expires_on <= addDays(t, lockDays)) alerts.push({ level: 'amber', kind: 'lock', text: `Lock #${k.id} (${k.customer_name}, ${k.remaining} pcs ${k.slab_code}) expires on ${k.expires_on}`, link: '#/locks' });
  }
  for (const d of incoming) {
    if (d.eta && d.eta < t) alerts.push({ level: 'amber', kind: 'incoming', text: `Shipment ${d.doc_no}${d.reference ? ` (${d.reference})` : ''} was due ${d.eta} — receive it or update the ETA`, link: `#/doc/${d.id}` });
  }
  const order = { red: 0, amber: 1, blue: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return {
    today: t,
    company_name: settings.company_name,
    kpi: {
      colors: stock.filter((s) => s.active).length,
      on_hand: sum(stock, 'on_hand'),
      locked: sum(stock, 'locked'),
      available: sum(stock, 'available'),
      remnant_count: sum(stock, 'remnant_count'),
      remnant_sqm: r3(sum(stock, 'remnant_sqm')),
      total_sqm: r3(sum(stock, 'total_sqm')),
      incoming_pcs: sum(stock, 'incoming'),
      glue_usable: sum(glue, 'usable'),
      glue_expiring: sum(glue, 'expiring'),
      glue_expired: sum(glue, 'expired'),
      pending_locks: locks.filter((k) => k.state === 'pending').length,
      active_locks: locks.filter((k) => k.state === 'active').length,
    },
    today_docs: Object.fromEntries(todayDocs.map((d) => [d.type, d.n])),
    sales_today: last14.periods.find((p) => p.key === t) || null,
    sales_week: week.total,
    sales_month: month.total,
    sales_14d: last14.periods,
    top_colors_30d: top30,
    incoming,
    alerts,
  };
}

// ---- colour detail -----------------------------------------------------------

function slabDetail(db, slabId) {
  const row = S.stockOverview(db).find((r) => r.id === slabId);
  const slab = db.prepare('SELECT * FROM slabs WHERE id = ?').get(slabId);
  if (!slab) return null;
  const t = today();
  const from = addMonths(`${t.slice(0, 7)}-01`, -11);
  const lines = salesLines(db, from, t).filter((l) => l.slab_id === slabId);
  const byMonth = new Map();
  for (let i = 0; i < 12; i++) {
    const key = addMonths(from, i).slice(0, 7);
    byMonth.set(key, { key, sqm: 0, full_pcs: 0, cut_sqm: 0 });
  }
  for (const l of lines) {
    const m = byMonth.get(l.date.slice(0, 7));
    if (!m) continue;
    m.sqm += l.sqm;
    if (l.kind === 'slab_out') m.full_pcs += l.qty;
    else m.cut_sqm += l.sqm;
  }
  const glues = S.glueOverview(db).filter((g) => g.matches.some((m) => m.id === slabId));
  return {
    slab: { ...slab, area: S.slabArea(slab) },
    stock: row || null,
    remnants: S.availableRemnants(db, { slabId }),
    locks: S.listLocks(db).filter((k) => k.slab_id === slabId && ['pending', 'active', 'expired'].includes(k.state)),
    incoming: db.prepare(`
      SELECT d.id, d.doc_no, d.partner, d.reference, d.eta, d.ship_status, SUM(l.qty) AS qty
        FROM docs d JOIN lines l ON l.doc_id = d.id
       WHERE d.type = 'inbound' AND d.status = 'expected' AND l.kind = 'slab_in' AND l.slab_id = ?
       GROUP BY d.id ORDER BY d.eta`).all(slabId),
    glues,
    monthly: [...byMonth.values()].map((m) => ({ ...m, sqm: r3(m.sqm), cut_sqm: r3(m.cut_sqm) })),
    history: db.prepare(`
      SELECT d.id AS doc_id, d.doc_no, d.type, d.date, c.name AS customer_name, d.deliver_to, d.partner, d.reason,
             l.kind, l.qty, l.sqm, l.leftover_sqm, loc.code AS location_code, tl.code AS to_location_code,
             r.code AS remnant_code, nr.code AS new_remnant_code
        FROM lines l JOIN docs d ON d.id = l.doc_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN locations loc ON loc.id = l.location_id
        LEFT JOIN locations tl ON tl.id = l.to_location_id
        LEFT JOIN remnants r ON r.id = l.remnant_id
        LEFT JOIN remnants nr ON nr.id = l.new_remnant_id
       WHERE d.status = 'posted' AND l.slab_id = ?
       ORDER BY d.date DESC, d.id DESC, l.id DESC LIMIT 100`).all(slabId),
  };
}

module.exports = { salesReport, computeClosing, closing, dashboard, slabDetail };
