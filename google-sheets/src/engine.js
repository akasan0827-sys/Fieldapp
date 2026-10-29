/*
 * Stock engine — shared by the Google Apps Script server (Code.gs) and the in-browser demo.
 * Pure JavaScript: no Node, no DOM, no Google APIs. Storage comes in through a `store`,
 * clock / hashing / signing through an `env` object.
 *
 * The API (paths, payloads, results) matches the Node version in /server, so the same screens work on both.
 */
var Engine = (function () {
  'use strict';

  // ===================================================================================
  // Schema: one Google Sheet tab per table. Column types:
  //   id = auto number, n = number (empty = null), z = number (empty = 0), s = text
  // Columns marked "for people" are copies kept only so the sheet is easy to read.
  // ===================================================================================
  const SCHEMA = {
    settings: { sheet: 'Settings', cols: { key: 's', value: 's' } },
    users: { sheet: 'Users', cols: { id: 'id', username: 's', name: 's', role: 's', pw_hash: 's', salt: 's', must_change: 'z', active: 'z', token_ver: 'z', created_at: 's' } },
    locations: { sheet: 'Racks', cols: { id: 'id', code: 's', name: 's', active: 'z' } },
    customers: { sheet: 'Customers', cols: { id: 'id', name: 's', key_account: 'z', contact: 's', phone: 's', address: 's', note: 's', active: 'z' } },
    slabs: { sheet: 'Colours', cols: { id: 'id', code: 's', name: 's', thickness_mm: 'z', width_mm: 'z', length_mm: 'z', min_pcs: 'z', color_hex: 's', note: 's', active: 'z' } },
    glues: { sheet: 'Glue', cols: { id: 'id', code: 's', name: 's', color: 's', unit: 's', shelf_life_months: 'z', min_qty: 'z', slab_ids: 's', note: 's', active: 'z' } },
    glue_lots: { sheet: 'GlueLots', cols: { id: 'id', glue_id: 'n', glue_code: 's', lot_no: 's', expiry: 's', received_date: 's', created_doc_id: 'n' } },
    docs: {
      sheet: 'Documents',
      cols: {
        id: 'id', doc_no: 's', type: 's', status: 's', date: 's', customer_id: 'n', customer_name: 's', partner: 's', deliver_to: 's',
        contact: 's', reference: 's', sales_person: 's', reason: 's', eta: 's', ship_status: 's', note: 's',
        created_by: 'n', created_at: 's', posted_by: 'n', posted_at: 's', voided_by: 'n', voided_at: 's', void_reason: 's',
      },
    },
    lines: {
      sheet: 'Lines',
      cols: {
        id: 'id', doc_id: 'n', doc_no: 's', del: 'z', kind: 's', slab_id: 'n', slab_code: 's', glue_id: 'n', glue_code: 's', lot_id: 'n',
        remnant_id: 'n', remnant_code: 's', location_id: 'n', location_code: 's', to_location_id: 'n', to_location_code: 's',
        qty: 'z', sqm: 'z', leftover_sqm: 'z', waste_sqm: 'z', width_mm: 'n', length_mm: 'n', new_remnant_id: 'n', new_remnant_code: 's',
        lock_id: 'n', lot_no: 's', expiry: 's', note: 's',
      },
    },
    moves: {
      sheet: 'Moves',
      cols: { id: 'id', doc_id: 'n', line_id: 'n', del: 'z', date: 's', item: 's', slab_id: 'n', slab_code: 's', glue_id: 'n', lot_id: 'n', lot_no: 's', location_id: 'n', location_code: 's', qty: 'z' },
    },
    remnants: {
      sheet: 'Offcuts',
      cols: {
        id: 'id', code: 's', slab_id: 'n', slab_code: 's', location_id: 'n', location_code: 's', width_mm: 'n', length_mm: 'n', sqm: 'z',
        status: 's', parent_id: 'n', created_doc_id: 'n', created_date: 's', closed_doc_id: 'n', closed_date: 's', note: 's',
      },
    },
    locks: {
      sheet: 'Locks',
      cols: {
        id: 'id', customer_id: 'n', customer_name: 's', slab_id: 'n', slab_code: 's', pcs: 'z', expires_on: 's', status: 's', note: 's',
        decision_note: 's', requested_by: 'n', decided_by: 'n', created_at: 's', decided_at: 's',
      },
    },
    month_closings: { sheet: 'Closings', cols: { month: 's', closed_at: 's', closed_by: 'n', snapshot: 's' } },
    audit: { sheet: 'Log', cols: { id: 'id', at: 's', user_id: 'n', user_name: 's', action: 's', detail: 's' } },
  };

  const DEFAULT_SETTINGS = {
    company_name: 'Solid Surface Stock',
    go_live_date: '',
    closed_through: '',
    expiry_warn_days: '60',
    lock_default_days: '14',
  };

  // ===================================================================================
  // Store: tables as arrays of row objects, loaded lazily, changes tracked for saving
  // ===================================================================================
  function createStore(loader) {
    const data = {};
    const index = {};
    const nextIds = {};
    const changes = {};
    const t = (name) => {
      if (!data[name]) data[name] = loader(name) || [];
      return data[name];
    };
    const mark = (name, row, kind) => {
      const c = changes[name] || (changes[name] = { ins: [], upd: new Set() });
      if (kind === 'ins') c.ins.push(row);
      else if (!c.ins.includes(row)) c.upd.add(row);
    };
    const store = {
      t,
      get(name, id) {
        if (id === null || id === undefined || id === '') return null;
        if (!index[name]) {
          index[name] = new Map();
          for (const r of t(name)) index[name].set(r.id, r);
        }
        return index[name].get(Number(id)) || null;
      },
      insert(name, row) {
        const cols = SCHEMA[name].cols;
        const obj = {};
        for (const [c, type] of Object.entries(cols)) {
          const v = row[c];
          obj[c] = v === undefined || v === null || v === '' ? (type === 's' ? '' : type === 'z' ? 0 : null) : v;
        }
        if (cols.id) {
          if (nextIds[name] === undefined) nextIds[name] = t(name).reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
          obj.id = nextIds[name]++;
        }
        t(name).push(obj);
        if (index[name]) index[name].set(obj.id, obj);
        mark(name, obj, 'ins');
        return obj;
      },
      update(name, row, patch) {
        Object.assign(row, patch);
        mark(name, row, 'upd');
        return row;
      },
      changes: () => changes,
      dirty: () => Object.keys(changes).length > 0,
      setting(key) {
        const r = t('settings').find((x) => x.key === key);
        return r ? String(r.value) : (DEFAULT_SETTINGS[key] ?? '');
      },
      settings() {
        const out = { ...DEFAULT_SETTINGS };
        for (const r of t('settings')) out[r.key] = String(r.value);
        return out;
      },
      setSetting(key, value) {
        const r = t('settings').find((x) => x.key === key);
        if (r) store.update('settings', r, { value: String(value) });
        else store.insert('settings', { key, value: String(value) });
      },
    };
    return store;
  }

  // ===================================================================================
  // Errors & validation (messages are templates so the screens can translate them)
  // ===================================================================================
  class ApiError extends Error {
    constructor(status, template, params) {
      super(fill(template, params));
      this.status = status;
      this.template = template;
      this.params = params || {};
      this.line = null;
    }
  }
  const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && p[k] !== undefined ? p[k] : `{${k}}`));
  const bad = (msg, params) => new ApiError(400, msg, params);
  const forbidden = (msg = 'You do not have permission to do this') => new ApiError(403, msg);
  const notFound = (msg = 'Not found') => new ApiError(404, msg);

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const fmtUtc = (dt) => dt.toISOString().slice(0, 10);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtUtc(parseDate(s)) === s;
  const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  const addDays = (s, n) => { const dt = parseDate(s); dt.setUTCDate(dt.getUTCDate() + n); return fmtUtc(dt); };
  const addMonths = (s, n) => {
    const [y, m, d] = s.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    return fmtUtc(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
  };
  const monthEnd = (month) => { const [y, m] = month.split('-').map(Number); return fmtUtc(new Date(Date.UTC(y, m, 0))); };
  const nextMonth = (month) => addMonths(`${month}-01`, 1).slice(0, 7);
  const weekStart = (s) => addDays(s, -((parseDate(s).getUTCDay() + 6) % 7));
  function isoWeek(s) {
    const dt = parseDate(s);
    const dow = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - dow + 3);
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    return 1 + Math.round((dt - firstThu) / (7 * 864e5));
  }

  function str(v, field, { required = false, max = 500 } = {}) {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string' && typeof v !== 'number') throw bad('{field} must be text', { field });
    v = String(v).trim();
    if (required && !v) throw bad('{field} is required', { field });
    if (v.length > max) throw bad('{field} is too long (max {max} characters)', { field, max });
    return v;
  }
  function num(v, field, { min = -Infinity, max = Infinity, int = false, required = true, positive = false } = {}) {
    if (v === undefined || v === null || v === '') {
      if (required) throw bad('{field} is required', { field });
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw bad('{field} must be a number', { field });
    if (int && !Number.isInteger(n)) throw bad('{field} must be a whole number', { field });
    if (positive && n <= 0) throw bad('{field} must be greater than 0', { field });
    if (n < min) throw bad('{field} must be at least {min}', { field, min });
    if (n > max) throw bad('{field} must be at most {max}', { field, max: r3(max) });
    return n;
  }
  function id(v, field, { required = true } = {}) {
    if (v === undefined || v === null || v === '') {
      if (required) throw bad('{field} is required', { field });
      return null;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw bad('{field} is invalid', { field });
    return n;
  }
  function date(v, field, { required = true } = {}) {
    if (v === undefined || v === null || v === '') {
      if (required) throw bad('{field} is required', { field });
      return null;
    }
    if (!isDate(v)) throw bad('{field} must be a date (YYYY-MM-DD)', { field });
    return v;
  }
  const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
  function oneOf(v, field, list) {
    if (!list.includes(v)) throw bad('{field} must be one of: {list}', { field, list: list.join(', ') });
    return v;
  }

  // ===================================================================================
  // Context helpers
  // ===================================================================================
  function ctxOf(store, env, user) {
    const c = {
      store, env, user,
      today: env.today(),
      now: env.now(),
      liveLines: () => store.t('lines').filter((l) => !l.del),
      liveMoves: () => store.t('moves').filter((m) => !m.del),
      doc: (docId) => store.get('docs', docId),
      audit(action, detail = '') {
        store.insert('audit', { at: c.now, user_id: user ? user.id : null, user_name: user ? user.name : '', action, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
      },
    };
    return c;
  }

  const slabArea = (s) => (s.width_mm * s.length_mm) / 1e6;
  const codeOf = (store, table, rid) => (store.get(table, rid) || {}).code || '';
  const glueSlabIds = (g) => String(g.slab_ids || '').split(',').map((x) => Number(x)).filter((x) => x > 0);

  // ===================================================================================
  // Stock queries
  // ===================================================================================
  function listLocks(c, asOf = c.today) {
    const { store } = c;
    const fulfilled = new Map();
    for (const l of c.liveLines()) {
      if (!l.lock_id || (l.kind !== 'slab_out' && l.kind !== 'slab_cut')) continue;
      const d = c.doc(l.doc_id);
      if (!d || d.status !== 'posted') continue;
      fulfilled.set(l.lock_id, (fulfilled.get(l.lock_id) || 0) + l.qty);
    }
    return store.t('locks').slice().sort((a, b) => b.id - a.id).map((k) => {
      const cust = store.get('customers', k.customer_id) || {};
      const slab = store.get('slabs', k.slab_id) || {};
      const f = fulfilled.get(k.id) || 0;
      const remaining = Math.max(0, k.pcs - f);
      let state = k.status;
      if (k.status === 'active') {
        if (remaining <= 0) state = 'fulfilled';
        else if (k.expires_on && k.expires_on < asOf) state = 'expired';
      }
      return {
        ...k, customer_name: cust.name || k.customer_name, key_account: cust.key_account || 0,
        slab_code: slab.code || k.slab_code, slab_name: slab.name || '', fulfilled: f, remaining, state,
        requested_by_name: (store.get('users', k.requested_by) || {}).name || '',
        decided_by_name: (store.get('users', k.decided_by) || {}).name || '',
      };
    });
  }
  function lockedBySlab(locks) {
    const m = new Map();
    for (const k of locks) if (k.state === 'active') m.set(k.slab_id, (m.get(k.slab_id) || 0) + k.remaining);
    return m;
  }

  function slabBalances(c, slabId = null) {
    const m = new Map();
    for (const mv of c.liveMoves()) {
      if (mv.item !== 'slab' || (slabId && mv.slab_id !== slabId)) continue;
      const k = `${mv.slab_id}:${mv.location_id}`;
      m.set(k, (m.get(k) || 0) + mv.qty);
    }
    const out = [];
    for (const [k, qty] of m) {
      if (!qty) continue;
      const [sid, lid] = k.split(':').map(Number);
      out.push({ slab_id: sid, location_id: lid, location_code: codeOf(c.store, 'locations', lid), qty });
    }
    return out.sort((a, b) => a.location_code.localeCompare(b.location_code));
  }
  function onHandAt(c, slabId, locId) {
    let q = 0;
    for (const mv of c.liveMoves()) if (mv.item === 'slab' && mv.slab_id === slabId && mv.location_id === locId) q += mv.qty;
    return q;
  }
  function onHandTotal(c, slabId) {
    let q = 0;
    for (const mv of c.liveMoves()) if (mv.item === 'slab' && mv.slab_id === slabId) q += mv.qty;
    return q;
  }
  function lotBalance(c, lotId) {
    let q = 0;
    for (const mv of c.liveMoves()) if (mv.item === 'glue' && mv.lot_id === lotId) q += mv.qty;
    return q;
  }

  function availableRemnants(c, slabId = null) {
    const { store } = c;
    return store.t('remnants').filter((r) => r.status === 'available' && (!slabId || r.slab_id === slabId)).map((r) => {
      const s = store.get('slabs', r.slab_id) || {};
      return { ...r, slab_code: s.code, slab_name: s.name, location_code: codeOf(store, 'locations', r.location_id), created_doc_no: (c.doc(r.created_doc_id) || {}).doc_no || '' };
    }).sort((a, b) => a.slab_code.localeCompare(b.slab_code) || b.sqm - a.sqm);
  }

  function stockOverview(c) {
    const { store } = c;
    const t = c.today;
    const balances = slabBalances(c);
    const locks = listLocks(c, t);
    const locked = lockedBySlab(locks);
    const pending = new Map();
    for (const k of locks) if (k.state === 'pending') pending.set(k.slab_id, (pending.get(k.slab_id) || 0) + k.pcs);
    const rem = new Map();
    for (const r of store.t('remnants')) {
      if (r.status !== 'available') continue;
      const x = rem.get(r.slab_id) || { n: 0, sqm: 0 };
      x.n += 1; x.sqm += r.sqm;
      rem.set(r.slab_id, x);
    }
    const incoming = new Map();
    const sold = new Map();
    const since = addDays(t, -90);
    for (const l of c.liveLines()) {
      const d = c.doc(l.doc_id);
      if (!d) continue;
      if (d.type === 'inbound' && d.status === 'expected' && l.kind === 'slab_in') {
        const x = incoming.get(l.slab_id) || { qty: 0, eta: null };
        x.qty += l.qty;
        if (d.eta && (!x.eta || d.eta < x.eta)) x.eta = d.eta;
        incoming.set(l.slab_id, x);
      }
      if (d.type === 'outbound' && d.status === 'posted' && d.date > since && l.slab_id) {
        const x = sold.get(l.slab_id) || { sqm: 0, pcs: 0 };
        x.sqm += l.sqm;
        if (l.kind === 'slab_out' || l.kind === 'slab_cut') x.pcs += l.qty;
        sold.set(l.slab_id, x);
      }
    }
    const glueBySlab = glueStockBySlab(c);
    return store.t('slabs').slice().sort((a, b) => a.code.localeCompare(b.code)).map((s) => {
      const area = slabArea(s);
      const locs = balances.filter((b) => b.slab_id === s.id).map(({ location_id, location_code, qty }) => ({ location_id, location_code, qty }));
      const onHand = locs.reduce((a, b) => a + b.qty, 0);
      const lk = locked.get(s.id) || 0;
      const rm = rem.get(s.id) || { n: 0, sqm: 0 };
      const inc = incoming.get(s.id) || { qty: 0, eta: null };
      const sd = sold.get(s.id) || { sqm: 0, pcs: 0 };
      const totalSqm = r3(onHand * area + rm.sqm);
      const avgSqm = r3(sd.sqm / 3);
      const available = onHand - lk;
      let status = 'ok';
      if (onHand <= 0 && !rm.n) status = 'out';
      else if (available < 0) status = 'overlocked';
      else if (s.min_pcs > 0 && available < s.min_pcs) status = 'low';
      return {
        id: s.id, code: s.code, name: s.name, color_hex: s.color_hex, active: s.active,
        thickness_mm: s.thickness_mm, width_mm: s.width_mm, length_mm: s.length_mm, area, min_pcs: s.min_pcs,
        on_hand: onHand, locked: lk, available, pending_lock: pending.get(s.id) || 0, locations: locs,
        remnant_count: rm.n, remnant_sqm: r3(rm.sqm), total_sqm: totalSqm,
        incoming: inc.qty, next_eta: inc.eta,
        sold_90d_sqm: r3(sd.sqm), sold_90d_pcs: sd.pcs, avg_month_sqm: avgSqm,
        months_cover: avgSqm > 0 ? r3(totalSqm / avgSqm) : null,
        glue_usable: glueBySlab.get(s.id) || 0, status,
      };
    }).filter((r) => r.active || r.on_hand || r.remnant_count || r.incoming);
  }

  function lotBalances(c) {
    const bal = new Map();
    for (const mv of c.liveMoves()) if (mv.item === 'glue') bal.set(mv.lot_id, (bal.get(mv.lot_id) || 0) + mv.qty);
    return c.store.t('glue_lots').map((gl) => ({ ...gl, qty: bal.get(gl.id) || 0 }))
      .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.id - b.id));
  }
  function lotState(expiry, t, warnDays) {
    if (expiry < t) return 'expired';
    if (expiry <= addDays(t, warnDays)) return 'expiring';
    return 'ok';
  }
  function glueStockBySlab(c) {
    const usable = new Map();
    for (const l of lotBalances(c)) if (l.expiry >= c.today && l.qty) usable.set(l.glue_id, (usable.get(l.glue_id) || 0) + l.qty);
    const m = new Map();
    for (const g of c.store.t('glues')) for (const sid of glueSlabIds(g)) m.set(sid, (m.get(sid) || 0) + (usable.get(g.id) || 0));
    return m;
  }
  function glueOverview(c) {
    const { store } = c;
    const t = c.today;
    const warn = Number(store.setting('expiry_warn_days')) || 60;
    const lots = lotBalances(c).filter((l) => l.qty !== 0);
    return store.t('glues').slice().sort((a, b) => a.code.localeCompare(b.code)).map((g) => {
      const gl = lots.filter((l) => l.glue_id === g.id).map((l) => ({
        id: l.id, lot_no: l.lot_no, expiry: l.expiry, received_date: l.received_date, qty: l.qty,
        state: lotState(l.expiry, t, warn), days_left: Math.round((Date.parse(l.expiry) - Date.parse(t)) / 864e5),
      }));
      const sum = (st) => gl.filter((l) => !st || st.includes(l.state)).reduce((a, l) => a + l.qty, 0);
      const usable = sum(['ok', 'expiring']);
      let status = 'ok';
      if (usable <= 0) status = 'out';
      else if (g.min_qty > 0 && usable < g.min_qty) status = 'low';
      return {
        ...g,
        matches: glueSlabIds(g).map((sid) => store.get('slabs', sid)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code)).map(({ id: sid, code, name }) => ({ id: sid, code, name })),
        lots: gl, on_hand: sum(), usable, expiring: sum(['expiring']), expired: sum(['expired']),
        next_expiry: (gl.find((l) => l.state !== 'expired') || {}).expiry || null, status,
      };
    }).filter((g) => g.active || g.on_hand);
  }

  // ===================================================================================
  // Documents: posting rules
  // ===================================================================================
  const PREFIX = { opening: 'OPN', inbound: 'IN', outbound: 'OUT', adjust: 'ADJ', transfer: 'TRF' };
  const KINDS = {
    opening: ['slab_in', 'remnant_in', 'glue_in'],
    inbound: ['slab_in', 'glue_in'],
    outbound: ['slab_out', 'slab_cut', 'remnant_out', 'remnant_cut', 'glue_out'],
    adjust: ['slab_adj', 'glue_adj', 'remnant_in', 'remnant_scrap'],
    transfer: ['slab_move', 'remnant_move'],
  };
  const SHIP_STATUS = ['ordered', 'on_board', 'at_port'];
  const MIN_OFFCUT_SQM = 0.005;
  const TOL = 0.0005;

  function getSlab(c, v, field = 'Slab colour') {
    const s = c.store.get('slabs', id(v, field));
    if (!s) throw bad('{field} not found', { field });
    return s;
  }
  function getLoc(c, v, field = 'Rack location') {
    const l = c.store.get('locations', id(v, field));
    if (!l) throw bad('{field} not found', { field });
    return l;
  }
  function getGlue(c, v) {
    const g = c.store.get('glues', id(v, 'Glue'));
    if (!g) throw bad('{field} not found', { field: 'Glue' });
    return g;
  }
  function getLot(c, v) {
    const l = c.store.get('glue_lots', id(v, 'Glue lot'));
    if (!l) throw bad('{field} not found', { field: 'Glue lot' });
    return l;
  }
  function getAvailableRemnant(c, v) {
    const r = c.store.get('remnants', id(v, 'Offcut'));
    if (!r) throw bad('{field} not found', { field: 'Offcut' });
    if (r.status !== 'available') throw bad('Offcut {code} is no longer in stock ({status})', { code: r.code, status: r.status });
    return r;
  }
  function checkOpenPeriod(c, d) {
    const closed = c.store.setting('closed_through');
    if (closed && d.slice(0, 7) <= closed) throw bad('{month} is a closed month. Use a later date, or ask an admin to reopen the month.', { month: d.slice(0, 7) });
  }
  function nextDocNo(c, type, d) {
    const p = `${PREFIX[type]}-${d.slice(2, 4)}${d.slice(5, 7)}-`;
    let n = 0;
    for (const x of c.store.t('docs')) if (x.doc_no.startsWith(p)) n = Math.max(n, Number(x.doc_no.slice(p.length)) || 0);
    return p + pad(n + 1, 4);
  }

  function parseHeader(c, input) {
    const type = oneOf(input.type, 'Document type', Object.keys(PREFIX));
    const expected = type === 'inbound' && input.status === 'expected';
    const h = {
      type, status: expected ? 'expected' : 'posted', date: date(input.date || c.today, 'Date'),
      customer_id: null, customer_name: '',
      partner: str(input.partner, 'Supplier', { max: 200 }),
      deliver_to: str(input.deliver_to, 'Delivered to', { max: 500 }),
      contact: str(input.contact, 'Contact', { max: 200 }),
      reference: str(input.reference, 'Reference', { max: 100 }),
      sales_person: str(input.sales_person, 'Sales person', { max: 100 }),
      reason: str(input.reason, 'Reason', { max: 100 }),
      eta: '', ship_status: '', note: str(input.note, 'Note', { max: 1000 }),
    };
    if (type === 'outbound') {
      h.customer_id = id(input.customer_id, 'Customer');
      const cust = c.store.get('customers', h.customer_id);
      if (!cust) throw bad('{field} not found', { field: 'Customer' });
      h.customer_name = cust.name;
      if (!h.deliver_to) throw bad('"Delivered to" (site / address) is required');
    }
    if (type === 'adjust' && !h.reason) throw bad('Reason is required for adjustments');
    if (expected) {
      h.eta = date(input.eta, 'ETA', { required: false }) || '';
      h.ship_status = oneOf(input.ship_status || 'ordered', 'Shipment status', SHIP_STATUS);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw bad('Add at least one line');
    if (input.lines.length > 500) throw bad('Too many lines (max 500)');
    return h;
  }

  function parseSize(raw, prefix, { defaultSqm = null, required = true, label = 'Size' } = {}) {
    const w = num(raw[`${prefix}width_mm`], `${label} width (mm)`, { required: false, positive: true, max: 10000 });
    const l = num(raw[`${prefix}length_mm`], `${label} length (mm)`, { required: false, positive: true, max: 10000 });
    let sqm = num(raw[`${prefix}sqm`], `${label} m²`, { required: false, min: 0, max: 100 });
    if (sqm === null && w && l) sqm = (w * l) / 1e6;
    if (sqm === null) sqm = defaultSqm;
    if (sqm === null && required) throw bad('{field}: enter m² or width × length', { field: label });
    return { sqm: sqm === null ? null : r3(sqm), width_mm: w, length_mm: l };
  }

  function withLine(i, fn) {
    try { fn(); } catch (e) {
      if (e instanceof ApiError && e.status === 400 && !e.line) e.line = i + 1;
      throw e;
    }
  }

  function postLines(c, doc, rawLines) {
    const { store } = c;
    const allowed = KINDS[doc.type];
    const slabLocs = new Map();
    const lots = new Set();
    const nonLockOut = new Map();
    const locksUsed = new Map();

    const writeLine = (o) => {
      const row = { doc_id: doc.id, doc_no: doc.doc_no, del: 0, ...o };
      if (row.slab_id) row.slab_code = codeOf(store, 'slabs', row.slab_id);
      if (row.glue_id) row.glue_code = codeOf(store, 'glues', row.glue_id);
      if (row.location_id) row.location_code = codeOf(store, 'locations', row.location_id);
      if (row.to_location_id) row.to_location_code = codeOf(store, 'locations', row.to_location_id);
      if (row.remnant_id) row.remnant_code = codeOf(store, 'remnants', row.remnant_id);
      if (row.new_remnant_id) row.new_remnant_code = codeOf(store, 'remnants', row.new_remnant_id);
      return store.insert('lines', row).id;
    };
    const move = (lineId, o) => {
      store.insert('moves', {
        doc_id: doc.id, line_id: lineId, del: 0, date: doc.date, item: o.item, slab_id: o.slab_id || null,
        slab_code: o.slab_id ? codeOf(store, 'slabs', o.slab_id) : '', glue_id: o.glue_id || null, lot_id: o.lot_id || null,
        lot_no: o.lot_id ? (store.get('glue_lots', o.lot_id) || {}).lot_no : '', location_id: o.location_id || null,
        location_code: o.location_id ? codeOf(store, 'locations', o.location_id) : '', qty: o.qty,
      });
      if (o.item === 'slab') {
        const k = `${o.slab_id}:${o.location_id}`;
        slabLocs.set(k, (slabLocs.get(k) || 0) + (o.qty < 0 ? -o.qty : 0));
      } else lots.add(o.lot_id);
    };
    const newRemnant = ({ slab_id, location_id, sqm, width_mm = null, length_mm = null, parent_id = null, note = '' }) => {
      const r = store.insert('remnants', {
        slab_id, slab_code: codeOf(store, 'slabs', slab_id), location_id, location_code: codeOf(store, 'locations', location_id),
        width_mm, length_mm, sqm: r3(sqm), status: 'available', parent_id, created_doc_id: doc.id, created_date: doc.date, note,
      });
      store.update('remnants', r, { code: `R-${pad(r.id, 5)}` });
      return r.id;
    };
    const closeRemnant = (rem, status) => store.update('remnants', rem, { status, closed_doc_id: doc.id, closed_date: doc.date });
    const useLock = (raw, slab, qty) => {
      const lockId = id(raw.lock_id, 'Lock', { required: false });
      if (!lockId) {
        nonLockOut.set(slab.id, (nonLockOut.get(slab.id) || 0) + qty);
        return null;
      }
      const k = store.get('locks', lockId);
      if (!k) throw bad('Lock #{id} not found', { id: lockId });
      if (k.status !== 'active') throw bad('Lock #{id} is not active ({status})', { id: lockId, status: k.status });
      if (k.slab_id !== slab.id) throw bad('Lock #{id} is for a different colour', { id: lockId });
      if (k.customer_id !== doc.customer_id) throw bad('Lock #{id} belongs to another customer', { id: lockId });
      if (k.expires_on && k.expires_on < doc.date) throw bad('Lock #{id} expired on {date}', { id: lockId, date: k.expires_on });
      locksUsed.set(lockId, (locksUsed.get(lockId) || 0) + qty);
      return lockId;
    };
    const leftover = (raw, maxSqm) => parseSize(raw, 'leftover_', { defaultSqm: Math.max(0, r3(maxSqm)), label: 'Leftover' });

    rawLines.forEach((raw, i) => withLine(i, () => {
      if (!raw || typeof raw !== 'object') throw bad('Invalid line');
      const kind = oneOf(raw.kind, 'Line type', allowed);
      const note = str(raw.note, 'Note', { max: 300 });
      switch (kind) {
        case 'slab_in': {
          const s = getSlab(c, raw.slab_id);
          const loc = getLoc(c, raw.location_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 100000 });
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty });
          break;
        }
        case 'slab_out': {
          const s = getSlab(c, raw.slab_id);
          const loc = getLoc(c, raw.location_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 100000 });
          const lockId = useLock(raw, s, qty);
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), lock_id: lockId, note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty: -qty });
          break;
        }
        case 'slab_cut': {
          const s = getSlab(c, raw.slab_id);
          const loc = getLoc(c, raw.location_id);
          const area = slabArea(s);
          const sqm = r3(num(raw.sqm, 'Delivered m²', { positive: true, max: area + TOL }));
          const lo = leftover(raw, area - sqm);
          if (sqm + lo.sqm > area + TOL) throw bad('Delivered + leftover ({total} m²) is more than one slab ({area} m²)', { total: r3(sqm + lo.sqm), area: r3(area) });
          const lockId = useLock(raw, s, 1);
          const leftLoc = raw.leftover_location_id ? getLoc(c, raw.leftover_location_id, 'Leftover rack') : loc;
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
          const rem = getAvailableRemnant(c, raw.remnant_id);
          closeRemnant(rem, 'used');
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, sqm: rem.sqm, note });
          break;
        }
        case 'remnant_cut': {
          const rem = getAvailableRemnant(c, raw.remnant_id);
          const sqm = r3(num(raw.sqm, 'Delivered m²', { positive: true }));
          if (sqm > rem.sqm + TOL) throw bad('Offcut {code} is only {sqm} m²', { code: rem.code, sqm: rem.sqm });
          const lo = leftover(raw, rem.sqm - sqm);
          if (sqm + lo.sqm > rem.sqm + TOL) throw bad('Delivered + leftover ({total} m²) is more than offcut {code} ({sqm} m²)', { total: r3(sqm + lo.sqm), code: rem.code, sqm: rem.sqm });
          closeRemnant(rem, 'used');
          const leftLocId = raw.leftover_location_id ? getLoc(c, raw.leftover_location_id, 'Leftover rack').id : rem.location_id;
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
          const s = getSlab(c, raw.slab_id);
          const loc = getLoc(c, raw.location_id);
          const size = parseSize(raw, '', { label: 'Offcut' });
          if (size.sqm <= 0) throw bad('Offcut m² must be greater than 0');
          if (size.sqm > slabArea(s) + TOL) throw bad("An offcut can't be bigger than a full slab ({area} m²)", { area: r3(slabArea(s)) });
          const rid = newRemnant({ slab_id: s.id, location_id: loc.id, ...size, note });
          writeLine({ kind, slab_id: s.id, location_id: loc.id, sqm: size.sqm, width_mm: size.width_mm, length_mm: size.length_mm, new_remnant_id: rid, note });
          break;
        }
        case 'remnant_scrap': {
          const rem = getAvailableRemnant(c, raw.remnant_id);
          closeRemnant(rem, 'scrapped');
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, sqm: rem.sqm, waste_sqm: rem.sqm, note });
          break;
        }
        case 'remnant_move': {
          const rem = getAvailableRemnant(c, raw.remnant_id);
          const to = getLoc(c, raw.to_location_id, 'New rack');
          if (to.id === rem.location_id) throw bad('Offcut {code} is already in {rack}', { code: rem.code, rack: to.code });
          writeLine({ kind, slab_id: rem.slab_id, remnant_id: rem.id, location_id: rem.location_id, to_location_id: to.id, sqm: rem.sqm, note });
          store.update('remnants', rem, { location_id: to.id, location_code: to.code });
          break;
        }
        case 'glue_in': {
          const g = getGlue(c, raw.glue_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
          const lotNo = str(raw.lot_no, 'Lot / batch no.', { required: true, max: 60 });
          const expiry = date(raw.expiry || addMonths(doc.date, g.shelf_life_months), 'Expiry date');
          let lot = store.t('glue_lots').find((x) => x.glue_id === g.id && String(x.lot_no).toLowerCase() === lotNo.toLowerCase());
          if (lot && lot.expiry !== expiry) throw bad('Lot {lot} of {code} already exists with expiry {date}', { lot: lotNo, code: g.code, date: lot.expiry });
          if (!lot) lot = store.insert('glue_lots', { glue_id: g.id, glue_code: g.code, lot_no: lotNo, expiry, received_date: doc.date, created_doc_id: doc.id });
          const lid = writeLine({ kind, glue_id: g.id, lot_id: lot.id, qty, lot_no: lot.lot_no, expiry, note });
          move(lid, { item: 'glue', glue_id: g.id, lot_id: lot.id, qty });
          break;
        }
        case 'glue_out': {
          const g = getGlue(c, raw.glue_id);
          const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
          let alloc = [];
          if (raw.lot_id) {
            const lot = getLot(c, raw.lot_id);
            if (lot.glue_id !== g.id) throw bad('That lot belongs to a different glue');
            if (lot.expiry < doc.date) throw bad('Lot {lot} expired on {date}', { lot: lot.lot_no, date: lot.expiry });
            alloc = [{ lot, q: qty }];
          } else {
            // first-expiry-first-out over non-expired lots
            const avail = lotBalances(c).filter((l) => l.glue_id === g.id && l.expiry >= doc.date && l.qty > 0);
            let need = qty;
            for (const lot of avail) {
              if (need <= 0) break;
              const q = Math.min(need, lot.qty);
              alloc.push({ lot, q });
              need -= q;
            }
            if (need > 0) throw bad('Only {have} usable {unit} of glue {code} in stock (expired lots excluded)', { have: qty - need, unit: g.unit, code: g.code });
          }
          for (const { lot, q } of alloc) {
            const lid = writeLine({ kind, glue_id: g.id, lot_id: lot.id, qty: q, lot_no: lot.lot_no, expiry: lot.expiry, note });
            move(lid, { item: 'glue', glue_id: g.id, lot_id: lot.id, qty: -q });
          }
          break;
        }
        case 'glue_adj': {
          const lot = getLot(c, raw.lot_id);
          const qty = num(raw.qty, 'Quantity (+/-)', { int: true, min: -1000000, max: 1000000 });
          if (qty === 0) throw bad('Quantity can not be 0');
          const lid = writeLine({ kind, glue_id: lot.glue_id, lot_id: lot.id, qty, lot_no: lot.lot_no, expiry: lot.expiry, note });
          move(lid, { item: 'glue', glue_id: lot.glue_id, lot_id: lot.id, qty });
          break;
        }
        case 'slab_adj': {
          const s = getSlab(c, raw.slab_id);
          const loc = getLoc(c, raw.location_id);
          const qty = num(raw.qty, 'Quantity (+/-)', { int: true, min: -100000, max: 100000 });
          if (qty === 0) throw bad('Quantity can not be 0');
          const lid = writeLine({ kind, slab_id: s.id, location_id: loc.id, qty, sqm: r3(qty * slabArea(s)), note });
          move(lid, { item: 'slab', slab_id: s.id, location_id: loc.id, qty });
          break;
        }
        case 'slab_move': {
          const s = getSlab(c, raw.slab_id);
          const from = getLoc(c, raw.location_id, 'From rack');
          const to = getLoc(c, raw.to_location_id, 'To rack');
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
    }));

    // stock can never go negative at a rack or in a glue lot
    for (const [key, taken] of slabLocs) {
      const [sid, lid] = key.split(':').map(Number);
      const q = onHandAt(c, sid, lid);
      if (q < 0) {
        const s = store.get('slabs', sid);
        throw bad('Not enough {code} {name} at rack {rack}: only {have} pcs there', { code: s.code, name: s.name, rack: codeOf(store, 'locations', lid), have: q + taken });
      }
    }
    for (const lotId of lots) {
      const q = lotBalance(c, lotId);
      if (q < 0) {
        const l = store.get('glue_lots', lotId);
        throw bad('Not enough glue {code} in lot {lot} (short by {short})', { code: codeOf(store, 'glues', l.glue_id), lot: l.lot_no, short: -q });
      }
    }
    // locks: never deliver more than the lock holds; never take stock locked for someone else
    if (locksUsed.size || nonLockOut.size) {
      const locks = listLocks(c);
      for (const [lockId, taken] of locksUsed) {
        const k = locks.find((x) => x.id === lockId);
        if (k.fulfilled > k.pcs) throw bad('Lock #{id} ({customer}, {code}) only has {left} pcs left', { id: lockId, customer: k.customer_name, code: k.slab_code, left: k.pcs - (k.fulfilled - taken) });
      }
      const locked = lockedBySlab(locks);
      for (const [sid, taken] of nonLockOut) {
        const onHand = onHandTotal(c, sid);
        const lk = locked.get(sid) || 0;
        if (onHand - lk < 0) {
          const s = store.get('slabs', sid);
          throw bad("Only {free} pcs of {code} {name} are free — {locked} pcs are locked for customers. Choose the customer's lock on the line or release a lock first.", { free: Math.max(0, onHand - lk + taken), code: s.code, name: s.name, locked: lk });
        }
      }
    }
  }

  function planLines(c, doc, rawLines) {
    rawLines.forEach((raw, i) => withLine(i, () => {
      const kind = oneOf(raw && raw.kind, 'Line type', KINDS.inbound);
      const note = str(raw.note, 'Note', { max: 300 });
      const qty = num(raw.qty, 'Quantity', { int: true, positive: true, max: 1000000 });
      if (kind === 'slab_in') {
        const s = getSlab(c, raw.slab_id);
        const loc = raw.location_id ? getLoc(c, raw.location_id) : null;
        c.store.insert('lines', { doc_id: doc.id, doc_no: doc.doc_no, kind, slab_id: s.id, slab_code: s.code, location_id: loc && loc.id, location_code: loc ? loc.code : '', qty, sqm: r3(qty * slabArea(s)), note });
      } else {
        const g = getGlue(c, raw.glue_id);
        c.store.insert('lines', { doc_id: doc.id, doc_no: doc.doc_no, kind, glue_id: g.id, glue_code: g.code, qty, lot_no: str(raw.lot_no, 'Lot', { max: 60 }), expiry: date(raw.expiry, 'Expiry', { required: false }) || '', note });
      }
    }));
  }

  function deleteLines(c, docId) {
    for (const l of c.store.t('lines')) if (l.doc_id === docId && !l.del) c.store.update('lines', l, { del: 1 });
  }

  function createDoc(c, input) {
    const h = parseHeader(c, input);
    if (h.status === 'posted') checkOpenPeriod(c, h.date);
    const posted = h.status === 'posted';
    const doc = c.store.insert('docs', {
      ...h, doc_no: nextDocNo(c, h.type, h.date), created_by: c.user.id, created_at: c.now,
      posted_by: posted ? c.user.id : null, posted_at: posted ? c.now : '',
    });
    if (posted) postLines(c, doc, input.lines);
    else planLines(c, doc, input.lines);
    c.audit(posted ? 'doc.post' : 'doc.expected', doc.doc_no);
    return doc.id;
  }

  function voidDoc(c, docId, reasonIn) {
    const { store } = c;
    const doc = store.get('docs', docId);
    if (!doc) throw notFound('Document not found');
    if (doc.status !== 'posted') throw bad('Only posted documents can be voided');
    const reason = str(reasonIn, 'Reason', { required: true, max: 300 });
    checkOpenPeriod(c, doc.date);
    for (const r of store.t('remnants')) {
      if (r.created_doc_id !== doc.id || r.status === 'void') continue;
      if (r.status !== 'available') throw bad('Offcut {code} (made by this document) was already {status} in {doc}. Void that document first.', { code: r.code, status: r.status, doc: (store.get('docs', r.closed_doc_id) || {}).doc_no || '' });
    }
    for (const r of store.t('remnants')) {
      if (r.created_doc_id === doc.id && r.status !== 'void') store.update('remnants', r, { status: 'void' });
      else if (r.closed_doc_id === doc.id) store.update('remnants', r, { status: 'available', closed_doc_id: null, closed_date: '' });
    }
    for (const l of c.liveLines()) {
      if (l.doc_id !== doc.id || l.kind !== 'remnant_move') continue;
      const r = store.get('remnants', l.remnant_id);
      if (r && r.location_id === l.to_location_id) store.update('remnants', r, { location_id: l.location_id, location_code: codeOf(store, 'locations', l.location_id) });
    }
    const mv = c.liveMoves().filter((m) => m.doc_id === doc.id);
    for (const m of mv) store.update('moves', m, { del: 1 });
    for (const m of mv) {
      if (m.item === 'slab') {
        const q = onHandAt(c, m.slab_id, m.location_id);
        if (q < 0) throw bad("Can't void: {code} at rack {rack} would become {qty} pcs (that stock was already delivered or moved). Void the later documents first, or post an adjustment.", { code: codeOf(store, 'slabs', m.slab_id), rack: codeOf(store, 'locations', m.location_id), qty: q });
      } else if (lotBalance(c, m.lot_id) < 0) {
        const l = store.get('glue_lots', m.lot_id);
        throw bad("Can't void: glue {code} lot {lot} would go negative (already used).", { code: codeOf(store, 'glues', l.glue_id), lot: l.lot_no });
      }
    }
    store.update('docs', doc, { status: 'void', voided_by: c.user.id, voided_at: c.now, void_reason: reason });
    c.audit('doc.void', `${doc.doc_no}: ${reason}`);
    return doc.id;
  }

  function receiveDoc(c, docId, input) {
    const { store } = c;
    const doc = store.get('docs', docId);
    if (!doc) throw notFound('Document not found');
    if (doc.type !== 'inbound' || doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be received');
    const d = date(input.date || c.today, 'Received date');
    checkOpenPeriod(c, d);
    if (!Array.isArray(input.lines) || !input.lines.length) throw bad('Add at least one received line');
    const planned = c.liveLines().filter((l) => l.doc_id === doc.id).map((l) => ({ ...l }));
    const origDate = doc.date;
    deleteLines(c, doc.id);
    const reference = input.reference !== undefined ? str(input.reference, 'Reference', { max: 100 }) : doc.reference;
    store.update('docs', doc, { status: 'posted', date: d, reference, posted_by: c.user.id, posted_at: c.now });
    postLines(c, doc, input.lines);

    let remainderId = null;
    if (input.keep_remaining) {
      const key = (l) => (l.kind === 'slab_in' ? `s${l.slab_id}` : `g${l.glue_id}`);
      const got = new Map();
      for (const l of c.liveLines()) if (l.doc_id === doc.id) got.set(key(l), (got.get(key(l)) || 0) + l.qty);
      const rest = [];
      for (const l of planned) {
        const k = key(l);
        const have = got.get(k) || 0;
        const left = l.qty - have;
        got.set(k, Math.max(0, have - l.qty));
        if (left > 0) rest.push({ ...l, qty: left });
      }
      if (rest.length) {
        const rd = store.insert('docs', {
          doc_no: nextDocNo(c, 'inbound', origDate), type: 'inbound', status: 'expected', date: origDate,
          partner: doc.partner, reference: doc.reference, eta: doc.eta, ship_status: doc.ship_status,
          note: `Remaining from ${doc.doc_no}${doc.note ? ` — ${doc.note}` : ''}`, created_by: c.user.id, created_at: c.now,
        });
        remainderId = rd.id;
        planLines(c, rd, rest.map((l) => ({ kind: l.kind, slab_id: l.slab_id, glue_id: l.glue_id, location_id: l.location_id, qty: l.qty, lot_no: l.lot_no || '', expiry: l.expiry || '', note: l.note })));
      }
    }
    c.audit('doc.receive', doc.doc_no);
    return { id: doc.id, remainder_id: remainderId };
  }

  function updateExpected(c, docId, input) {
    const doc = c.store.get('docs', docId);
    if (!doc) throw notFound('Document not found');
    if (doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be edited');
    c.store.update('docs', doc, {
      eta: input.eta !== undefined ? (date(input.eta, 'ETA', { required: false }) || '') : doc.eta,
      ship_status: input.ship_status !== undefined ? oneOf(input.ship_status, 'Shipment status', SHIP_STATUS) : doc.ship_status,
      partner: input.partner !== undefined ? str(input.partner, 'Supplier', { max: 200 }) : doc.partner,
      reference: input.reference !== undefined ? str(input.reference, 'Reference', { max: 100 }) : doc.reference,
      note: input.note !== undefined ? str(input.note, 'Note', { max: 1000 }) : doc.note,
    });
    if (Array.isArray(input.lines)) {
      if (!input.lines.length) throw bad('Add at least one line');
      deleteLines(c, doc.id);
      planLines(c, doc, input.lines);
    }
    c.audit('doc.update_expected', doc.doc_no);
    return doc.id;
  }

  function deleteExpected(c, docId) {
    const doc = c.store.get('docs', docId);
    if (!doc) throw notFound('Document not found');
    if (doc.status !== 'expected') throw bad('Only incoming (expected) shipments can be deleted — void posted documents instead');
    deleteLines(c, doc.id);
    c.store.update('docs', doc, { status: 'deleted' });
    c.audit('doc.delete_expected', doc.doc_no);
  }

  function getDoc(c, docId) {
    const { store } = c;
    const d = store.get('docs', docId);
    if (!d || d.status === 'deleted') throw notFound('Document not found');
    const uname = (uid) => (store.get('users', uid) || {}).name || '';
    const cust = store.get('customers', d.customer_id) || {};
    return {
      ...d, customer_name: cust.name || d.customer_name, customer_phone: cust.phone || '',
      created_by_name: uname(d.created_by), posted_by_name: uname(d.posted_by), voided_by_name: uname(d.voided_by),
      lines: c.liveLines().filter((l) => l.doc_id === d.id).sort((a, b) => a.id - b.id).map((l) => {
        const s = store.get('slabs', l.slab_id) || {};
        const g = store.get('glues', l.glue_id) || {};
        const nr = store.get('remnants', l.new_remnant_id) || {};
        return {
          ...l, slab_code: s.code || l.slab_code, slab_name: s.name || '', glue_code: g.code || l.glue_code, glue_name: g.name || '', glue_unit: g.unit || '',
          location_code: codeOf(store, 'locations', l.location_id), to_location_code: codeOf(store, 'locations', l.to_location_id),
          remnant_code: codeOf(store, 'remnants', l.remnant_id), new_remnant_code: nr.code || '', new_remnant_status: nr.status || '',
        };
      }),
    };
  }

  function listDocs(c, q = {}) {
    const { store } = c;
    const sums = new Map();
    for (const l of c.liveLines()) {
      const s = sums.get(l.doc_id) || { slab_pcs: 0, sqm: 0, glue_qty: 0, line_count: 0 };
      if (['slab_in', 'slab_out', 'slab_adj', 'slab_move'].includes(l.kind)) s.slab_pcs += l.qty;
      if (l.kind === 'slab_cut') s.slab_pcs += 1;
      if (l.slab_id && l.kind !== 'slab_move' && l.kind !== 'remnant_move') s.sqm += l.sqm;
      if (l.glue_id) s.glue_qty += l.qty;
      s.line_count += 1;
      sums.set(l.doc_id, s);
    }
    const like = (q.q || '').toLowerCase();
    const list = store.t('docs').filter((d) => d.status !== 'deleted'
      && (!q.type || d.type === q.type) && (!q.status || d.status === q.status)
      && (!q.from || d.date >= q.from) && (!q.to || d.date <= q.to)
      && (!q.customer_id || d.customer_id === Number(q.customer_id))
      && (!like || [d.doc_no, d.reference, d.deliver_to, d.partner, d.note, d.customer_name, d.sales_person].some((x) => String(x || '').toLowerCase().includes(like))));
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const limit = Math.min(Number(q.limit) || 300, 2000);
    return list.slice(0, limit).map((d) => {
      const s = sums.get(d.id) || { slab_pcs: 0, sqm: 0, glue_qty: 0, line_count: 0 };
      return {
        id: d.id, doc_no: d.doc_no, type: d.type, status: d.status, date: d.date, customer_id: d.customer_id,
        customer_name: (store.get('customers', d.customer_id) || {}).name || d.customer_name, partner: d.partner, deliver_to: d.deliver_to,
        contact: d.contact, reference: d.reference, sales_person: d.sales_person, reason: d.reason, eta: d.eta || null, ship_status: d.ship_status,
        note: d.note, void_reason: d.void_reason, created_at: d.created_at, created_by_name: (store.get('users', d.created_by) || {}).name || '',
        ...s, sqm: r3(s.sqm),
      };
    });
  }

  // ---- locks ------------------------------------------------------------------------
  function freeForLock(c, slabId, excludeLockId = null) {
    const locks = listLocks(c).filter((k) => k.id !== excludeLockId);
    const locked = lockedBySlab(locks).get(slabId) || 0;
    const onHand = onHandTotal(c, slabId);
    let incoming = 0;
    for (const l of c.liveLines()) {
      if (l.kind !== 'slab_in' || l.slab_id !== slabId) continue;
      const d = c.doc(l.doc_id);
      if (d && d.type === 'inbound' && d.status === 'expected') incoming += l.qty;
    }
    return { onHand, locked, free: onHand - locked, incoming };
  }
  function assertLockable(c, slabId, pcs, excludeLockId = null) {
    const f = freeForLock(c, slabId, excludeLockId);
    if (pcs > Math.max(0, f.free) + f.incoming) {
      const code = codeOf(c.store, 'slabs', slabId);
      if (f.incoming) throw bad('Only {free} pcs of {code} are free to lock (+{incoming} incoming)', { free: Math.max(0, f.free), code, incoming: f.incoming });
      throw bad('Only {free} pcs of {code} are free to lock', { free: Math.max(0, f.free), code });
    }
  }
  function createLock(c, input) {
    const customerId = id(input.customer_id, 'Customer');
    const cust = c.store.get('customers', customerId);
    if (!cust) throw bad('{field} not found', { field: 'Customer' });
    const s = getSlab(c, input.slab_id);
    const pcs = num(input.pcs, 'Pieces', { int: true, positive: true, max: 100000 });
    const expires = date(input.expires_on, 'Lock until', { required: false });
    if (expires && expires < c.today) throw bad('"Lock until" is in the past');
    const note = str(input.note, 'Note', { max: 500 });
    const direct = c.user.role !== 'sales';
    if (direct) assertLockable(c, s.id, pcs);
    const k = c.store.insert('locks', {
      customer_id: customerId, customer_name: cust.name, slab_id: s.id, slab_code: s.code, pcs, expires_on: expires || '',
      status: direct ? 'active' : 'pending', note, requested_by: c.user.id, decided_by: direct ? c.user.id : null,
      created_at: c.now, decided_at: direct ? c.now : '',
    });
    c.audit(direct ? 'lock.create' : 'lock.request', `#${k.id} ${s.code} x${pcs}`);
    return k.id;
  }
  function decideLock(c, lockId, action, input = {}) {
    const { store, user } = c;
    const k = store.get('locks', lockId);
    if (!k) throw notFound('Lock not found');
    const note = str(input.note, 'Note', { max: 500 });
    if (action === 'approve' || action === 'reject') {
      if (user.role === 'sales') throw forbidden('Only SCM or admin can approve lock requests');
      if (k.status !== 'pending') throw bad('This lock is not waiting for approval');
      if (action === 'approve') {
        if (k.expires_on && k.expires_on < c.today) throw bad('The requested "lock until" date has passed — extend it first');
        assertLockable(c, k.slab_id, k.pcs, k.id);
      }
      store.update('locks', k, { status: action === 'approve' ? 'active' : 'rejected', decided_by: user.id, decided_at: c.now, decision_note: note });
    } else if (action === 'release') {
      const own = k.requested_by === user.id && k.status === 'pending';
      if (user.role === 'sales' && !own) throw forbidden('Only SCM or admin can release locks');
      if (!['pending', 'active'].includes(k.status)) throw bad('This lock is already closed');
      store.update('locks', k, { status: 'released', decided_by: user.id, decided_at: c.now, decision_note: note || (own ? 'Cancelled by requester' : '') });
    } else if (action === 'update') {
      if (user.role === 'sales') throw forbidden('Only SCM or admin can change locks');
      if (!['pending', 'active'].includes(k.status)) throw bad('This lock is already closed');
      const pcs = input.pcs !== undefined ? num(input.pcs, 'Pieces', { int: true, positive: true }) : k.pcs;
      const expires = input.expires_on !== undefined ? (date(input.expires_on, 'Lock until', { required: false }) || '') : k.expires_on;
      const fulfilled = listLocks(c).find((x) => x.id === k.id).fulfilled;
      if (pcs < fulfilled) throw bad('{n} pcs were already delivered against this lock', { n: fulfilled });
      if (k.status === 'active' && pcs > k.pcs) assertLockable(c, k.slab_id, pcs, k.id);
      store.update('locks', k, { pcs, expires_on: expires, note: input.note !== undefined ? str(input.note, 'Note', { max: 500 }) : k.note });
    } else throw bad('Unknown action');
    c.audit(`lock.${action}`, `#${k.id}`);
    return k.id;
  }

  // ===================================================================================
  // Reports
  // ===================================================================================
  function salesLines(c, from, to) {
    const out = [];
    for (const l of c.liveLines()) {
      const d = c.doc(l.doc_id);
      if (!d || d.type !== 'outbound' || d.status !== 'posted' || d.date < from || d.date > to) continue;
      const s = c.store.get('slabs', l.slab_id) || {};
      const g = c.store.get('glues', l.glue_id) || {};
      out.push({
        doc_id: d.id, doc_no: d.doc_no, date: d.date, customer_id: d.customer_id,
        customer_name: (c.store.get('customers', d.customer_id) || {}).name || d.customer_name, deliver_to: d.deliver_to, sales_person: d.sales_person,
        kind: l.kind, slab_id: l.slab_id, slab_code: s.code, slab_name: s.name, glue_id: l.glue_id, glue_code: g.code, glue_name: g.name, qty: l.qty, sqm: l.sqm,
      });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.doc_id - b.doc_id));
  }
  const blank = () => ({ deliveries: new Set(), full_pcs: 0, cut_sqm: 0, sqm: 0, glue: 0 });
  function addAcc(acc, l) {
    acc.deliveries.add(l.doc_id);
    if (l.kind === 'slab_out') acc.full_pcs += l.qty;
    if (['slab_cut', 'remnant_cut', 'remnant_out'].includes(l.kind)) acc.cut_sqm += l.sqm;
    if (l.slab_id) acc.sqm += l.sqm;
    if (l.kind === 'glue_out') acc.glue += l.qty;
  }
  const fin = (acc) => ({ deliveries: acc.deliveries.size, full_pcs: acc.full_pcs, cut_sqm: r3(acc.cut_sqm), sqm: r3(acc.sqm), glue: acc.glue });
  const periodKey = (d, group) => (group === 'week' ? weekStart(d) : group === 'month' ? d.slice(0, 7) : d);
  const periodLabel = (key, group) => (group === 'week' ? `W${pad(isoWeek(key))} · ${key.slice(5)}–${addDays(key, 6).slice(5)}` : key);

  function salesReport(c, { from, to, group = 'day' }) {
    const lines = salesLines(c, from, to);
    const periods = new Map();
    let cur = group === 'week' ? weekStart(from) : group === 'month' ? from.slice(0, 7) : from;
    for (let i = 0; i < 800; i++) {
      if ((group === 'month' ? `${cur}-01` : cur) > to) break;
      periods.set(cur, blank());
      cur = group === 'day' ? addDays(cur, 1) : group === 'week' ? addDays(cur, 7) : addMonths(`${cur}-01`, 1).slice(0, 7);
    }
    const byColor = new Map();
    const byCustomer = new Map();
    const bySales = new Map();
    const byGlue = new Map();
    const deliveries = new Map();
    const total = blank();
    const bucket = (m, k, init) => { if (!m.has(k)) m.set(k, { ...init, acc: blank() }); return m.get(k).acc; };
    for (const l of lines) {
      const k = periodKey(l.date, group);
      if (!periods.has(k)) periods.set(k, blank());
      addAcc(periods.get(k), l);
      addAcc(total, l);
      if (l.slab_id) addAcc(bucket(byColor, l.slab_id, { slab_id: l.slab_id, code: l.slab_code, name: l.slab_name }), l);
      if (l.glue_id) addAcc(bucket(byGlue, l.glue_id, { glue_id: l.glue_id, code: l.glue_code, name: l.glue_name }), l);
      addAcc(bucket(byCustomer, l.customer_id, { customer_id: l.customer_id, name: l.customer_name }), l);
      addAcc(bucket(bySales, l.sales_person || '(not set)', { name: l.sales_person || '(not set)' }), l);
      addAcc(bucket(deliveries, l.doc_id, { doc_id: l.doc_id, doc_no: l.doc_no, date: l.date, customer_name: l.customer_name, deliver_to: l.deliver_to, sales_person: l.sales_person }), l);
    }
    const flat = (m) => [...m.values()].map(({ acc, ...rest }) => ({ ...rest, ...fin(acc) })).sort((a, b) => b.sqm - a.sqm || b.glue - a.glue);
    return {
      from, to, group, total: fin(total),
      periods: [...periods.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, acc]) => ({ key, label: periodLabel(key, group), ...fin(acc) })),
      by_color: flat(byColor), by_glue: flat(byGlue), by_customer: flat(byCustomer), by_sales: flat(bySales),
      deliveries: [...deliveries.values()].map(({ acc, ...rest }) => ({ ...rest, ...fin(acc) })).reverse(),
    };
  }

  function computeClosing(c, month) {
    const { store } = c;
    const start = `${month}-01`;
    const end = monthEnd(month);
    const docType = (docId) => (c.doc(docId) || {}).type;
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + (v || 0));
    const pcsOpen = new Map(); const pcsIn = new Map(); const pcsOut = new Map(); const pcsAdj = new Map();
    const gOpen = new Map(); const gIn = new Map(); const gOut = new Map(); const gAdj = new Map();
    const lotAtEnd = new Map();
    for (const m of c.liveMoves()) {
      const isSlab = m.item === 'slab';
      const k = isSlab ? m.slab_id : m.glue_id;
      if (!isSlab && m.date <= end) add(lotAtEnd, m.lot_id, m.qty);
      if (m.date < start) { add(isSlab ? pcsOpen : gOpen, k, m.qty); continue; }
      if (m.date > end) continue;
      const tp = docType(m.doc_id);
      if (tp === 'opening' || tp === 'inbound') add(isSlab ? pcsIn : gIn, k, m.qty);
      else if (tp === 'outbound') add(isSlab ? pcsOut : gOut, k, -m.qty);
      else add(isSlab ? pcsAdj : gAdj, k, m.qty);
    }
    const remOpen = new Map(); const remNew = new Map(); const remGone = new Map(); const remClose = new Map(); const remCount = new Map();
    for (const r of store.t('remnants')) {
      if (r.status === 'void') continue;
      if (r.created_date < start && (!r.closed_date || r.closed_date >= start)) add(remOpen, r.slab_id, r.sqm);
      if (r.created_date >= start && r.created_date <= end) add(remNew, r.slab_id, r.sqm);
      if ((r.status === 'used' || r.status === 'scrapped') && r.closed_date >= start && r.closed_date <= end) add(remGone, r.slab_id, r.sqm);
      if (r.created_date <= end && (!r.closed_date || r.closed_date > end)) { add(remClose, r.slab_id, r.sqm); add(remCount, r.slab_id, 1); }
    }
    const sold = new Map(); const scrapped = new Map();
    for (const l of c.liveLines()) {
      const d = c.doc(l.doc_id);
      if (!d || d.status !== 'posted' || d.date < start || d.date > end || !l.slab_id) continue;
      if (d.type === 'outbound') {
        const x = sold.get(l.slab_id) || { sqm: 0, full_pcs: 0, waste: 0, docs: new Set() };
        x.sqm += l.sqm; if (l.kind === 'slab_out') x.full_pcs += l.qty; x.waste += l.waste_sqm; x.docs.add(d.id);
        sold.set(l.slab_id, x);
      } else if (d.type === 'adjust') add(scrapped, l.slab_id, l.waste_sqm);
    }
    const slabRows = store.t('slabs').slice().sort((a, b) => a.code.localeCompare(b.code)).map((s) => {
      const area = slabArea(s);
      const o = pcsOpen.get(s.id) || 0; const i = pcsIn.get(s.id) || 0; const out = pcsOut.get(s.id) || 0; const a = pcsAdj.get(s.id) || 0;
      const cl = o + i - out + a;
      const sd = sold.get(s.id) || { sqm: 0, full_pcs: 0, waste: 0, docs: new Set() };
      const row = {
        slab_id: s.id, code: s.code, name: s.name, area, open_pcs: o, in_pcs: i, out_pcs: out, adj_pcs: a, close_pcs: cl,
        open_offcut_sqm: r3(remOpen.get(s.id) || 0), new_offcut_sqm: r3(remNew.get(s.id) || 0), used_offcut_sqm: r3(remGone.get(s.id) || 0),
        close_offcut_sqm: r3(remClose.get(s.id) || 0), close_offcut_count: remCount.get(s.id) || 0,
        sold_sqm: r3(sd.sqm), sold_full_pcs: sd.full_pcs, deliveries: sd.docs.size, waste_sqm: r3(sd.waste + (scrapped.get(s.id) || 0)),
      };
      row.open_sqm = r3(o * area + row.open_offcut_sqm);
      row.close_sqm = r3(cl * area + row.close_offcut_sqm);
      return row;
    }).filter((r) => r.open_pcs || r.in_pcs || r.out_pcs || r.adj_pcs || r.close_pcs || r.open_offcut_sqm || r.close_offcut_sqm || r.new_offcut_sqm);
    const expiredAtEnd = new Map();
    for (const gl of store.t('glue_lots')) if (gl.expiry <= end && (lotAtEnd.get(gl.id) || 0) > 0) add(expiredAtEnd, gl.glue_id, lotAtEnd.get(gl.id));
    const glueRows = store.t('glues').slice().sort((a, b) => a.code.localeCompare(b.code)).map((g) => {
      const o = gOpen.get(g.id) || 0; const i = gIn.get(g.id) || 0; const out = gOut.get(g.id) || 0; const a = gAdj.get(g.id) || 0;
      return { glue_id: g.id, code: g.code, name: g.name, color: g.color, unit: g.unit, open: o, in: i, out, adj: a, close: o + i - out + a, expired_at_close: expiredAtEnd.get(g.id) || 0 };
    }).filter((r) => r.open || r.in || r.out || r.adj || r.close);
    const sum = (rows, k) => r3(rows.reduce((a, r) => a + (r[k] || 0), 0));
    const docCounts = {};
    for (const d of store.t('docs')) if (d.status === 'posted' && d.date >= start && d.date <= end) docCounts[d.type] = (docCounts[d.type] || 0) + 1;
    return {
      month, start, end, slabs: slabRows, glues: glueRows,
      totals: {
        open_pcs: sum(slabRows, 'open_pcs'), in_pcs: sum(slabRows, 'in_pcs'), out_pcs: sum(slabRows, 'out_pcs'), adj_pcs: sum(slabRows, 'adj_pcs'),
        close_pcs: sum(slabRows, 'close_pcs'), open_sqm: sum(slabRows, 'open_sqm'), close_sqm: sum(slabRows, 'close_sqm'),
        open_offcut_sqm: sum(slabRows, 'open_offcut_sqm'), close_offcut_sqm: sum(slabRows, 'close_offcut_sqm'),
        new_offcut_sqm: sum(slabRows, 'new_offcut_sqm'), used_offcut_sqm: sum(slabRows, 'used_offcut_sqm'),
        sold_sqm: sum(slabRows, 'sold_sqm'), sold_full_pcs: sum(slabRows, 'sold_full_pcs'), waste_sqm: sum(slabRows, 'waste_sqm'),
        glue_open: sum(glueRows, 'open'), glue_in: sum(glueRows, 'in'), glue_out: sum(glueRows, 'out'), glue_adj: sum(glueRows, 'adj'),
        glue_close: sum(glueRows, 'close'), glue_expired: sum(glueRows, 'expired_at_close'),
      },
      doc_counts: docCounts,
    };
  }
  function closing(c, month) {
    const row = c.store.t('month_closings').find((m) => m.month === month);
    if (row) return { ...JSON.parse(row.snapshot), closed: true, closed_at: row.closed_at, closed_by_name: (c.store.get('users', row.closed_by) || {}).name || '' };
    return { ...computeClosing(c, month), closed: false };
  }

  function dashboard(c) {
    const t = c.today;
    const stock = stockOverview(c);
    const glue = glueOverview(c);
    const locks = listLocks(c);
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const last14 = salesReport(c, { from: addDays(t, -13), to: t, group: 'day' });
    const week = salesReport(c, { from: weekStart(t), to: t, group: 'week' });
    const month = salesReport(c, { from: `${t.slice(0, 7)}-01`, to: t, group: 'month' });
    const top30 = salesReport(c, { from: addDays(t, -29), to: t, group: 'month' }).by_color.slice(0, 8);
    const incMap = new Map();
    for (const l of c.liveLines()) {
      const d = c.doc(l.doc_id);
      if (!d || d.type !== 'inbound' || d.status !== 'expected') continue;
      const x = incMap.get(d.id) || { id: d.id, doc_no: d.doc_no, partner: d.partner, reference: d.reference, eta: d.eta || null, ship_status: d.ship_status, slab_pcs: 0, glue_qty: 0 };
      if (l.kind === 'slab_in') x.slab_pcs += l.qty; else x.glue_qty += l.qty;
      incMap.set(d.id, x);
    }
    const incoming = [...incMap.values()].sort((a, b) => ((a.eta || '9999') < (b.eta || '9999') ? -1 : 1));
    const alerts = [];
    const A = (level, text, params, link) => alerts.push({ level, text, params, link });
    for (const s of stock) {
      if (s.status === 'overlocked') A('red', '{code} {name}: {n} pcs more locked than in stock', { code: s.code, name: s.name, n: -s.available }, `/stock/${s.id}`);
      else if (s.status === 'out' && s.active) A('red', '{code} {name} is out of stock', { code: s.code, name: s.name }, `/stock/${s.id}`);
      else if (s.status === 'low') A('amber', '{code} {name}: {n} pcs available (min {min})', { code: s.code, name: s.name, n: s.available, min: s.min_pcs }, `/stock/${s.id}`);
    }
    for (const g of glue) {
      for (const l of g.lots) {
        if (l.state === 'expired') A('red', 'Glue {code} lot {lot}: {qty} {unit} expired on {date}', { code: g.code, lot: l.lot_no, qty: l.qty, unit: g.unit, date: l.expiry }, '/glue');
        else if (l.state === 'expiring') A('amber', 'Glue {code} lot {lot}: {qty} {unit} expire on {date} ({days} days)', { code: g.code, lot: l.lot_no, qty: l.qty, unit: g.unit, date: l.expiry, days: l.days_left }, '/glue');
      }
      if (g.status === 'low' || (g.status === 'out' && g.active)) A(g.status === 'out' ? 'red' : 'amber', 'Glue {code} {name}: {n} usable {unit}', { code: g.code, name: g.name, n: g.usable, unit: g.unit }, '/glue');
    }
    for (const k of locks) {
      if (k.state === 'pending') A('blue', 'Lock request #{id}: {customer} wants {pcs} pcs {code} — waiting for approval', { id: k.id, customer: k.customer_name, pcs: k.pcs, code: k.slab_code }, '/locks');
      if (k.state === 'expired') A('amber', 'Lock #{id} ({customer}, {pcs} pcs {code}) expired on {date} — release or extend', { id: k.id, customer: k.customer_name, pcs: k.remaining, code: k.slab_code, date: k.expires_on }, '/locks');
      if (k.state === 'active' && k.expires_on && k.expires_on <= addDays(t, 3)) A('amber', 'Lock #{id} ({customer}, {pcs} pcs {code}) expires on {date}', { id: k.id, customer: k.customer_name, pcs: k.remaining, code: k.slab_code, date: k.expires_on }, '/locks');
    }
    for (const d of incoming) if (d.eta && d.eta < t) A('amber', 'Shipment {doc} {ref} was due {date} — receive it or update the ETA', { doc: d.doc_no, ref: d.reference ? `(${d.reference})` : '', date: d.eta }, `/doc/${d.id}`);
    const order = { red: 0, amber: 1, blue: 2 };
    alerts.sort((a, b) => order[a.level] - order[b.level]);
    return {
      today: t, company_name: c.store.setting('company_name'),
      kpi: {
        colors: stock.filter((s) => s.active).length, on_hand: sum(stock, 'on_hand'), locked: sum(stock, 'locked'), available: sum(stock, 'available'),
        remnant_count: sum(stock, 'remnant_count'), remnant_sqm: r3(sum(stock, 'remnant_sqm')), total_sqm: r3(sum(stock, 'total_sqm')),
        incoming_pcs: sum(stock, 'incoming'), glue_usable: sum(glue, 'usable'), glue_expiring: sum(glue, 'expiring'), glue_expired: sum(glue, 'expired'),
        pending_locks: locks.filter((k) => k.state === 'pending').length, active_locks: locks.filter((k) => k.state === 'active').length,
      },
      sales_week: week.total, sales_month: month.total, sales_14d: last14.periods, top_colors_30d: top30, incoming, alerts,
    };
  }

  function slabDetail(c, slabId) {
    const { store } = c;
    const slab = store.get('slabs', slabId);
    if (!slab) return null;
    const t = c.today;
    const from = addMonths(`${t.slice(0, 7)}-01`, -11);
    const byMonth = new Map();
    for (let i = 0; i < 12; i++) { const key = addMonths(from, i).slice(0, 7); byMonth.set(key, { key, sqm: 0, full_pcs: 0, cut_sqm: 0 }); }
    for (const l of salesLines(c, from, t)) {
      if (l.slab_id !== slabId) continue;
      const m = byMonth.get(l.date.slice(0, 7));
      if (!m) continue;
      m.sqm += l.sqm;
      if (l.kind === 'slab_out') m.full_pcs += l.qty; else m.cut_sqm += l.sqm;
    }
    const incoming = new Map();
    const history = [];
    for (const l of c.liveLines()) {
      if (l.slab_id !== slabId) continue;
      const d = c.doc(l.doc_id);
      if (!d) continue;
      if (d.type === 'inbound' && d.status === 'expected' && l.kind === 'slab_in') {
        const x = incoming.get(d.id) || { id: d.id, doc_no: d.doc_no, partner: d.partner, reference: d.reference, eta: d.eta || null, ship_status: d.ship_status, qty: 0 };
        x.qty += l.qty;
        incoming.set(d.id, x);
      }
      if (d.status === 'posted') {
        history.push({
          doc_id: d.id, doc_no: d.doc_no, type: d.type, date: d.date, customer_name: (store.get('customers', d.customer_id) || {}).name || d.customer_name,
          deliver_to: d.deliver_to, partner: d.partner, reason: d.reason, kind: l.kind, qty: l.qty, sqm: l.sqm, leftover_sqm: l.leftover_sqm,
          location_code: codeOf(store, 'locations', l.location_id), to_location_code: codeOf(store, 'locations', l.to_location_id),
          remnant_code: codeOf(store, 'remnants', l.remnant_id), new_remnant_code: codeOf(store, 'remnants', l.new_remnant_id), lock_id: l.lock_id, waste_sqm: l.waste_sqm, _id: l.id,
        });
      }
    }
    history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.doc_id - a.doc_id || b._id - a._id));
    return {
      slab: { ...slab, area: slabArea(slab) },
      stock: stockOverview(c).find((r) => r.id === slabId) || null,
      remnants: availableRemnants(c, slabId),
      locks: listLocks(c).filter((k) => k.slab_id === slabId && ['pending', 'active', 'expired'].includes(k.state)),
      incoming: [...incoming.values()].sort((a, b) => ((a.eta || '9999') < (b.eta || '9999') ? -1 : 1)),
      glues: glueOverview(c).filter((g) => g.matches.some((m) => m.id === slabId)),
      monthly: [...byMonth.values()].map((m) => ({ ...m, sqm: r3(m.sqm), cut_sqm: r3(m.cut_sqm) })),
      history: history.slice(0, 100),
    };
  }

  // ===================================================================================
  // Users & sessions (signed tokens — nothing to store per login)
  // ===================================================================================
  const TOKEN_DAYS = 30;
  function hashPassword(env, pw, salt) {
    let h = `${salt}:${pw}`;
    for (let i = 0; i < 200; i++) h = env.sha256(`${h}:${salt}`);
    return h;
  }
  function setPassword(env, pw) {
    const salt = env.randomId(16);
    return { salt, pw_hash: hashPassword(env, pw, salt) };
  }
  function checkPasswordRules(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
    if (pw.length > 200) throw bad('Password is too long');
  }
  function makeToken(env, u) {
    const payload = `${u.id}.${u.token_ver || 0}.${Date.now() + TOKEN_DAYS * 864e5}`;
    return `${payload}.${env.sign(payload)}`;
  }
  function tokenUser(store, env, token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const payload = parts.slice(0, 3).join('.');
    if (env.sign(payload) !== parts[3]) return null;
    const [uid, ver, exp] = parts.map(Number);
    if (!(exp > Date.now())) return null;
    const u = store.get('users', uid);
    if (!u || !u.active || (u.token_ver || 0) !== ver) return null;
    return { id: u.id, username: u.username, name: u.name, role: u.role, must_change: u.must_change };
  }
  function requireRole(user, ...roles) {
    if (!user) throw new ApiError(401, 'Please log in');
    if (roles.length && !roles.includes(user.role)) throw forbidden();
  }
  /** Creates the first admin when there are no users. Returns the password, or null. */
  function ensureAdmin(store, env, password) {
    if (store.t('users').length) return null;
    const pw = password || env.randomId(10);
    store.insert('users', { username: 'admin', name: 'Administrator', role: 'admin', ...setPassword(env, pw), must_change: 1, active: 1, token_ver: 0, created_at: env.now() });
    return pw;
  }

  // ===================================================================================
  // Routes (same paths as the Node version)
  // ===================================================================================
  const routes = [];
  const route = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, fn });
  };
  const EDIT = ['admin', 'scm'];
  const unique = (store, table, field, value, exceptId = null) => {
    const v = String(value).toLowerCase();
    if (store.t(table).some((r) => String(r[field]).toLowerCase() === v && r.id !== exceptId)) throw bad('That code / name already exists');
  };

  route('POST', '/api/login', (c, { body }) => {
    const username = str(body.username, 'Username', { required: true, max: 60 }).toLowerCase();
    const u = c.store.t('users').find((x) => x.username.toLowerCase() === username && x.active);
    if (!u || hashPassword(c.env, String(body.password || ''), u.salt) !== u.pw_hash) throw new ApiError(401, 'Wrong username or password');
    c.user = u;
    c.audit('login');
    return { token: makeToken(c.env, u), user: { id: u.id, username: u.username, name: u.name, role: u.role, must_change: u.must_change } };
  });
  route('POST', '/api/logout', () => ({ ok: true }));
  route('GET', '/api/me', (c) => { requireRole(c.user); return { user: c.user, settings: c.store.settings(), today: c.today }; });
  route('POST', '/api/me/password', (c, { body }) => {
    requireRole(c.user);
    const u = c.store.get('users', c.user.id);
    if (hashPassword(c.env, String(body.current || ''), u.salt) !== u.pw_hash) throw bad('Current password is wrong');
    checkPasswordRules(body.password);
    if (body.password === body.current) throw bad('Choose a new password');
    c.store.update('users', u, { ...setPassword(c.env, body.password), must_change: 0, token_ver: (u.token_ver || 0) + 1 });
    c.audit('password.change');
    return { ok: true, token: makeToken(c.env, u) };
  });

  route('GET', '/api/ref', (c) => {
    requireRole(c.user);
    const { store } = c;
    return {
      slabs: store.t('slabs').slice().sort((a, b) => a.code.localeCompare(b.code)).map((s) => ({ ...s, area: slabArea(s) })),
      glues: store.t('glues').slice().sort((a, b) => a.code.localeCompare(b.code)).map((g) => ({ ...g, slab_ids: glueSlabIds(g) })),
      locations: store.t('locations').slice().sort((a, b) => a.code.localeCompare(b.code)),
      customers: store.t('customers').slice().sort((a, b) => b.key_account - a.key_account || a.name.localeCompare(b.name)),
      users: store.t('users').filter((u) => u.active).map(({ id: uid, name, role }) => ({ id: uid, name, role })).sort((a, b) => a.name.localeCompare(b.name)),
      settings: store.settings(),
      today: c.today,
    };
  });

  route('GET', '/api/dashboard', (c) => { requireRole(c.user); return dashboard(c); });
  route('GET', '/api/stock', (c) => { requireRole(c.user); return { rows: stockOverview(c), today: c.today }; });
  route('GET', '/api/stock/:id', (c, { params }) => {
    requireRole(c.user);
    const d = slabDetail(c, Number(params.id));
    if (!d) throw notFound('Colour not found');
    return d;
  });
  route('GET', '/api/remnants', (c, { query }) => { requireRole(c.user); return availableRemnants(c, query.slab_id ? Number(query.slab_id) : null); });
  route('GET', '/api/glue', (c) => { requireRole(c.user); return glueOverview(c); });
  route('GET', '/api/racks', (c) => {
    requireRole(c.user);
    const bal = slabBalances(c);
    const rem = availableRemnants(c);
    return c.store.t('locations').slice().sort((a, b) => a.code.localeCompare(b.code)).map((l) => ({
      ...l,
      slabs: bal.filter((b) => b.location_id === l.id).map((b) => { const s = c.store.get('slabs', b.slab_id); return { location_id: l.id, slab_id: b.slab_id, code: s.code, name: s.name, qty: b.qty }; }).sort((a, b) => a.code.localeCompare(b.code)),
      remnants: rem.filter((x) => x.location_id === l.id),
    })).filter((l) => l.active || l.slabs.length || l.remnants.length);
  });

  route('GET', '/api/locks', (c) => { requireRole(c.user); return listLocks(c); });
  route('GET', '/api/locks/free/:slabId', (c, { params }) => { requireRole(c.user); return freeForLock(c, Number(params.slabId)); });
  route('POST', '/api/locks', (c, { body }) => { requireRole(c.user); return { id: createLock(c, body) }; });
  route('POST', '/api/locks/:id/:action', (c, { params, body }) => {
    requireRole(c.user);
    const action = oneOf(params.action, 'Action', ['approve', 'reject', 'release', 'update']);
    return { id: decideLock(c, Number(params.id), action, body) };
  });

  route('GET', '/api/docs', (c, { query }) => { requireRole(c.user); return listDocs(c, query); });
  route('GET', '/api/docs/:id', (c, { params }) => { requireRole(c.user); return getDoc(c, Number(params.id)); });
  route('POST', '/api/docs', (c, { body }) => { requireRole(c.user, ...EDIT); return { id: createDoc(c, body) }; });
  route('POST', '/api/docs/:id/void', (c, { params, body }) => { requireRole(c.user, ...EDIT); return { id: voidDoc(c, Number(params.id), body.reason) }; });
  route('POST', '/api/docs/:id/receive', (c, { params, body }) => { requireRole(c.user, ...EDIT); return receiveDoc(c, Number(params.id), body); });
  route('PATCH', '/api/docs/:id', (c, { params, body }) => { requireRole(c.user, ...EDIT); return { id: updateExpected(c, Number(params.id), body) }; });
  route('DELETE', '/api/docs/:id', (c, { params }) => { requireRole(c.user, ...EDIT); deleteExpected(c, Number(params.id)); return { ok: true }; });

  route('GET', '/api/reports/sales', (c, { query }) => {
    requireRole(c.user);
    const to = date(query.to || c.today, 'To');
    const from = date(query.from || addDays(to, -29), 'From');
    if (from > to) throw bad('"From" is after "To"');
    return salesReport(c, { from, to, group: oneOf(query.group || 'day', 'Group', ['day', 'week', 'month']) });
  });
  route('GET', '/api/closing', (c) => {
    requireRole(c.user);
    const first = c.store.t('docs').filter((d) => d.status === 'posted').reduce((m, d) => (!m || d.date < m ? d.date : m), '');
    return {
      closed_through: c.store.setting('closed_through'),
      months: c.store.t('month_closings').filter((m) => isMonth(m.month)).sort((a, b) => (a.month < b.month ? 1 : -1)).map((m) => ({ month: m.month, closed_at: m.closed_at, closed_by_name: (c.store.get('users', m.closed_by) || {}).name || '' })),
      first_month: (first || c.today).slice(0, 7),
    };
  });
  route('GET', '/api/closing/:month', (c, { params }) => {
    requireRole(c.user);
    if (!isMonth(params.month)) throw bad('Month must be YYYY-MM');
    return closing(c, params.month);
  });
  route('POST', '/api/closing/:month/close', (c, { params }) => {
    requireRole(c.user, 'admin');
    const { month } = params;
    if (!isMonth(month)) throw bad('Month must be YYYY-MM');
    const closed = c.store.setting('closed_through');
    if (closed && month <= closed) throw bad('{month} is already closed', { month });
    if (closed && month !== nextMonth(closed)) throw bad('Close {month} first', { month: nextMonth(closed) });
    if (monthEnd(month) >= c.today) throw bad('A month can be closed only after its last day');
    c.store.insert('month_closings', { month, closed_at: c.now, closed_by: c.user.id, snapshot: JSON.stringify(computeClosing(c, month)) });
    c.store.setSetting('closed_through', month);
    c.audit('month.close', month);
    return { ok: true };
  });
  route('POST', '/api/closing/:month/reopen', (c, { params }) => {
    requireRole(c.user, 'admin');
    const closed = c.store.setting('closed_through');
    if (params.month !== closed) throw bad('Only the last closed month ({month}) can be reopened', { month: closed || '–' });
    const row = c.store.t('month_closings').find((m) => m.month === params.month);
    if (row) c.store.update('month_closings', row, { month: `${row.month}-reopened-${Date.now()}` });
    const prev = c.store.t('month_closings').filter((m) => isMonth(m.month)).reduce((m, r) => (r.month > m ? r.month : m), '');
    c.store.setSetting('closed_through', prev);
    c.audit('month.reopen', params.month);
    return { ok: true };
  });

  // ---- master data ----------------------------------------------------------------
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
  route('POST', '/api/slabs', (c, { body }) => {
    requireRole(c.user, ...EDIT);
    const f = slabFields(body);
    unique(c.store, 'slabs', 'code', f.code);
    const s = c.store.insert('slabs', f);
    c.audit('slab.create', f.code);
    return { id: s.id };
  });
  route('PATCH', '/api/slabs/:id', (c, { params, body }) => {
    requireRole(c.user, ...EDIT);
    const cur = c.store.get('slabs', Number(params.id));
    if (!cur) throw notFound('Colour not found');
    const f = slabFields(body, cur);
    unique(c.store, 'slabs', 'code', f.code, cur.id);
    c.store.update('slabs', cur, f);
    c.audit('slab.update', f.code);
    return { id: cur.id };
  });
  route('POST', '/api/slabs/bulk', (c, { body }) => {
    requireRole(c.user, ...EDIT);
    if (!Array.isArray(body.rows) || !body.rows.length) throw bad('Nothing to import');
    let created = 0;
    let updated = 0;
    body.rows.forEach((row, i) => withLine(i, () => {
      const code = str(row.code, 'Code', { required: true });
      const cur = c.store.t('slabs').find((s) => s.code.toLowerCase() === code.toLowerCase());
      const f = slabFields(row, cur || {});
      if (cur) { c.store.update('slabs', cur, { name: f.name, thickness_mm: f.thickness_mm, width_mm: f.width_mm, length_mm: f.length_mm, min_pcs: f.min_pcs }); updated++; } else { c.store.insert('slabs', f); created++; }
    }));
    c.audit('slab.bulk', `${created} new, ${updated} updated`);
    return { created, updated };
  });

  const glueFields = (c, b, cur = {}) => ({
    code: str(b.code ?? cur.code, 'Code', { required: true, max: 40 }),
    name: str(b.name ?? cur.name, 'Name', { required: true, max: 100 }),
    color: str(b.color ?? cur.color, 'Colour', { max: 60 }),
    unit: str(b.unit ?? cur.unit ?? 'pcs', 'Unit', { required: true, max: 20 }),
    shelf_life_months: num(b.shelf_life_months ?? cur.shelf_life_months ?? 12, 'Shelf life', { int: true, min: 1, max: 120 }),
    min_qty: num(b.min_qty ?? cur.min_qty ?? 0, 'Minimum stock', { int: true, min: 0, max: 1000000 }),
    note: str(b.note ?? cur.note, 'Note', { max: 500 }),
    active: b.active === undefined ? (cur.active ?? 1) : (bool(b.active) ? 1 : 0),
    slab_ids: Array.isArray(b.slab_ids)
      ? b.slab_ids.map((sid) => { const s = c.store.get('slabs', id(sid, 'Slab colour')); if (!s) throw bad('{field} not found', { field: 'Slab colour' }); return s.id; }).join(',')
      : (cur.slab_ids || ''),
  });
  route('POST', '/api/glues', (c, { body }) => {
    requireRole(c.user, ...EDIT);
    const f = glueFields(c, body);
    unique(c.store, 'glues', 'code', f.code);
    const g = c.store.insert('glues', f);
    c.audit('glue.create', f.code);
    return { id: g.id };
  });
  route('PATCH', '/api/glues/:id', (c, { params, body }) => {
    requireRole(c.user, ...EDIT);
    const cur = c.store.get('glues', Number(params.id));
    if (!cur) throw notFound('Glue not found');
    const f = glueFields(c, body, cur);
    unique(c.store, 'glues', 'code', f.code, cur.id);
    c.store.update('glues', cur, f);
    c.audit('glue.update', f.code);
    return { id: cur.id };
  });

  route('POST', '/api/locations', (c, { body }) => {
    requireRole(c.user, ...EDIT);
    const codes = Array.isArray(body.codes) ? body.codes : [body.code];
    const ids = codes.map((x) => {
      const code = str(x, 'Rack code', { required: true, max: 30 });
      unique(c.store, 'locations', 'code', code);
      return c.store.insert('locations', { code, name: str(body.name, 'Description', { max: 100 }), active: 1 }).id;
    });
    c.audit('location.create', codes.join(','));
    return { ids };
  });
  route('PATCH', '/api/locations/:id', (c, { params, body }) => {
    requireRole(c.user, ...EDIT);
    const cur = c.store.get('locations', Number(params.id));
    if (!cur) throw notFound('Rack not found');
    const code = str(body.code ?? cur.code, 'Rack code', { required: true, max: 30 });
    unique(c.store, 'locations', 'code', code, cur.id);
    c.store.update('locations', cur, { code, name: str(body.name ?? cur.name, 'Description', { max: 100 }), active: body.active === undefined ? cur.active : (bool(body.active) ? 1 : 0) });
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
  route('POST', '/api/customers', (c, { body }) => {
    requireRole(c.user);
    const f = customerFields(body);
    unique(c.store, 'customers', 'name', f.name);
    const cu = c.store.insert('customers', f);
    c.audit('customer.create', f.name);
    return { id: cu.id };
  });
  route('PATCH', '/api/customers/:id', (c, { params, body }) => {
    requireRole(c.user, ...EDIT);
    const cur = c.store.get('customers', Number(params.id));
    if (!cur) throw notFound('Customer not found');
    const f = customerFields(body, cur);
    unique(c.store, 'customers', 'name', f.name, cur.id);
    c.store.update('customers', cur, f);
    return { id: cur.id };
  });

  route('GET', '/api/users', (c) => {
    requireRole(c.user, 'admin');
    return c.store.t('users').map(({ id: uid, username, name, role, active, must_change, created_at }) => ({ id: uid, username, name, role, active, must_change, created_at }))
      .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  });
  route('POST', '/api/users', (c, { body }) => {
    requireRole(c.user, 'admin');
    const username = str(body.username, 'Username', { required: true, max: 40 });
    if (!/^[A-Za-z0-9._-]+$/.test(username)) throw bad('Username may only contain letters, numbers, dot, dash and underscore');
    unique(c.store, 'users', 'username', username);
    checkPasswordRules(body.password);
    const u = c.store.insert('users', {
      username, name: str(body.name, 'Name', { required: true, max: 100 }), role: oneOf(body.role, 'Role', ['admin', 'scm', 'sales']),
      ...setPassword(c.env, body.password), must_change: 1, active: 1, token_ver: 0, created_at: c.now,
    });
    c.audit('user.create', username);
    return { id: u.id };
  });
  route('PATCH', '/api/users/:id', (c, { params, body }) => {
    requireRole(c.user, 'admin');
    const cur = c.store.get('users', Number(params.id));
    if (!cur) throw notFound('User not found');
    const role = body.role !== undefined ? oneOf(body.role, 'Role', ['admin', 'scm', 'sales']) : cur.role;
    const active = body.active !== undefined ? (bool(body.active) ? 1 : 0) : cur.active;
    if (cur.id === c.user.id && (role !== 'admin' || !active)) throw bad("You can't remove your own admin access");
    const patch = { name: str(body.name ?? cur.name, 'Name', { required: true, max: 100 }), role, active };
    if (body.password) {
      checkPasswordRules(body.password);
      Object.assign(patch, setPassword(c.env, body.password), { must_change: 1, token_ver: (cur.token_ver || 0) + 1 });
    }
    if (!active) patch.token_ver = (cur.token_ver || 0) + 1;
    c.store.update('users', cur, patch);
    c.audit('user.update', cur.username);
    return { id: cur.id };
  });

  route('PATCH', '/api/settings', (c, { body }) => {
    requireRole(c.user, 'admin');
    const s = c.store;
    if (body.company_name !== undefined) s.setSetting('company_name', str(body.company_name, 'Company name', { required: true, max: 100 }));
    if (body.go_live_date !== undefined) s.setSetting('go_live_date', date(body.go_live_date, 'Go-live date', { required: false }) || '');
    if (body.expiry_warn_days !== undefined) s.setSetting('expiry_warn_days', num(body.expiry_warn_days, 'Glue expiry warning', { int: true, min: 1, max: 365 }));
    if (body.lock_default_days !== undefined) s.setSetting('lock_default_days', num(body.lock_default_days, 'Default lock days', { int: true, min: 1, max: 365 }));
    c.audit('settings.update');
    return s.settings();
  });
  route('GET', '/api/audit', (c) => {
    requireRole(c.user, 'admin');
    return c.store.t('audit').slice(-300).reverse();
  });

  /**
   * Handle one API request. Returns { status, body }. Never throws for API errors.
   * The caller saves `store` changes only when status is 200 (all-or-nothing).
   */
  function handle(store, env, method, url, body, token) {
    try {
      const [path, qs] = String(url).split('?');
      const query = {};
      if (qs) for (const part of qs.split('&')) { const [k, v = ''] = part.split('='); if (k) query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
      let match = null;
      let pathOk = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathOk = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        match = { fn: r.fn, params };
        break;
      }
      if (!match) throw new ApiError(pathOk ? 405 : 404, pathOk ? 'Method not allowed' : 'Not found');
      const user = tokenUser(store, env, token);
      const c = ctxOf(store, env, user);
      const result = match.fn(c, { params: match.params, query, body: body && typeof body === 'object' ? body : {} });
      return { status: 200, body: result === undefined ? { ok: true } : result };
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: e.template, params: e.params, line: e.line, message: e.line ? `Line ${e.line}: ${e.message}` : e.message } };
      return { status: 500, body: { error: 'Something went wrong on the server: {msg}', params: { msg: String((e && e.message) || e) }, message: String((e && e.stack) || e) } };
    }
  }

  return {
    SCHEMA, DEFAULT_SETTINGS, createStore, handle, ensureAdmin, setPassword, ApiError,
    // exposed for the "Stock (live)" sheet and seeding
    stockOverview: (store, env) => stockOverview(ctxOf(store, env, null)),
    glueOverview: (store, env) => glueOverview(ctxOf(store, env, null)),
    createDoc: (store, env, user, input) => createDoc(ctxOf(store, env, user), input),
    createLock: (store, env, user, input) => createLock(ctxOf(store, env, user), input),
    util: { addDays, addMonths, r3, isDate },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
