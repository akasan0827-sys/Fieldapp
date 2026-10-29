'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Round to 3 decimals (sqm precision: 0.001 m2 = 10 cm2)
const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;

/** Today's date (YYYY-MM-DD) in the server's local time zone (set TZ env, e.g. TZ=Asia/Seoul). */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const fmtUtc = (dt) => dt.toISOString().slice(0, 10);

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmtUtc(parseDate(s)) === s;
}

function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function addDays(s, n) {
  const dt = parseDate(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtUtc(dt);
}

function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmtUtc(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}

function monthStart(month) {
  return `${month}-01`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return fmtUtc(new Date(Date.UTC(y, m, 0)));
}

function prevMonth(month) {
  return addMonths(`${month}-01`, -1).slice(0, 7);
}

function nextMonth(month) {
  return addMonths(`${month}-01`, 1).slice(0, 7);
}

/** Monday of the ISO week containing date s. */
function weekStart(s) {
  const dow = (parseDate(s).getUTCDay() + 6) % 7;
  return addDays(s, -dow);
}

function isoWeek(s) {
  const dt = parseDate(s);
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fdow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fdow + 3);
  return { year: dt.getUTCFullYear(), week: 1 + Math.round((dt - firstThu) / (7 * 864e5)) };
}

// ---- input validation -------------------------------------------------------

function str(v, name, { required = false, max = 500 } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} must be text`);
  v = String(v).trim();
  if (required && !v) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return v;
}

function num(v, name, { min = -Infinity, max = Infinity, int = false, required = true, positive = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (int && !Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (positive && n <= 0) throw bad(`${name} must be greater than 0`);
  if (n < min) throw bad(`${name} must be at least ${min}`);
  if (n > max) throw bad(`${name} must be at most ${max}`);
  return n;
}

function id(v, name, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} is invalid`);
  return n;
}

function date(v, name, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (!isDate(v)) throw bad(`${name} must be a date (YYYY-MM-DD)`);
  return v;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

function oneOf(v, name, list) {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}

module.exports = {
  HttpError, bad, pad, r3, today, nowIso, isDate, isMonth, addDays, addMonths,
  monthStart, monthEnd, prevMonth, nextMonth, weekStart, isoWeek,
  str, num, id, date, bool, oneOf,
};
