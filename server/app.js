'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRouter, readBody, parseCookies, sendJson } = require('./http');
const { getSettings, setSetting, tx, audit } = require('./db');
const A = require('./auth');
const U = require('./util');
const S = require('./stock');
const D = require('./docs');
const R = require('./reports');

const { HttpError, bad, str, num, id, date, bool, oneOf, nowIso, today } = U;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

const EDIT = ['admin', 'scm'];

function createApp(db, { secureCookies = false } = {}) {
  const r = createRouter();
  const sseClients = new Set();
  const broadcast = (what) => {
    const msg = `event: change\ndata: ${JSON.stringify({ what, at: nowIso() })}\n\n`;
    for (const c of sseClients) c.write(msg);
  };

  const cookie = (req, token, maxAge) => {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https';
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  // ---------------------------------------------------------------- auth
  r.post('/api/login', ({ body, req, res }) => {
    const ip = req.socket.remoteAddress || '';
    const username = str(body.username, 'Username', { required: true, max: 60 });
    const guard = A.loginGuard(`${ip}|${username.toLowerCase()}`);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!u || !A.verifyPassword(String(body.password || ''), u.pw_hash)) {
      guard.fail();
      throw new HttpError(401, 'Wrong username or password');
    }
    guard.ok();
    const s = A.createSession(db, u.id);
    res.setHeader('Set-Cookie', cookie(req, s.token, s.maxAge));
    audit(db, u.id, 'login', ip);
    return { user: { id: u.id, username: u.username, name: u.name, role: u.role, must_change: u.must_change } };
  });

  r.post('/api/logout', ({ req, res, cookies }) => {
    A.deleteSession(db, cookies.sid);
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    return { ok: true };
  });

  r.get('/api/me', ({ user }) => {
    A.requireRole(user);
    const st = getSettings(db);
    return { user, settings: st, today: today() };
  });

  r.post('/api/me/password', ({ user, body }) => {
    A.requireRole(user);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!A.verifyPassword(String(body.current || ''), u.pw_hash)) throw bad('Current password is wrong');
    A.checkPasswordRules(body.password);
    if (body.password === body.current) throw bad('Choose a new password');
    db.prepare('UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?').run(A.hashPassword(body.password), u.id);
    audit(db, u.id, 'password.change');
    return { ok: true };
  });

  // ---------------------------------------------------------------- reference data for forms
  r.get('/api/ref', ({ user }) => {
    A.requireRole(user);
    const slabs = db.prepare('SELECT * FROM slabs ORDER BY code').all().map((s) => ({ ...s, area: S.slabArea(s) }));
    const matches = db.prepare('SELECT glue_id, slab_id FROM glue_matches').all();
    const glues = db.prepare('SELECT * FROM glues ORDER BY code').all()
      .map((g) => ({ ...g, slab_ids: matches.filter((m) => m.glue_id === g.id).map((m) => m.slab_id) }));
    return {
      slabs,
      glues,
      locations: db.prepare('SELECT * FROM locations ORDER BY code').all(),
      customers: db.prepare('SELECT * FROM customers ORDER BY key_account DESC, name').all(),
      users: db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all(),
      settings: getSettings(db),
      today: today(),
    };
  });

  // ---------------------------------------------------------------- stock views
  r.get('/api/dashboard', ({ user }) => { A.requireRole(user); return R.dashboard(db); });
  r.get('/api/stock', ({ user }) => { A.requireRole(user); return { rows: S.stockOverview(db), today: today() }; });
  r.get('/api/stock/:id', ({ user, params }) => {
    A.requireRole(user);
    const d = R.slabDetail(db, Number(params.id));
    if (!d) throw new HttpError(404, 'Colour not found');
    return d;
  });
  r.get('/api/remnants', ({ user, query }) => {
    A.requireRole(user);
    return S.availableRemnants(db, { slabId: query.slab_id ? Number(query.slab_id) : null });
  });
  r.get('/api/glue', ({ user }) => { A.requireRole(user); return S.glueOverview(db); });
  r.get('/api/racks', ({ user }) => {
    A.requireRole(user);
    const locs = db.prepare('SELECT * FROM locations ORDER BY code').all();
    const bal = db.prepare(`
      SELECT m.location_id, m.slab_id, s.code, s.name, SUM(m.qty) AS qty FROM moves m JOIN slabs s ON s.id = m.slab_id
       WHERE m.item = 'slab' GROUP BY m.location_id, m.slab_id HAVING SUM(m.qty) <> 0 ORDER BY s.code`).all();
    const rem = S.availableRemnants(db);
    return locs.map((l) => ({
      ...l,
      slabs: bal.filter((b) => b.location_id === l.id),
      remnants: rem.filter((x) => x.location_id === l.id),
    })).filter((l) => l.active || l.slabs.length || l.remnants.length);
  });

  // ---------------------------------------------------------------- locks
  r.get('/api/locks', ({ user }) => { A.requireRole(user); return S.listLocks(db); });
  r.get('/api/locks/free/:slabId', ({ user, params }) => { A.requireRole(user); return D.freeForLock(db, Number(params.slabId)); });
  r.post('/api/locks', ({ user, body }) => { A.requireRole(user); return { id: D.createLock(db, user, body) }; });
  r.post('/api/locks/:id/:action', ({ user, params, body }) => {
    A.requireRole(user);
    const action = oneOf(params.action, 'Action', ['approve', 'reject', 'release', 'update']);
    return { id: D.decideLock(db, user, Number(params.id), action, body) };
  });

  // ---------------------------------------------------------------- documents
  r.get('/api/docs', ({ user, query }) => { A.requireRole(user); return D.listDocs(db, query); });
  r.get('/api/docs/:id', ({ user, params }) => { A.requireRole(user); return D.getDoc(db, Number(params.id)); });
  r.post('/api/docs', ({ user, body }) => { A.requireRole(user, ...EDIT); return { id: D.createDoc(db, user, body) }; });
  r.post('/api/docs/:id/void', ({ user, params, body }) => { A.requireRole(user, ...EDIT); return { id: D.voidDoc(db, user, Number(params.id), body.reason) }; });
  r.post('/api/docs/:id/receive', ({ user, params, body }) => { A.requireRole(user, ...EDIT); return D.receiveDoc(db, user, Number(params.id), body); });
  r.patch('/api/docs/:id', ({ user, params, body }) => { A.requireRole(user, ...EDIT); return { id: D.updateExpected(db, user, Number(params.id), body) }; });
  r.delete('/api/docs/:id', ({ user, params }) => { A.requireRole(user, ...EDIT); D.deleteExpected(db, user, Number(params.id)); return { ok: true }; });

  // ---------------------------------------------------------------- reports
  r.get('/api/reports/sales', ({ user, query }) => {
    A.requireRole(user);
    const to = date(query.to || today(), 'To');
    const from = date(query.from || U.addDays(to, -29), 'From');
    if (from > to) throw bad('"From" is after "To"');
    const group = oneOf(query.group || 'day', 'Group', ['day', 'week', 'month']);
    return R.salesReport(db, { from, to, group });
  });

  r.get('/api/closing', ({ user }) => {
    A.requireRole(user);
    return {
      closed_through: getSettings(db).closed_through,
      months: db.prepare(`SELECT mc.month, mc.closed_at, u.name AS closed_by_name FROM month_closings mc
                           LEFT JOIN users u ON u.id = mc.closed_by ORDER BY mc.month DESC`).all(),
      first_month: (db.prepare(`SELECT MIN(date) AS d FROM docs WHERE status = 'posted'`).get().d || today()).slice(0, 7),
    };
  });
  r.get('/api/closing/:month', ({ user, params }) => {
    A.requireRole(user);
    if (!U.isMonth(params.month)) throw bad('Month must be YYYY-MM');
    return R.closing(db, params.month);
  });
  r.post('/api/closing/:month/close', ({ user, params }) => {
    A.requireRole(user, 'admin');
    const month = params.month;
    if (!U.isMonth(month)) throw bad('Month must be YYYY-MM');
    return tx(db, () => {
      const closed = getSettings(db).closed_through;
      if (closed && month <= closed) throw bad(`${month} is already closed`);
      if (closed && month !== U.nextMonth(closed)) throw bad(`Close ${U.nextMonth(closed)} first`);
      if (U.monthEnd(month) >= today()) throw bad('A month can be closed only after its last day');
      const snap = R.computeClosing(db, month);
      db.prepare('INSERT INTO month_closings (month, closed_at, closed_by, snapshot) VALUES (?, ?, ?, ?)')
        .run(month, nowIso(), user.id, JSON.stringify(snap));
      setSetting(db, 'closed_through', month);
      audit(db, user.id, 'month.close', month);
      return { ok: true };
    });
  });
  r.post('/api/closing/:month/reopen', ({ user, params }) => {
    A.requireRole(user, 'admin');
    return tx(db, () => {
      const closed = getSettings(db).closed_through;
      if (params.month !== closed) throw bad(`Only the last closed month (${closed || 'none'}) can be reopened`);
      db.prepare('DELETE FROM month_closings WHERE month = ?').run(params.month);
      const prev = db.prepare('SELECT MAX(month) AS m FROM month_closings').get().m || '';
      setSetting(db, 'closed_through', prev);
      audit(db, user.id, 'month.reopen', params.month);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- master data
  const slabFields = (b, cur = {}) => ({
    code: str(b.code ?? cur.code, 'Code', { required: true, max: 40 }),
    name: str(b.name ?? cur.name, 'Colour name', { required: true, max: 100 }),
    thickness_mm: num(b.thickness_mm ?? cur.thickness_mm ?? 12, 'Thickness', { positive: true, max: 200 }),
    width_mm: num(b.width_mm ?? cur.width_mm ?? 760, 'Width', { positive: true, max: 10000 }),
    length_mm: num(b.length_mm ?? cur.length_mm ?? 3680, 'Length', { positive: true, max: 10000 }),
    min_pcs: num(b.min_pcs ?? cur.min_pcs ?? 0, 'Minimum stock', { int: true, min: 0, max: 100000 }),
    color_hex: (() => {
      const v = str(b.color_hex ?? cur.color_hex, 'Swatch colour', { max: 7 });
      if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad('Swatch colour must look like #A1B2C3');
      return v;
    })(),
    note: str(b.note ?? cur.note, 'Note', { max: 500 }),
    active: b.active === undefined ? (cur.active ?? 1) : (bool(b.active) ? 1 : 0),
  });
  const unique = (fn) => {
    try { return fn(); } catch (e) {
      if (/UNIQUE constraint/.test(e.message)) throw bad('That code / name already exists');
      throw e;
    }
  };

  r.post('/api/slabs', ({ user, body }) => {
    A.requireRole(user, ...EDIT);
    const f = slabFields(body);
    const newId = unique(() => db.prepare(`INSERT INTO slabs (code, name, thickness_mm, width_mm, length_mm, min_pcs, color_hex, note, active)
      VALUES (:code, :name, :thickness_mm, :width_mm, :length_mm, :min_pcs, :color_hex, :note, :active)`).run(f).lastInsertRowid);
    audit(db, user.id, 'slab.create', f.code);
    return { id: Number(newId) };
  });
  r.patch('/api/slabs/:id', ({ user, params, body }) => {
    A.requireRole(user, ...EDIT);
    const cur = db.prepare('SELECT * FROM slabs WHERE id = ?').get(Number(params.id));
    if (!cur) throw new HttpError(404, 'Colour not found');
    const f = slabFields(body, cur);
    unique(() => db.prepare(`UPDATE slabs SET code = :code, name = :name, thickness_mm = :thickness_mm, width_mm = :width_mm,
      length_mm = :length_mm, min_pcs = :min_pcs, color_hex = :color_hex, note = :note, active = :active WHERE id = :id`).run({ ...f, id: cur.id }));
    audit(db, user.id, 'slab.update', f.code);
    return { id: cur.id };
  });
  r.post('/api/slabs/bulk', ({ user, body }) => {
    A.requireRole(user, ...EDIT);
    if (!Array.isArray(body.rows) || !body.rows.length) throw bad('Nothing to import');
    return tx(db, () => {
      let created = 0;
      let updated = 0;
      body.rows.forEach((row, i) => {
        try {
          const cur = db.prepare('SELECT * FROM slabs WHERE code = ?').get(str(row.code, 'Code', { required: true }));
          const f = slabFields(row, cur || {});
          if (cur) {
            db.prepare(`UPDATE slabs SET name = :name, thickness_mm = :thickness_mm, width_mm = :width_mm, length_mm = :length_mm,
              min_pcs = :min_pcs WHERE id = :id`).run({ name: f.name, thickness_mm: f.thickness_mm, width_mm: f.width_mm, length_mm: f.length_mm, min_pcs: f.min_pcs, id: cur.id });
            updated++;
          } else {
            db.prepare(`INSERT INTO slabs (code, name, thickness_mm, width_mm, length_mm, min_pcs, color_hex, note, active)
              VALUES (:code, :name, :thickness_mm, :width_mm, :length_mm, :min_pcs, :color_hex, :note, :active)`).run(f);
            created++;
          }
        } catch (e) {
          if (e instanceof HttpError) e.message = `Row ${i + 1}: ${e.message}`;
          throw e;
        }
      });
      audit(db, user.id, 'slab.bulk', `${created} new, ${updated} updated`);
      return { created, updated };
    });
  });

  const glueFields = (b, cur = {}) => ({
    code: str(b.code ?? cur.code, 'Code', { required: true, max: 40 }),
    name: str(b.name ?? cur.name, 'Name', { required: true, max: 100 }),
    color: str(b.color ?? cur.color, 'Colour', { max: 60 }),
    unit: str(b.unit ?? cur.unit ?? 'pcs', 'Unit', { required: true, max: 20 }),
    shelf_life_months: num(b.shelf_life_months ?? cur.shelf_life_months ?? 12, 'Shelf life', { int: true, min: 1, max: 120 }),
    min_qty: num(b.min_qty ?? cur.min_qty ?? 0, 'Minimum stock', { int: true, min: 0, max: 1000000 }),
    note: str(b.note ?? cur.note, 'Note', { max: 500 }),
    active: b.active === undefined ? (cur.active ?? 1) : (bool(b.active) ? 1 : 0),
  });
  const setMatches = (glueId, slabIds) => {
    if (!Array.isArray(slabIds)) return;
    db.prepare('DELETE FROM glue_matches WHERE glue_id = ?').run(glueId);
    const ins = db.prepare('INSERT OR IGNORE INTO glue_matches (glue_id, slab_id) VALUES (?, ?)');
    for (const sid of slabIds) {
      const s = db.prepare('SELECT id FROM slabs WHERE id = ?').get(id(sid, 'Slab colour'));
      if (!s) throw bad('Slab colour not found');
      ins.run(glueId, s.id);
    }
  };
  r.post('/api/glues', ({ user, body }) => {
    A.requireRole(user, ...EDIT);
    return tx(db, () => {
      const f = glueFields(body);
      const gid = Number(unique(() => db.prepare(`INSERT INTO glues (code, name, color, unit, shelf_life_months, min_qty, note, active)
        VALUES (:code, :name, :color, :unit, :shelf_life_months, :min_qty, :note, :active)`).run(f).lastInsertRowid));
      setMatches(gid, body.slab_ids);
      audit(db, user.id, 'glue.create', f.code);
      return { id: gid };
    });
  });
  r.patch('/api/glues/:id', ({ user, params, body }) => {
    A.requireRole(user, ...EDIT);
    return tx(db, () => {
      const cur = db.prepare('SELECT * FROM glues WHERE id = ?').get(Number(params.id));
      if (!cur) throw new HttpError(404, 'Glue not found');
      const f = glueFields(body, cur);
      unique(() => db.prepare(`UPDATE glues SET code = :code, name = :name, color = :color, unit = :unit,
        shelf_life_months = :shelf_life_months, min_qty = :min_qty, note = :note, active = :active WHERE id = :id`).run({ ...f, id: cur.id }));
      setMatches(cur.id, body.slab_ids);
      audit(db, user.id, 'glue.update', f.code);
      return { id: cur.id };
    });
  });

  r.post('/api/locations', ({ user, body }) => {
    A.requireRole(user, ...EDIT);
    const codes = Array.isArray(body.codes) ? body.codes : [body.code];
    return tx(db, () => {
      const ids = [];
      for (const c of codes) {
        const code = str(c, 'Rack code', { required: true, max: 30 });
        ids.push(Number(unique(() => db.prepare('INSERT INTO locations (code, name) VALUES (?, ?)')
          .run(code, str(body.name, 'Description', { max: 100 })).lastInsertRowid)));
      }
      audit(db, user.id, 'location.create', codes.join(','));
      return { ids };
    });
  });
  r.patch('/api/locations/:id', ({ user, params, body }) => {
    A.requireRole(user, ...EDIT);
    const cur = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(params.id));
    if (!cur) throw new HttpError(404, 'Rack not found');
    unique(() => db.prepare('UPDATE locations SET code = ?, name = ?, active = ? WHERE id = ?').run(
      str(body.code ?? cur.code, 'Rack code', { required: true, max: 30 }),
      str(body.name ?? cur.name, 'Description', { max: 100 }),
      body.active === undefined ? cur.active : (bool(body.active) ? 1 : 0), cur.id));
    return { id: cur.id };
  });

  const customerFields = (b, cur = {}) => ({
    name: str(b.name ?? cur.name, 'Customer name', { required: true, max: 150 }),
    key_account: b.key_account === undefined ? (cur.key_account ?? 0) : (bool(b.key_account) ? 1 : 0),
    contact: str(b.contact ?? cur.contact, 'Contact person', { max: 100 }),
    phone: str(b.phone ?? cur.phone, 'Phone', { max: 50 }),
    address: str(b.address ?? cur.address, 'Address', { max: 500 }),
    note: str(b.note ?? cur.note, 'Note', { max: 500 }),
    active: b.active === undefined ? (cur.active ?? 1) : (bool(b.active) ? 1 : 0),
  });
  r.post('/api/customers', ({ user, body }) => {
    A.requireRole(user);
    const f = customerFields(body);
    const cid = Number(unique(() => db.prepare(`INSERT INTO customers (name, key_account, contact, phone, address, note, active)
      VALUES (:name, :key_account, :contact, :phone, :address, :note, :active)`).run(f).lastInsertRowid));
    audit(db, user.id, 'customer.create', f.name);
    return { id: cid };
  });
  r.patch('/api/customers/:id', ({ user, params, body }) => {
    A.requireRole(user, ...EDIT);
    const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(params.id));
    if (!cur) throw new HttpError(404, 'Customer not found');
    const f = customerFields(body, cur);
    unique(() => db.prepare(`UPDATE customers SET name = :name, key_account = :key_account, contact = :contact, phone = :phone,
      address = :address, note = :note, active = :active WHERE id = :id`).run({ ...f, id: cur.id }));
    return { id: cur.id };
  });

  // ---------------------------------------------------------------- users & settings (admin)
  r.get('/api/users', ({ user }) => {
    A.requireRole(user, 'admin');
    return db.prepare('SELECT id, username, name, role, active, must_change, created_at FROM users ORDER BY active DESC, name').all();
  });
  r.post('/api/users', ({ user, body }) => {
    A.requireRole(user, 'admin');
    const username = str(body.username, 'Username', { required: true, max: 40 });
    if (!/^[A-Za-z0-9._-]+$/.test(username)) throw bad('Username may only contain letters, numbers, dot, dash and underscore');
    A.checkPasswordRules(body.password);
    const uid = Number(unique(() => db.prepare(`INSERT INTO users (username, name, role, pw_hash, must_change, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(username, str(body.name, 'Name', { required: true, max: 100 }), oneOf(body.role, 'Role', ['admin', 'scm', 'sales']),
        A.hashPassword(body.password), nowIso()).lastInsertRowid));
    audit(db, user.id, 'user.create', username);
    return { id: uid };
  });
  r.patch('/api/users/:id', ({ user, params, body }) => {
    A.requireRole(user, 'admin');
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!cur) throw new HttpError(404, 'User not found');
    const role = body.role !== undefined ? oneOf(body.role, 'Role', ['admin', 'scm', 'sales']) : cur.role;
    const active = body.active !== undefined ? (bool(body.active) ? 1 : 0) : cur.active;
    if (cur.id === user.id && (role !== 'admin' || !active)) throw bad("You can't remove your own admin access");
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
      .run(str(body.name ?? cur.name, 'Name', { required: true, max: 100 }), role, active, cur.id);
    if (body.password) {
      A.checkPasswordRules(body.password);
      db.prepare('UPDATE users SET pw_hash = ?, must_change = 1 WHERE id = ?').run(A.hashPassword(body.password), cur.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cur.id);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cur.id);
    audit(db, user.id, 'user.update', cur.username);
    return { id: cur.id };
  });

  r.patch('/api/settings', ({ user, body }) => {
    A.requireRole(user, 'admin');
    if (body.company_name !== undefined) setSetting(db, 'company_name', str(body.company_name, 'Company name', { required: true, max: 100 }));
    if (body.go_live_date !== undefined) setSetting(db, 'go_live_date', date(body.go_live_date, 'Go-live date', { required: false }) || '');
    if (body.expiry_warn_days !== undefined) setSetting(db, 'expiry_warn_days', num(body.expiry_warn_days, 'Glue expiry warning', { int: true, min: 1, max: 365 }));
    if (body.lock_default_days !== undefined) setSetting(db, 'lock_default_days', num(body.lock_default_days, 'Default lock days', { int: true, min: 1, max: 365 }));
    audit(db, user.id, 'settings.update');
    return getSettings(db);
  });

  r.get('/api/audit', ({ user }) => {
    A.requireRole(user, 'admin');
    return db.prepare(`SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`).all();
  });

  r.get('/api/backup', ({ user, res }) => {
    A.requireRole(user, 'admin');
    const file = path.join(os.tmpdir(), `stock-backup-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const data = fs.readFileSync(file);
    fs.unlinkSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="stock-backup-${today()}.db"`,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
    audit(db, user.id, 'backup.download');
    return undefined;
  });

  // ---------------------------------------------------------------- request handling
  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      serveStatic(req, res, pathname);
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const user = A.sessionUser(db, cookies.sid);

    if (pathname === '/api/events') {
      if (!user) { sendJson(res, 401, { error: 'Please log in' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    try {
      const mutating = req.method !== 'GET';
      if (mutating) {
        // CSRF: only same-origin JSON requests may change data
        const origin = req.headers.origin;
        if (origin) {
          let host = null;
          try { host = new URL(origin).host; } catch { /* "null" or garbage */ }
          if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
        }
        if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send JSON');
      }
      const m = r.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const body = mutating ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const result = await m.handler({ req, res, user, cookies, params: m.params, query, body });
      if (res.headersSent) return;
      sendJson(res, 200, result === undefined ? { ok: true } : result, SECURITY_HEADERS);
      if (mutating && !['/api/login', '/api/logout', '/api/me/password'].includes(pathname)) broadcast(pathname);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof URIError) {
        sendJson(res, 400, { error: 'Bad request' });
      } else {
        console.error(new Date().toISOString(), req.method, pathname, err);
        sendJson(res, 500, { error: 'Something went wrong on the server. Please try again.' });
      }
    }
  }

  return { handler, broadcast, closeAll: () => { for (const c of sseClients) c.end(); sseClients.clear(); } };
}

module.exports = { createApp };
