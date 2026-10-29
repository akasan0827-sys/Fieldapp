import { api, state, loadRef, connectLive, disconnectLive, onChange, can } from './api.js';
import { html, raw, $, toast, formData, fmtDateTime, labelTables, todayStr } from './ui.js';
import * as overview from './pages/overview.js';
import * as docs from './pages/docs.js';
import * as forms from './pages/forms.js';
import * as reports from './pages/reports.js';
import * as setup from './pages/setup.js';

const ROUTES = [
  ['/dashboard', overview.dashboard],
  ['/stock', overview.stockList],
  ['/stock/:id', overview.stockDetail],
  ['/offcuts', overview.offcuts],
  ['/glue', overview.glue],
  ['/racks', overview.racks],
  ['/locks', overview.locks],
  ['/deliveries', docs.deliveries],
  ['/deliveries/new', forms.newDelivery],
  ['/receiving', docs.receiving],
  ['/receiving/new', forms.newReceipt],
  ['/adjust', forms.adjust],
  ['/history', docs.history],
  ['/doc/:id', docs.docView],
  ['/doc/:id/receive', forms.receiveShipment],
  ['/doc/:id/edit', forms.editShipment],
  ['/reports/sales', reports.sales],
  ['/reports/closing', reports.closing],
  ['/setup/opening', forms.opening],
  ['/setup/colors', setup.colors],
  ['/setup/glues', setup.glues],
  ['/setup/racks', setup.racksSetup],
  ['/setup/customers', setup.customers],
  ['/setup/users', setup.users],
  ['/setup/settings', setup.settings],
  ['/account', setup.account],
];

const NAV = [
  ['Overview', [
    ['/dashboard', 'Dashboard', '◧'],
    ['/stock', 'Slab stock', '▤'],
    ['/offcuts', 'Offcuts (m²)', '◩'],
    ['/glue', 'Glue', '◍'],
    ['/racks', 'Racks', '▦'],
  ]],
  ['Sales', [
    ['/locks', 'Locks', '🔒'],
    ['/deliveries', 'Deliveries', '⇢'],
    ['/reports/sales', 'Sales report', '↗'],
  ]],
  ['Warehouse', [
    ['/receiving', 'Receiving & incoming', '⇠'],
    ['/adjust', 'Adjust / move', '±', 'edit'],
    ['/history', 'All movements', '☰'],
    ['/reports/closing', 'Monthly closing', '▣'],
  ]],
  ['Setup', [
    ['/setup/opening', 'Initial stock', '⓪', 'edit'],
    ['/setup/colors', 'Slab colours', '◐', 'edit'],
    ['/setup/glues', 'Glue products', '◑', 'edit'],
    ['/setup/racks', 'Rack locations', '▥', 'edit'],
    ['/setup/customers', 'Customers', '☺'],
    ['/setup/users', 'Users', '👤', 'admin'],
    ['/setup/settings', 'Settings & backup', '⚙', 'admin'],
  ]],
];

const ROLE_LABEL = { admin: 'Admin', scm: 'SCM', sales: 'Sales' };
const root = document.getElementById('app');
let current = null; // { page, params, query }

function matchRoute(hash) {
  const [pathPart, qs] = (hash.replace(/^#/, '') || '/dashboard').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [pattern, page] of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    const m = re.exec(pathPart);
    if (m) {
      const params = {};
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { page, params, query, path: pathPart };
    }
  }
  return null;
}

function allowed(flag) {
  if (!flag) return true;
  if (flag === 'edit') return can.edit();
  if (flag === 'admin') return can.admin();
  return true;
}

function renderShell() {
  const u = state.me.user;
  root.innerHTML = String(html`
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark">▦</span><span>${state.me.settings.company_name}</span></div>
        <nav>${NAV.map(([group, items]) => {
          const visible = items.filter((i) => allowed(i[3]));
          if (!visible.length) return '';
          return html`<div class="nav-group"><div class="nav-title">${group}</div>
            ${visible.map(([path, label, icon]) => html`<a href="#${path}" data-path="${path}"><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`)}</div>`;
        })}</nav>
      </aside>
      <div class="main-col">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menuBtn" aria-label="Menu">☰</button>
          <h1 id="pageTitle"></h1>
          <div class="topbar-right">
            <span class="live" id="live" title="Live updates"></span>
            <div class="user-menu">
              <button class="user-btn" id="userBtn">${u.name} <span class="role role-${u.role}">${ROLE_LABEL[u.role]}</span></button>
              <div class="user-pop" id="userPop" hidden>
                <a href="#/account">Change password</a>
                <button id="logoutBtn">Log out</button>
              </div>
            </div>
          </div>
        </header>
        <main id="main" tabindex="-1"></main>
      </div>
    </div>`);
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#userBtn').onclick = (e) => { e.stopPropagation(); $('#userPop').hidden = !$('#userPop').hidden; };
  document.addEventListener('click', () => { const p = $('#userPop'); if (p) p.hidden = true; });
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; labelTables($('#main')); });
  }).observe($('#main'), { childList: true, subtree: true });
  $('#logoutBtn').onclick = async () => {
    await api.post('/api/logout').catch(() => {});
    disconnectLive();
    state.me = null;
    showLogin();
  };
  updateLive();
}

function updateLive() {
  const el = $('#live');
  if (!el) return;
  el.className = `live ${state.live ? 'on' : 'off'}`;
  el.textContent = state.live ? 'Live' : 'Reconnecting…';
  el.title = state.lastChange ? `Last update ${fmtDateTime(state.lastChange.toISOString())}` : 'Live updates';
}

async function route() {
  if (!state.me) return;
  if (state.me.user.must_change) return showForcePassword();
  const m = matchRoute(location.hash);
  if (!m) { location.hash = '#/dashboard'; return; }
  if (m.page.roles && !m.page.roles.includes(state.me.user.role)) {
    location.hash = '#/dashboard';
    toast('You do not have access to that page', 'error');
    return;
  }
  current = m;
  // highlight the longest menu path that matches the current page
  const links = [...document.querySelectorAll('.sidebar a')];
  const best = links.map((a) => a.dataset.path)
    .filter((p) => m.path === p || m.path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  links.forEach((a) => a.classList.toggle('active', a.dataset.path === best));
  $('#sidebar').classList.remove('open');
  await renderPage();
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function renderPage({ live = false } = {}) {
  const { page, params, query } = current;
  const main = $('#main');
  const title = typeof page.title === 'function' ? page.title(params) : page.title;
  $('#pageTitle').textContent = title;
  document.title = `${title} · ${state.me.settings.company_name}`;
  if (!live) main.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (todayStr() !== state.me.clientDay) { // the app was left open over midnight
      state.me = { ...(await api.get('/api/me')), clientDay: todayStr() };
    }
    await loadRef();
    const y = window.scrollY;
    await page.render(main, { params, query, live });
    if (live) window.scrollTo(0, y);
  } catch (e) {
    main.innerHTML = String(html`<div class="alert alert-error">${e.message}</div>`);
  }
}

function showLogin(msg) {
  document.title = 'Log in';
  root.innerHTML = String(html`
    <div class="login-wrap">
      <form class="login card" id="loginForm">
        <div class="brand brand-lg"><span class="brand-mark">▦</span><span>Stock manager</span></div>
        <p class="muted">Solid surface slabs, offcuts & glue</p>
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="form-error" ${msg ? '' : raw('hidden')}>${msg || ''}</div>
        <button class="btn btn-primary btn-block" type="submit">Log in</button>
      </form>
    </div>`);
  const f = $('#loginForm');
  f.username.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('.form-error');
    try {
      await api.post('/api/login', formData(f));
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}

function showForcePassword() {
  root.innerHTML = String(html`
    <div class="login-wrap">
      <form class="login card" id="pwForm">
        <h2>Choose a new password</h2>
        <p class="muted">Hello ${state.me.user.name}. Please replace the temporary password before you continue.</p>
        <label>Current (temporary) password<input name="current" type="password" autocomplete="current-password" required></label>
        <label>New password (min. 8 characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Repeat new password<input name="password2" type="password" autocomplete="new-password" minlength="8" required></label>
        <div class="form-error" hidden></div>
        <button class="btn btn-primary btn-block" type="submit">Save password</button>
      </form>
    </div>`);
  const f = $('#pwForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    const err = f.querySelector('.form-error');
    try {
      if (d.password !== d.password2) throw new Error('The new passwords do not match');
      await api.post('/api/me/password', { current: d.current, password: d.password });
      toast('Password saved');
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}

async function boot() {
  try {
    state.me = { ...(await api.get('/api/me')), clientDay: todayStr() };
  } catch {
    showLogin();
    return;
  }
  if (state.me.user.must_change) { showForcePassword(); return; }
  state.ref = null;
  renderShell();
  connectLive(updateLive);
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  await route();
}

api.onUnauthorized = () => { if (state.me) { state.me = null; disconnectLive(); showLogin('Your session has ended. Please log in again.'); } };
window.addEventListener('hashchange', route);
onChange(async () => {
  if (!current || !current.page.live || document.querySelector('.modal-backdrop')) return;
  await renderPage({ live: true });
});
// re-render reference-dependent pages after local saves too
export async function refresh() {
  state.ref = null;
  if (current) await renderPage({ live: true });
}
window.addEventListener('app:refresh', refresh);

boot();
