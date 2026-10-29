'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

global.Engine = require('../src/engine.js');
global.Seed = require('../src/seed.js');
const MemoryBackend = require('../src/memory-backend.js');

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const env = {
  today: localToday,
  now: () => new Date().toISOString(),
  sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
  sign: (s) => crypto.createHmac('sha256', 'test-secret').update(s).digest('hex').slice(0, 32),
  randomId: (n) => crypto.randomBytes(n).toString('hex').slice(0, n),
};
const { addDays, addMonths } = Engine.util;
const backend = MemoryBackend(env, {});
backend.run((store) => Engine.ensureAdmin(store, env, 'admin-pass-1'));

function client() {
  let token = '';
  const call = (method, url, body) => {
    const r = backend.call(method, url, body, token);
    if (r.body && r.body.token) token = r.body.token;
    return r;
  };
  return {
    ok(method, url, body) {
      const r = call(method, url, body);
      assert.equal(r.status, 200, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    fail(method, url, body, status = 400, re) {
      const r = call(method, url, body);
      assert.equal(r.status, status, `${method} ${url} expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
      if (re) assert.match(r.body.message, re);
      return r.body;
    },
  };
}

const admin = client();
const sales = client();
const T = env.today();
const ids = {};

test('login and permissions', () => {
  admin.fail('POST', '/api/login', { username: 'admin', password: 'nope' }, 401);
  const r = admin.ok('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
  assert.equal(r.user.role, 'admin');
  assert.equal(r.user.must_change, 1);
  admin.ok('POST', '/api/me/password', { current: 'admin-pass-1', password: 'admin-pass-2' });
  admin.ok('GET', '/api/me'); // new token after password change
  admin.ok('POST', '/api/users', { username: 'ploy', name: 'Ploy', role: 'sales', password: 'sales-pass-1' });
  sales.ok('POST', '/api/login', { username: 'ploy', password: 'sales-pass-1' });
  client().fail('GET', '/api/stock', undefined, 401);
  const tampered = backend.call('GET', '/api/stock', undefined, 'x.y.z.w');
  assert.equal(tampered.status, 401);
});

test('master data', () => {
  ids.white = admin.ok('POST', '/api/slabs', { code: 'S-008', name: 'N-WHITE', min_pcs: 5 }).id;
  ids.grey = admin.ok('POST', '/api/slabs', { code: 'CC-010', name: 'Cascade Pure Grey' }).id;
  admin.fail('POST', '/api/slabs', { code: 's-008', name: 'dup' }, 400, /already exists/);
  [ids.a1, ids.a2, ids.off] = admin.ok('POST', '/api/locations', { codes: ['A1', 'A2', 'OFF'] }).ids;
  ids.glue = admin.ok('POST', '/api/glues', { code: 'G-WH', name: 'White glue', shelf_life_months: 12, slab_ids: [ids.white] }).id;
  ids.cust = admin.ok('POST', '/api/customers', { name: 'Siam Interior', key_account: true, address: 'Bangkok' }).id;
  ids.cust2 = sales.ok('POST', '/api/customers', { name: 'Other Co' }).id;
  sales.fail('POST', '/api/slabs', { code: 'X', name: 'x' }, 403);
  const ref = admin.ok('GET', '/api/ref');
  assert.equal(ref.slabs.length, 2);
  assert.deepEqual(ref.glues[0].slab_ids, [ids.white]);
});

test('opening stock with racks, offcuts and glue lots', () => {
  sales.fail('POST', '/api/docs', { type: 'opening', lines: [] }, 403);
  const r = admin.ok('POST', '/api/docs', {
    type: 'opening', date: addDays(T, -10),
    lines: [
      { kind: 'slab_in', slab_id: ids.white, location_id: ids.a1, qty: 10 },
      { kind: 'slab_in', slab_id: ids.white, location_id: ids.a2, qty: 5 },
      { kind: 'slab_in', slab_id: ids.grey, location_id: ids.a1, qty: 3 },
      { kind: 'remnant_in', slab_id: ids.white, location_id: ids.off, width_mm: 760, length_mm: 1000 },
      { kind: 'glue_in', glue_id: ids.glue, qty: 10, lot_no: 'OLD', expiry: addDays(T, -1) },
      { kind: 'glue_in', glue_id: ids.glue, qty: 4, lot_no: 'SOON', expiry: addDays(T, 30) },
      { kind: 'glue_in', glue_id: ids.glue, qty: 20, lot_no: 'LATER', expiry: addDays(T, 300) },
    ],
  });
  ids.opening = r.id;
  assert.match(admin.ok('GET', `/api/docs/${r.id}`).doc_no, /^OPN-\d{4}-0001$/);
  const w = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 15);
  assert.equal(w.remnant_count, 1);
  assert.equal(w.remnant_sqm, 0.76);
  assert.equal(w.total_sqm, Math.round((15 * 0.76 * 3.68 + 0.76) * 1000) / 1000);
  const glue = sales.ok('GET', '/api/glue');
  assert.equal(glue[0].usable, 24);
  assert.equal(glue[0].expired, 10);
  assert.equal(glue[0].lots.find((l) => l.lot_no === 'SOON').state, 'expiring');
});

test('deliveries: full slabs, cut by sqm, offcut cut, glue FEFO', () => {
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 1 }] }, 400, /Delivered to/);
  const err = admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Site', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a2, qty: 6 }] }, 400, /only 5 pcs/);
  assert.equal(err.error, 'Not enough {code} {name} at rack {rack}: only {have} pcs there');
  const r = admin.ok('POST', '/api/docs', {
    type: 'outbound', date: T, customer_id: ids.cust, deliver_to: 'Sukhumvit site, Bangkok', sales_person: 'Ploy',
    lines: [
      { kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 2 },
      { kind: 'slab_cut', slab_id: ids.white, location_id: ids.a1, sqm: 1.2, leftover_location_id: ids.off },
      { kind: 'glue_out', glue_id: ids.glue, qty: 6 },
    ],
  });
  const doc = admin.ok('GET', `/api/docs/${r.id}`);
  const cut = doc.lines.find((l) => l.kind === 'slab_cut');
  assert.equal(cut.sqm, 1.2);
  assert.equal(cut.leftover_sqm, Math.round((0.76 * 3.68 - 1.2) * 1000) / 1000);
  assert.ok(cut.new_remnant_code);
  assert.deepEqual(doc.lines.filter((l) => l.kind === 'glue_out').map((l) => [l.lot_no, l.qty]), [['SOON', 4], ['LATER', 2]]);
  const rems = admin.ok('GET', `/api/remnants?slab_id=${ids.white}`);
  assert.equal(rems.length, 2);
  const big = rems.find((x) => x.id === cut.new_remnant_id);
  const r2 = admin.ok('POST', '/api/docs', { type: 'outbound', date: addDays(T, -4), customer_id: ids.cust2, deliver_to: 'Phuket', lines: [{ kind: 'remnant_cut', remnant_id: big.id, sqm: 1.0, leftover_sqm: 0.5 }] });
  assert.equal(admin.ok('GET', `/api/docs/${r2.id}`).lines[0].waste_sqm, Math.round((big.sqm - 1.5) * 1000) / 1000);
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'remnant_out', remnant_id: big.id }] }, 400, /no longer in stock/);
  const w = admin.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 12);
  assert.equal(w.remnant_count, 2);
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'glue_out', glue_id: ids.glue, qty: 19 }] }, 400, /Only 18 usable/);
  // a failed request leaves nothing behind
  const after = admin.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(after.on_hand, 12);
});

test('locks: sales request, SCM approval, reserved stock, delivery against lock', () => {
  const req = sales.ok('POST', '/api/locks', { customer_id: ids.cust, slab_id: ids.white, pcs: 8, expires_on: addDays(T, 10) });
  assert.equal(sales.ok('GET', '/api/locks').find((k) => k.id === req.id).state, 'pending');
  sales.fail('POST', `/api/locks/${req.id}/approve`, {}, 403);
  admin.ok('POST', `/api/locks/${req.id}/approve`, {});
  let w = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(w.locked, 8);
  assert.equal(w.available, 4);
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 5 }] }, 400, /Only 4 pcs .* free/);
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 1, lock_id: req.id }] }, 400, /another customer/);
  admin.fail('POST', '/api/locks', { customer_id: ids.cust2, slab_id: ids.white, pcs: 5 }, 400, /Only 4 pcs/);
  const out = admin.ok('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Bangkok', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 3, lock_id: req.id }] });
  assert.equal(sales.ok('GET', '/api/locks').find((k) => k.id === req.id).remaining, 5);
  w = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 9);
  assert.equal(w.available, 4);
  admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Bangkok', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 4, lock_id: req.id }, { kind: 'slab_out', slab_id: ids.white, location_id: ids.a2, qty: 2, lock_id: req.id }] }, 400, /only has 5 pcs left/);
  admin.ok('POST', `/api/docs/${out.id}/void`, { reason: 'Wrong customer' });
  assert.equal(sales.ok('GET', '/api/locks').find((k) => k.id === req.id).remaining, 8);
  admin.ok('POST', `/api/locks/${req.id}/release`, {});
  w = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.white);
  assert.equal(w.locked, 0);
  assert.equal(w.available, 12);
});

test('incoming shipment: expected, partial receive keeps the rest incoming', () => {
  const r = admin.ok('POST', '/api/docs', {
    type: 'inbound', status: 'expected', partner: 'Supplier', reference: 'PO-1', eta: addDays(T, 7), ship_status: 'on_board',
    lines: [{ kind: 'slab_in', slab_id: ids.grey, qty: 50 }, { kind: 'glue_in', glue_id: ids.glue, qty: 10 }],
  });
  let g = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.grey);
  assert.equal(g.incoming, 50);
  assert.equal(g.next_eta, addDays(T, 7));
  admin.fail('POST', `/api/docs/${r.id}/void`, { reason: 'x' }, 400, /Only posted/);
  const rec = admin.ok('POST', `/api/docs/${r.id}/receive`, {
    date: T, keep_remaining: true,
    lines: [{ kind: 'slab_in', slab_id: ids.grey, location_id: ids.a2, qty: 30 }, { kind: 'glue_in', glue_id: ids.glue, qty: 10, lot_no: 'NEW1' }],
  });
  assert.ok(rec.remainder_id);
  g = sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.grey);
  assert.equal(g.on_hand, 33);
  assert.equal(g.incoming, 20);
  const rest = admin.ok('GET', `/api/docs/${rec.remainder_id}`);
  assert.equal(rest.status, 'expected');
  assert.equal(rest.lines.length, 1);
  assert.equal(admin.ok('GET', '/api/glue')[0].lots.find((l) => l.lot_no === 'NEW1').expiry, addMonths(T, 12));
  admin.ok('DELETE', `/api/docs/${rec.remainder_id}`);
  assert.equal(sales.ok('GET', '/api/stock').rows.find((s) => s.id === ids.grey).incoming, 0);
});

test('adjustments, transfers and void protection', () => {
  admin.fail('POST', '/api/docs', { type: 'adjust', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -1 }] }, 400, /Reason/);
  admin.ok('POST', '/api/docs', { type: 'adjust', reason: 'Damaged / broken', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -1 }] });
  admin.fail('POST', '/api/docs', { type: 'adjust', reason: 'Count', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -5 }] }, 400, /Not enough/);
  admin.ok('POST', '/api/docs', { type: 'transfer', lines: [{ kind: 'slab_move', slab_id: ids.grey, location_id: ids.a2, to_location_id: ids.a1, qty: 30 }] });
  const racks = admin.ok('GET', '/api/racks');
  assert.equal(racks.find((r) => r.id === ids.a1).slabs.find((s) => s.slab_id === ids.grey).qty, 32);
  admin.fail('POST', `/api/docs/${ids.opening}/void`, { reason: 'test' }, 400, /already/);
});

test('reports: sales by day/week and monthly closing', () => {
  const rep = sales.ok('GET', `/api/reports/sales?from=${addDays(T, -13)}&to=${T}&group=day`);
  assert.equal(rep.periods.length, 14);
  assert.ok(rep.total.sqm > 0);
  assert.equal(rep.by_customer.length, 2);
  const wk = sales.ok('GET', `/api/reports/sales?from=${addDays(T, -30)}&to=${T}&group=week`);
  assert.ok(wk.periods.every((p) => /^W\d\d/.test(p.label)));
  const month = T.slice(0, 7);
  const c = sales.ok('GET', `/api/closing/${month}`);
  const w = c.slabs.find((s) => s.slab_id === ids.white);
  assert.equal(w.open_pcs + w.in_pcs - w.out_pcs + w.adj_pcs, w.close_pcs);
  sales.fail('POST', `/api/closing/${month}/close`, {}, 403);
  admin.fail('POST', `/api/closing/${month}/close`, {}, 400, /after its last day/);
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  admin.ok('POST', `/api/closing/${prev}/close`, {});
  assert.equal(admin.ok('GET', `/api/closing/${prev}`).closed, true);
  admin.fail('POST', '/api/docs', { type: 'adjust', date: `${prev}-15`, reason: 'x', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: 1 }] }, 400, /closed month/);
  admin.ok('POST', `/api/closing/${prev}/reopen`, {});
  assert.equal(admin.ok('GET', `/api/closing/${prev}`).closed, false);
  assert.equal(admin.ok('GET', '/api/closing').months.length, 0);
});

test('dashboard and colour detail', () => {
  const d = sales.ok('GET', '/api/dashboard');
  assert.ok(d.kpi.on_hand > 0);
  assert.ok(d.alerts.every((a) => a.text && a.params));
  const det = sales.ok('GET', `/api/stock/${ids.white}`);
  assert.equal(det.monthly.length, 12);
  assert.ok(det.history.length > 0);
});

test('demo seed builds a consistent data set', () => {
  const demo = MemoryBackend(env, {});
  demo.run((store) => { Engine.ensureAdmin(store, env, 'demo1234'); Seed.demo(store, env); });
  const login = demo.call('POST', '/api/login', { username: 'scm', password: 'demo1234' });
  assert.equal(login.status, 200);
  const dash = demo.call('GET', '/api/dashboard', undefined, login.body.token);
  assert.equal(dash.status, 200);
  assert.equal(dash.body.kpi.colors, 28);
  assert.ok(dash.body.sales_month.deliveries > 0);
  assert.equal(dash.body.kpi.pending_locks, 1);
  const stock = demo.call('GET', '/api/stock', undefined, login.body.token).body.rows;
  assert.ok(stock.every((r) => r.on_hand >= 0));
});
