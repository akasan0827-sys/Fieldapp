/*
 * Google Apps Script server: the Google Sheet is the database, this file is the web app.
 * It is joined with engine.js and seed.js into dist/Code.gs by build.js.
 *
 *   doGet()      serves the app (dist/Index.html)
 *   api()        is called by the app through google.script.run for every request
 *   onOpen()     adds the "Stock app" menu to the Sheet (first-time setup, demo data, links)
 */

var APP_TITLE = 'Stock manager';
var LIVE_SHEET = 'Stock (live)';

// ------------------------------------------------------------------------------------
// Web app entry points
// ------------------------------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Every request from the app comes through here. Returns a JSON string { status, body }. */
function api(reqJson) {
  var req = JSON.parse(reqJson);
  var method = String(req.method || 'GET').toUpperCase();
  var url = String(req.url || '');
  if (method === 'GET' && url === '/api/version') return JSON.stringify({ status: 200, body: { version: dataVersion_() } });

  var write = method !== 'GET';
  var lock = null;
  if (write) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return JSON.stringify({ status: 503, body: { error: 'The system is busy, please try again in a few seconds.' } });
  }
  try {
    var ss = spreadsheet_();
    var store = Engine.createStore(function (name) { return readTable_(ss, name); });
    var res = Engine.handle(store, env_(), method, url, req.body, req.token);
    if (res.status === 200 && write && store.dirty()) {
      saveStore_(ss, store);
      // logins and password changes only touch Users / Log: no need to refresh everybody's screen
      var dataChanged = Object.keys(store.changes()).some(function (n) { return n !== 'audit' && n !== 'users'; });
      if (dataChanged) {
        bumpVersion_();
        try { writeLiveSheet_(ss, store); } catch (e) { console.warn('Stock (live) sheet not updated: ' + e); }
      }
    }
    if (res.status === 200 && url === '/api/me' && res.body && res.body.user && res.body.user.role === 'admin') res.body.sheet_url = ss.getUrl();
    if (res.status === 500) console.error(res.body.message);
    return JSON.stringify(res);
  } finally {
    if (lock) lock.releaseLock();
  }
}

// ------------------------------------------------------------------------------------
// Environment for the engine: clock, hashing, signing
// ------------------------------------------------------------------------------------
function env_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Bangkok';
  return {
    today: function () { return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'); },
    now: function () { return new Date().toISOString(); },
    sha256: function (s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); },
    sign: function (s) { return hex_(Utilities.computeHmacSha256Signature(s, tokenSecret_(), Utilities.Charset.UTF_8)).slice(0, 40); },
    randomId: function (n) { return Utilities.getUuid().replace(/-/g, '').slice(0, n || 16); },
  };
}
function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
  return out;
}
function tokenSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}
function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open the Google Sheet and run "Stock app → First-time setup" once.');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  return ss;
}

// ------------------------------------------------------------------------------------
// Data version: the app asks for it every 30 seconds to know when to refresh
// ------------------------------------------------------------------------------------
function dataVersion_() {
  var cache = CacheService.getScriptCache();
  var v = cache.get('DATA_VERSION');
  if (v) return v;
  v = PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || '1';
  cache.put('DATA_VERSION', v, 21600);
  return v;
}
function bumpVersion_() {
  var v = String(Date.now());
  PropertiesService.getScriptProperties().setProperty('DATA_VERSION', v);
  CacheService.getScriptCache().put('DATA_VERSION', v, 21600);
}

// ------------------------------------------------------------------------------------
// Sheet <-> rows
// ------------------------------------------------------------------------------------
function sheetFor_(ss, name, create) {
  var def = Engine.SCHEMA[name];
  var sh = ss.getSheetByName(def.sheet);
  if (!sh && create) {
    sh = ss.insertSheet(def.sheet);
    var cols = Object.keys(def.cols);
    ensureColumns_(sh, cols.length);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8f0fb');
    sh.setFrozenRows(1);
    if (sh.getMaxColumns() > cols.length) sh.deleteColumns(cols.length + 1, sh.getMaxColumns() - cols.length);
    sh.getRange(1, 1, 1, cols.length).protect().setDescription('Column names used by the stock app — do not change').setWarningOnly(true);
  }
  return sh;
}

function ensureColumns_(sh, n) {
  if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
}

function cellOut_(v, type) {
  if (v === null || v === undefined) return '';
  if (type === 's') {
    var s = String(v);
    // keep text as text: stop Sheets turning "2026-01-05", "0012" or "=..." into dates, numbers or formulas
    return s === '' ? '' : "'" + s;
  }
  return v;
}
function cellIn_(v, type) {
  if (type === 's') {
    if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
    return v === null || v === undefined ? '' : String(v);
  }
  if (v === '' || v === null || v === undefined) return type === 'n' ? null : 0;
  var x = Number(v);
  return isNaN(x) ? (type === 'n' ? null : 0) : x;
}

function readTable_(ss, name) {
  var def = Engine.SCHEMA[name];
  var sh = sheetFor_(ss, name, false);
  if (!sh) return [];
  var last = sh.getLastRow();
  var width = sh.getLastColumn();
  if (last < 2 || width < 1) return [];
  var header = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  var cols = Object.keys(def.cols);
  var at = cols.map(function (c) { return header.indexOf(c); });
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (raw.every(function (x) { return x === ''; })) continue;
    var o = {};
    for (var j = 0; j < cols.length; j++) o[cols[j]] = cellIn_(at[j] >= 0 ? raw[at[j]] : '', def.cols[cols[j]]);
    Object.defineProperty(o, '__row', { value: i + 2, enumerable: false, writable: true });
    rows.push(o);
  }
  return rows;
}

function saveStore_(ss, store) {
  var changes = store.changes();
  Object.keys(changes).forEach(function (name) {
    var def = Engine.SCHEMA[name];
    var cols = Object.keys(def.cols);
    var sh = sheetFor_(ss, name, true);
    var header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
    var missing = cols.filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length) { // a newer version added columns: append them to the header
      ensureColumns_(sh, header.length + missing.length);
      sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#e8f0fb');
      header = header.concat(missing);
    }
    var toRow = function (r) {
      return header.map(function (h) { return def.cols[h] ? cellOut_(r[h], def.cols[h]) : ''; });
    };
    var c = changes[name];
    // updates: rewrite only the changed rows (rows are never physically deleted, so row numbers stay valid)
    c.upd.forEach(function (r) {
      if (r.__row) sh.getRange(r.__row, 1, 1, header.length).setValues([toRow(r)]);
    });
    if (c.ins.length) {
      var start = Math.max(sh.getLastRow(), 1) + 1;
      var need = start + c.ins.length - 1 - sh.getMaxRows();
      if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
      sh.getRange(start, 1, c.ins.length, header.length).setValues(c.ins.map(toRow));
      c.ins.forEach(function (r, k) { Object.defineProperty(r, '__row', { value: start + k, enumerable: false, writable: true }); });
    }
  });
  SpreadsheetApp.flush();
}

/** A read-only overview tab for people who like to look at the Sheet directly. */
function writeLiveSheet_(ss, store) {
  var rows = Engine.stockOverview(store, env_());
  var sh = ss.getSheetByName(LIVE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LIVE_SHEET, 0);
    sh.setFrozenRows(2);
  }
  var head = ['Code', 'Colour', 'Available', 'On hand', 'Locked', 'Offcuts', 'Offcut m²', 'Total m²', 'Incoming', 'Next ETA', 'Sold m² / month', 'Status', 'Racks'];
  var data = rows.filter(function (r) { return r.active || r.on_hand || r.remnant_count; }).map(function (r) {
    return ["'" + r.code, r.name, r.available, r.on_hand, r.locked, r.remnant_count, r.remnant_sqm, r.total_sqm, r.incoming,
      r.next_eta ? "'" + r.next_eta : '', r.avg_month_sqm, r.status,
      r.locations.map(function (l) { return l.location_code + ': ' + l.qty; }).join(', ')];
  });
  ensureColumns_(sh, head.length);
  sh.clearContents();
  sh.getRange(1, 1).setValue('Live stock — updated automatically by the stock app at ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm') + '. Do not edit: use the app.');
  sh.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8f0fb');
  if (data.length) sh.getRange(3, 1, data.length, head.length).setValues(data);
}

// ------------------------------------------------------------------------------------
// Sheet menu: setup, demo data, links
// ------------------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Stock app')
    .addItem('1. First-time setup', 'setupSheets')
    .addItem('2. Load the 28 standard colours, racks and glues', 'loadStandardColours')
    .addItem('Load demo data (for testing only)', 'loadDemoData')
    .addSeparator()
    .addItem('Show the app link', 'showAppLink')
    .addItem('Reset the admin password', 'resetAdminPassword')
    .addToUi();
}

function withStore_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = spreadsheet_();
    var store = Engine.createStore(function (name) { return readTable_(ss, name); });
    var out = fn(store, ss);
    if (store.dirty()) {
      saveStore_(ss, store);
      bumpVersion_();
      writeLiveSheet_(ss, store);
    }
    return out;
  } finally {
    lock.releaseLock();
  }
}

function setupSheets() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  if (ss.getSpreadsheetTimeZone() && ss.getSpreadsheetTimeZone() !== Session.getScriptTimeZone()) {
    console.log('Sheet time zone ' + ss.getSpreadsheetTimeZone() + ', script time zone ' + Session.getScriptTimeZone());
  }
  Object.keys(Engine.SCHEMA).forEach(function (name) { sheetFor_(ss, name, true); });
  var blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('แผ่นงาน1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  var pw = withStore_(function (store) {
    var p = Engine.ensureAdmin(store, env_(), null);
    if (!store.t('settings').length) store.setSetting('company_name', Engine.DEFAULT_SETTINGS.company_name);
    return p;
  });
  ui.alert('Setup done',
    (pw ? 'Admin login:\n\n   username:  admin\n   password:  ' + pw + '\n\nWrite this down — you will choose your own password at the first login.\n\n' : 'The tables already exist; nothing was overwritten.\n\n')
    + 'Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), then share the link with your team.',
    ui.ButtonSet.OK);
}

function loadStandardColours() {
  var n = withStore_(function (store) { var before = store.t('slabs').length; Seed.colors(store); return store.t('slabs').length - before; });
  SpreadsheetApp.getUi().alert(n ? n + ' colours added (plus racks and glue products). You can change them in the app under Setup.' : 'The colours were already there — nothing changed.');
}

function loadDemoData() {
  var ui = SpreadsheetApp.getUi();
  var ok = ui.alert('Load demo data?', 'This adds sample customers, deliveries, receipts and locks so you can try the app. Only do this in a test copy of the Sheet — not in the Sheet you will use for real stock.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  var res = withStore_(function (store) {
    var pw = Engine.ensureAdmin(store, env_(), null);
    return { pw: pw, done: Seed.demo(store, env_()) };
  });
  ui.alert(res.done === false ? 'There are already documents in this Sheet — demo data was not added.'
    : 'Demo data added. Demo users: scm / sales / sales2, password demo1234.' + (res.pw ? '\n\nAdmin login: admin / ' + res.pw : ''));
}

function showAppLink() {
  var url = ScriptApp.getService().getUrl();
  var html = url
    ? '<p style="font-family:sans-serif">Send this link to your team (they can add it to their phone home screen):</p><p><a href="' + url + '" target="_blank" style="font-family:sans-serif;word-break:break-all">' + url + '</a></p>'
    : '<p style="font-family:sans-serif">The app is not deployed yet. In the Apps Script editor choose Deploy → New deployment → Web app.</p>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(170), 'App link');
}

function resetAdminPassword() {
  var ui = SpreadsheetApp.getUi();
  var pw = withStore_(function (store) {
    var admin = store.t('users').find(function (u) { return u.username === 'admin'; });
    if (!admin) return Engine.ensureAdmin(store, env_(), null);
    var p = env_().randomId(10);
    store.update('users', admin, Object.assign(Engine.setPassword(env_(), p), { must_change: 1, active: 1, token_ver: (admin.token_ver || 0) + 1 }));
    return p;
  });
  ui.alert('New admin password', 'username:  admin\npassword:  ' + pw + '\n\nYou will choose your own password at the next login.', ui.ButtonSet.OK);
}
