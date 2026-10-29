// Runs dist/Code.gs against a fake Google Sheet (values typed in like Sheets does: dates and numbers
// are auto-converted unless the text starts with an apostrophe) and checks that the stock read back
// from the sheet matches the in-memory engine exactly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const Engine = require('../src/engine.js');
global.Engine = Engine;
const Seed = require('../src/seed.js');
const MemoryBackend = require('../src/memory-backend.js');

// ---- fake Google services ----------------------------------------------------------------
function typed(v) {
  // what Google Sheets stores when a value is entered with setValues()
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00`);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function fakeSheets() {
  const sheets = [];
  const mkSheet = (name) => {
    const cells = []; // rows of values
    let maxRows = 1000;
    let maxCols = 26;
    const sh = {
      getName: () => name,
      getLastRow: () => { for (let r = cells.length; r > 0; r--) if ((cells[r - 1] || []).some((x) => x !== '' && x !== undefined)) return r; return 0; },
      getLastColumn: () => cells.reduce((m, row) => { let w = 0; (row || []).forEach((x, i) => { if (x !== '' && x !== undefined) w = i + 1; }); return Math.max(m, w); }, 0),
      getMaxRows: () => maxRows,
      getMaxColumns: () => maxCols,
      insertRowsAfter: (after, n) => { maxRows += n; },
      deleteColumns: (from, n) => { maxCols -= n; },
      insertColumnsAfter: (after, n) => { maxCols += n; },
      setFrozenRows: () => {},
      clearContents: () => { cells.length = 0; },
      getRange(r, c, nr = 1, nc = 1) {
        if (r + nr - 1 > maxRows || c + nc - 1 > maxCols) throw new Error(`Range outside the sheet: ${name} R${r}C${c} ${nr}x${nc} (max ${maxRows}x${maxCols})`);
        const range = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (__, j) => { const v = (cells[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
          setValues(vals) {
            assert.strictEqual(vals.length, nr, 'row count');
            vals.forEach((row, i) => {
              assert.strictEqual(row.length, nc, 'column count');
              cells[r - 1 + i] = cells[r - 1 + i] || [];
              row.forEach((v, j) => { cells[r - 1 + i][c - 1 + j] = typed(v); });
            });
            return range;
          },
          setValue(v) { return range.setValues([[v]]); },
          setFontWeight: () => range,
          setBackground: () => range,
          protect: () => ({ setDescription() { return this; }, setWarningOnly() { return this; } }),
        };
        return range;
      },
      cells,
    };
    return sh;
  };
  const ss = {
    getId: () => 'sheet-1',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    insertSheet: (n, i) => { const s = mkSheet(n); if (i === 0) sheets.unshift(s); else sheets.push(s); return s; },
    getSheets: () => sheets,
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
    getSpreadsheetTimeZone: () => 'Asia/Bangkok',
  };
  return ss;
}

function googleContext() {
  const ss = fakeSheets();
  const props = new Map();
  const cache = new Map();
  const alerts = [];
  const bytes = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const pad = (n) => String(n).padStart(2, '0');
  const ctx = {
    console,
    Engine: undefined,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      flush: () => {},
      getUi: () => ({
        alert: (...a) => { alerts.push(a.filter((x) => typeof x === 'string').join('\n')); return 'OK'; },
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
        Button: { OK: 'OK' },
        createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; },
        showModalDialog() {},
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) || null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => bytes(crypto.createHash('sha256').update(s, 'utf8').digest()),
      computeHmacSha256Signature: (s, key) => bytes(crypto.createHmac('sha256', key).update(s, 'utf8').digest()),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return fmt.includes('HH') ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
      },
    },
    HtmlService: { createHtmlOutputFromFile: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }), XFrameOptionsMode: { DEFAULT: 1 } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/x/exec' }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  const call = (method, url, body, token) => JSON.parse(ctx.api(JSON.stringify({ method, url, body, token })));
  return { ctx, ss, alerts, call, props };
}

test('Code.gs: setup, demo data and requests round-trip through the sheet', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../dist/Code.gs')), 'run "npm run build" first');
  const g = googleContext();
  g.ctx.setupSheets();
  const pw = /password:\s+(\S+)/.exec(g.alerts[0])[1];
  assert.ok(pw.length >= 8);
  g.ctx.loadStandardColours();
  g.ctx.loadDemoData();

  // the same seed in memory
  const env = {
    today: () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    now: () => new Date().toISOString(),
    sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    sign: (s) => crypto.createHmac('sha256', 'k').update(s).digest('hex'),
    randomId: (n = 16) => crypto.randomBytes(n).toString('hex').slice(0, n),
  };
  const mem = MemoryBackend(env, {});
  mem.run((store) => { Engine.ensureAdmin(store, env, 'x'); Seed.colors(store); });
  mem.run((store) => Seed.demo(store, env));

  const login = (call, username, password) => call('POST', '/api/login', { username, password }).body.token;
  const tg = login(g.call, 'scm', 'demo1234');
  const tm = login(mem.call, 'scm', 'demo1234');
  assert.ok(tg && tm, 'scm can log in on both');

  const strip = (rows) => rows.map(({ id, ...r }) => r);
  const same = (url) => {
    const a = g.call('GET', url, undefined, tg);
    const b = mem.call('GET', url, undefined, tm);
    assert.strictEqual(a.status, 200, `${url}: ${JSON.stringify(a.body)}`);
    const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (/(^|_)at$/.test(k) ? '<time>' : v)));
    assert.deepStrictEqual(norm(a.body), norm(b.body), `${url} differs between the sheet and memory`);
    return a.body;
  };
  const stock = same('/api/stock');
  assert.ok(stock.rows.length >= 28);
  same('/api/glue');
  same('/api/remnants');
  same('/api/locks');
  same('/api/dashboard');
  same('/api/docs?type=outbound');

  // a delivery with a cut (creates an offcut) + glue, on both
  const row = stock.rows.find((r) => r.available > 3 && r.locations.length);
  const glue = g.call('GET', '/api/glue', undefined, tg).body.find((x) => x.usable > 2);
  const cust = g.call('GET', '/api/ref', undefined, tg).body.customers[0];
  const doc = {
    type: 'outbound', date: env.today(), customer_id: cust.id, deliver_to: 'Site 0012 / 2026-01-05', reference: '=SUM(A1)',
    lines: [
      { kind: 'slab_out', slab_id: row.id, location_id: row.locations[0].location_id, qty: 2 },
      { kind: 'slab_cut', slab_id: row.id, location_id: row.locations[0].location_id, sqm: 1.2 },
      { kind: 'glue_out', glue_id: glue.id, qty: 1 },
    ],
  };
  const r1 = g.call('POST', '/api/docs', doc, tg);
  const r2 = mem.call('POST', '/api/docs', doc, tm);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  const d1 = g.call('GET', `/api/docs/${r1.body.id}`, undefined, tg).body;
  assert.strictEqual(d1.deliver_to, 'Site 0012 / 2026-01-05', 'text that looks like a number/date stays text');
  assert.strictEqual(d1.reference, '=SUM(A1)', 'text that looks like a formula stays text');
  same('/api/stock');
  same('/api/remnants');
  same('/api/glue');

  // void it again: updates rows in place
  assert.strictEqual(g.call('POST', `/api/docs/${r1.body.id}/void`, { reason: 'test' }, tg).status, 200);
  assert.strictEqual(mem.call('POST', `/api/docs/${r2.body.id}/void`, { reason: 'test' }, tm).status, 200);
  same('/api/stock');
  same('/api/remnants');

  // version changes after a stock save, not after a login; live sheet is written
  const v1 = g.call('GET', '/api/version').body.version;
  assert.ok(v1);
  login(g.call, 'sales', 'demo1234');
  assert.strictEqual(g.call('GET', '/api/version').body.version, v1, 'a login does not refresh everybody');
  const live = g.ss.getSheetByName('Stock (live)');
  assert.ok(live && live.getLastRow() > 3, 'Stock (live) tab filled');

  // admin password from setup works and must be changed
  const ta = login(g.call, 'admin', pw);
  const me = g.call('GET', '/api/me', undefined, ta).body;
  assert.strictEqual(me.user.must_change, 1);
  assert.ok(me.sheet_url, 'admin gets the sheet link');
  const ch = g.call('POST', '/api/me/password', { current: pw, password: 'new-password-1' }, ta);
  assert.strictEqual(ch.status, 200);
  assert.ok(ch.body.token, 'a fresh token after the password change');
  assert.strictEqual(g.call('GET', '/api/me', undefined, ta).status, 401, 'old token stops working');
  assert.strictEqual(g.call('GET', '/api/me', undefined, ch.body.token).body.user.must_change, 0);

  // failed request does not change the sheet
  const before = JSON.stringify(g.ss.getSheets().map((s) => s.cells));
  const bad = g.call('POST', '/api/docs', { ...doc, lines: [{ kind: 'slab_out', slab_id: row.id, location_id: row.locations[0].location_id, qty: 99999 }] }, tg);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.stringify(g.ss.getSheets().map((s) => s.cells)), before, 'nothing written on error');
});

test('demo SHA-256 matches the standard', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/demo.html'), 'utf8');
  const start = html.indexOf('(function () {\n  \'use strict\';\n  // small synchronous SHA-256');
  assert.ok(start > 0);
  const end = html.indexOf('var pad = function', start);
  const code = `${html.slice(start, end)} window.__sha = sha256; })();`;
  const ctx = { window: {}, unescape, encodeURIComponent };
  vm.runInNewContext(code, ctx);
  for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'ไทย สวัสดี', 'a'.repeat(1000)]) {
    assert.strictEqual(ctx.window.__sha(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), s.slice(0, 20));
  }
});
