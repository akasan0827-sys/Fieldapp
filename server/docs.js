'use strict';
const { tx, getSettings, audit } = require('./db');
const U = require('./util');
const { bad, HttpError, r3, today, nowIso, str, num, id, date, oneOf, addMonths } = U;
const { slabArea, listLocks, lockedBySlab, onHandAt, onHandTotal } = require('./stock');

const PREFIX = { opening: 'OPN', inbound: 'IN', outbound: 'OUT', adjust: 'ADJ', transfer: 'TRF' };
const KINDS = {
  opening: ['slab_in', 'remnant_in', 'glue_in'],
  inbound: ['slab_in', 'glue_in'],
  outbound: ['slab_out', 'slab_cut', 'remnant_out', 'remnant_cut', 'glue_out'],
  adjust: ['slab_adj', 'glue_adj', 'remnant_in', 'remnant_scrap'],
  transfer: ['slab_move', 'remnant_move'],
};
const SHIP_STATUS = ['ordered', 'on_board', 'at_port'];
const MIN_OFFCUT_SQM = 0.005; // anything smaller is treated as waste
const TOL = 0.0005;

// ---- lookups ----------------------------------------------------------------

function getSlab(db, v, name = 'Slab colour') {
  const s = db.prepare('SELECT * FROM slabs WHERE id = ?').get(id(v, name));
  if (!s) throw bad(`${name} not found`);
  return s;
}
function getLoc(db, v, name = 'Rack location') {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(id(v, name));
  if (!l) throw bad(`${name} not found`);
  return l;
}
function getGlue(db, v) {
  const g = db.prepare('SELECT * FROM glues WHERE id = ?').get(id(v, 'Glue'));
  if (!g) throw bad('Glue not found');
  return g;
}
function getLot(db, v) {
  const l = db.prepare('SELECT * FROM glue_lots WHERE id = ?').get(id(v, 'Glue lot'));
  if (!l) throw bad('Glue lot not found');
  return l;
}
function getAvailableRemnant(db, v) {
  const r = db.prepare('SELECT * FROM remnants WHERE id = ?').get(id(v, 'Offcut'));
  if (!r) throw bad('Offcut not found');
  if (r.status !== 'available') throw bad(`Offcut ${r.code} is no longer in stock (${r.status})`);
  return r;
}
const lotBalance = (db, lotId) =>
  db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM moves WHERE item = 'glue' AND lot_id = ?`).get(lotId).q;

function checkOpenPeriod(db, d) {
  const closed = getSettings(db).closed_through;
  if (closed && d.slice(0, 7) <= closed) {
    throw bad(`${d.slice(0, 7)} is a closed month. Use a later date, or ask an admin to reopen the month.`);
  }
}

function nextDocNo(db, type, d) {
  const p = `${PREFIX[type]}-${d.slice(2, 4)}${d.slice(5, 7)}-`;
  const last = db.prepare('SELECT doc_no FROM docs WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1').get(`${p}%`);
  const n = last ? Number(last.doc_no.slice(p.length)) + 1 : 1;
  return p + U.pad(n, 4);
}

// ---- header -----------------------------------------------------------------

function parseHeader(db, input) {
  const type = oneOf(input.type, 'Document type', Object.keys(PREFIX));
  const expected = type === 'inbound' && input.status === 'expected';
  const h = {
    type,
    status: expected ? 'expected' : 'posted',
    date: date(input.date || today(), 'Date'),
    customer_id: null,
    partner: str(input.partner, 'Supplier', { max: 200 }),
    deliver_to: str(input.deliver_to, 'Delivered to', { max: 500 }),
    contact: str(input.contact, 'Contact', { max: 200 }),
    reference: str(input.reference, 'Reference', { max: 100 }),
    sales_person: str(input.sales_person, 'Sales person', { max: 100 }),
    reason: str(input.reason, 'Reason', { max: 100 }),
    eta: null,
    ship_status: '',
    note: str(input.note, 'Note', { max: 1000 }),
  };
  if (type === 'outbound') {
    h.customer_id = id(input.customer_id, 'Customer');
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(h.customer_id)) throw bad('Customer not found');
    if (!h.deliver_to) throw bad('"Delivered to" (site / address) is required');
  }
  if (type === 'adjust' && !h.reason) throw bad('Reason is required for adjustments');
  if (expected) {
    h.eta = date(input.eta, 'ETA', { required: false });
    h.ship_status = oneOf(input.ship_status || 'ordered', 'Shipment status', SHIP_STATUS);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw bad('Add at least one line');
  if (input.lines.length > 500) throw bad('Too many lines (max 500)');
  return h;
}

// ---- posting ----------------------------------------------------------------

function lineWriter(db, doc) {
  const ins = db.prepare(`
    INSERT INTO lines (doc_id, kind, slab_id, glue_id, lot_id, remnant_id, location_id, to_location_id,
                       qty, sqm, leftover_sqm, waste_sqm, width_mm, length_mm, new_remnant_id, lock_id,
                       lot_no, expiry, note)
    VALUES (:doc_id, :kind, :slab_id, :glue_id, :lot_id, :remnant_id, :location_id, :to_location_id,
            :qty, :sqm, :leftover_sqm, :waste_sqm, :width_mm, :length_mm, :new_remnant_id, :lock_id,
            :lot_no, :expiry, :note)`);
  return (o) => Number(ins.run({
    doc_id: doc.id, slab_id: null, glue_id: null, lot_id: null, remnant_id: null, location_id: null,
    to_location_id: null, qty: 0, sqm: 0, leftover_sqm: 0, waste_sqm: 0, width_mm: null, length_mm: null,
    new_remnant_id: null, lock_id: null, lot_no: '', expiry: null, note: '', ...o,
  }).lastInsertRowid);
}

/** Offcut size from sqm and/or width x length (mm). */
function parseSize(raw, prefix, { defaultSqm = null, required = true, label = 'Size' } = {}) {
  const w = num(raw[`${prefix}width_mm`], `${label} width (mm)`, { required: false, positive: true, max: 10000 });
  const l = num(raw[`${prefix}length_mm`], `${label} length (mm)`, { required: false, positive: true, max: 10000 });
  let sqm = num(raw[`${prefix}sqm`], `${label} m²`, { required: false, min: 0, max: 100 });
  if (sqm === null && w && l) sqm = (w * l) / 1e6;
  if (sqm === null) sqm = defaultSqm;
  if (sqm === null && required) throw bad(`${label}: enter m² or width × length`);
  return { sqm: sqm === null ? null : r3(sqm), width_mm: w, length_mm: l };
}

function postLines(db, doc, rawLines) {
  const allowed = KINDS[doc.type];
  const writeLine = lineWriter(db, doc);
  const insMove = db.prepare(`INSERT INTO moves (doc_id, line_id, date, item, slab_id, glue_id, lot_id, location_id, qty)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const slabLocs = new Map(); // "slab:loc" -> pcs taken out by this doc
  const lots = new Set();
  const nonLockOut = new Map(); // slab -> pcs delivered without a lock
  const locksUsed = new Map(); // lock -> pcs delivered against it by this doc

  const move = (lineId, o) => {
    insMove.run(doc.id, lineId, doc.date, o.item, o.slab_id ?? null, o.glue_id ?? null, o.lot_id ?? null, o.location_id ?? null, o.qty);
    if (o.item === 'slab') {
      const k = `${o.slab_id}:${o.location_id}`;
      slabLocs.set(k, (slabLocs.get(k) || 0) + (o.qty < 0 ? -o.qty : 0));
    } else lots.add(o.lot_id);
  };

  const newRemnant = ({ slab_id, location_id, sqm, width_mm = null, length_mm = null, parent_id = null, note = '' }) => {
    const rid = Number(db.prepare(`
      INSERT INTO remnants (slab_id, location_id, width_mm, length_mm, sqm, status, parent_id, created_doc_id, created_date, note)
      VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, ?)`)
      .run(slab_id, location_id, width_mm, length_mm, r3(sqm), parent_id, doc.id, doc.date, note).lastInsertRowid);
    db.prepare('UPDATE remnants SET code = ? WHERE id = ?').run(`R-${U.pad(rid, 5)}`, rid);
    return rid;
  };
  const closeRemnant = (rem, status) =>
    db.prepare('UPDATE remnants SET status = ?, closed_doc_id = ?, closed_date = ? WHERE id = ?').run(status, doc.id, doc.date, rem.id);

  const useLock = (raw, slab, qty) => {
    const lockId = id(raw.lock_id, 'Lock', { required: false });
    if (!lockId) {
      nonLockOut.set(slab.id, (nonLockOut.get(slab.id) || 0) + qty);
      return null;
    }
    const k = db.prepare('SELECT * FROM locks WHERE id = ?').get(lockId);
    if (!k) throw bad(`Lock #${lockId} not found`);
    if (k.status !== 'active') throw bad(`Lock #${lockId} is not active (${k.status})`);
    if (k.slab_id !== slab.id) throw bad(`Lock #${lockId} is for a different colour`);
    if (k.customer_id !== doc.customer_id) throw bad(`Lock #${lockId} belongs to another customer`);
    if (k.expires_on && k.expires_on < doc.date) throw bad(`Lock #${lockId} expired on ${k.expires_on}`);
    locksUsed.set(lockId, (locksUsed.get(lockId) || 0) + qty);
    return lockId;
  };

  const leftover = (raw, maxSqm) => parseSize(raw, 'leftover_', { defaultSqm: Math.max(0, r3(maxSqm)), label: 'Leftover' });

  rawLines.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object') throw bad('Invalid line');
      const kind = oneOf(raw.kind, 'Line type', allowed);
      const note = str(raw.note, 'Note', { max: 300 });
      switch (kind) {
        case 'slab_in': {
          const s = getSlab(db, raw.slab_id);
          const loc = getLoc(db, raw.location_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 100000 });
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty });
          break;
        }
        case 'slab_out': {
          const s = getSlab(db, raw.slab_id);
          const loc = getLoc(db, raw.location_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 100000 });
          const lockId = useLock(raw, s, qty);
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), lock_id: lockId, note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty: -qty });
          break;
        }
        case 'slab_cut': {
          const s = getSlab(db, raw.slab_id);
          const loc = getLoc(db, raw.location_id);
          const area = slabArea(s);
          const sqm = r3(num(raw.sqm, 'Delivered m²', { positive: true, max: area + TOL }));
          const lo = leftover(raw, area - sqm);
          if (sqm + lo.sqm > area + TOL) throw bad(`Delivered + leftover (${r3(sqm + lo.sqm)} m²) is more than one slab (${r3(area)} m²)`);
          const lockId = useLock(raw, s, 1);
          const leftLoc = raw.leftover_location_id ? getLoc(db, raw.leftover_location_id, 'Leftover rack') : loc;
          const keep = lo.sqm >= MIN_OFFCUT_SQM;
          const rid = keep ? newRemnant({ slab_id: s.id, location_id: leftLoc.id, sqm: lo.sqm, width_mm: lo.width_mm, length_mm: lo.length_mm, note: `Offcut from ${doc.doc_no}` }) : null;
          const lid = writeLine({
            kind, slab_id: s.id, location_id: loc.id, to_location_id: keep ? leftLoc.id : null, qty: 1, sqm,
            leftover_sqm: keep ? lo.sqm : 0, waste_sqm: r3(area - sqm - (keep ? lo.sqm : 0)),
            width_mm: lo.width_mm, length_mm: lo.length_mm, new_remnant_id: rid, lock_id: lockId, note,
          });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty: -1 });
          break;
        }
        case 'remnant_out': {
          const rem = getAvailableRemnant(db, raw.remnant_id);
          closeRemnant(rem, 'used');
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, sqm: rem.sqm, note });
          break;
        }
        case 'remnant_cut': {
          const rem = getAvailableRemnant(db, raw.remnant_id);
          const sqm = r3(num(raw.sqm, 'Delivered m²', { positive: true }));
          if (sqm > rem.sqm + TOL) throw bad(`Offcut ${rem.code} is only ${rem.sqm} m²`);
          const lo = leftover(raw, rem.sqm - sqm);
          if (sqm + lo.sqm > rem.sqm + TOL) throw bad(`Delivered + leftover (${r3(sqm + lo.sqm)} m²) is more than offcut ${rem.code} (${rem.sqm} m²)`);
          closeRemnant(rem, 'used');
          const leftLocId = raw.leftover_location_id ? getLoc(db, raw.leftover_location_id, 'Leftover rack').id : rem.location_id;
          const keep = lo.sqm >= MIN_OFFCUT_SQM;
          const rid = keep ? newRemnant({ slab_id: rem.slab_id, location_id: leftLocId, sqm: lo.sqm, width_mm: lo.width_mm, length_mm: lo.length_mm, parent_id: rem.id, note: `Cut from ${rem.code} (${doc.doc_no})` }) : null;
          writeLine({
            kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, to_location_id: keep ? leftLocId : null,
            sqm, leftover_sqm: keep ? lo.sqm : 0, waste_sqm: r3(rem.sqm - sqm - (keep ? lo.sqm : 0)),
            width_mm: lo.width_mm, length_mm: lo.length_mm, new_remnant_id: rid, note,
          });
          break;
        }
        case 'remnant_in': {
          const s = getSlab(db, raw.slab_id);
          const loc = getLoc(db, raw.location_id);
          const size = parseSize(raw, '', { label: 'Offcut' });
          if (size.sqm <= 0) throw bad('Offcut m² must be greater than 0');
          if (size.sqm > slabArea(s) + TOL) throw bad(`An offcut can't be bigger than a full slab (${r3(slabArea(s))} m²)`);
          const rid = newRemnant({ slab_id: s.id, location_id: loc.id, ...size, note });
          writeLine({ kind, slab_id: s.id, location_id: loc.id, sqm: size.sqm, width_mm: size.width_mm, length_mm: size.length_mm, new_remnant_id: rid, note });
          break;
        }
        case 'remnant_scrap': {
          const rem = getAvailableRemnant(db, raw.remnant_id);
          closeRemnant(rem, 'scrapped');
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, sqm: rem.sqm, waste_sqm: rem.sqm, note });
          break;
        }
        case 'remnant_move': {
          const rem = getAvailableRemnant(db, raw.remnant_id);
          const to = getLoc(db, raw.to_location_id, 'New rack');
          if (to.id === rem.location_id) throw bad(`Offcut ${rem.code} is already in ${to.code}`);
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, to_location_id: to.id, sqm: rem.sqm, note });
          db.prepare('UPDATE remnants SET location_id = ? WHERE id = ?').run(to.id, rem.id);
          break;
        }
        case 'glue_in': {
          const g = getGlue(db, raw.glue_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
          const lotNo = str(raw.lot_no, 'Lot / batch no.', { required: true, max: 60 });
          const expiry = date(raw.expiry || addMonths(doc.date, g.shelf_life_months), 'Expiry date');
          let lot = db.prepare('SELECT * FROM glue_lots WHERE glue_id = ? AND lot_no = ?').get(g.id, lotNo);
          if (lot && lot.expiry !== expiry) throw bad(`Lot ${lotNo} of ${g.code} already exists with expiry ${lot.expiry}`);
          if (!lot) {
            const lotId = Number(db.prepare('INSERT INTO glue_lots (glue_id, lot_no, expiry, received_date, created_doc_id) VALUES (?, ?, ?, ?, ?)')
              .run(g.id, lotNo, expiry, doc.date, doc.id).lastInsertRowid);
            lot = { id: lotId };
          }
          const lid = writeLine({ kind, glue_id: g.id, lot_id: lot.id, qty, lot_no: lotNo, expiry, note });
          move(lid, { item: 'glue', glue_id: g.id, lot_id: lot.id, qty });
          break;
        }
        case 'glue_out': {
          const g = getGlue(db, raw.glue_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
          let alloc = [];
          if (raw.lot_id) {
            const lot = getLot(db, raw.lot_id);
            if (lot.glue_id !== g.id) throw bad('That lot belongs to a different glue');
            if (lot.expiry < doc.date) throw bad(`Lot ${lot.lot_no} expired on ${lot.expiry}`);
            alloc = [{ lot, q: qty }];
          } else {
            // First-expiry-first-out over non-expired lots
            const lotsAvail = db.prepare(`
              SELECT gl.*, SUM(m.qty) AS bal FROM glue_lots gl JOIN moves m ON m.item = 'glue' AND m.lot_id = gl.id
               WHERE gl.glue_id = ? AND gl.expiry >= ? GROUP BY gl.id HAVING SUM(m.qty) > 0
               ORDER BY gl.expiry, gl.id`).all(g.id, doc.date);
            let need = qty;
            for (const lot of lotsAvail) {
              if (need <= 0) break;
              const q = Math.min(need, lot.bal);
              alloc.push({ lot, q });
              need -= q;
            }
            if (need > 0) {
              const have = qty - need;
              throw bad(`Only ${have} usable ${g.unit} of glue ${g.code} in stock (expired lots excluded)`);
            }
          }
          for (const { lot, q } of alloc) {
            const lid = writeLine({ kind, glue_id: g.id, lot_id: lot.id, qty: q, lot_no: lot.lot_no, expiry: lot.expiry, note });
            move(lid, { item: 'glue', glue_id: g.id, lot_id: lot.id, qty: -q });
          }
          break;
        }
        case 'glue_adj': {
          const lot = getLot(db, raw.lot_id);
          const qty = num(raw.qty, 'Quantity (+/-)', { int: true, min: -1000000, max: 1000000 });
          if (qty === 0) throw bad('Quantity can not be 0');
          const lid = writeLine({ kind, glue_id: lot.glue_id, lot_id: lot.id, qty, lot_no: lot.lot_no, expiry: lot.expiry, note });
          move(lid, { item: 'glue', glue_id: lot.glue_id, lot_id: lot.id, qty });
          break;
        }
        case 'slab_adj': {
          const s = getSlab(db, raw.slab_id);
          const loc = getLoc(db, raw.location_id);
          const qty = num(raw.qty, 'Quantity (+/-)', { int: true, min: -100000, max: 100000 });
          if (qty === 0) throw bad('Quantity can not be 0');
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty });
          break;
        }
        case 'slab_move': {
          const s = getSlab(db, raw.slab_id);
          const from = getLoc(db, raw.location_id, 'From rack');
          const to = getLoc(db, raw.to_location_id, 'To rack');
          if (from.id === to.id) throw bad('From and To rack are the same');
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 100000 });
          const lid = writeLine({ kind, slab_id: s.id, location_id: from.id, to_location_id: to.id, qty, note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: from.id, qty: -qty });
          move(lid, { item: 'slab', slab_id: s.id, location_id: to.id, qty });
          break;
        }
        default:
          throw bad('Unknown line type');
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) e.message = `Line ${i + 1}: ${e.message}`;
      throw e;
    }
  });

  // -- stock can never go negative at a rack or in a glue lot
  for (const [key, taken] of slabLocs) {
    const [sid, lid] = key.split(':').map(Number);
    const q = onHandAt(db, sid, lid);
    if (q < 0) {
      const s = db.prepare('SELECT code, name FROM slabs WHERE id = ?').get(sid);
      const l = db.prepare('SELECT code FROM locations WHERE id = ?').get(lid);
      throw bad(`Not enough ${s.code} ${s.name} at rack ${l.code}: only ${q + taken} pcs there`);
    }
  }
  for (const lotId of lots) {
    const q = lotBalance(db, lotId);
    if (q < 0) {
      const l = db.prepare('SELECT gl.lot_no, g.code FROM glue_lots gl JOIN glues g ON g.id = gl.glue_id WHERE gl.id = ?').get(lotId);
      throw bad(`Not enough glue ${l.code} in lot ${l.lot_no} (short by ${-q})`);
    }
  }

  // -- locks: never deliver more than the lock holds; never take stock locked for someone else
  if (locksUsed.size || nonLockOut.size) {
    const locks = listLocks(db);
    for (const [lockId, taken] of locksUsed) {
      const k = locks.find((x) => x.id === lockId);
      if (k.fulfilled > k.pcs) {
        throw bad(`Lock #${lockId} (${k.customer_name}, ${k.slab_code}) only has ${k.pcs - (k.fulfilled - taken)} pcs left`);
      }
    }
    const locked = lockedBySlab(locks);
    for (const [sid, taken] of nonLockOut) {
      const onHand = onHandTotal(db, sid);
      const lk = locked.get(sid) || 0;
      if (onHand - lk < 0) {
        const s = db.prepare('SELECT code, name FROM slabs WHERE id = ?').get(sid);
        const free = Math.max(0, onHand - lk + taken);
        throw bad(`Only ${free} pcs of ${s.code} ${s.name} are free — ${lk} pcs are locked for customers. Choose the customer's lock on the line or release a lock first.`);
      }
    }
  }
}

function planLines(db, doc, rawLines) {
  const writeLine = lineWriter(db, doc);
  rawLines.forEach((raw, i) => {
    try {
      const kind = oneOf(raw && raw.kind, 'Line type', KINDS.inbound);
      const note = str(raw.note, 'Note', { max: 300 });
      const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
      if (kind === 'slab_in') {
        const s = getSlab(db, raw.slab_id);
        const loc = raw.location_id ? getLoc(db, raw.location_id) : null;
        writeLine({ kind, slab_id: s.id, location_id: loc && loc.id, qty, sqm: r3(qty * slabArea(s)), note });
      } else {
        const g = getGlue(db, raw.glue_id);
        writeLine({ kind, glue_id: g.id, qty, lot_no: str(raw.lot_no, 'Lot', { max: 60 }), expiry: date(raw.expiry, 'Expiry', { required: false }), note });
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) e.message = `Line ${i + 1}: ${e.message}`;
      throw e;
    }
  });
}

// ---- public operations ------------------------------------------------------

function createDoc(db, user, input) {
  return tx(db, () => {
    const h = parseHeader(db, input);
    if (h.status === 'posted') checkOpenPeriod(db, h.date);
    const docNo = nextDocNo(db, h.type, h.date);
    const now = nowIso();
    const posted = h.status === 'posted';
    const docId = Number(db.prepare(`
      INSERT INTO docs (doc_no, type, status, date, customer_id, partner, deliver_to, contact, reference, sales_person,
                        reason, eta, ship_status, note, created_by, created_at, posted_by, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      docNo, h.type, h.status, h.date, h.customer_id, h.partner, h.deliver_to, h.contact, h.reference, h.sales_person,
      h.reason, h.eta, h.ship_status, h.note, user.id, now, posted ? user.id : null, posted ? now : null,
    ).lastInsertRowid);
    const doc = { id: docId, doc_no: docNo, ...h };
    if (posted) postLines(db, doc, input.lines);
    else planLines(db, doc, input.lines);
    audit(db, user.id, posted ? 'doc.post' : 'doc.expected', docNo);
    return docId;
  });
}

function voidDoc(db, user, docId, reasonIn) {
  return tx(db, () => {
    const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.status !== 'posted') throw bad('Only posted documents can be voided');
    const reason = str(reasonIn, 'Reason', { required: true, max: 300 });
    checkOpenPeriod(db, doc.date);

    for (const r of db.prepare(`SELECT r.*, d.doc_no AS closed_doc_no FROM remnants r LEFT JOIN docs d ON d.id = r.closed_doc_id
                                 WHERE r.created_doc_id = ? AND r.status <> 'void'`).all(doc.id)) {
      if (r.status !== 'available') {
        throw bad(`Offcut ${r.code} (made by this document) was already ${r.status} in ${r.closed_doc_no}. Void that document first.`);
      }
    }
    db.prepare(`UPDATE remnants SET status = 'void' WHERE created_doc_id = ?`).run(doc.id);
    db.prepare(`UPDATE remnants SET status = 'available', closed_doc_id = NULL, closed_date = NULL WHERE closed_doc_id = ?`).run(doc.id);
    for (const l of db.prepare(`SELECT * FROM lines WHERE doc_id = ? AND kind = 'remnant_move'`).all(doc.id)) {
      db.prepare('UPDATE remnants SET location_id = ? WHERE id = ? AND location_id = ?').run(l.location_id, l.remnant_id, l.to_location_id);
    }
    const mv = db.prepare('SELECT * FROM moves WHERE doc_id = ?').all(doc.id);
    db.prepare('DELETE FROM moves WHERE doc_id = ?').run(doc.id);
    for (const m of mv) {
      if (m.item === 'slab') {
        const q = onHandAt(db, m.slab_id, m.location_id);
        if (q < 0) {
          const s = db.prepare('SELECT code FROM slabs WHERE id = ?').get(m.slab_id);
          const l = db.prepare('SELECT code FROM locations WHERE id = ?').get(m.location_id);
          throw bad(`Can't void: ${s.code} at rack ${l.code} would become ${q} pcs (that stock was already delivered or moved). Void the later documents first, or post an adjustment.`);
        }
      } else if (lotBalance(db, m.lot_id) < 0) {
        const l = db.prepare('SELECT gl.lot_no, g.code FROM glue_lots gl JOIN glues g ON g.id = gl.glue_id WHERE gl.id = ?').get(m.lot_id);
        throw bad(`Can't void: glue ${l.code} lot ${l.lot_no} would go negative (already used).`);
      }
    }
    db.prepare(`UPDATE docs SET status = 'void', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?`)
      .run(user.id, nowIso(), reason, doc.id);
    audit(db, user.id, 'doc.void', `${doc.doc_no}: ${reason}`);
    return doc.id;
  });
}

/** Receive an expected (incoming) shipment, optionally keeping un-received quantities as still incoming. */
function receiveDoc(db, user, docId, input) {
  return tx(db, () => {
    const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.type !== 'inbound' || doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be received');
    const d = date(input.date || today(), 'Received date');
    checkOpenPeriod(db, d);
    if (!Array.isArray(input.lines) || !input.lines.length) throw bad('Add at least one received line');

    const planned = db.prepare('SELECT * FROM lines WHERE doc_id = ?').all(doc.id);
    db.prepare('DELETE FROM lines WHERE doc_id = ?').run(doc.id);
    const reference = input.reference !== undefined ? str(input.reference, 'Reference', { max: 100 }) : doc.reference;
    const now = nowIso();
    db.prepare(`UPDATE docs SET status = 'posted', date = ?, reference = ?, posted_by = ?, posted_at = ? WHERE id = ?`)
      .run(d, reference, user.id, now, doc.id);
    postLines(db, { ...doc, date: d, status: 'posted', reference }, input.lines);

    let remainderId = null;
    if (input.keep_remaining) {
      const key = (l) => (l.kind === 'slab_in' ? `s${l.slab_id}` : `g${l.glue_id}`);
      const got = new Map();
      for (const l of db.prepare('SELECT * FROM lines WHERE doc_id = ?').all(doc.id)) got.set(key(l), (got.get(key(l)) || 0) + l.qty);
      const rest = [];
      for (const l of planned) {
        const k = key(l);
        const have = got.get(k) || 0;
        const left = l.qty - have;
        got.set(k, Math.max(0, have - l.qty));
        if (left > 0) rest.push({ ...l, qty: left });
      }
      if (rest.length) {
        const docNo = nextDocNo(db, 'inbound', doc.date);
        remainderId = Number(db.prepare(`
          INSERT INTO docs (doc_no, type, status, date, partner, reference, eta, ship_status, note, created_by, created_at)
          VALUES (?, 'inbound', 'expected', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          docNo, doc.date, doc.partner, doc.reference, doc.eta, doc.ship_status,
          `Remaining from ${doc.doc_no}${doc.note ? ` — ${doc.note}` : ''}`, user.id, now).lastInsertRowid);
        planLines(db, { id: remainderId }, rest.map((l) => ({ ...l, lot_no: l.lot_no || '', expiry: l.expiry || '' })));
      }
    }
    audit(db, user.id, 'doc.receive', doc.doc_no);
    return { id: doc.id, remainder_id: remainderId };
  });
}

function updateExpected(db, user, docId, input) {
  return tx(db, () => {
    const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be edited');
    const f = {
      eta: input.eta !== undefined ? date(input.eta, 'ETA', { required: false }) : doc.eta,
      ship_status: input.ship_status !== undefined ? oneOf(input.ship_status, 'Shipment status', SHIP_STATUS) : doc.ship_status,
      partner: input.partner !== undefined ? str(input.partner, 'Supplier', { max: 200 }) : doc.partner,
      reference: input.reference !== undefined ? str(input.reference, 'Reference', { max: 100 }) : doc.reference,
      note: input.note !== undefined ? str(input.note, 'Note', { max: 1000 }) : doc.note,
    };
    db.prepare('UPDATE docs SET eta = ?, ship_status = ?, partner = ?, reference = ?, note = ? WHERE id = ?')
      .run(f.eta, f.ship_status, f.partner, f.reference, f.note, doc.id);
    if (Array.isArray(input.lines)) {
      if (!input.lines.length) throw bad('Add at least one line');
      db.prepare('DELETE FROM lines WHERE doc_id = ?').run(doc.id);
      planLines(db, doc, input.lines);
    }
    audit(db, user.id, 'doc.update_expected', doc.doc_no);
    return doc.id;
  });
}

function deleteExpected(db, user, docId) {
  return tx(db, () => {
    const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be deleted — void posted documents instead');
    db.prepare('DELETE FROM lines WHERE doc_id = ?').run(doc.id);
    db.prepare('DELETE FROM docs WHERE id = ?').run(doc.id);
    audit(db, user.id, 'doc.delete_expected', doc.doc_no);
  });
}

function getDoc(db, docId) {
  const doc = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
           cu.name AS created_by_name, pu.name AS posted_by_name, vu.name AS voided_by_name
      FROM docs d
      LEFT JOIN customers c ON c.id = d.customer_id
      LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN users pu ON pu.id = d.posted_by
      LEFT JOIN users vu ON vu.id = d.voided_by
     WHERE d.id = ?`).get(docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  doc.lines = db.prepare(`
    SELECT l.*, s.code AS slab_code, s.name AS slab_name, g.code AS glue_code, g.name AS glue_name, g.unit AS glue_unit,
           loc.code AS location_code, tl.code AS to_location_code,
           r.code AS remnant_code, nr.code AS new_remnant_code, nr.status AS new_remnant_status,
           k.customer_id AS lock_customer_id
      FROM lines l
      LEFT JOIN slabs s ON s.id = l.slab_id
      LEFT JOIN glues g ON g.id = l.glue_id
      LEFT JOIN locations loc ON loc.id = l.location_id
      LEFT JOIN locations tl ON tl.id = l.to_location_id
      LEFT JOIN remnants r ON r.id = l.remnant_id
      LEFT JOIN remnants nr ON nr.id = l.new_remnant_id
      LEFT JOIN locks k ON k.id = l.lock_id
     WHERE l.doc_id = ? ORDER BY l.id`).all(docId);
  return doc;
}

function listDocs(db, q = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (q.type) { where.push('d.type = ?'); args.push(q.type); }
  if (q.status) { where.push('d.status = ?'); args.push(q.status); }
  if (q.from) { where.push('d.date >= ?'); args.push(q.from); }
  if (q.to) { where.push('d.date <= ?'); args.push(q.to); }
  if (q.customer_id) { where.push('d.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.slab_id) { where.push('EXISTS (SELECT 1 FROM lines x WHERE x.doc_id = d.id AND x.slab_id = ?)'); args.push(Number(q.slab_id)); }
  if (q.q) {
    where.push(`(d.doc_no LIKE ? OR d.reference LIKE ? OR d.deliver_to LIKE ? OR d.partner LIKE ? OR d.note LIKE ?
                 OR c.name LIKE ? OR d.sales_person LIKE ?)`);
    const like = `%${q.q}%`;
    args.push(like, like, like, like, like, like, like);
  }
  const limit = Math.min(Number(q.limit) || 300, 2000);
  return db.prepare(`
    SELECT d.id, d.doc_no, d.type, d.status, d.date, d.customer_id, c.name AS customer_name, d.partner, d.deliver_to,
           d.contact, d.reference, d.sales_person, d.reason, d.eta, d.ship_status, d.note, d.void_reason, d.created_at,
           u.name AS created_by_name,
           COALESCE(SUM(CASE WHEN l.kind IN ('slab_in','slab_out','slab_adj','slab_move') THEN l.qty
                             WHEN l.kind = 'slab_cut' THEN 1 ELSE 0 END), 0) AS slab_pcs,
           COALESCE(SUM(CASE WHEN l.slab_id IS NOT NULL AND l.kind NOT IN ('slab_move','remnant_move') THEN l.sqm ELSE 0 END), 0) AS sqm,
           COALESCE(SUM(CASE WHEN l.glue_id IS NOT NULL THEN l.qty ELSE 0 END), 0) AS glue_qty,
           COUNT(l.id) AS line_count
      FROM docs d
      LEFT JOIN customers c ON c.id = d.customer_id
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN lines l ON l.doc_id = d.id
     WHERE ${where.join(' AND ')}
     GROUP BY d.id
     ORDER BY d.date DESC, d.id DESC
     LIMIT ${limit}`).all(...args).map((d) => ({ ...d, sqm: r3(d.sqm) }));
}

// ---- locks ------------------------------------------------------------------

function freeForLock(db, slabId, excludeLockId = null) {
  const locks = listLocks(db).filter((k) => k.id !== excludeLockId);
  const locked = lockedBySlab(locks).get(slabId) || 0;
  const onHand = onHandTotal(db, slabId);
  const incoming = db.prepare(`SELECT COALESCE(SUM(l.qty), 0) AS q FROM lines l JOIN docs d ON d.id = l.doc_id
                               WHERE d.type = 'inbound' AND d.status = 'expected' AND l.kind = 'slab_in' AND l.slab_id = ?`).get(slabId).q;
  return { onHand, locked, free: onHand - locked, incoming };
}

function assertLockable(db, slabId, pcs, excludeLockId = null) {
  const f = freeForLock(db, slabId, excludeLockId);
  if (pcs > Math.max(0, f.free) + f.incoming) {
    const s = db.prepare('SELECT code FROM slabs WHERE id = ?').get(slabId);
    throw bad(`Only ${Math.max(0, f.free)} pcs of ${s.code} are free to lock${f.incoming ? ` (+${f.incoming} incoming)` : ''}`);
  }
}

function createLock(db, user, input) {
  return tx(db, () => {
    const customerId = id(input.customer_id, 'Customer');
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw bad('Customer not found');
    const s = getSlab(db, input.slab_id);
    const pcs = num(input.pcs, 'Pieces', { int: true, positive: true, max: 100000 });
    const expires = date(input.expires_on, 'Lock until', { required: false });
    if (expires && expires < today()) throw bad('"Lock until" is in the past');
    const note = str(input.note, 'Note', { max: 500 });
    const direct = user.role !== 'sales';
    if (direct) assertLockable(db, s.id, pcs);
    const lockId = Number(db.prepare(`
      INSERT INTO locks (customer_id, slab_id, pcs, expires_on, status, note, requested_by, decided_by, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      customerId, s.id, pcs, expires, direct ? 'active' : 'pending', note, user.id,
      direct ? user.id : null, nowIso(), direct ? nowIso() : null).lastInsertRowid);
    audit(db, user.id, direct ? 'lock.create' : 'lock.request', `#${lockId} ${s.code} x${pcs}`);
    return lockId;
  });
}

function decideLock(db, user, lockId, action, input = {}) {
  return tx(db, () => {
    const k = db.prepare('SELECT * FROM locks WHERE id = ?').get(lockId);
    if (!k) throw new HttpError(404, 'Lock not found');
    const note = str(input.note, 'Note', { max: 500 });
    const now = nowIso();
    if (action === 'approve' || action === 'reject') {
      if (user.role === 'sales') throw new HttpError(403, 'Only SCM or admin can approve lock requests');
      if (k.status !== 'pending') throw bad('This lock is not waiting for approval');
      if (action === 'approve') {
        if (k.expires_on && k.expires_on < today()) throw bad('The requested "lock until" date has passed — extend it first');
        assertLockable(db, k.slab_id, k.pcs, k.id);
      }
      db.prepare('UPDATE locks SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
        .run(action === 'approve' ? 'active' : 'rejected', user.id, now, note, k.id);
    } else if (action === 'release') {
      const own = k.requested_by === user.id && k.status === 'pending';
      if (user.role === 'sales' && !own) throw new HttpError(403, 'Only SCM or admin can release locks');
      if (!['pending', 'active'].includes(k.status)) throw bad('This lock is already closed');
      db.prepare(`UPDATE locks SET status = 'released', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
        .run(user.id, now, note || (own ? 'Cancelled by requester' : ''), k.id);
    } else if (action === 'update') {
      if (user.role === 'sales') throw new HttpError(403, 'Only SCM or admin can change locks');
      if (!['pending', 'active'].includes(k.status)) throw bad('This lock is already closed');
      const pcs = input.pcs !== undefined ? num(input.pcs, 'Pieces', { int: true, positive: true }) : k.pcs;
      const expires = input.expires_on !== undefined ? date(input.expires_on, 'Lock until', { required: false }) : k.expires_on;
      const fulfilled = listLocks(db).find((x) => x.id === k.id).fulfilled;
      if (pcs < fulfilled) throw bad(`${fulfilled} pcs were already delivered against this lock`);
      if (k.status === 'active' && pcs > k.pcs) assertLockable(db, k.slab_id, pcs, k.id);
      db.prepare('UPDATE locks SET pcs = ?, expires_on = ?, note = ? WHERE id = ?')
        .run(pcs, expires, input.note !== undefined ? str(input.note, 'Note', { max: 500 }) : k.note, k.id);
    } else throw bad('Unknown action');
    audit(db, user.id, `lock.${action}`, `#${k.id}`);
    return k.id;
  });
}

module.exports = {
  KINDS, SHIP_STATUS, createDoc, voidDoc, receiveDoc, updateExpected, deleteExpected, getDoc, listDocs,
  createLock, decideLock, freeForLock, checkOpenPeriod,
};
