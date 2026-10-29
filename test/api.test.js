'use strict';
process.emitWarning = () => {};
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, setSetting } = require('../server/db');
const { ensureAdmin } = require('../server/auth');
const { createApp } = require('../server/app');
const { today, addDays, addMonths } = require('../server/util');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-test-'));
const db = openDb(path.join(dir, 'test.db'));
ensureAdmin(db, 'admin-pass-1');
const app = createApp(db);
const server = http.createServer(app.handler);
let base;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    patch: (u, b = {}) => call('PATCH', u, b),
    del: (u) => call('DELETE', u, {}),
    async ok(method, u, b) {
      const r = await call(method, u, b);
      assert.equal(r.status, 200, `${method} ${u} -> ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
    async fail(method, u, b, status = 400, re) {
      const r = await call(method, u, b);
      assert.equal(r.status, status, `${method} ${u} expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`);
      if (re) assert.match(r.data.error, re);
      return r.data;
    },
  };
}

const admin = client();
const sales = client();
const T = today();
const D1 = addDays(T, -10);
const ids = {};

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { app.closeAll(); server.close(); db.close(); });

test('login and permissions', async () => {
  await admin.fail('POST', '/api/login', { username: 'admin', password: 'nope' }, 401);
  const r = await admin.ok('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
  assert.equal(r.user.role, 'admin');
  assert.equal(r.user.must_change, 1);
  await admin.ok('POST', '/api/me/password', { current: 'admin-pass-1', password: 'admin-pass-2' });
  await admin.ok('POST', '/api/users', { username: 'jisoo', name: 'Jisoo', role: 'sales', password: 'sales-pass-1' });
  await sales.ok('POST', '/api/login', { username: 'jisoo', password: 'sales-pass-1' });
  await client().fail('GET', '/api/stock', undefined, 401);
});

test('master data', async () => {
  ids.white = (await admin.ok('POST', '/api/slabs', { code: 'S-008', name: 'N-WHITE', min_pcs: 5 })).id;
  ids.grey = (await admin.ok('POST', '/api/slabs', { code: 'CC-010', name: 'Cascade Pure Grey' })).id;
  await admin.fail('POST', '/api/slabs', { code: 's-008', name: 'dup' }, 400, /already exists/);
  const locs = await admin.ok('POST', '/api/locations', { codes: ['A1', 'A2', 'OFF'] });
  [ids.a1, ids.a2, ids.off] = locs.ids;
  ids.glue = (await admin.ok('POST', '/api/glues', { code: 'G-WH', name: 'White glue', shelf_life_months: 12, slab_ids: [ids.white] })).id;
  ids.cust = (await admin.ok('POST', '/api/customers', { name: 'Hanil Interior', key_account: true, address: 'Seoul' })).id;
  ids.cust2 = (await sales.ok('POST', '/api/customers', { name: 'Other Co' })).id;
  await sales.fail('POST', '/api/slabs', { code: 'X', name: 'x' }, 403);
  const ref = await admin.ok('GET', '/api/ref');
  assert.equal(ref.slabs.length, 2);
  assert.deepEqual(ref.glues[0].slab_ids, [ids.white]);
});

test('opening stock with racks, offcuts and glue lots', async () => {
  await sales.fail('POST', '/api/docs', { type: 'opening', lines: [] }, 403);
  const r = await admin.ok('POST', '/api/docs', {
    type: 'opening', date: D1,
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
  const doc = await admin.ok('GET', `/api/docs/${r.id}`);
  assert.match(doc.doc_no, /^OPN-\d{4}-0001$/);
  const stock = (await sales.ok('GET', '/api/stock')).rows;
  const w = stock.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 15);
  assert.equal(w.remnant_count, 1);
  assert.equal(w.remnant_sqm, 0.76);
  assert.equal(w.total_sqm, Math.round((15 * 0.76 * 3.68 + 0.76) * 1000) / 1000);
  const glue = await sales.ok('GET', '/api/glue');
  assert.equal(glue[0].usable, 24);
  assert.equal(glue[0].expired, 10);
  assert.equal(glue[0].lots.find((l) => l.lot_no === 'SOON').state, 'expiring');
});

test('deliveries: full slabs, cut by sqm, offcut cut, glue FEFO', async () => {
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 1 }] }, 400, /Delivered to/);
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Site', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a2, qty: 6 }] }, 400, /only 5 pcs/);
  const r = await admin.ok('POST', '/api/docs', {
    type: 'outbound', date: T, customer_id: ids.cust, deliver_to: 'Seongsu site, Seoul', sales_person: 'Jisoo',
    lines: [
      { kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 2 },
      { kind: 'slab_cut', slab_id: ids.white, location_id: ids.a1, sqm: 1.2, leftover_location_id: ids.off },
      { kind: 'glue_out', glue_id: ids.glue, qty: 6 },
    ],
  });
  const doc = await admin.ok('GET', `/api/docs/${r.id}`);
  const cut = doc.lines.find((l) => l.kind === 'slab_cut');
  assert.equal(cut.sqm, 1.2);
  assert.equal(cut.leftover_sqm, Math.round((0.76 * 3.68 - 1.2) * 1000) / 1000);
  assert.ok(cut.new_remnant_code);
  // FEFO: expired lot skipped, 4 from SOON then 2 from LATER
  const glueLines = doc.lines.filter((l) => l.kind === 'glue_out');
  assert.deepEqual(glueLines.map((l) => [l.lot_no, l.qty]), [['SOON', 4], ['LATER', 2]]);

  const rems = await admin.ok('GET', `/api/remnants?slab_id=${ids.white}`);
  assert.equal(rems.length, 2);
  const big = rems.find((x) => x.id === cut.new_remnant_id);
  // cut 1.0 m2 from the offcut, keep 0.5, rest is waste
  const r2 = await admin.ok('POST', '/api/docs', {
    type: 'outbound', date: addDays(T, -4), customer_id: ids.cust2, deliver_to: 'Busan',
    lines: [{ kind: 'remnant_cut', remnant_id: big.id, sqm: 1.0, leftover_sqm: 0.5 }],
  });
  const d2 = await admin.ok('GET', `/api/docs/${r2.id}`);
  assert.equal(d2.lines[0].waste_sqm, Math.round((big.sqm - 1.5) * 1000) / 1000);
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'remnant_out', remnant_id: big.id }] }, 400, /no longer in stock/);
  const w = (await admin.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 12);
  assert.equal(w.remnant_count, 2);
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'glue_out', glue_id: ids.glue, qty: 19 }] }, 400, /Only 18 usable/);
});

test('locks: sales request, SCM approval, reserved stock, delivery against lock', async () => {
  // 12 white on hand (A1 7, A2 5)
  const req = await sales.ok('POST', '/api/locks', { customer_id: ids.cust, slab_id: ids.white, pcs: 8, expires_on: addDays(T, 10) });
  let locks = await sales.ok('GET', '/api/locks');
  assert.equal(locks.find((k) => k.id === req.id).state, 'pending');
  await sales.fail('POST', `/api/locks/${req.id}/approve`, {}, 403);
  await admin.ok('POST', `/api/locks/${req.id}/approve`, {});
  let w = (await sales.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.white);
  assert.equal(w.locked, 8);
  assert.equal(w.available, 4);
  // another customer can only take the 4 free pieces
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 5 }] }, 400, /Only 4 pcs .* free/);
  // lock can't be used by another customer
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust2, deliver_to: 'x', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 1, lock_id: req.id }] }, 400, /another customer/);
  // can't lock more than free stock
  await admin.fail('POST', '/api/locks', { customer_id: ids.cust2, slab_id: ids.white, pcs: 5 }, 400, /Only 4 pcs/);
  // owner delivers 3 against the lock
  const out = await admin.ok('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Seoul', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 3, lock_id: req.id }] });
  locks = await sales.ok('GET', '/api/locks');
  assert.equal(locks.find((k) => k.id === req.id).remaining, 5);
  w = (await sales.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.white);
  assert.equal(w.on_hand, 9);
  assert.equal(w.available, 4);
  await admin.fail('POST', '/api/docs', { type: 'outbound', customer_id: ids.cust, deliver_to: 'Seoul', lines: [{ kind: 'slab_out', slab_id: ids.white, location_id: ids.a1, qty: 4, lock_id: req.id }, { kind: 'slab_out', slab_id: ids.white, location_id: ids.a2, qty: 2, lock_id: req.id }] }, 400, /only has 5 pcs left/);
  // voiding the delivery puts stock and lock back
  await admin.ok('POST', `/api/docs/${out.id}/void`, { reason: 'Wrong customer' });
  locks = await sales.ok('GET', '/api/locks');
  assert.equal(locks.find((k) => k.id === req.id).remaining, 8);
  // release
  await admin.ok('POST', `/api/locks/${req.id}/release`, {});
  w = (await sales.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.white);
  assert.equal(w.locked, 0);
  assert.equal(w.available, 12);
});

test('incoming shipment: expected, partial receive keeps the rest incoming', async () => {
  const r = await admin.ok('POST', '/api/docs', {
    type: 'inbound', status: 'expected', partner: 'Supplier', reference: 'PO-1', eta: addDays(T, 7), ship_status: 'on_board',
    lines: [{ kind: 'slab_in', slab_id: ids.grey, qty: 50 }, { kind: 'glue_in', glue_id: ids.glue, qty: 10 }],
  });
  let g = (await sales.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.grey);
  assert.equal(g.incoming, 50);
  assert.equal(g.next_eta, addDays(T, 7));
  await admin.fail('POST', `/api/docs/${r.id}/void`, { reason: 'x' }, 400, /Only posted/);
  const rec = await admin.ok('POST', `/api/docs/${r.id}/receive`, {
    date: T, keep_remaining: true,
    lines: [{ kind: 'slab_in', slab_id: ids.grey, location_id: ids.a2, qty: 30 }, { kind: 'glue_in', glue_id: ids.glue, qty: 10, lot_no: 'NEW1' }],
  });
  assert.ok(rec.remainder_id);
  g = (await sales.ok('GET', '/api/stock')).rows.find((s) => s.id === ids.grey);
  assert.equal(g.on_hand, 33);
  assert.equal(g.incoming, 20);
  const rest = await admin.ok('GET', `/api/docs/${rec.remainder_id}`);
  assert.equal(rest.status, 'expected');
  assert.equal(rest.lines.length, 1);
  const lot = (await admin.ok('GET', '/api/glue'))[0].lots.find((l) => l.lot_no === 'NEW1');
  assert.equal(lot.expiry, addMonths(T, 12));
  await admin.ok('DELETE', `/api/docs/${rec.remainder_id}`);
});

test('adjustments, transfers and void protection', async () => {
  await admin.fail('POST', '/api/docs', { type: 'adjust', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -1 }] }, 400, /Reason/);
  await admin.ok('POST', '/api/docs', { type: 'adjust', reason: 'Damaged / broken', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -1 }] });
  await admin.fail('POST', '/api/docs', { type: 'adjust', reason: 'Count', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: -5 }] }, 400, /Not enough/);
  await admin.ok('POST', '/api/docs', { type: 'transfer', lines: [{ kind: 'slab_move', slab_id: ids.grey, location_id: ids.a2, to_location_id: ids.a1, qty: 30 }] });
  const racks = await admin.ok('GET', '/api/racks');
  assert.equal(racks.find((r) => r.id === ids.a1).slabs.find((s) => s.slab_id === ids.grey).qty, 32);
  // the opening document can't be voided: its stock has already been delivered
  await admin.fail('POST', `/api/docs/${ids.opening}/void`, { reason: 'test' }, 400, /already/);
});

test('reports: sales by day/week and monthly closing', async () => {
  const rep = await sales.ok('GET', `/api/reports/sales?from=${addDays(T, -13)}&to=${T}&group=day`);
  assert.equal(rep.periods.length, 14);
  assert.ok(rep.total.sqm > 0);
  assert.equal(rep.by_customer.length, 2);
  const wk = await sales.ok('GET', `/api/reports/sales?from=${addDays(T, -30)}&to=${T}&group=week`);
  assert.ok(wk.periods.every((p) => /^W\d\d/.test(p.label)));
  const month = T.slice(0, 7);
  const c = await sales.ok('GET', `/api/closing/${month}`);
  const w = c.slabs.find((s) => s.slab_id === ids.white);
  assert.equal(w.open_pcs + w.in_pcs - w.out_pcs + w.adj_pcs, w.close_pcs);
  await sales.fail('POST', `/api/closing/${month}/close`, {}, 403);
  await admin.fail('POST', `/api/closing/${month}/close`, {}, 400, /after its last day/);
  // close last month, then posting into it is blocked
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  await admin.ok('POST', `/api/closing/${prev}/close`, {});
  const closed = await admin.ok('GET', `/api/closing/${prev}`);
  assert.equal(closed.closed, true);
  await admin.fail('POST', '/api/docs', { type: 'adjust', date: `${prev}-15`, reason: 'x', lines: [{ kind: 'slab_adj', slab_id: ids.grey, location_id: ids.a1, qty: 1 }] }, 400, /closed month/);
  await admin.ok('POST', `/api/closing/${prev}/reopen`, {});
  setSetting(db, 'closed_through', '');
});

test('CSRF and input safety', async () => {
  const r = await fetch(`${base}/api/docs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  const r2 = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r2.status, 403);
  const page = await fetch(`${base}/../server/db.js`);
  assert.notEqual(page.status, 200);
});

test('static files and odd input do not crash the server', async () => {
  for (const p of ['/%E0%A4%A', '/../public-x/a.js', '/js/app.js', '/some/spa/route']) {
    const r = await fetch(base + p);
    assert.ok([200, 400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: '{}' });
  assert.equal(r.status, 403);
  const ok = await fetch(`${base}/api/stock`);
  assert.equal(ok.status, 401); // server still alive
});
