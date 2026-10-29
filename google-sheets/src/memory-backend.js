/*
 * In-memory backend for the browser demo and the tests.
 * Each request works on a copy of the data; it is kept only if the request succeeds,
 * exactly like the Google Sheet version saves only successful requests.
 */
var MemoryBackend = function (env, initialData, onSave) {
  'use strict';
  let data = initialData || {};
  let version = 1;
  const copy = (rows) => JSON.parse(JSON.stringify(rows || []));
  return {
    version: () => version,
    data: () => data,
    reset(newData) { data = newData || {}; version += 1; },
    /** Runs fn(store) with the same all-or-nothing saving as an API request. */
    run(fn) {
      const store = Engine.createStore((t) => copy(data[t]));
      const out = fn(store);
      if (store.dirty()) {
        for (const name of Object.keys(store.changes())) data[name] = store.t(name);
        version += 1;
        if (onSave) onSave(data);
      }
      return out;
    },
    call(method, url, body, token) {
      if (method === 'GET' && url === '/api/version') return { status: 200, body: { version: String(version) } };
      const store = Engine.createStore((t) => copy(data[t]));
      const res = Engine.handle(store, env, method, url, body, token);
      if (res.status === 200 && method !== 'GET' && store.dirty()) {
        for (const name of Object.keys(store.changes())) data[name] = store.t(name);
        version += 1;
        if (onSave) onSave(data);
      }
      return JSON.parse(JSON.stringify(res));
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = MemoryBackend;
