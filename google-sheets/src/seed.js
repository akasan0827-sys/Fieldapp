/*
 * Starter data shared by the Google Sheet menu ("Load my colours", "Load demo data") and the browser demo.
 */
var Seed = (function () {
  'use strict';

  // Colours from the current stock sheet: code, name, stock pcs (demo uses the stock figure)
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

  /** Adds the 28 colours, example racks and glue colours (skips anything that already exists). */
  function colors(store) {
    const has = (t, f, v) => store.t(t).some((r) => String(r[f]).toLowerCase() === String(v).toLowerCase());
    for (const [code, name, stock] of COLORS) {
      if (!has('slabs', 'code', code)) store.insert('slabs', { code, name, thickness_mm: 12, width_mm: 760, length_mm: 3680, min_pcs: stock >= 40 ? 15 : 5, color_hex: SWATCH[code] || '', active: 1 });
    }
    for (const c of RACKS) if (!has('locations', 'code', c)) store.insert('locations', { code: c, name: c.startsWith('OFFCUT') ? 'Offcut rack' : `Rack ${c[0]}`, active: 1 });
    for (const [code, name, color, matches] of GLUES) {
      if (has('glues', 'code', code)) continue;
      const ids = matches.map((m) => (store.t('slabs').find((s) => s.code === m) || {}).id).filter(Boolean);
      store.insert('glues', { code, name, color, unit: 'pcs', shelf_life_months: 12, min_qty: 20, slab_ids: ids.join(','), active: 1 });
    }
  }

  /** Full demo: colours, users, customers, 75 days of movements, incoming shipments and locks. */
  function demo(store, env) {
    colors(store);
    if (store.t('docs').length) return false;
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const { addDays } = Engine.util;

    const mkUser = (username, name, role) => {
      let u = store.t('users').find((x) => x.username === username);
      if (!u) u = store.insert('users', { username, name, role, ...Engine.setPassword(env, 'demo1234'), must_change: 0, active: 1, token_ver: 0, created_at: env.now() });
      return u;
    };
    const scm = mkUser('scm', 'Somchai (SCM)', 'scm');
    const sales1 = mkUser('sales', 'Ploy (Sales)', 'sales');
    mkUser('sales2', 'Daniel (Sales)', 'sales');

    const customers = [
      ['Siam Interior Co.', 1, 'Khun Nok', '081-234-5678', 'Sukhumvit 55, Watthana, Bangkok'],
      ['Riverside Kitchen Works', 1, 'Khun Arthit', '089-765-4321', 'Rama 3 Rd, Bang Kho Laem, Bangkok'],
      ['Grand Hotel Renovation', 0, 'Site office', '02-555-0101', 'Silom Rd, Bang Rak, Bangkok'],
      ['Phuket Marina Residence', 0, 'Khun Mali', '076-700-123', 'Chalong, Mueang Phuket'],
      ['Central Mall Fit-out', 1, 'Khun Ying', '086-111-2222', 'Rama 9 Rd, Huai Khwang, Bangkok'],
      ['Green Lab Furniture', 0, 'Khun Ton', '038-888-222', 'Amata City, Chonburi'],
    ];
    for (const [name, key_account, contact, phone, address] of customers) {
      if (!store.t('customers').some((c) => c.name === name)) store.insert('customers', { name, key_account, contact, phone, address, active: 1 });
    }
    const cust = store.t('customers');
    const byCode = (code) => store.t('slabs').find((s) => s.code === code);
    const rack = (code) => store.t('locations').find((l) => l.code === code).id;
    const glues = store.t('glues');
    const t = env.today();
    const start = addDays(t, -75);
    store.setSetting('go_live_date', start);
    store.setSetting('company_name', 'Solid Surface Stock (demo)');

    const lines = [];
    COLORS.forEach(([code, , stock], i) => {
      const s = byCode(code);
      const qty = stock + 25;
      lines.push({ kind: 'slab_in', slab_id: s.id, location_id: rack(RACKS[i % 12]), qty: Math.ceil(qty * 0.7) });
      lines.push({ kind: 'slab_in', slab_id: s.id, location_id: rack(RACKS[(i + 5) % 12]), qty: Math.floor(qty * 0.3) });
    });
    for (let i = 0; i < 9; i++) {
      lines.push({ kind: 'remnant_in', slab_id: pick(store.t('slabs')).id, location_id: rack(pick(['OFFCUT-1', 'OFFCUT-2'])), width_mm: 760, length_mm: 600 + Math.floor(rnd() * 2400) });
    }
    glues.forEach((g, i) => {
      lines.push({ kind: 'glue_in', glue_id: g.id, qty: 30 + i * 6, lot_no: `L${2600 + i}A`, expiry: addDays(t, i === 1 ? -5 : 20 + i * 15) });
      lines.push({ kind: 'glue_in', glue_id: g.id, qty: 40, lot_no: `L${2600 + i}B`, expiry: addDays(t, 200 + i * 20) });
    });
    Engine.createDoc(store, env, scm, { type: 'opening', date: start, note: 'Stock count at go-live', lines });

    const moveQty = (slabId) => {
      const m = new Map();
      for (const mv of store.t('moves')) if (!mv.del && mv.item === 'slab' && mv.slab_id === slabId) m.set(mv.location_id, (m.get(mv.location_id) || 0) + mv.qty);
      return [...m.entries()].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
    };
    const popular = ['S-008', 'S-008', 'T-021', 'P-004', 'D-046', 'ST-101', 'VM-004', 'CC-010', 'D-047', 'CC-001', 'ST-103', 'VM-001'];
    for (let d = 1; d <= 74; d++) {
      const day = addDays(start, d);
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (dow === 0) continue;
      const n = dow === 6 ? 1 : 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const c = pick(cust);
        const s = byCode(pick(popular));
        const bal = moveQty(s.id);
        if (!bal.length) continue;
        const docLines = [];
        if (rnd() < 0.3) docLines.push({ kind: 'slab_cut', slab_id: s.id, location_id: bal[0][0], sqm: Math.round((0.6 + rnd() * 1.6) * 100) / 100, leftover_location_id: rack('OFFCUT-1') });
        else docLines.push({ kind: 'slab_out', slab_id: s.id, location_id: bal[0][0], qty: Math.min(bal[0][1], 1 + Math.floor(rnd() * 6)) });
        const g = glues.find((x) => String(x.slab_ids).split(',').map(Number).includes(s.id));
        const glueQty = 1 + Math.floor(rnd() * 3);
        const usable = g ? (Engine.glueOverview(store, env).find((x) => x.id === g.id) || {}).usable || 0 : 0;
        if (g && rnd() < 0.7 && usable >= glueQty) docLines.push({ kind: 'glue_out', glue_id: g.id, qty: glueQty });
        Engine.createDoc(store, env, scm, {
          type: 'outbound', date: day, customer_id: c.id, deliver_to: c.address, contact: c.contact,
          reference: `DO-${day.replace(/-/g, '').slice(2)}-${k + 1}`, sales_person: pick(['Ploy (Sales)', 'Daniel (Sales)']), lines: docLines,
        });
      }
    }
    const cc2 = byCode('CC-002');
    Engine.createDoc(store, env, scm, { type: 'adjust', date: addDays(t, -20), reason: 'Damaged / broken', note: 'Forklift damage', lines: [{ kind: 'slab_adj', slab_id: cc2.id, location_id: moveQty(cc2.id)[0][0], qty: -1 }] });
    Engine.createDoc(store, env, scm, {
      type: 'inbound', status: 'expected', partner: 'Supplier Co. Ltd', reference: 'PO-2611 / BL MSKU1234567', eta: addDays(t, 9), ship_status: 'on_board',
      lines: [
        { kind: 'slab_in', slab_id: byCode('S-008').id, qty: 75 }, { kind: 'slab_in', slab_id: byCode('D-048').id, qty: 75 },
        { kind: 'slab_in', slab_id: byCode('P-005').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('S-002').id, qty: 50 },
        { kind: 'glue_in', glue_id: glues[0].id, qty: 60 },
      ],
    });
    Engine.createDoc(store, env, scm, {
      type: 'inbound', status: 'expected', partner: 'Supplier Co. Ltd', reference: 'PO-2612', eta: addDays(t, 34), ship_status: 'ordered',
      lines: [{ kind: 'slab_in', slab_id: byCode('T-235').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('CT-006').id, qty: 25 }, { kind: 'slab_in', slab_id: byCode('CS-405').id, qty: 25 }],
    });
    const custBy = (name) => cust.find((c) => c.name === name).id;
    Engine.createLock(store, env, scm, { customer_id: custBy('Central Mall Fit-out'), slab_id: byCode('VM-004').id, pcs: 14, expires_on: addDays(t, 21), note: 'Phase 2 counters' });
    Engine.createLock(store, env, scm, { customer_id: custBy('Siam Interior Co.'), slab_id: byCode('D-047').id, pcs: 12, expires_on: addDays(t, 2), note: 'Condo project' });
    Engine.createLock(store, env, scm, { customer_id: custBy('Riverside Kitchen Works'), slab_id: byCode('D-046').id, pcs: 18, expires_on: addDays(t, 30) });
    Engine.createLock(store, env, sales1, { customer_id: custBy('Phuket Marina Residence'), slab_id: byCode('T-021').id, pcs: 10, expires_on: addDays(t, 14), note: 'Lobby reception desk' });
    return true;
  }

  return { colors, demo, COLORS, GLUES, RACKS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Seed;
