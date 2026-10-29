import { api, state, loadRef, can } from '../api.js';
import { html, raw, $, $$, n, fmtDateTime, toast, modal, formData, emptyState, swatch } from '../ui.js';
import { customerModal } from './forms.js';

const set = (el, h) => { el.innerHTML = String(h); };
const EDIT_ROLES = ['admin', 'scm'];
const active = (v) => (v ? '' : html` <span class="badge badge-muted">inactive</span>`);

// =====================================================================================
// Slab colours
// =====================================================================================
function slabModal(cur) {
  const s = cur || { code: '', name: '', thickness_mm: 12, width_mm: 760, length_mm: 3680, min_pcs: 0, color_hex: '', note: '', active: 1 };
  return modal({
    title: cur ? `Edit ${s.code}` : 'New slab colour',
    body: html`
      <div class="row-2"><label>Code <input name="code" required value="${s.code}" placeholder="S-008"></label>
      <label>Colour name <input name="name" required value="${s.name}" placeholder="N-WHITE"></label></div>
      <div class="row-3"><label>Thickness mm <input name="thickness_mm" type="number" step="any" value="${s.thickness_mm}"></label>
      <label>Width mm <input name="width_mm" type="number" step="any" value="${s.width_mm}"></label>
      <label>Length mm <input name="length_mm" type="number" step="any" value="${s.length_mm}"></label></div>
      <div class="row-2"><label>Minimum stock (pcs, for "Low" alerts) <input name="min_pcs" type="number" min="0" value="${s.min_pcs}"></label>
      <label>Swatch colour <input name="color_hex" type="color" value="${s.color_hex || '#e5e5e5'}"></label></div>
      <label>Note <input name="note" value="${s.note}"></label>
      <label class="check"><input type="checkbox" name="active" ${s.active ? raw('checked') : ''}> Active (shown in forms)</label>`,
    onSubmit: (f) => {
      const v = formData(f);
      return cur ? api.patch(`/api/slabs/${cur.id}`, v) : api.post('/api/slabs', v);
    },
  });
}

export const colors = {
  title: 'Slab colours',
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    set(main, html`
      <div class="toolbar"><span class="muted">${ref.slabs.length} colours</span><span class="spacer"></span>
        <button class="btn" id="paste">Paste list from Excel</button>
        <button class="btn btn-primary" id="add">+ New colour</button></div>
      ${ref.slabs.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Code</th><th>Colour</th><th>Size (T × W × L mm)</th><th class="num">m² / slab</th><th class="num">Min. pcs</th><th>Note</th><th></th></tr></thead>
        <tbody>${ref.slabs.map((s) => html`<tr><td class="nowrap">${swatch(s.color_hex)}<strong>${s.code}</strong></td><td>${s.name}${active(s.active)}</td>
          <td>${n(s.thickness_mm)} × ${n(s.width_mm)} × ${n(s.length_mm)}</td><td class="num">${n(s.area, 3)}</td><td class="num">${n(s.min_pcs)}</td><td class="small">${s.note}</td>
          <td><button class="btn btn-sm" data-edit="${s.id}">Edit</button></td></tr>`)}</tbody></table></div>`
        : emptyState('No colours yet. Add them one by one or paste the list from Excel.')}`);
    $('#add', main).onclick = async () => { if (await slabModal()) { toast('Colour added'); this.render(main); } };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      if (await slabModal(ref.slabs.find((s) => s.id === Number(b.dataset.edit)))) { toast('Saved'); this.render(main); }
    }));
    $('#paste', main).onclick = async () => {
      const res = await modal({
        title: 'Paste colours from Excel', submit: 'Import', wide: true,
        body: html`<p class="muted">Columns: <strong>Code</strong>, <strong>Name</strong>, and optionally Thickness, Width, Length (mm) and Minimum pcs.
          Existing codes are updated. Default size is 12 × 760 × 3680.</p>
          <textarea name="text" rows="10" placeholder="S-008&#9;N-WHITE&#10;P-004&#9;Solaris&#9;12&#9;760&#9;3680&#9;10"></textarea>`,
        onSubmit: async (f) => {
          const rows = formData(f).text.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((c) => c[0])
            .map(([code, name, t, w, l, min]) => ({ code, name: name || code, thickness_mm: t || undefined, width_mm: w || undefined, length_mm: l || undefined, min_pcs: min || undefined }));
          return api.post('/api/slabs/bulk', { rows });
        },
      });
      if (res) { toast(`${res.created} added, ${res.updated} updated`); this.render(main); }
    };
  },
};

// =====================================================================================
// Glue products
// =====================================================================================
function glueModal(cur, slabs) {
  const g = cur || { code: '', name: '', color: '', unit: 'pcs', shelf_life_months: 12, min_qty: 0, note: '', active: 1, slab_ids: [] };
  return modal({
    title: cur ? `Edit ${g.code}` : 'New glue product', wide: true,
    body: html`
      <div class="row-3"><label>Code <input name="code" required value="${g.code}" placeholder="G-WH"></label>
      <label>Name <input name="name" required value="${g.name}" placeholder="Glue White"></label>
      <label>Colour <input name="color" value="${g.color}" placeholder="White"></label></div>
      <div class="row-3"><label>Unit <input name="unit" value="${g.unit}" placeholder="pcs / kit / cartridge"></label>
      <label>Shelf life (months) <input name="shelf_life_months" type="number" min="1" max="120" value="${g.shelf_life_months}"></label>
      <label>Minimum stock <input name="min_qty" type="number" min="0" value="${g.min_qty}"></label></div>
      <fieldset class="checks"><legend>Used for slab colours</legend>
        ${slabs.map((s) => html`<label class="check"><input type="checkbox" name="slab_ids" data-multi="1" value="${s.id}" ${g.slab_ids.includes(s.id) ? raw('checked') : ''}> ${s.code} ${s.name}</label>`)}
      </fieldset>
      <label>Note <input name="note" value="${g.note}"></label>
      <label class="check"><input type="checkbox" name="active" ${g.active ? raw('checked') : ''}> Active</label>`,
    onSubmit: (f) => {
      const v = formData(f);
      return cur ? api.patch(`/api/glues/${cur.id}`, v) : api.post('/api/glues', v);
    },
  });
}

export const glues = {
  title: 'Glue products',
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    const code = (id) => ref.slabs.find((s) => s.id === id)?.code;
    set(main, html`
      <div class="toolbar"><span class="muted">One product per glue colour. Stock is kept per lot with its expiry date.</span><span class="spacer"></span>
        <button class="btn btn-primary" id="add">+ New glue</button></div>
      ${ref.glues.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Code</th><th>Name</th><th>Colour</th><th>Unit</th><th class="num">Shelf life</th><th class="num">Min.</th><th>For slab colours</th><th></th></tr></thead>
        <tbody>${ref.glues.map((g) => html`<tr><td><strong>${g.code}</strong></td><td>${g.name}${active(g.active)}</td><td>${g.color}</td><td>${g.unit}</td>
          <td class="num">${g.shelf_life_months} mo</td><td class="num">${n(g.min_qty)}</td><td class="small">${g.slab_ids.map(code).join(', ') || '–'}</td>
          <td><button class="btn btn-sm" data-edit="${g.id}">Edit</button></td></tr>`)}</tbody></table></div>` : emptyState('No glue products yet.')}`);
    const slabs = ref.slabs.filter((s) => s.active);
    $('#add', main).onclick = async () => { if (await glueModal(null, slabs)) { toast('Glue added'); this.render(main); } };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      if (await glueModal(ref.glues.find((g) => g.id === Number(b.dataset.edit)), ref.slabs)) { toast('Saved'); this.render(main); }
    }));
  },
};

// =====================================================================================
// Racks
// =====================================================================================
export const racksSetup = {
  title: 'Rack locations',
  roles: EDIT_ROLES,
  async render(main) {
    const ref = await loadRef(true);
    set(main, html`
      <form class="card toolbar" id="addForm">
        <label class="inline grow">New racks <input name="codes" placeholder="A1, A2, A3 or OFFCUT-1" required></label>
        <label class="inline">Description <input name="name" placeholder="e.g. Rack A"></label>
        <button class="btn btn-primary">Add</button>
      </form>
      <p class="muted small">Tip: create one rack (or a few) just for offcuts — leftover pieces from cutting go there by default.</p>
      ${ref.locations.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Rack</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>${ref.locations.map((l) => html`<tr><td><strong>${l.code}</strong></td><td>${l.name}</td><td>${l.active ? 'Active' : 'Inactive'}</td>
          <td class="nowrap"><button class="btn btn-sm" data-edit="${l.id}">Edit</button></td></tr>`)}</tbody></table></div>` : emptyState('No racks yet.')}`);
    $('#addForm', main).onsubmit = async (e) => {
      e.preventDefault();
      const v = formData(e.target);
      try {
        await api.post('/api/locations', { codes: v.codes.split(/[,\s]+/).filter(Boolean), name: v.name });
        toast('Racks added');
        this.render(main);
      } catch (ex) { toast(ex.message, 'error'); }
    };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      const l = ref.locations.find((x) => x.id === Number(b.dataset.edit));
      const ok = await modal({
        title: `Edit rack ${l.code}`,
        body: html`<label>Code <input name="code" value="${l.code}" required></label><label>Description <input name="name" value="${l.name}"></label>
          <label class="check"><input type="checkbox" name="active" ${l.active ? raw('checked') : ''}> Active</label>`,
        onSubmit: (f) => api.patch(`/api/locations/${l.id}`, formData(f)),
      });
      if (ok) { toast('Saved'); this.render(main); }
    }));
  },
};

// =====================================================================================
// Customers
// =====================================================================================
let custQ = '';
export const customers = {
  title: 'Customers',
  async render(main) {
    const ref = await loadRef(true);
    const edit = can.edit();
    set(main, html`
      <div class="toolbar"><input type="search" id="q" placeholder="Search customers…" value="${custQ}" aria-label="Search">
        <span class="spacer"></span><button class="btn btn-primary" id="add">+ New customer</button></div>
      <div id="list"></div>
      <p class="muted small">★ = key account (special customer). Their stock can be locked from the Locks page.</p>`);
    const draw = () => {
      const q = custQ.toLowerCase();
      const list = ref.customers.filter((c) => !q || `${c.name} ${c.contact} ${c.address}`.toLowerCase().includes(q));
      set($('#list', main), list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Customer</th><th>Contact</th><th>Phone</th><th>Default delivery address</th><th>Note</th>${edit ? html`<th></th>` : ''}</tr></thead>
        <tbody>${list.map((c) => html`<tr><td>${c.key_account ? html`<span title="Key account">★</span> ` : ''}<strong>${c.name}</strong>${active(c.active)}</td><td>${c.contact}</td><td>${c.phone}</td>
          <td>${c.address}</td><td class="small">${c.note}</td>${edit ? html`<td><button class="btn btn-sm" data-edit="${c.id}">Edit</button></td>` : ''}</tr>`)}</tbody></table></div>`
        : emptyState('No customers found.'));
      $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
        if (await customerModal(ref.customers.find((c) => c.id === Number(b.dataset.edit)))) { toast('Saved'); this.render(main); }
      }));
    };
    draw();
    $('#q', main).oninput = (e) => { custQ = e.target.value; draw(); };
    $('#add', main).onclick = async () => { if (await customerModal()) { toast('Customer added'); this.render(main); } };
  },
};

// =====================================================================================
// Users (admin)
// =====================================================================================
const ROLES = [['scm', 'SCM — manages stock, deliveries, receipts, locks'], ['sales', 'Sales — sees live stock, requests locks'], ['admin', 'Admin — everything incl. users, closing, backup']];

export const users = {
  title: 'Users',
  roles: ['admin'],
  async render(main) {
    const list = await api.get('/api/users');
    set(main, html`
      <div class="toolbar"><span class="muted">Give every employee their own login — every movement records who entered it.</span><span class="spacer"></span>
        <button class="btn btn-primary" id="add">+ New user</button></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${list.map((u) => html`<tr><td><strong>${u.name}</strong></td><td>${u.username}</td><td><span class="role role-${u.role}">${u.role.toUpperCase()}</span></td>
          <td>${u.active ? (u.must_change ? 'Must set password' : 'Active') : 'Disabled'}</td><td>${fmtDateTime(u.created_at)}</td>
          <td><button class="btn btn-sm" data-edit="${u.id}">Edit</button></td></tr>`)}</tbody></table></div>
      <section class="card"><h2>Roles</h2><ul>${ROLES.map(([, d]) => html`<li>${d}</li>`)}</ul></section>`);
    const roleSelect = (cur) => html`<select name="role">${ROLES.map(([r, d]) => html`<option value="${r}" ${r === cur ? raw('selected') : ''}>${d}</option>`)}</select>`;
    $('#add', main).onclick = async () => {
      const ok = await modal({
        title: 'New user',
        body: html`<div class="row-2"><label>Name <input name="name" required></label><label>Username <input name="username" required autocomplete="off"></label></div>
          <label>Role ${roleSelect('sales')}</label>
          <label>Temporary password (min. 8) <input name="password" required minlength="8" autocomplete="new-password"></label>
          <p class="muted small">They will be asked to choose their own password at first login.</p>`,
        onSubmit: (f) => api.post('/api/users', formData(f)),
      });
      if (ok) { toast('User created'); this.render(main); }
    };
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', async () => {
      const u = list.find((x) => x.id === Number(b.dataset.edit));
      const ok = await modal({
        title: `Edit ${u.username}`,
        body: html`<label>Name <input name="name" value="${u.name}" required></label>
          <label>Role ${roleSelect(u.role)}</label>
          <label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> Active (can log in)</label>
          <label>Reset password (leave empty to keep) <input name="password" minlength="8" autocomplete="new-password"></label>`,
        onSubmit: (f) => { const v = formData(f); if (!v.password) delete v.password; return api.patch(`/api/users/${u.id}`, v); },
      });
      if (ok) { toast('Saved'); this.render(main); }
    }));
  },
};

// =====================================================================================
// Settings & backup (admin)
// =====================================================================================
export const settings = {
  title: 'Settings & backup',
  roles: ['admin'],
  async render(main) {
    const ref = await loadRef(true);
    const s = ref.settings;
    const log = await api.get('/api/audit');
    set(main, html`
      <form class="card" id="setForm">
        <h2>General</h2>
        <div class="form-grid">
          <label>Company name <input name="company_name" value="${s.company_name}" required></label>
          <label>Go-live date (initial stock count) <input type="date" name="go_live_date" value="${s.go_live_date}"></label>
          <label>Warn about glue expiring within (days) <input type="number" name="expiry_warn_days" min="1" max="365" value="${s.expiry_warn_days}"></label>
          <label>Default lock period (days) <input type="number" name="lock_default_days" min="1" max="365" value="${s.lock_default_days}"></label>
        </div>
        <button class="btn btn-primary">Save settings</button>
      </form>
      <section class="card">
        <h2>Backup</h2>
        <p>Download a complete copy of the database (all stock, movements, users). Keep it somewhere safe — e.g. a daily copy on a NAS or cloud drive.</p>
        <a class="btn" href="/api/backup" download>⇩ Download backup</a>
      </section>
      <section class="card">
        <h2>Activity log</h2>
        <div class="table-wrap"><table class="table compact"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${log.map((a) => html`<tr><td class="nowrap">${fmtDateTime(a.at)}</td><td>${a.user_name || '–'}</td><td>${a.action}</td><td class="small">${a.detail}</td></tr>`)}</tbody></table></div>
      </section>`);
    $('#setForm', main).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api.patch('/api/settings', formData(e.target));
        state.me.settings = res;
        toast('Settings saved');
      } catch (ex) { toast(ex.message, 'error'); }
    };
  },
};

// =====================================================================================
// Account
// =====================================================================================
export const account = {
  title: 'My account',
  async render(main) {
    const u = state.me.user;
    set(main, html`
      <form class="card narrow" id="pwForm">
        <h2>${u.name} <span class="role role-${u.role}">${u.role.toUpperCase()}</span></h2>
        <p class="muted">Username: ${u.username}</p>
        <label>Current password <input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password (min. 8) <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>Repeat new password <input type="password" name="password2" required minlength="8" autocomplete="new-password"></label>
        <button class="btn btn-primary">Change password</button>
      </form>`);
    $('#pwForm', main).onsubmit = async (e) => {
      e.preventDefault();
      const v = formData(e.target);
      try {
        if (v.password !== v.password2) throw new Error('The new passwords do not match');
        await api.post('/api/me/password', { current: v.current, password: v.password });
        toast('Password changed');
        e.target.reset();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  },
};
