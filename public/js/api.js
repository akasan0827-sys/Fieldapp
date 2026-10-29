// API client, shared state and live updates (Server-Sent Events).

export const state = {
  me: null,       // { user, settings, today }
  ref: null,      // reference data (colours, glues, racks, customers, users)
  live: false,
  lastChange: null,
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login' && api.onUnauthorized) api.onUnauthorized();
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: (u) => call('GET', u),
  post: (u, b) => call('POST', u, b),
  patch: (u, b) => call('PATCH', u, b),
  del: (u) => call('DELETE', u),
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

// ---- live updates -------------------------------------------------------------
let es = null;
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function connectLive(statusCb) {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onopen = () => { state.live = true; statusCb(); };
  es.onerror = () => { state.live = false; statusCb(); };
  let timer = null;
  es.addEventListener('change', (e) => {
    state.lastChange = new Date();
    state.ref = null; // reference data may have changed
    clearTimeout(timer);
    timer = setTimeout(() => {
      statusCb();
      for (const fn of listeners) fn(JSON.parse(e.data));
    }, 250);
  });
}

export function disconnectLive() {
  if (es) es.close();
  es = null;
  state.live = false;
}
