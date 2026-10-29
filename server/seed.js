#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   node server/seed.js colors   -> adds the 28 slab colours, rack locations and glue colours (no stock)
 *   node server/seed.js demo     -> colours + a full set of demo transactions (use a separate DATA_DIR!)
 */
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...r) => (String((w && w.message) || w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...r));

const path = require('node:path');
const { openDb, setSetting } = require('./db');
const { ensureAdmin, hashPassword } = require('./auth');
const D = require('./docs');
const { today, addDays, nowIso } = require('./util');

// Colours from the current stock sheet (code, name, stock pcs)
const COLORS = [
  ['S-008', 'N-WHITE', 240], ['P-004', 'Solaris', 76], ['P-005', 'Night Gleam', 10], ['D-048', 'Crystal Mirror', 0],
  ['T-021', 'Pure Arctic', 90], ['T-235', 'Thetis', 12], ['ST-101', 'Clara', 74], ['VM-003', 'Venato Blanc', 0],
  ['VM-001', 'Venato Sparkle', 75], ['VM-004', 'Venato Champagne', 74], ['S-002', 'White (B)', 4], ['CT-006', 'Melange Concrete', 4],
  ['D-013', 'Night Light', 43], ['CS-501', 'Calacatta Glory', 15], ['CS-502', 'Black Desert', 14], ['ST-103', 'Nublado', 46],
  ['CC-012', 'Cascade Camel', 17], ['CC-010', 'Cascade Pure Grey', 35], ['ST-201', 'Romano', 22], ['ST-102', 'Marelinho', 48],
  ['CC-001', 'Cascade Ice', 39], ['CC-002', 'Cascade Cream', 33], ['D-047', 'Cream Cheese', 31], ['D-024', 'Silver White', 24],
  ['CS-405', 'Vanilla Cream', 16], ['CS-406', 'Still White', 22], ['T-050', 'Ice Queen', 24], ['D-046', 'Lut Desert', 72],
];
const SWATCH = {
  'S-008': '#f4f4f1', 'P-004': '#e9dcc0', 'P-005': '#2c2f36', 'D-048': '#d9dde3', 'T-021': '#f7f8f8', 'T-235': '#cfc6b8',
  'ST-101': '#e8e4dc', 'VM-003': '#efede8', 'VM-001': '#e6e4df', 'VM-004': '#e5d8c3', 'S-002': '#f1f0ec', 'CT-006': '#9c9a95',
  'D-013': '#3a3a40', 'CS-501': '#f2efe8', 'CS-502': '#1f1d1c', 'ST-103': '#d8d2c6', 'CC-012': '#c8a982', 'CC-010': '#a7a9ab',
  'ST-201': '#bdb6aa', 'ST-102': '#ddd6cb', 'CC-001': '#e9eef0', 'CC-002': '#efe4cf', 'D-047': '#f1e6cf', 'D-024': '#d8d9db',
  'CS-405': '#f0e3c8', 'CS-406': '#f5f5f2', 'T-050': '#eef2f4', 'D-046': '#c49a6c',
};
const GLUES = [
  ['G-WH', 'Glue White', 'White', ['S-008', 'T-021', 'S-002', 'CS-406', 'T-050', 'CC-001', 'CS-501']],
  ['G-SW', 'Glue Silver White', 'Silver white', ['D-024', 'VM-003', 'VM-001', 'ST-101']],
  ['G-CR', 'Glue Cream', 'Cream', ['D-047', 'CS-405', 'CC-002', 'P-004', 'VM-004']],
  ['G-BG', 'Glue Beige', 'Beige', ['D-046', 'CC-012', 'ST-103', 'T-235', 'ST-102']],
  ['G-GR', 'Glue Grey', 'Grey', ['CC-010', 'CT-006', 'ST-201', 'D-048']],
  ['G-BK', 'Glue Black', 'Black', ['CS-502', 'P-005', 'D-013']],
];
const RACKS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'C1', 'C2', 'OFFCUT-1', 'OFFCUT-2'];

function seedColors(db) {
  const insSlab = db.prepare(`INSERT OR IGNORE INTO slabs (code, name, thickness_mm, width_mm, length_mm, min_pcs, color_hex) VALUES (?, ?, 12, 760, 3680, ?, ?)`);
  for (const [code, name, stock] of COLORS) insSlab.run(code, name, stock >= 40 ? 15 : 5, SWATCH[code] || '');
  const insLoc = db.prepare('INSERT OR IGNORE INTO locations (code, name) VALUES (?, ?)');
  for (const c of RACKS) insLoc.run(c, c.startsWith('OFFCUT') ? 'Offcut rack' : `Rack ${c[0]}`);
  for (const [code, name, color, matches] of GLUES) {
    db.prepare(`INSERT OR IGNORE INTO glues (code, name, color, unit, shelf_life_months, min_qty) VALUES (?, ?, ?, 'pcs', 12, 20)`).run(code, name, color);
    const g = db.prepare('SELECT id FROM glues WHERE code = ?').get(code);
    for (const sc of matches) {
      const s = db.prepare('SELECT id FROM slabs WHERE code = ?').get(sc);
      if (s) db.prepare('INSERT OR IGNORE INTO glue_matches (glue_id, slab_id) VALUES (?, ?)').run(g.id, s.id);
    }
  }
}

function seedDemo(db) {
  seedColors(db);
  if (db.prepare('SELECT COUNT(*) AS n FROM docs').get().n) {
    console.log('Database already has documents — demo transactions skipped.');
    return;
  }
  // deterministic pseudo-random
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const mkUser = (username, name, role) => {
    db.prepare(`INSERT OR IGNORE INTO users (username, name, role, pw_hash, must_change, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .run(username, name, role, hashPassword('demo1234'), nowIso());
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  };
  const scm = mkUser('scm', 'Minho (SCM)', 'scm');
  const sales1 = mkUser('sales', 'Jisoo (Sales)', 'sales');
  mkUser('sales2', 'Daniel (Sales)', 'sales');

  const customers = [
    ['Hanil Interior', 1, 'Mr. Park', '010-2345-6789', 'Seongsu-dong 2-ga 301, Seoul'],
    ['Daewoo Kitchen Works', 1, 'Ms. Lee', '010-3456-7890', 'Gimpo Industrial Complex B-12'],
    ['Seoul Hotel Renovation', 0, 'Site office', '02-555-0101', 'Jung-gu Sogong-ro 106, Seoul'],
    ['Busan Marina Tower', 0, 'Mr. Choi', '051-700-1234', 'Haeundae Marine City 2-ro 38, Busan'],
    ['Lotte Mall Fit-out', 1, 'Ms. Kim', '010-9876-5432', 'Songpa-gu Olympic-ro 300, Seoul'],
    ['Green Lab Furniture', 0, 'Mr. Jung', '031-888-2222', 'Paju Book City 145'],
  ];
  for (const c of customers) db.prepare('INSERT OR IGNORE INTO customers (name, key_account, contact, phone, address) VALUES (?, ?, ?, ?, ?)').run(...c);
  const cust = db.prepare('SELECT * FROM customers').all();
  const slabs = db.prepare('SELECT * FROM slabs').all();
  const byCode = (c) => slabs.find((s) => s.code === c);
  const locs = db.prepare('SELECT * FROM locations').all();
  const rack = (c) => locs.find((l) => l.code === c).id;
  const glues = db.prepare('SELECT * FROM glues').all();

  const t = today();
  const start = addDays(t, -75);
  setSetting(db, 'go_live_date', start);
  setSetting(db, 'company_name', 'Solid Surface Korea (demo)');

  // Opening stock spread over racks
  const lines = [];
  COLORS.forEach(([code, , stock], i) => {
    const s = byCode(code);
    const qty = stock + 25; // a bit more so 75 days of deliveries fit
    const r1 = RACKS[i % 12];
    const r2 = RACKS[(i + 5) % 12];
    lines.push({ kind: 'slab_in', slab_id: s.id, location_id: rack(r1), qty: Math.ceil(qty * 0.7) });
    lines.push({ kind: 'slab_in', slab_id: s.id, location_id: rack(r2), qty: Math.floor(qty * 0.3) });
  });
  for (let i = 0; i < 9; i++) {
    lines.push({ kind: 'remnant_in', slab_id: pick(slabs).id, location_id: rack(pick(['OFFCUT-1', 'OFFCUT-2'])), width_mm: 760, length_mm: 600 + Math.floor(rnd() * 2400) });
  }
  glues.forEach((g, i) => {
    lines.push({ kind: 'glue_in', glue_id: g.id, qty: 30 + i * 6, lot_no: `L${2600 + i}A`, expiry: addDays(t, i === 1 ? -5 : 20 + i * 15) });
    lines.push({ kind: 'glue_in', glue_id: g.id, qty: 40, lot_no: `L${2600 + i}B`, expiry: addDays(t, 200 + i * 20) });
  });
  D.createDoc(db, scm, { type: 'opening', date: start, note: 'Stock count at go-live', lines });

  // Deliveries over the last 75 days
  const popular = ['S-008', 'S-008', 'T-021', 'P-004', 'D-046', 'ST-101', 'VM-004', 'CC-010', 'D-047', 'CC-001', 'ST-103', 'VM-001'];
  for (let d = 1; d <= 74; d++) {
    const day = addDays(start, d);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow === 0) continue;
    const n = dow === 6 ? 1 : 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const c = pick(cust);
      const s = byCode(pick(popular));
      const bal = db.prepare(`SELECT location_id, SUM(qty) AS q FROM moves WHERE item = 'slab' AND slab_id = ? GROUP BY location_id HAVING q > 0 ORDER BY q DESC`).all(s.id);
      if (!bal.length) continue;
      const docLines = [];
      if (rnd() < 0.3) {
        docLines.push({ kind: 'slab_cut', slab_id: s.id, location_id: bal[0].location_id, sqm: Math.round((0.6 + rnd() * 1.6) * 100) / 100, leftover_location_id: rack('OFFCUT-1') });
      } else {
        docLines.push({ kind: 'slab_out', slab_id: s.id, location_id: bal[0].location_id, qty: Math.min(bal[0].q, 1 + Math.floor(rnd() * 6)) });
      }
      const g = glues.find((x) => db.prepare('SELECT 1 FROM glue_matches WHERE glue_id = ? AND slab_id = ?').get(x.id, s.id));
      if (g && rnd() < 0.7) docLines.push({ kind: 'glue_out', glue_id: g.id, qty: 1 + Math.floor(rnd() * 3) });
      try {
        D.createDoc(db, scm, {
          type: 'outbound', date: day, customer_id: c.id, deliver_to: c.address, contact: c.contact,
          reference: `DO-${day.replace(/-/g, '').slice(2)}-${k + 1}`, sales_person: pick(['Jisoo (Sales)', 'Daniel (Sales)']), lines: docLines,
        });
      } catch (e) {
        // skip deliveries that don't fit the random stock
      }
    }
  }

  // An adjustment
  D.createDoc(db, scm, { type: 'adjust', date: addDays(t, -20), reason: 'Damaged / broken', note: 'Forklift damage', lines: [{ kind: 'slab_adj', slab_id: byCode('CC-002').id, location_id: db.prepare(`SELECT location_id FROM moves WHERE item='slab' AND slab_id=? AND qty>0 LIMIT 1`).get(byCode('CC-002').id).location_id, qty: -1 }] });

  // Incoming shipments
  D.createDoc(db, scm, {
    type: 'inbound', status: 'expected', partner: 'Supplier Co. Ltd', reference: 'PO-2611 / BL MSKU1234567', eta: addDays(t, 9), ship_status: 'on_board',
    lines: [
      { kind: 'slab_in', slab_id: byCode('S-008').id, qty: 75 }, { kind: 'slab_in', slab_id: byCode('D-048').id, qty: 75 },
      { kind: 'slab_in', slab_id: byCode('P-005').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('S-002').id, qty: 50 },
      { kind: 'glue_in', glue_id: glues[0].id, qty: 60 },
    ],
  });
  D.createDoc(db, scm, {
    type: 'inbound', status: 'expected', partner: 'Supplier Co. Ltd', reference: 'PO-2612', eta: addDays(t, 34), ship_status: 'ordered',
    lines: [{ kind: 'slab_in', slab_id: byCode('T-235').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('CT-006').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('CS-405').id, qty: 25 }],
  });

  // Locks
  const custBy = (n) => cust.find((c) => c.name === n).id;
  D.createLock(db, scm, { customer_id: custBy('Lotte Mall Fit-out'), slab_id: byCode('VM-004').id, pcs: 14, expires_on: addDays(t, 21), note: 'Phase 2 counters' });
  D.createLock(db, scm, { customer_id: custBy('Hanil Interior'), slab_id: byCode('D-047').id, pcs: 12, expires_on: addDays(t, 2), note: 'Apartment project' });
  D.createLock(db, scm, { customer_id: custBy('Daewoo Kitchen Works'), slab_id: byCode('D-046').id, pcs: 18, expires_on: addDays(t, 30) });
  D.createLock(db, sales1, { customer_id: custBy('Busan Marina Tower'), slab_id: byCode('T-021').id, pcs: 10, expires_on: addDays(t, 14), note: 'Lobby reception desk' });
}

module.exports = { seedColors, seedDemo };

if (require.main === module) {
  const mode = process.argv[2];
  if (!['colors', 'demo'].includes(mode)) {
    console.log('Usage: node server/seed.js colors|demo');
    process.exit(1);
  }
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const db = openDb(path.join(DATA_DIR, 'stock.db'));
  const pw = ensureAdmin(db, process.env.ADMIN_PASSWORD);
  if (pw) console.log(`Admin account created — username: admin, password: ${pw}`);
  if (mode === 'colors') {
    seedColors(db);
    console.log(`Added ${COLORS.length} slab colours, ${RACKS.length} racks and ${GLUES.length} glue colours.`);
  } else seedDemo(db);
  db.close();
}
