import { api, state, loadRef, connectLive, disconnectLive, onChange, can, host } from './api.js';
import { t, getLang, setLang } from './i18n.js';
import { html, raw, $, toast, formData, fmtDateTime, labelTables, todayStr, confirmBox } from './ui.js';
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
    ['/setup/settings', 'Settings', '⚙', 'admin'],
  ]],
];

const ROLE_LABEL = { admin: 'Admin', scm: 'SCM', sales: 'Sales' };
const DEMO_USERS = [
  ['admin', 'Admin (owner)', 'admin'],
  ['scm', 'Somchai — SCM', 'scm'],
  ['sales', 'Ploy — Sales', 'sales'],
];
const root = document.getElementById('app');
let current = null; // { page, params, query, path }
let currentPath = host.initialPath || '/dashboard';

// ---- in-page router (the URL never changes: works inside Google's frame and on claude.ai) ----
function matchRoute(full) {
  const [pathPart, qs] = (full || '/dashboard').split('?');
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

function navigate(path, { fromHistory = false } = {}) {
  const p = String(path || '/dashboard').replace(/^#/, '');
  if (!fromHistory && host.onNavigate && p !== currentPath) host.onNavigate(p);
  currentPath = p;
  route();
}
window.addEventListener('app:go', (e) => navigate(e.detail));
window.addEventListener('app:history', (e) => navigate(e.detail, { fromHistory: true }));
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

function allowed(flag) {
  if (!flag) return true;
  if (flag === 'edit') return can.edit();
  if (flag === 'admin') return can.admin();
  return true;
}

const langToggle = () => html`<div class="lang-seg" role="group" aria-label="Language / ภาษา">
  <button type="button" data-lang="en" class="${getLang() === 'en' ? 'on' : ''}" aria-pressed="${getLang() === 'en'}">EN</button>
  <button type="button" data-lang="th" class="${getLang() === 'th' ? 'on' : ''}" aria-pressed="${getLang() === 'th'}" lang="th">ไทย</button>
</div>`;
function bindLang(rootEl, after) {
  rootEl.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lang === getLang()) return;
    setLang(b.dataset.lang);
    after();
  }));
}

function renderShell() {
  const u = state.me.user;
  root.innerHTML = String(html`
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark" aria-hidden="true">▦</span><span id="brandName">${state.me.settings.company_name}</span></div>
        <nav>${NAV.map(([group, items]) => {
          const visible = items.filter((i) => allowed(i[3]));
          if (!visible.length) return '';
          return html`<div class="nav-group"><div class="nav-title">${t(group)}</div>
            ${visible.map(([path, label, icon]) => html`<a href="#${path}" data-path="${path}"><span class="nav-icon" aria-hidden="true">${icon}</span>${t(label)}</a>`)}</div>`;
        })}</nav>
        ${host.kind === 'demo' ? html`<div class="demo-note">${t('Demo — your changes stay in this browser.')}<button type="button" class="link-btn" id="resetDemo2">${t('Reset demo')}</button></div>` : ''}
      </aside>
      <div class="scrim" id="scrim" hidden></div>
      <div class="main-col">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menuBtn" aria-label="${t('Menu')}">☰</button>
          <h1 id="pageTitle"></h1>
          <div class="topbar-right">
            <span class="live" id="live"></span>
            ${langToggle()}
            <div class="user-menu">
              <button class="user-btn" id="userBtn" aria-haspopup="true"><span class="user-name">${u.name}</span> <span class="role role-${u.role}">${t(ROLE_LABEL[u.role])}</span></button>
              <div class="user-pop" id="userPop" hidden>
                <a href="#/account">${t('Change password')}</a>
                ${host.kind === 'demo' ? html`<button type="button" id="resetDemo">${t('Reset demo')}</button>` : ''}
                <button type="button" id="logoutBtn">${host.kind === 'demo' ? t('Switch user') : t('Log out')}</button>
              </div>
            </div>
          </div>
        </header>
        <main id="main" tabindex="-1"></main>
      </div>
    </div>`);
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const closeMenu = () => { sidebar.classList.remove('open'); scrim.hidden = true; };
  $('#menuBtn').onclick = () => { const open = !sidebar.classList.contains('open'); sidebar.classList.toggle('open', open); scrim.hidden = !open; };
  scrim.onclick = closeMenu;
  renderShell.closeMenu = closeMenu;
  $('#userBtn').onclick = (e) => { e.stopPropagation(); $('#userPop').hidden = !$('#userPop').hidden; };
  bindLang(root.querySelector('.topbar'), () => { renderShell(); route(); });
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; const m = $('#main'); if (m) labelTables(m); });
  }).observe($('#main'), { childList: true, subtree: true });
  $('#logoutBtn').onclick = async () => {
    await api.post('/api/logout').catch(() => {});
    api.logout();
    disconnectLive();
    state.me = null;
    showLogin();
  };
  const reset = async () => {
    if (!(await confirmBox(t('Reset demo?'), t('All changes you made in the demo are removed and the sample data is loaded again.'), { submit: t('Reset demo'), danger: true }))) return;
    await host.reset();
    api.logout();
    disconnectLive();
    state.me = null;
    state.ref = null;
    showLogin();
    toast(t('Demo data reset'));
  };
  if ($('#resetDemo')) $('#resetDemo').onclick = reset;
  if ($('#resetDemo2')) $('#resetDemo2').onclick = reset;
  updateLive();
}
document.addEventListener('click', () => { const p = $('#userPop'); if (p) p.hidden = true; });

function updateLive() {
  const el = $('#live');
  if (!el) return;
  const secs = Math.round((host.pollMs || 30000) / 1000);
  el.className = `live ${state.live ? 'on' : 'off'}`;
  el.innerHTML = String(html`<span class="live-text">${state.live ? t('Live') : t('Offline')}</span>`);
  el.title = `${t('Stock refreshes automatically every {n} seconds', { n: secs })}${state.lastChange ? ` · ${t('last change {when}', { when: fmtDateTime(state.lastChange.toISOString()) })}` : ''}`;
}

async function route() {
  if (!state.me) return;
  if (state.me.user.must_change) { showForcePassword(); return; }
  const m = matchRoute(currentPath);
  if (!m) { currentPath = '/dashboard'; route(); return; }
  if (m.page.roles && !m.page.roles.includes(state.me.user.role)) {
    currentPath = '/dashboard';
    toast(t('You do not have access to that page'), 'error');
    route();
    return;
  }
  current = m;
  // highlight the longest menu path that matches the current page
  const links = [...document.querySelectorAll('.sidebar a')];
  const best = links.map((a) => a.dataset.path)
    .filter((p) => m.path === p || m.path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  links.forEach((a) => { a.classList.toggle('active', a.dataset.path === best); if (a.dataset.path === best) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (renderShell.closeMenu) renderShell.closeMenu();
  await renderPage();
  const main = $('#main');
  if (main) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function renderPage({ live = false } = {}) {
  const { page, params, query } = current;
  const main = $('#main');
  const title = typeof page.title === 'function' ? page.title(params) : t(page.title);
  $('#pageTitle').textContent = title;
  document.title = `${title} · ${state.me.settings.company_name}`;
  if (!live) main.innerHTML = String(html`<div class="loading">${t('Loading…')}</div>`);
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

function loginFrame(inner) {
  root.innerHTML = String(html`
    <div class="login-wrap">
      <div class="login-top">${langToggle()}</div>
      ${inner}
    </div>`);
}

function showLogin(msg) {
  document.title = t('Log in');
  loginFrame(html`
    <form class="login card" id="loginForm">
      <div class="brand brand-lg"><span class="brand-mark" aria-hidden="true">▦</span><span>${t('Stock manager')}</span></div>
      <p class="muted">${t('Solid surface slabs, offcuts & glue')}</p>
      ${host.kind === 'demo' ? html`<div class="demo-login">
        <p><strong>${t('Try the demo — tap a person:')}</strong></p>
        <div class="demo-users">${DEMO_USERS.map(([username, label, role]) => html`<button type="button" class="btn" data-demo="${username}"><span class="role role-${role}">${t(ROLE_LABEL[role])}</span> ${t(label)}</button>`)}</div>
        <p class="muted small">${t('Or type a username below. Every demo password is demo1234.')}</p>
      </div>` : ''}
      <label>${t('Username')}<input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label>${t('Password')}<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="form-error" ${msg ? '' : raw('hidden')}>${msg || ''}</div>
      <button class="btn btn-primary btn-block" type="submit">${t('Log in')}</button>
    </form>`);
  bindLang(root, () => showLogin(msg));
  const f = $('#loginForm');
  const err = f.querySelector('.form-error');
  const login = async (body) => {
    try {
      await api.post('/api/login', body);
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  if (host.kind !== 'demo') f.username.focus();
  f.onsubmit = (e) => { e.preventDefault(); login(formData(f)); };
  root.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => login({ username: b.dataset.demo, password: 'demo1234' })));
}

function showForcePassword() {
  loginFrame(html`
    <form class="login card" id="pwForm">
      <h2>${t('Choose a new password')}</h2>
      <p class="muted">${t('Hello {name}. Please replace the temporary password before you continue.', { name: state.me.user.name })}</p>
      <label>${t('Current (temporary) password')}<input name="current" type="password" autocomplete="current-password" required></label>
      <label>${t('New password (min. 8 characters)')}<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>${t('Repeat new password')}<input name="password2" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="form-error" hidden></div>
      <button class="btn btn-primary btn-block" type="submit">${t('Save password')}</button>
      <button class="btn btn-block btn-ghost" type="button" id="cancelPw">${t('Log out')}</button>
    </form>`);
  bindLang(root, showForcePassword);
  const f = $('#pwForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    const err = f.querySelector('.form-error');
    try {
      if (d.password !== d.password2) throw new Error(t('The new passwords do not match'));
      await api.post('/api/me/password', { current: d.current, password: d.password });
      toast(t('Password saved'));
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  $('#cancelPw').onclick = () => { api.logout(); state.me = null; showLogin(); };
}

async function boot() {
  try {
    state.me = { ...(await api.get('/api/me')), clientDay: todayStr() };
  } catch (e) {
    showLogin(e.status && e.status !== 401 ? e.message : '');
    return;
  }
  if (state.me.user.must_change) { showForcePassword(); return; }
  state.ref = null;
  renderShell();
  connectLive(updateLive);
  await route();
}

api.onUnauthorized = () => {
  if (state.me) {
    state.me = null;
    api.logout();
    disconnectLive();
    showLogin(t('Your session has ended. Please log in again.'));
  }
};
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
