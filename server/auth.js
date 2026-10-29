'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, nowIso } = require('./util');

const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

function checkPasswordRules(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 200) throw bad('Password is too long');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, nowIso(), expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function sessionUser(db, token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.must_change
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, nowIso()) || null;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token || '');
}

/** Creates the first admin account when the database has no users. Returns the generated password, if any. */
function ensureAdmin(db, envPassword) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;
  const pw = envPassword || crypto.randomBytes(6).toString('base64url');
  db.prepare(`INSERT INTO users (username, name, role, pw_hash, must_change, created_at) VALUES ('admin', 'Administrator', 'admin', ?, 1, ?)`)
    .run(hashPassword(pw), nowIso());
  return pw;
}

function requireRole(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please log in');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to do this');
}

// Simple in-memory brute-force protection for the login form
const attempts = new Map();
function loginGuard(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now) throw new HttpError(429, 'Too many failed logins. Try again in a few minutes.');
  return {
    fail() {
      const cur = attempts.get(key) || { n: 0, until: 0 };
      cur.n += 1;
      if (cur.n >= 8) { cur.until = now + 5 * 60e3; cur.n = 0; }
      attempts.set(key, cur);
    },
    ok() { attempts.delete(key); },
  };
}

module.exports = {
  hashPassword, verifyPassword, checkPasswordRules, createSession, sessionUser, deleteSession,
  ensureAdmin, requireRole, loginGuard,
};
