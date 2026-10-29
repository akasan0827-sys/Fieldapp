#!/usr/bin/env node
'use strict';
// node:sqlite is stable enough for this app; hide its "experimental" banner.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String((warning && warning.message) || warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { openDb } = require('./db');
const { ensureAdmin } = require('./auth');
const { createApp } = require('./app');
const { today } = require('./util');

const DEMO = process.argv.includes('--demo');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', DEMO ? 'demo-data' : 'data');
const DB_FILE = path.join(DATA_DIR, 'stock.db');
const BACKUP_DAYS = Number(process.env.BACKUP_DAYS) || 30;

const db = openDb(DB_FILE);
const generated = ensureAdmin(db, process.env.ADMIN_PASSWORD || (DEMO ? 'demo1234' : undefined));
if (DEMO) {
  db.prepare(`UPDATE users SET must_change = 0 WHERE username = 'admin'`).run();
  require('./seed').seedDemo(db);
}
const app = createApp(db, { secureCookies: process.env.COOKIE_SECURE === '1' });
const server = http.createServer(app.handler);

// Daily automatic backup into DATA_DIR/backups (keeps the last BACKUP_DAYS days)
function dailyBackup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `stock-${today()}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter((f) => /^stock-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_DAYS))) fs.unlinkSync(path.join(dir, f));
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}
setTimeout(dailyBackup, 5000).unref();
setInterval(dailyBackup, 3 * 3600e3).unref();

server.listen(PORT, HOST, () => {
  console.log(`Stock manager running on http://localhost:${PORT}  (database: ${DB_FILE})`);
  if (DEMO) console.log('DEMO MODE — log in as admin, scm or sales with password demo1234');
  if (generated && !DEMO) {
    console.log('');
    console.log('  First start — an admin account was created:');
    console.log('    username: admin');
    console.log(`    password: ${generated}`);
    console.log('  You will be asked to change this password at first login.');
    console.log('');
  }
});

function shutdown() {
  app.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
