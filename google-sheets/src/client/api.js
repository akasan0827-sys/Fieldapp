// API client. The transport (Google Apps Script or the in-browser demo) is set by the host page
// as window.STOCK_TRANSPORT(method, url, body, token) -> Promise<{ status, body }>.
import { tError } from './i18n.js';

export const state = {
  me: null, // { user, settings, today }
  ref: null, // reference data (colours, glues, racks, customers, users)
  live: false,
  lastChange: null,
};

export const host = window.STOCK_HOST || { kind: 'gs', canPrint: true, pollMs: 30000 };

const TOKEN_KEY = 'stock_token';
let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage blocked */ }
function setToken(tk) {
  token = tk || '';
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(tError(body));
    this.status = status;
    this.body = body;
  }
}

async function call(method, url, body) {
  let res;
  try {
    res = await window.STOCK_TRANSPORT(method, url, body, token);
  } catch (e) {
    throw new ApiError(0, { error: 'Could not reach the server. Check the internet connection and try again.' });
  }
  if (res.status !== 200) {
    if (res.status === 401 && url !== '/api/login' && api.onUnauthorized) api.onUnauthorized();
    throw new ApiError(res.status, res.body);
  }
  if (res.body && res.body.token) setToken(res.body.token);
  return res.body;
}

export const api = {
  get: (u) => call('GET', u),
  post: (u, b) => call('POST', u, b || {}),
  patch: (u, b) => call('PATCH', u, b || {}),
  del: (u) => call('DELETE', u, {}),
  logout: () => setToken(''),
  onUnauthorized: null,
};

export async function loadRef(force = false) {
  if (!state.ref || force) state.ref = await api.get('/api/ref');
  return state.ref;
}

export const can = {
  edit: () => ['admin', 'scm'].includes(state.me?.user.role),
  admin: () => state.me?.user.role === 'admin',
};

// ---- live updates: ask the server for its data version every few seconds -------------
let timer = null;
let lastVersion = null;
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function connectLive(statusCb) {
  disconnectLive();
  const tick = async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      const v = (await window.STOCK_TRANSPORT('GET', '/api/version', undefined, token)).body.version;
      state.live = true;
      if (lastVersion !== null && v !== lastVersion) {
        state.lastChange = new Date();
        state.ref = null;
        for (const fn of listeners) fn();
      }
      lastVersion = v;
    } catch {
      state.live = false;
    }
    statusCb();
  };
  tick();
  timer = setInterval(tick, host.pollMs || 30000);
  document.addEventListener('visibilitychange', tick);
  connectLive.tick = tick;
}
export function disconnectLive() {
  if (timer) clearInterval(timer);
  if (connectLive.tick) document.removeEventListener('visibilitychange', connectLive.tick);
  timer = null;
  state.live = false;
}
