'use strict';
const { r3, today, addDays } = require('./util');
const { getSettings } = require('./db');

// exact area (m2) of one full slab; round only for display
const slabArea = (s) => (s.width_mm * s.length_mm) / 1e6;

// ---- locks -----------------------------------------------------------------

/**
 * All locks with computed fields:
 *   fulfilled = pieces already delivered against the lock (posted outbound lines)
 *   remaining = pcs - fulfilled
 *   state     = pending | active | expired | fulfilled | rejected | released
 * Only state 'active' reserves stock.
 */
function listLocks(db, { asOf = today() } = {}) {
  const rows = db.prepare(`
    SELECT k.*, c.name AS customer_name, c.key_account, s.code AS slab_code, s.name AS slab_name,
           COALESCE(f.fulfilled, 0) AS fulfilled,
           ru.name AS requested_by_name, du.name AS decided_by_name
      FROM locks k
      JOIN customers c ON c.id = k.customer_id
      JOIN slabs s ON s.id = k.slab_id
      LEFT JOIN (SELECT l.lock_id, SUM(l.qty) AS fulfilled
                   FROM lines l JOIN docs d ON d.id = l.doc_id
                  WHERE d.status = 'posted' AND l.lock_id IS NOT NULL AND l.kind IN ('slab_out','slab_cut')
                  GROUP BY l.lock_id) f ON f.lock_id = k.id
      LEFT JOIN users ru ON ru.id = k.requested_by
      LEFT JOIN users du ON du.id = k.decided_by
     ORDER BY k.id DESC`).all();
  return rows.map((k) => {
    const remaining = Math.max(0, k.pcs - k.fulfilled);
    let state = k.status;
    if (k.status === 'active') {
      if (remaining <= 0) state = 'fulfilled';
      else if (k.expires_on && k.expires_on < asOf) state = 'expired';
    }
    return { ...k, remaining, state };
  });
}

function lockedBySlab(locks) {
  const m = new Map();
  for (const k of locks) if (k.state === 'active') m.set(k.slab_id, (m.get(k.slab_id) || 0) + k.remaining);
  return m;
}

// ---- slabs -----------------------------------------------------------------

function slabBalances(db, { slabId = null } = {}) {
  return db.prepare(`
    SELECT m.slab_id, m.location_id, loc.code AS location_code, SUM(m.qty) AS qty
      FROM moves m LEFT JOIN locations loc ON loc.id = m.location_id
     WHERE m.item = 'slab' AND (? IS NULL OR m.slab_id = ?)
     GROUP BY m.slab_id, m.location_id
    HAVING SUM(m.qty) <> 0
     ORDER BY loc.code`).all(slabId, slabId);
}

function onHandAt(db, slabId, locationId) {
  return db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM moves
                      WHERE item = 'slab' AND slab_id = ? AND location_id = ?`).get(slabId, locationId).q;
}

function onHandTotal(db, slabId) {
  return db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM moves WHERE item = 'slab' AND slab_id = ?`).get(slabId).q;
}

function availableRemnants(db, { slabId = null } = {}) {
  return db.prepare(`
    SELECT r.*, s.code AS slab_code, s.name AS slab_name, loc.code AS location_code,
           d.doc_no AS created_doc_no
      FROM remnants r
      JOIN slabs s ON s.id = r.slab_id
      LEFT JOIN locations loc ON loc.id = r.location_id
      LEFT JOIN docs d ON d.id = r.created_doc_id
     WHERE r.status = 'available' AND (? IS NULL OR r.slab_id = ?)
     ORDER BY s.code, r.sqm DESC`).all(slabId, slabId);
}

/** Live stock per slab colour — what sales sees. */
function stockOverview(db) {
  const t = today();
  const slabs = db.prepare('SELECT * FROM slabs ORDER BY code').all();
  const balances = slabBalances(db);
  const locks = listLocks(db, { asOf: t });
  const locked = lockedBySlab(locks);
  const pending = new Map();
  for (const k of locks) if (k.state === 'pending') pending.set(k.slab_id, (pending.get(k.slab_id) || 0) + k.pcs);

  const rem = new Map();
  for (const r of db.prepare(`SELECT slab_id, COUNT(*) AS n, SUM(sqm) AS sqm FROM remnants
                               WHERE status = 'available' GROUP BY slab_id`).all()) rem.set(r.slab_id, r);

  const incoming = new Map();
  for (const r of db.prepare(`
      SELECT l.slab_id, SUM(l.qty) AS qty, MIN(d.eta) AS eta
        FROM lines l JOIN docs d ON d.id = l.doc_id
       WHERE d.type = 'inbound' AND d.status = 'expected' AND l.kind = 'slab_in'
       GROUP BY l.slab_id`).all()) incoming.set(r.slab_id, r);

  // sales in the last 90 days -> average per month
  const sold = new Map();
  for (const r of db.prepare(`
      SELECT l.slab_id, SUM(l.sqm) AS sqm,
             SUM(CASE WHEN l.kind IN ('slab_out','slab_cut') THEN l.qty ELSE 0 END) AS pcs
        FROM lines l JOIN docs d ON d.id = l.doc_id
       WHERE d.type = 'outbound' AND d.status = 'posted' AND d.date > ? AND l.slab_id IS NOT NULL
       GROUP BY l.slab_id`).all(addDays(t, -90))) sold.set(r.slab_id, r);

  const glueBySlab = glueStockBySlab(db, t);

  const rows = slabs.map((s) => {
    const area = slabArea(s);
    const locs = balances.filter((b) => b.slab_id === s.id).map((b) => ({ location_id: b.location_id, location_code: b.location_code, qty: b.qty }));
    const onHand = locs.reduce((a, b) => a + b.qty, 0);
    const lk = locked.get(s.id) || 0;
    const rm = rem.get(s.id) || { n: 0, sqm: 0 };
    const inc = incoming.get(s.id) || { qty: 0, eta: null };
    const sd = sold.get(s.id) || { sqm: 0, pcs: 0 };
    const totalSqm = r3(onHand * area + (rm.sqm || 0));
    const avgSqm = r3((sd.sqm || 0) / 3);
    const available = onHand - lk;
    let status = 'ok';
    if (onHand <= 0 && !rm.n) status = 'out';
    else if (available < 0) status = 'overlocked';
    else if (s.min_pcs > 0 && available < s.min_pcs) status = 'low';
    return {
      id: s.id, code: s.code, name: s.name, color_hex: s.color_hex, active: s.active,
      thickness_mm: s.thickness_mm, width_mm: s.width_mm, length_mm: s.length_mm, area,
      min_pcs: s.min_pcs,
      on_hand: onHand, locked: lk, available, pending_lock: pending.get(s.id) || 0,
      locations: locs,
      remnant_count: rm.n || 0, remnant_sqm: r3(rm.sqm || 0),
      total_sqm: totalSqm,
      incoming: inc.qty || 0, next_eta: inc.eta || null,
      sold_90d_sqm: r3(sd.sqm || 0), sold_90d_pcs: sd.pcs || 0, avg_month_sqm: avgSqm,
      months_cover: avgSqm > 0 ? r3(totalSqm / avgSqm) : null,
      glue_usable: glueBySlab.get(s.id) || 0,
      status,
    };
  }).filter((r) => r.active || r.on_hand || r.remnant_count || r.incoming);
  return rows;
}

// ---- glue ------------------------------------------------------------------

function lotBalances(db) {
  return db.prepare(`
    SELECT gl.*, g.code AS glue_code, g.name AS glue_name, g.color AS glue_color, g.unit,
           COALESCE(b.qty, 0) AS qty
      FROM glue_lots gl
      JOIN glues g ON g.id = gl.glue_id
      LEFT JOIN (SELECT lot_id, SUM(qty) AS qty FROM moves WHERE item = 'glue' GROUP BY lot_id) b ON b.lot_id = gl.id
     ORDER BY gl.expiry, gl.id`).all();
}

function lotState(expiry, t, warnDays) {
  if (expiry < t) return 'expired';
  if (expiry <= addDays(t, warnDays)) return 'expiring';
  return 'ok';
}

function glueStockBySlab(db, t) {
  const m = new Map();
  const rows = db.prepare(`
    SELECT gm.slab_id, SUM(b.qty) AS qty
      FROM glue_matches gm
      JOIN glue_lots gl ON gl.glue_id = gm.glue_id AND gl.expiry >= ?
      JOIN (SELECT lot_id, SUM(qty) AS qty FROM moves WHERE item = 'glue' GROUP BY lot_id) b ON b.lot_id = gl.id
     GROUP BY gm.slab_id`).all(t);
  for (const r of rows) m.set(r.slab_id, r.qty);
  return m;
}

function glueOverview(db) {
  const t = today();
  const warn = Number(getSettings(db).expiry_warn_days) || 60;
  const glues = db.prepare('SELECT * FROM glues ORDER BY code').all();
  const matches = db.prepare(`SELECT gm.glue_id, s.id, s.code, s.name FROM glue_matches gm
                               JOIN slabs s ON s.id = gm.slab_id ORDER BY s.code`).all();
  const lots = lotBalances(db).filter((l) => l.qty !== 0);
  return glues.map((g) => {
    const gl = lots.filter((l) => l.glue_id === g.id).map((l) => ({
      id: l.id, lot_no: l.lot_no, expiry: l.expiry, received_date: l.received_date, qty: l.qty,
      state: lotState(l.expiry, t, warn),
      days_left: Math.round((Date.parse(l.expiry) - Date.parse(t)) / 864e5),
    }));
    const sum = (st) => gl.filter((l) => !st || st.includes(l.state)).reduce((a, l) => a + l.qty, 0);
    const usable = sum(['ok', 'expiring']);
    let status = 'ok';
    if (usable <= 0) status = 'out';
    else if (g.min_qty > 0 && usable < g.min_qty) status = 'low';
    return {
      ...g,
      matches: matches.filter((m) => m.glue_id === g.id).map(({ id, code, name }) => ({ id, code, name })),
      lots: gl,
      on_hand: sum(), usable, expiring: sum(['expiring']), expired: sum(['expired']),
      next_expiry: gl.find((l) => l.state !== 'expired')?.expiry || null,
      status,
    };
  }).filter((g) => g.active || g.on_hand);
}

module.exports = {
  slabArea, listLocks, lockedBySlab, slabBalances, onHandAt, onHandTotal,
  availableRemnants, stockOverview, lotBalances, lotState, glueOverview,
};
