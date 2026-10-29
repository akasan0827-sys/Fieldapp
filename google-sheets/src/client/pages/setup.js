import { api, state, loadRef, can, host } from '../api.js';
import { t } from '../i18n.js';
import { html, raw, $, $$, n, fmtDateTime, toast, modal, formData, emptyState, swatch } from '../ui.js';
import { customerModal } from './forms.js';

const set = (el, h) => { el.innerHTML = String(h); };
const EDIT_ROLES = ['admin', 'scm'];
const active = (v) => (v ? '' : html` <span class="badge badge-muted">${t('inactive')}</span>`);
const same = (a, b) => String(a) === String(b);

// =====================================================================================
// Slab colours
// =====================================================================================
function slabModal(cur) {
  const s = cur || { code: '', name: '', thickness_mm: 12, width_mm: 760, length_mm: 3680, min_pcs: 0, color_hex: '', note: '', active: 1 };
  return modal({
    title: cur ? t('Edit {name}', { name: s.code }) : t('New slab colour'),
    body: html`
      <div class="row-2"><label>${t('Code')} <input name="code" required value="${s.code}" placeholder="S-008"></label>
      <label>${t('Colour name')} <input name="name" required value="${s.name}" placeholder="N-WHITE"></label></div>
      <div class="row-3"><label>${t('Thickness mm')} <input name="thickness_mm" type="number" step="any" value="${s.thickness_mm}"></label>
      <label>${t('Width mm')} <input name="width_mm" type="number" step="any" value="${s.width_mm}"></label>
      <label>${t('Length mm')} <input name="length_mm" type="number" step="any" value="${s.length_mm}"></label></div>
      <div class="row-2"><label>${t('Minimum stock (pcs, for "Low" alerts)')} <input name="min_pcs" type="number" min="0" value="${s.min_pcs}"></label>
      <label>${t('Swatch colour')} <input name="color_hex" type="color" value="${s.color_hex || '#e5e5e5'}"></label></div>
      <label>${t('Note')} <input name="note" value="${s.note}"></label>
      <label class="check"><input type="checkbox" name="active" ${s.active ? raw('checked') : ''}> ${t('Active (shown in forms)')}</label>`,
    onSubmit: (f) => {
      const v = formData(f);
      return cur ? api.patch(`/api/slabs/${cur.id}`, v) : api.post('/api/slabs', v);
    },
  });
}

export const colors = {
  title: () => t('Slab colours'),
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    set(main, html`
      <div class="toolbar wrap"><span class="muted">${t('{n} colours', { n: ref.slabs.length })}</span><span class="spacer"></span>
        <button class="btn" id="paste">${t('Paste list from Excel')}</button>
        <button class="btn btn-primary" id="add">${t('+ New colour')}</button></div>
      ${ref.slabs.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Code')}</th><th>${t('Colour')}</th><th>${t('Size (T × W × L mm)')}</th><th class="num">${t('m² / slab')}</th><th class="num">${t('Min. pcs')}</th><th>${t('Note')}</th><th></th></tr></thead>
        <tbody>${ref.slabs.map((s) => html`<tr><td class="nowrap">${swatch(s.color_hex)}<strong>${s.code}</strong></td><td>${s.name}${active(s.active)}</td>
          <td>${n(s.thickness_mm)} × ${n(s.width_mm)} × ${n(s.length_mm)}</td><td class="num">${n(s.area, 3)}</td><td class="num">${n(s.min_pcs)}</td><td class="small">${s.note}</td>
          <td><button class="btn btn-sm" data-edit="${s.id}">${t('Edit')}</button></td></tr>`)}</tbody></table></div>`
        : emptyState(t('No colours yet. Add them one by one or paste the list from Excel.'))}`);
    $('#add', main).onclick = async () => { if (await slabModal()) { toast(t('Colour added')); this.render(main); } };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      if (await slabModal(ref.slabs.find((s) => same(s.id, b.dataset.edit)))) { toast(t('Saved')); this.render(main); }
    }));
    $('#paste', main).onclick = async () => {
      const res = await modal({
        title: t('Paste colours from Excel'), submit: t('Import'), wide: true,
        body: html`<p class="muted">${t('Columns: Code, Name, and optionally Thickness, Width, Length (mm) and Minimum pcs. Existing codes are updated. Default size is 12 × 760 × 3680.')}</p>
          <textarea name="text" rows="10" placeholder="S-008&#9;N-WHITE&#10;P-004&#9;Solaris&#9;12&#9;760&#9;3680&#9;10"></textarea>`,
        onSubmit: async (f) => {
          const rows = formData(f).text.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((c) => c[0])
            .map(([code, name, th, w, l, min]) => ({ code, name: name || code, thickness_mm: th || undefined, width_mm: w || undefined, length_mm: l || undefined, min_pcs: min || undefined }));
          return api.post('/api/slabs/bulk', { rows });
        },
      });
      if (res) { toast(t('{a} added, {u} updated', { a: res.created, u: res.updated })); this.render(main); }
    };
  },
};

// =====================================================================================
// Glue products
// =====================================================================================
function glueModal(cur, slabs) {
  const g = cur || { code: '', name: '', color: '', unit: 'pcs', shelf_life_months: 12, min_qty: 0, note: '', active: 1, slab_ids: [] };
  const ids = new Set((g.slab_ids || []).map(String));
  return modal({
    title: cur ? t('Edit {name}', { name: g.code }) : t('New glue product'), wide: true,
    body: html`
      <div class="row-3"><label>${t('Code')} <input name="code" required value="${g.code}" placeholder="G-WH"></label>
      <label>${t('Name')} <input name="name" required value="${g.name}" placeholder="Glue White"></label>
      <label>${t('Colour')} <input name="color" value="${g.color}" placeholder="White"></label></div>
      <div class="row-3"><label>${t('Unit')} <input name="unit" value="${g.unit}" placeholder="pcs / kit / cartridge"></label>
      <label>${t('Shelf life (months)')} <input name="shelf_life_months" type="number" min="1" max="120" value="${g.shelf_life_months}"></label>
      <label>${t('Minimum stock')} <input name="min_qty" type="number" min="0" value="${g.min_qty}"></label></div>
      <fieldset class="checks"><legend>${t('Used for slab colours')}</legend>
        ${slabs.map((s) => html`<label class="check"><input type="checkbox" name="slab_ids" data-multi="1" value="${s.id}" ${ids.has(String(s.id)) ? raw('checked') : ''}> ${s.code} ${s.name}</label>`)}
      </fieldset>
      <label>${t('Note')} <input name="note" value="${g.note}"></label>
      <label class="check"><input type="checkbox" name="active" ${g.active ? raw('checked') : ''}> ${t('Active')}</label>`,
    onSubmit: (f) => {
      const v = formData(f);
      return cur ? api.patch(`/api/glues/${cur.id}`, v) : api.post('/api/glues', v);
    },
  });
}

export const glues = {
  title: () => t('Glue products'),
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    const code = (id) => ref.slabs.find((s) => same(s.id, id))?.code;
    set(main, html`
      <div class="toolbar wrap"><span class="muted">${t('One product per glue colour. Stock is kept per lot with its expiry date.')}</span><span class="spacer"></span>
        <button class="btn btn-primary" id="add">${t('+ New glue')}</button></div>
      ${ref.glues.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Code')}</th><th>${t('Name')}</th><th>${t('Colour')}</th><th>${t('Unit')}</th><th class="num">${t('Shelf life')}</th><th class="num">${t('Min.')}</th><th>${t('For slab colours')}</th><th></th></tr></thead>
        <tbody>${ref.glues.map((g) => html`<tr><td><strong>${g.code}</strong></td><td>${g.name}${active(g.active)}</td><td>${g.color}</td><td>${t(g.unit)}</td>
          <td class="num">${t('{n} mo', { n: g.shelf_life_months })}</td><td class="num">${n(g.min_qty)}</td><td class="small">${g.slab_ids.map(code).filter(Boolean).join(', ') || '–'}</td>
          <td><button class="btn btn-sm" data-edit="${g.id}">${t('Edit')}</button></td></tr>`)}</tbody></table></div>` : emptyState(t('No glue products yet.'))}`);
    const slabs = ref.slabs.filter((s) => s.active);
    $('#add', main).onclick = async () => { if (await glueModal(null, slabs)) { toast(t('Glue added')); this.render(main); } };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      if (await glueModal(ref.glues.find((g) => same(g.id, b.dataset.edit)), ref.slabs)) { toast(t('Saved')); this.render(main); }
    }));
  },
};

// =====================================================================================
// Racks
// =====================================================================================
export const racksSetup = {
  title: () => t('Rack locations'),
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    set(main, html`
      <form class="card toolbar wrap" id="addForm">
        <label class="inline grow">${t('New racks')} <input name="codes" placeholder="A1, A2, A3 / OFFCUT-1" required></label>
        <label class="inline">${t('Description')} <input name="name" placeholder="${t('e.g. Rack A')}"></label>
        <button class="btn btn-primary">${t('Add')}</button>
      </form>
      <p class="muted small">${t('Tip: create one rack (or a few) just for offcuts — leftover pieces from cutting go there by default.')}</p>
      ${ref.locations.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Rack')}</th><th>${t('Description')}</th><th>${t('Status')}</th><th></th></tr></thead>
        <tbody>${ref.locations.map((l) => html`<tr><td><strong>${l.code}</strong></td><td>${l.name}</td><td>${l.active ? t('Active') : t('Inactive')}</td>
          <td class="nowrap"><button class="btn btn-sm" data-edit="${l.id}">${t('Edit')}</button></td></tr>`)}</tbody></table></div>` : emptyState(t('No racks yet.'))}`);
    $('#addForm', main).onsubmit = async (e) => {
      e.preventDefault();
      const v = formData(e.target);
      try {
        await api.post('/api/locations', { codes: v.codes.split(/[,\s]+/).filter(Boolean), name: v.name });
        toast(t('Racks added'));
        this.render(main);
      } catch (ex) { toast(ex.message, 'error'); }
    };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      const l = ref.locations.find((x) => same(x.id, b.dataset.edit));
      const ok = await modal({
        title: t('Edit rack {code}', { code: l.code }),
        body: html`<label>${t('Code')} <input name="code" value="${l.code}" required></label><label>${t('Description')} <input name="name" value="${l.name}"></label>
          <label class="check"><input type="checkbox" name="active" ${l.active ? raw('checked') : ''}> ${t('Active')}</label>`,
        onSubmit: (f) => api.patch(`/api/locations/${l.id}`, formData(f)),
      });
      if (ok) { toast(t('Saved')); this.render(main); }
    }));
  },
};

// =====================================================================================
// Customers
// =====================================================================================
let custQ = '';
export const customers = {
  title: () => t('Customers'),
  async render(main) {
    const ref = await loadRef(true);
    const edit = can.edit();
    set(main, html`
      <div class="toolbar wrap"><input type="search" id="q" placeholder="${t('Search customers…')}" value="${custQ}" aria-label="${t('Search')}">
        <span class="spacer"></span><button class="btn btn-primary" id="add">${t('+ New customer')}</button></div>
      <div id="list"></div>
      <p class="muted small">${t('★ = key account (special customer). Their stock can be locked from the Locks page.')}</p>`);
    const draw = () => {
      const q = custQ.toLowerCase();
      const list = ref.customers.filter((c) => !q || `${c.name} ${c.contact} ${c.address}`.toLowerCase().includes(q));
      set($('#list', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Customer')}</th><th>${t('Contact')}</th><th>${t('Phone')}</th><th>${t('Default delivery address')}</th><th>${t('Note')}</th>${edit ? html`<th></th>` : ''}</tr></thead>
        <tbody>${list.map((c) => html`<tr><td>${c.key_account ? html`<span title="${t('Key account')}">★</span> ` : ''}<strong>${c.name}</strong>${active(c.active)}</td><td>${c.contact}</td><td>${c.phone}</td>
          <td>${c.address}</td><td class="small">${c.note}</td>${edit ? html`<td><button class="btn btn-sm" data-edit="${c.id}">${t('Edit')}</button></td>` : ''}</tr>`)}</tbody></table></div>`
        : emptyState(t('No customers found.')));
      $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
        if (await customerModal(ref.customers.find((c) => same(c.id, b.dataset.edit)))) { toast(t('Saved')); this.render(main); }
      }));
    };
    draw();
    $('#q', main).oninput = (e) => { custQ = e.target.value; draw(); };
    $('#add', main).onclick = async () => { if (await customerModal()) { toast(t('Customer added')); this.render(main); } };
  },
};

// =====================================================================================
// Users (admin)
// =====================================================================================
const ROLES = [['scm', 'SCM — manages stock, deliveries, receipts, locks'], ['sales', 'Sales — sees live stock, requests locks'], ['admin', 'Admin — everything incl. users, closing and settings']];

export const users = {
  title: () => t('Users'),
  roles: ['admin'],
  async render(main) {
    const list = await api.get('/api/users');
    set(main, html`
      <div class="toolbar wrap"><span class="muted">${t('Give every employee their own login — every movement records who entered it.')}</span><span class="spacer"></span>
        <button class="btn btn-primary" id="add">${t('+ New user')}</button></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${t('Name')}</th><th>${t('Username')}</th><th>${t('Role')}</th><th>${t('Status')}</th><th>${t('Created')}</th><th></th></tr></thead>
        <tbody>${list.map((u) => html`<tr><td><strong>${u.name}</strong></td><td>${u.username}</td><td><span class="role role-${u.role}">${u.role.toUpperCase()}</span></td>
          <td>${u.active ? (u.must_change ? t('Must set password') : t('Active')) : t('Disabled')}</td><td>${fmtDateTime(u.created_at)}</td>
          <td><button class="btn btn-sm" data-edit="${u.id}">${t('Edit')}</button></td></tr>`)}</tbody></table></div>
      <section class="card"><h2>${t('Roles')}</h2><ul>${ROLES.map(([, d]) => html`<li>${t(d)}</li>`)}</ul></section>`);
    const roleSelect = (cur) => html`<select name="role">${ROLES.map(([r, d]) => html`<option value="${r}" ${r === cur ? raw('selected') : ''}>${t(d)}</option>`)}</select>`;
    $('#add', main).onclick = async () => {
      const ok = await modal({
        title: t('New user'),
        body: html`<div class="row-2"><label>${t('Name')} <input name="name" required></label><label>${t('Username')} <input name="username" required autocomplete="off" autocapitalize="none"></label></div>
          <label>${t('Role')} ${roleSelect('sales')}</label>
          <label>${t('Temporary password (min. 8)')} <input name="password" required minlength="8" autocomplete="new-password"></label>
          <p class="muted small">${t('They will be asked to choose their own password at first login.')}</p>`,
        onSubmit: (f) => api.post('/api/users', formData(f)),
      });
      if (ok) { toast(t('User created')); this.render(main); }
    };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      const u = list.find((x) => same(x.id, b.dataset.edit));
      const ok = await modal({
        title: t('Edit {name}', { name: u.username }),
        body: html`<label>${t('Name')} <input name="name" value="${u.name}" required></label>
          <label>${t('Role')} ${roleSelect(u.role)}</label>
          <label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> ${t('Active (can log in)')}</label>
          <label>${t('Reset password (leave empty to keep)')} <input name="password" minlength="8" autocomplete="new-password"></label>`,
        onSubmit: (f) => { const v = formData(f); if (!v.password) delete v.password; return api.patch(`/api/users/${u.id}`, v); },
      });
      if (ok) { toast(t('Saved')); this.render(main); }
    }));
  },
};

// =====================================================================================
// Settings (admin)
// =====================================================================================
const ACTIONS = {
  login: 'Logged in', 'password.change': 'Changed password',
  'doc.post': 'Saved movement', 'doc.expected': 'Registered incoming shipment', 'doc.receive': 'Received shipment',
  'doc.update_expected': 'Changed incoming shipment', 'doc.delete_expected': 'Deleted incoming shipment', 'doc.void': 'Voided document',
  'lock.create': 'Locked stock', 'lock.request': 'Requested a lock', 'lock.approve': 'Approved lock', 'lock.reject': 'Rejected lock',
  'lock.release': 'Released lock', 'lock.cancel': 'Cancelled lock request', 'lock.update': 'Changed lock',
  'month.close': 'Closed month', 'month.reopen': 'Reopened month', 'settings.update': 'Changed settings',
  'slab.create': 'Added colour', 'slab.update': 'Changed colour', 'slab.bulk': 'Imported colours',
  'glue.create': 'Added glue', 'glue.update': 'Changed glue', 'location.create': 'Added racks', 'location.update': 'Changed rack',
  'customer.create': 'Added customer', 'customer.update': 'Changed customer', 'user.create': 'Added user', 'user.update': 'Changed user',
};

export const settings = {
  title: () => t('Settings'),
  roles: ['admin'],
  async render(main) {
    const ref = await loadRef(true);
    const s = ref.settings;
    const log = await api.get('/api/audit');
    set(main, html`
      <form class="card" id="setForm">
        <h2>${t('General')}</h2>
        <div class="form-grid">
          <label>${t('Company name')} <input name="company_name" value="${s.company_name}" required></label>
          <label>${t('Go-live date (initial stock count)')} <input type="date" name="go_live_date" value="${s.go_live_date}"></label>
          <label>${t('Warn about glue expiring within (days)')} <input type="number" name="expiry_warn_days" min="1" max="365" value="${s.expiry_warn_days}"></label>
          <label>${t('Default lock period (days)')} <input type="number" name="lock_default_days" min="1" max="365" value="${s.lock_default_days}"></label>
        </div>
        <button class="btn btn-primary">${t('Save settings')}</button>
      </form>
      <section class="card">
        <h2>${t('Where is my data?')}</h2>
        ${host.kind === 'demo'
          ? html`<p>${t('This is a demo: everything you enter stays in this browser only. Use “Reset demo” in the menu to start again.')}</p>
            <p class="muted">${t('In the real version every number is saved in your own Google Sheet (one tab per table). Google keeps the version history, so you can always see or restore an earlier state.')}</p>`
          : html`<p>${t('Every number is saved in your Google Sheet (one tab per table). Google keeps the version history: in the Sheet choose File → Version history to see or restore an earlier state.')}</p>
            ${state.me.sheet_url ? html`<p><a class="btn" href="${state.me.sheet_url}" target="_blank" rel="noopener">${t('Open the Google Sheet')} ↗</a></p>` : ''}
            <p class="muted small">${t('Please do not type into the data tabs directly — use this app, so the stock always adds up. The “Stock (live)” tab is safe to read, filter and copy.')}</p>`}
      </section>
      <section class="card">
        <h2>${t('Activity log')}</h2>
        <div class="table-wrap"><table class="table compact"><thead><tr><th>${t('When')}</th><th>${t('Who')}</th><th>${t('Action')}</th><th>${t('Detail')}</th></tr></thead>
          <tbody>${log.map((a) => html`<tr><td class="nowrap">${fmtDateTime(a.at)}</td><td>${a.user_name || '–'}</td><td>${ACTIONS[a.action] ? t(ACTIONS[a.action]) : a.action}</td><td class="small">${a.detail}</td></tr>`)}</tbody></table></div>
      </section>`);
    $('#setForm', main).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api.patch('/api/settings', formData(e.target));
        state.me.settings = res;
        const brand = $('#brandName');
        if (brand) brand.textContent = res.company_name;
        toast(t('Settings saved'));
      } catch (ex) { toast(ex.message, 'error'); }
    };
  },
};

// =====================================================================================
// Account
// =====================================================================================
export const account = {
  title: () => t('My account'),
  async render(main) {
    const u = state.me.user;
    set(main, html`
      <form class="card narrow" id="pwForm">
        <h2>${u.name} <span class="role role-${u.role}">${u.role.toUpperCase()}</span></h2>
        <p class="muted">${t('Username')}: ${u.username}</p>
        <label>${t('Current password')} <input type="password" name="current" required autocomplete="current-password"></label>
        <label>${t('New password (min. 8)')} <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>${t('Repeat new password')} <input type="password" name="password2" required minlength="8" autocomplete="new-password"></label>
        <button class="btn btn-primary">${t('Change password')}</button>
      </form>`);
    $('#pwForm', main).onsubmit = async (e) => {
      e.preventDefault();
      const v = formData(e.target);
      try {
        if (v.password !== v.password2) throw new Error(t('The new passwords do not match'));
        await api.post('/api/me/password', { current: v.current, password: v.password });
        toast(t('Password changed'));
        e.target.reset();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  },
};
