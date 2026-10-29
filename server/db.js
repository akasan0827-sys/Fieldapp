'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','scm','sales')),
  pw_hash     TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Rack / storage locations
CREATE TABLE IF NOT EXISTS locations (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name   TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  key_account INTEGER NOT NULL DEFAULT 0,
  contact     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1
);

-- Slab colours (one row per colour / SKU)
CREATE TABLE IF NOT EXISTS slabs (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL,
  thickness_mm REAL NOT NULL DEFAULT 12,
  width_mm     REAL NOT NULL DEFAULT 760,
  length_mm    REAL NOT NULL DEFAULT 3680,
  min_pcs      INTEGER NOT NULL DEFAULT 0,
  color_hex    TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS glues (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  color             TEXT NOT NULL DEFAULT '',
  unit              TEXT NOT NULL DEFAULT 'pcs',
  shelf_life_months INTEGER NOT NULL DEFAULT 12,
  min_qty           INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',
  active            INTEGER NOT NULL DEFAULT 1
);

-- Which slab colours a glue colour is used for
CREATE TABLE IF NOT EXISTS glue_matches (
  glue_id INTEGER NOT NULL REFERENCES glues(id) ON DELETE CASCADE,
  slab_id INTEGER NOT NULL REFERENCES slabs(id) ON DELETE CASCADE,
  PRIMARY KEY (glue_id, slab_id)
);

CREATE TABLE IF NOT EXISTS glue_lots (
  id             INTEGER PRIMARY KEY,
  glue_id        INTEGER NOT NULL REFERENCES glues(id),
  lot_no         TEXT NOT NULL COLLATE NOCASE,
  expiry         TEXT NOT NULL,
  received_date  TEXT NOT NULL,
  created_doc_id INTEGER,
  UNIQUE (glue_id, lot_no)
);

-- Documents: opening stock, inbound (received or expected), outbound deliveries,
-- adjustments and rack transfers. Posted documents are never edited, only voided.
CREATE TABLE IF NOT EXISTS docs (
  id           INTEGER PRIMARY KEY,
  doc_no       TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL CHECK (type IN ('opening','inbound','outbound','adjust','transfer')),
  status       TEXT NOT NULL CHECK (status IN ('expected','posted','void')),
  date         TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id),
  partner      TEXT NOT NULL DEFAULT '',
  deliver_to   TEXT NOT NULL DEFAULT '',
  contact      TEXT NOT NULL DEFAULT '',
  reference    TEXT NOT NULL DEFAULT '',
  sales_person TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  eta          TEXT,
  ship_status  TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  posted_by    INTEGER REFERENCES users(id),
  posted_at    TEXT,
  voided_by    INTEGER REFERENCES users(id),
  voided_at    TEXT,
  void_reason  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS docs_type_date ON docs(type, status, date);

CREATE TABLE IF NOT EXISTS lines (
  id              INTEGER PRIMARY KEY,
  doc_id          INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  slab_id         INTEGER REFERENCES slabs(id),
  glue_id         INTEGER REFERENCES glues(id),
  lot_id          INTEGER REFERENCES glue_lots(id),
  remnant_id      INTEGER,
  location_id     INTEGER REFERENCES locations(id),
  to_location_id  INTEGER REFERENCES locations(id),
  qty             REAL NOT NULL DEFAULT 0,   -- pieces (full slabs / glue units)
  sqm             REAL NOT NULL DEFAULT 0,   -- m2 delivered / registered
  leftover_sqm    REAL NOT NULL DEFAULT 0,
  waste_sqm       REAL NOT NULL DEFAULT 0,
  width_mm        REAL,
  length_mm       REAL,
  new_remnant_id  INTEGER,
  lock_id         INTEGER,
  lot_no          TEXT NOT NULL DEFAULT '',
  expiry          TEXT,
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS lines_doc ON lines(doc_id);
CREATE INDEX IF NOT EXISTS lines_lock ON lines(lock_id);

-- Countable stock ledger (full slabs per rack, glue units per lot). Only posted docs.
CREATE TABLE IF NOT EXISTS moves (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES docs(id),
  line_id     INTEGER NOT NULL REFERENCES lines(id),
  date        TEXT NOT NULL,
  item        TEXT NOT NULL CHECK (item IN ('slab','glue')),
  slab_id     INTEGER REFERENCES slabs(id),
  glue_id     INTEGER REFERENCES glues(id),
  lot_id      INTEGER REFERENCES glue_lots(id),
  location_id INTEGER REFERENCES locations(id),
  qty         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS moves_slab ON moves(item, slab_id, location_id);
CREATE INDEX IF NOT EXISTS moves_lot ON moves(item, lot_id);
CREATE INDEX IF NOT EXISTS moves_date ON moves(date);

-- Partial slabs / offcuts kept in the rack, measured in m2
CREATE TABLE IF NOT EXISTS remnants (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL DEFAULT '',
  slab_id        INTEGER NOT NULL REFERENCES slabs(id),
  location_id    INTEGER REFERENCES locations(id),
  width_mm       REAL,
  length_mm      REAL,
  sqm            REAL NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('available','used','scrapped','void')),
  parent_id      INTEGER,
  created_doc_id INTEGER NOT NULL,
  created_date   TEXT NOT NULL,
  closed_doc_id  INTEGER,
  closed_date    TEXT,
  note           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS remnants_status ON remnants(status, slab_id);

-- Stock reserved for a customer
CREATE TABLE IF NOT EXISTS locks (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  slab_id      INTEGER NOT NULL REFERENCES slabs(id),
  pcs          INTEGER NOT NULL CHECK (pcs > 0),
  expires_on   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','active','rejected','released')),
  note         TEXT NOT NULL DEFAULT '',
  decision_note TEXT NOT NULL DEFAULT '',
  requested_by INTEGER REFERENCES users(id),
  decided_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);

CREATE TABLE IF NOT EXISTS month_closings (
  month     TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  snapshot  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  user_id INTEGER,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
`;

const DEFAULT_SETTINGS = {
  company_name: 'Solid Surface Stock',
  go_live_date: '',
  closed_through: '', // YYYY-MM of the last closed month
  expiry_warn_days: '60',
  lock_default_days: '14',
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/** Run fn inside a write transaction; rolls back on any thrown error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function audit(db, userId, action, detail = '') {
  db.prepare('INSERT INTO audit(at, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), userId || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

module.exports = { openDb, tx, getSettings, setSetting, audit };
