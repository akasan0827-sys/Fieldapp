import { api, state, loadRef } from '../api.js';
import {
  html, raw, $, $$, n, fmtDate, toast, modal, formData, options, emptyState, addMonths, swatch,
} from '../ui.js';

const set = (el, h) => { el.innerHTML = String(h); };
const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const EDIT_ROLES = ['admin', 'scm'];

// =====================================================================================
// Context: everything the line editors need to show availability
// =====================================================================================
async function loadCtx() {
  const [ref, stock, remnants, glue, locks] = await Promise.all([
    loadRef(true), api.get('/api/stock'), api.get('/api/remnants'), api.get('/api/glue'), api.get('/api/locks'),
  ]);
  const ctx = {
    ref,
    stock: stock.rows,
    remnants,
    glue,
    locks,
    header: {},
    today: state.me.today,
    slab: (id) => ref.slabs.find((s) => String(s.id) === String(id)),
    row: (id) => stock.rows.find((s) => String(s.id) === String(id)),
    glueOf: (id) => glue.find((g) => String(g.id) === String(id)) || ref.glues.find((g) => String(g.id) === String(id)),
    rem: (id) => remnants.find((r) => String(r.id) === String(id)),
    activeRacks: () => ref.locations.filter((l) => l.active),
  };
  ctx.rackQty = (slabId, locId) => {
    const r = ctx.row(slabId);
    const l = r && r.locations.find((x) => String(x.location_id) === String(locId));
    return l ? l.qty : 0;
  };
  ctx.customerLocks = (slabId) => locks.filter((k) => k.state === 'active' && String(k.slab_id) === String(slabId)
    && String(k.customer_id) === String(ctx.header.customer_id || ''));
  ctx.offcutRack = () => ctx.activeRacks().find((l) => /off|cut|remn/i.test(`${l.code} ${l.name}`));
  return ctx;
}

const slabOptions = (ctx, selected, { showAvail = true } = {}) => options(
  ctx.ref.slabs.filter((s) => s.active || String(s.id) === String(selected)), selected,
  { empty: '— colour —', label: (s) => { const r = ctx.row(s.id); return `${s.code} ${s.name}${showAvail && r ? ` · ${r.available} free` : ''}`; } },
);
const rackOptions = (ctx, selected, { slabId = null, onlyStocked = false, empty = '— rack —' } = {}) => {
  let racks = ctx.activeRacks();
  if (slabId) {
    const withQty = racks.map((l) => ({ ...l, q: ctx.rackQty(slabId, l.id) }));
    racks = (onlyStocked ? withQty.filter((l) => l.q > 0) : withQty).sort((a, b) => b.q - a.q);
    return options(racks, selected, { empty, label: (l) => `${l.code} · ${l.q} pcs` });
  }
  return options(racks, selected, { empty, label: (l) => l.code });
};
const remnantLabel = (r) => `${r.code} · ${r.slab_code} ${r.slab_name} · ${n(r.sqm, 2)} m²${r.location_code ? ` · ${r.location_code}` : ''}${r.width_mm && r.length_mm ? ` (${r.width_mm}×${r.length_mm})` : ''}`;

function field(label, input, cls = '') {
  return html`<label class="${cls}">${label}${input}</label>`;
}

// =====================================================================================
// Line editor
// =====================================================================================
function lineEditor(el, specs, ctx, onChange = () => {}) {
  let uid = 0;
  const lines = [];
  const card = (l) => {
    const sp = specs[l.kind];
    return html`<div class="line-card" data-uid="${l.uid}">
      <div class="line-head"><span class="line-kind">${sp.label}</span>
        <button type="button" class="icon-btn" data-remove aria-label="Remove line">✕</button></div>
      <div class="line-fields">${sp.render(l, ctx)}</div>
      ${sp.info ? html`<div class="line-info">${sp.info(l, ctx)}</div>` : ''}
    </div>`;
  };
  const draw = (silent = false) => {
    set(el, lines.length ? html`${lines.map(card)}` : emptyState('No lines yet — add one with the buttons above.'));
    if (!silent) onChange();
  };
  const redrawOne = (l) => {
    const c = el.querySelector(`[data-uid="${l.uid}"]`);
    if (c) c.outerHTML = String(card(l));
  };
  const handler = (e) => {
    const c = e.target.closest('[data-uid]');
    if (!c || !e.target.name) return;
    const l = lines.find((x) => String(x.uid) === c.dataset.uid);
    l[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const sp = specs[l.kind];
    const redraw = sp.onField ? sp.onField(l, e.target.name, ctx) : false;
    if (redraw && e.type === 'change') {
      redrawOne(l);
    } else {
      // keep dependent inputs in sync without re-rendering the focused one
      $$('input,select', c).forEach((inp) => {
        if (inp !== e.target && inp.name && l[inp.name] !== undefined && inp.type !== 'checkbox' && String(inp.value) !== String(l[inp.name] ?? '')) inp.value = l[inp.name] ?? '';
      });
      const info = c.querySelector('.line-info');
      if (info && sp.info) set(info, sp.info(l, ctx));
    }
    onChange();
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', handler);
  el.addEventListener('click', (e) => {
    if (!e.target.closest('[data-remove]')) return;
    const c = e.target.closest('[data-uid]');
    lines.splice(lines.findIndex((x) => String(x.uid) === c.dataset.uid), 1);
    draw();
  });
  draw(true); // first paint: the caller's onChange may reference the editor, which isn't returned yet
  return {
    lines,
    add(kind, init = {}) {
      const sp = specs[kind];
      const l = { uid: ++uid, kind, note: '', ...(sp.defaults ? sp.defaults(ctx, init) : {}), ...init };
      if (sp.init) sp.init(l, ctx);
      lines.push(l);
      draw();
      const c = el.querySelector(`[data-uid="${l.uid}"]`);
      if (c) { c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.querySelector('select,input')?.focus(); }
      return l;
    },
    redrawAll: draw,
    payload: () => lines.map((l) => specs[l.kind].payload(l, ctx)),
  };
}

const noteField = (l) => field('Note', html`<input name="note" value="${l.note}" maxlength="300">`, 'grow');

// ---- outbound lines ------------------------------------------------------------------
function defaultRack(ctx, slabId) {
  const r = ctx.row(slabId);
  if (!r || !r.locations.length) return '';
  return [...r.locations].sort((a, b) => b.qty - a.qty)[0].location_id;
}
function autoLock(l, ctx) {
  const ks = ctx.customerLocks(l.slab_id);
  l.lock_id = ks.length ? String(ks[0].id) : '';
}
const lockSelect = (l, ctx) => {
  const ks = ctx.customerLocks(l.slab_id);
  const r = ctx.row(l.slab_id);
  return field('Customer lock', html`<select name="lock_id">
    <option value="">No lock — free stock (${r ? Math.max(0, r.available) : 0} pcs)</option>
    ${ks.map((k) => html`<option value="${k.id}" ${String(k.id) === String(l.lock_id) ? raw('selected') : ''}>🔒 Lock #${k.id} · ${k.remaining} pcs left${k.expires_on ? ` · until ${k.expires_on}` : ''}</option>`)}
  </select>`);
};

const OUT_SPECS = {
  slab_out: {
    label: 'Full slabs',
    defaults: (ctx, init) => ({ slab_id: init.slab_id || '', location_id: '', qty: '', lock_id: '' }),
    init: (l, ctx) => { if (l.slab_id) { l.location_id = defaultRack(ctx, l.slab_id); autoLock(l, ctx); } },
    render: (l, ctx) => html`
      ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id)}</select>`, 'w-lg')}
      ${field('From rack', html`<select name="location_id" required>${l.slab_id ? rackOptions(ctx, l.location_id, { slabId: l.slab_id, onlyStocked: true }) : html`<option value="">— choose colour first —</option>`}</select>`)}
      ${field('Pieces', html`<input name="qty" type="number" min="1" step="1" value="${l.qty}" required class="w-sm">`)}
      ${l.slab_id ? lockSelect(l, ctx) : ''}
      ${noteField(l)}`,
    onField: (l, name, ctx) => {
      if (name === 'slab_id') { l.location_id = defaultRack(ctx, l.slab_id); autoLock(l, ctx); return true; }
      return false;
    },
    info: (l, ctx) => {
      const s = ctx.slab(l.slab_id);
      if (!s) return '';
      const q = Number(l.qty) || 0;
      const atRack = l.location_id ? ctx.rackQty(l.slab_id, l.location_id) : 0;
      const warn = l.location_id && q > atRack ? html` <span class="text-bad">Only ${atRack} pcs in this rack.</span>` : '';
      return html`${q} × ${n(s.area, 3)} m² = <strong>${n(q * s.area, 2)} m²</strong>${warn}`;
    },
    payload: (l) => ({ kind: 'slab_out', slab_id: l.slab_id, location_id: l.location_id, qty: l.qty, lock_id: l.lock_id || null, note: l.note }),
  },

  slab_cut: {
    label: 'Cut by m²',
    defaults: (ctx, init) => ({ slab_id: init.slab_id || '', source: '', sqm: '', leftover_sqm: '', leftover_width_mm: '', leftover_length_mm: '', leftover_location_id: '', lock_id: '', touched: false }),
    init: (l, ctx) => {
      if (!l.slab_id) return;
      const loc = defaultRack(ctx, l.slab_id);
      const firstRem = ctx.remnants.find((r) => String(r.slab_id) === String(l.slab_id));
      l.source = loc ? `slab:${loc}` : (firstRem ? `rem:${firstRem.id}` : '');
      l.leftover_location_id = String(ctx.offcutRack()?.id || loc || '');
      autoLock(l, ctx);
    },
    render: (l, ctx) => {
      const rems = ctx.remnants.filter((r) => String(r.slab_id) === String(l.slab_id));
      const r = ctx.row(l.slab_id);
      const fromSlab = l.source.startsWith('slab:');
      return html`
        ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id)}</select>`, 'w-lg')}
        ${field('Cut from', html`<select name="source" required>
          <option value="">— choose —</option>
          ${r ? html`<optgroup label="New full slab">${r.locations.filter((x) => x.qty > 0).map((x) => html`<option value="slab:${x.location_id}" ${l.source === `slab:${x.location_id}` ? raw('selected') : ''}>Full slab from rack ${x.location_code} (${x.qty} pcs)</option>`)}</optgroup>` : ''}
          ${rems.length ? html`<optgroup label="Existing offcut">${rems.map((x) => html`<option value="rem:${x.id}" ${l.source === `rem:${x.id}` ? raw('selected') : ''}>${x.code} · ${n(x.sqm, 2)} m²${x.location_code ? ` · ${x.location_code}` : ''}</option>`)}</optgroup>` : ''}
        </select>`, 'w-lg')}
        ${field('Delivered m²', html`<input name="sqm" type="number" min="0.01" step="0.01" value="${l.sqm}" required class="w-sm">`)}
        ${field('Leftover kept m²', html`<input name="leftover_sqm" type="number" min="0" step="0.001" value="${l.leftover_sqm}" class="w-sm">`)}
        ${field('Leftover size W×L mm (optional)', html`<span class="pair"><input name="leftover_width_mm" type="number" min="1" value="${l.leftover_width_mm}" placeholder="W" class="w-xs"> × <input name="leftover_length_mm" type="number" min="1" value="${l.leftover_length_mm}" placeholder="L" class="w-xs"></span>`)}
        ${field('Leftover goes to rack', html`<select name="leftover_location_id">${rackOptions(ctx, l.leftover_location_id, { empty: '— same rack —' })}</select>`)}
        ${fromSlab && l.slab_id ? lockSelect(l, ctx) : ''}
        ${noteField(l)}`;
    },
    onField: (l, name, ctx) => {
      if (name === 'slab_id') { l.source = ''; l.touched = false; OUT_SPECS.slab_cut.init(l, ctx); recalcLeft(l, ctx); return true; }
      if (name === 'source') { if (!l.touched) recalcLeft(l, ctx); return true; }
      if (name === 'sqm') { if (!l.touched) recalcLeft(l, ctx); }
      if (name === 'leftover_sqm') l.touched = l.leftover_sqm !== '';
      if (name === 'leftover_width_mm' || name === 'leftover_length_mm') {
        const w = num(l.leftover_width_mm);
        const len = num(l.leftover_length_mm);
        if (w && len) { l.leftover_sqm = r3((w * len) / 1e6); l.touched = true; }
      }
      return false;
    },
    info: (l, ctx) => {
      const src = sourceArea(l, ctx);
      if (!src) return '';
      const d = Number(l.sqm) || 0;
      const left = Number(l.leftover_sqm) || 0;
      let waste = r3(src - d - left);
      if (Math.abs(waste) < 0.0005) waste = 0;
      return html`Source ${n(src, 3)} m² − delivered ${n(d, 2)} − leftover ${n(left, 3)} = waste <strong class="${waste < -0.0005 ? 'text-bad' : ''}">${n(waste, 3)} m²</strong>
        ${waste < -0.0005 ? html` <span class="text-bad">Delivered + leftover is more than the source.</span>` : ''}
        ${left > 0 ? html` · the leftover becomes a new offcut in stock` : ''}`;
    },
    payload: (l) => {
      const base = { sqm: l.sqm, leftover_sqm: l.leftover_sqm === '' ? null : l.leftover_sqm, leftover_width_mm: l.leftover_width_mm || null, leftover_length_mm: l.leftover_length_mm || null, leftover_location_id: l.leftover_location_id || null, note: l.note };
      const [type, idv] = l.source.split(':');
      if (type === 'rem') return { kind: 'remnant_cut', remnant_id: idv, ...base };
      return { kind: 'slab_cut', slab_id: l.slab_id, location_id: idv || null, lock_id: l.lock_id || null, ...base };
    },
  },

  remnant_out: {
    label: 'Whole offcut',
    defaults: () => ({ remnant_id: '' }),
    render: (l, ctx) => html`
      ${field('Offcut', html`<select name="remnant_id" required><option value="">— choose offcut —</option>
        ${ctx.remnants.map((r) => html`<option value="${r.id}" ${String(r.id) === String(l.remnant_id) ? raw('selected') : ''}>${remnantLabel(r)}</option>`)}</select>`, 'w-xl')}
      ${noteField(l)}`,
    info: (l, ctx) => { const r = ctx.rem(l.remnant_id); return r ? html`Delivers the whole piece: <strong>${n(r.sqm, 2)} m²</strong>` : ''; },
    payload: (l) => ({ kind: 'remnant_out', remnant_id: l.remnant_id, note: l.note }),
  },

  glue_out: {
    label: 'Glue',
    defaults: () => ({ glue_id: '', qty: '', lot_id: '' }),
    render: (l, ctx) => {
      const docSlabs = new Set(ctx.lineSlabs ? ctx.lineSlabs() : []);
      const sorted = [...ctx.glue].filter((g) => g.active).sort((a, b) => {
        const am = a.matches.some((m) => docSlabs.has(String(m.id))) ? 0 : 1;
        const bm = b.matches.some((m) => docSlabs.has(String(m.id))) ? 0 : 1;
        return am - bm || a.code.localeCompare(b.code);
      });
      const g = ctx.glueOf(l.glue_id);
      return html`
        ${field('Glue', html`<select name="glue_id" required>${options(sorted, l.glue_id, { empty: '— glue —', label: (x) => `${x.matches.some((m) => docSlabs.has(String(m.id))) ? '★ ' : ''}${x.code} ${x.name} · ${x.usable} usable` })}</select>`, 'w-lg')}
        ${field('Qty', html`<input name="qty" type="number" min="1" step="1" value="${l.qty}" required class="w-sm">`)}
        ${field('Lot', html`<select name="lot_id"><option value="">Automatic (first expiry first)</option>
          ${g && g.lots ? g.lots.filter((x) => x.state !== 'expired' && x.qty > 0).map((x) => html`<option value="${x.id}" ${String(x.id) === String(l.lot_id) ? raw('selected') : ''}>${x.lot_no} · exp. ${x.expiry} · ${x.qty}</option>`) : ''}</select>`)}
        ${noteField(l)}`;
    },
    onField: (l, name) => { if (name === 'glue_id') { l.lot_id = ''; return true; } return false; },
    info: (l, ctx) => {
      const g = ctx.glueOf(l.glue_id);
      if (!g) return html`<span class="muted">★ = matches a colour in this delivery</span>`;
      const q = Number(l.qty) || 0;
      return html`${g.matches.length ? `For ${g.matches.map((m) => m.code).join(', ')} · ` : ''}${g.usable} ${g.unit} usable${q > g.usable ? html` · <span class="text-bad">not enough</span>` : ''}`;
    },
    payload: (l) => ({ kind: 'glue_out', glue_id: l.glue_id, qty: l.qty, lot_id: l.lot_id || null, note: l.note }),
  },
};

function sourceArea(l, ctx) {
  if (!l.source) return 0;
  const [type, idv] = l.source.split(':');
  if (type === 'rem') return ctx.rem(idv)?.sqm || 0;
  return ctx.slab(l.slab_id)?.area || 0;
}
function recalcLeft(l, ctx) {
  const src = sourceArea(l, ctx);
  const d = Number(l.sqm) || 0;
  l.leftover_sqm = src && d ? String(Math.max(0, r3(src - d))) : '';
}

// ---- inbound lines --------------------------------------------------------------------
function inSpecs(mode) {
  const received = () => mode.received;
  return {
    slab_in: {
      label: 'Slabs',
      defaults: () => ({ slab_id: '', qty: '', location_id: '' }),
      render: (l, ctx) => html`
        ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id, { showAvail: false })}</select>`, 'w-lg')}
        ${field('Pieces', html`<input name="qty" type="number" min="1" step="1" value="${l.qty}" required class="w-sm">`)}
        ${field(received() ? 'Into rack' : 'Rack (optional)', html`<select name="location_id" ${received() ? raw('required') : ''}>${rackOptions(ctx, l.location_id, { slabId: l.slab_id || null, empty: '— rack —' })}</select>`)}
        ${noteField(l)}`,
      onField: (l, name) => name === 'slab_id',
      info: (l, ctx) => { const s = ctx.slab(l.slab_id); return s ? html`= ${n((Number(l.qty) || 0) * s.area, 2)} m²` : ''; },
      payload: (l) => ({ kind: 'slab_in', slab_id: l.slab_id, qty: l.qty, location_id: l.location_id || null, note: l.note }),
    },
    glue_in: {
      label: 'Glue',
      defaults: () => ({ glue_id: '', qty: '', lot_no: '', expiry: '', touched: false }),
      render: (l, ctx) => html`
        ${field('Glue', html`<select name="glue_id" required>${options(ctx.ref.glues.filter((g) => g.active || String(g.id) === String(l.glue_id)), l.glue_id, { empty: '— glue —', label: (g) => `${g.code} ${g.name}` })}</select>`, 'w-lg')}
        ${field('Qty', html`<input name="qty" type="number" min="1" step="1" value="${l.qty}" required class="w-sm">`)}
        ${field(received() ? 'Lot / batch no.' : 'Lot (optional)', html`<input name="lot_no" value="${l.lot_no}" ${received() ? raw('required') : ''} class="w-md">`)}
        ${field(received() ? 'Expiry date' : 'Expiry (optional)', html`<input name="expiry" type="date" value="${l.expiry}" ${received() ? raw('required') : ''}>`)}
        ${noteField(l)}`,
      onField: (l, name, ctx) => {
        if (name === 'glue_id' && !l.touched && mode.received) {
          const g = ctx.ref.glues.find((x) => String(x.id) === String(l.glue_id));
          if (g) l.expiry = addMonths(mode.date(), g.shelf_life_months);
        }
        if (name === 'expiry') l.touched = true;
        return false;
      },
      info: (l, ctx) => {
        const g = ctx.ref.glues.find((x) => String(x.id) === String(l.glue_id));
        return g ? html`Shelf life ${g.shelf_life_months} months — check the expiry printed on the box.` : '';
      },
      payload: (l) => ({ kind: 'glue_in', glue_id: l.glue_id, qty: l.qty, lot_no: l.lot_no, expiry: l.expiry || null, note: l.note }),
    },
  };
}

// ---- adjustment / transfer lines ---------------------------------------------------------
const lotOptions = (ctx, selected) => {
  const lots = ctx.glue.flatMap((g) => g.lots.map((l) => ({ ...l, g })));
  return html`<option value="">— lot —</option>${lots.map((l) => html`<option value="${l.id}" ${String(l.id) === String(selected) ? raw('selected') : ''}>${l.g.code} · lot ${l.lot_no} · exp. ${l.expiry} · ${l.qty} ${l.g.unit}${l.state === 'expired' ? ' (expired)' : ''}</option>`)}`;
};

const ADJ_SPECS = {
  slab_adj: {
    label: 'Slabs + / −',
    defaults: () => ({ slab_id: '', location_id: '', qty: '' }),
    render: (l, ctx) => html`
      ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id, { showAvail: false })}</select>`, 'w-lg')}
      ${field('Rack', html`<select name="location_id" required>${rackOptions(ctx, l.location_id, { slabId: l.slab_id || null })}</select>`)}
      ${field('Pieces (+ add / − remove)', html`<input name="qty" type="number" step="1" value="${l.qty}" required class="w-sm" placeholder="-1">`)}
      ${noteField(l)}`,
    onField: (l, name) => name === 'slab_id',
    info: (l, ctx) => {
      if (!l.slab_id || !l.location_id) return '';
      const now = ctx.rackQty(l.slab_id, l.location_id);
      const after = now + (Number(l.qty) || 0);
      return html`Now ${now} pcs in this rack → after: <strong class="${after < 0 ? 'text-bad' : ''}">${after}</strong>`;
    },
    payload: (l) => ({ kind: 'slab_adj', slab_id: l.slab_id, location_id: l.location_id, qty: l.qty, note: l.note }),
  },
  remnant_in: {
    label: 'Register offcut',
    defaults: (ctx) => ({ slab_id: '', location_id: String(ctx.offcutRack()?.id || ''), width_mm: '', length_mm: '', sqm: '' }),
    render: (l, ctx) => html`
      ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id, { showAvail: false })}</select>`, 'w-lg')}
      ${field('Rack', html`<select name="location_id" required>${rackOptions(ctx, l.location_id)}</select>`)}
      ${field('Size W × L (mm)', html`<span class="pair"><input name="width_mm" type="number" min="1" value="${l.width_mm}" placeholder="760" class="w-xs"> × <input name="length_mm" type="number" min="1" value="${l.length_mm}" placeholder="1200" class="w-xs"></span>`)}
      ${field('or m²', html`<input name="sqm" type="number" min="0.01" step="0.001" value="${l.sqm}" class="w-sm">`)}
      ${noteField(l)}`,
    onField: (l, name) => {
      if ((name === 'width_mm' || name === 'length_mm') && num(l.width_mm) && num(l.length_mm)) l.sqm = String(r3((num(l.width_mm) * num(l.length_mm)) / 1e6));
      return false;
    },
    info: (l) => (l.sqm ? html`Offcut of <strong>${n(l.sqm, 3)} m²</strong> will be added` : ''),
    payload: (l) => ({ kind: 'remnant_in', slab_id: l.slab_id, location_id: l.location_id, width_mm: l.width_mm || null, length_mm: l.length_mm || null, sqm: l.sqm || null, note: l.note }),
  },
  remnant_scrap: {
    label: 'Scrap offcut',
    defaults: () => ({ remnant_id: '' }),
    render: (l, ctx) => html`
      ${field('Offcut', html`<select name="remnant_id" required><option value="">— offcut —</option>${ctx.remnants.map((r) => html`<option value="${r.id}" ${String(r.id) === String(l.remnant_id) ? raw('selected') : ''}>${remnantLabel(r)}</option>`)}</select>`, 'w-xl')}
      ${noteField(l)}`,
    payload: (l) => ({ kind: 'remnant_scrap', remnant_id: l.remnant_id, note: l.note }),
  },
  glue_adj: {
    label: 'Glue + / −',
    defaults: () => ({ lot_id: '', qty: '' }),
    render: (l, ctx) => html`
      ${field('Glue lot', html`<select name="lot_id" required>${lotOptions(ctx, l.lot_id)}</select>`, 'w-xl')}
      ${field('Qty (+ / −)', html`<input name="qty" type="number" step="1" value="${l.qty}" required class="w-sm">`)}
      ${noteField(l)}`,
    payload: (l) => ({ kind: 'glue_adj', lot_id: l.lot_id, qty: l.qty, note: l.note }),
  },
};

const MOVE_SPECS = {
  slab_move: {
    label: 'Move slabs',
    defaults: () => ({ slab_id: '', location_id: '', to_location_id: '', qty: '' }),
    render: (l, ctx) => html`
      ${field('Colour', html`<select name="slab_id" required>${slabOptions(ctx, l.slab_id, { showAvail: false })}</select>`, 'w-lg')}
      ${field('From rack', html`<select name="location_id" required>${l.slab_id ? rackOptions(ctx, l.location_id, { slabId: l.slab_id, onlyStocked: true }) : html`<option value="">— colour first —</option>`}</select>`)}
      ${field('To rack', html`<select name="to_location_id" required>${rackOptions(ctx, l.to_location_id)}</select>`)}
      ${field('Pieces', html`<input name="qty" type="number" min="1" step="1" value="${l.qty}" required class="w-sm">`)}
      ${noteField(l)}`,
    onField: (l, name, ctx) => { if (name === 'slab_id') { l.location_id = defaultRack(ctx, l.slab_id); return true; } return false; },
    payload: (l) => ({ kind: 'slab_move', slab_id: l.slab_id, location_id: l.location_id, to_location_id: l.to_location_id, qty: l.qty, note: l.note }),
  },
  remnant_move: {
    label: 'Move offcut',
    defaults: () => ({ remnant_id: '', to_location_id: '' }),
    render: (l, ctx) => html`
      ${field('Offcut', html`<select name="remnant_id" required><option value="">— offcut —</option>${ctx.remnants.map((r) => html`<option value="${r.id}" ${String(r.id) === String(l.remnant_id) ? raw('selected') : ''}>${remnantLabel(r)}</option>`)}</select>`, 'w-xl')}
      ${field('To rack', html`<select name="to_location_id" required>${rackOptions(ctx, l.to_location_id)}</select>`)}
      ${noteField(l)}`,
    payload: (l) => ({ kind: 'remnant_move', remnant_id: l.remnant_id, to_location_id: l.to_location_id, note: l.note }),
  },
};

// =====================================================================================
// Shared form frame
// =====================================================================================
function formFrame({ headerHtml, buttons, submitLabel, extra = '' }) {
  return html`
    <form class="doc-form" id="docForm" novalidate>
      <div class="form-error alert alert-error" hidden></div>
      <section class="card"><div class="form-grid">${headerHtml}</div></section>
      <section class="card">
        <div class="line-buttons">${buttons.map(([kind, label]) => html`<button type="button" class="btn" data-add="${kind}">+ ${label}</button>`)}</div>
        <div id="lines" class="lines"></div>
      </section>
      ${extra}
      <div class="form-footer">
        <div id="summary" class="summary"></div>
        <button type="submit" class="btn btn-primary btn-lg">${submitLabel}</button>
      </div>
    </form>`;
}

async function submitDoc(main, payloadFn, okMsg, afterHash) {
  const f = $('#docForm', main);
  const err = $('.form-error', f);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', f);
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await payloadFn();
      toast(okMsg);
      location.hash = afterHash(res);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
      btn.disabled = false;
    }
  };
}

// read only the header section (line cards have their own "note" etc. fields)
const headerValues = (main) => {
  const out = {};
  $$('.form-grid input, .form-grid select, .form-grid textarea', $('#docForm', main)).forEach((el) => {
    if (!el.name) return;
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; } else out[el.name] = el.value;
  });
  return out;
};

// =====================================================================================
// New delivery
// =====================================================================================
export const newDelivery = {
  title: 'New delivery',
  roles: EDIT_ROLES,
  async render(main, { query }) {
    const ctx = await loadCtx();
    const users = ctx.ref.users;
    set(main, formFrame({
      headerHtml: html`
        ${field('Delivery date', html`<input type="date" name="date" value="${ctx.today}" required>`)}
        ${field(html`<span class="label-row">Customer <button type="button" class="link-btn" id="newCust">+ new customer</button></span>`, html`<select name="customer_id" id="cust" required>${options(ctx.ref.customers.filter((c) => c.active), '', { empty: '— choose customer —', label: (c) => `${c.key_account ? '★ ' : ''}${c.name}` })}</select>`, 'span-2')}
        ${field('Delivered to (site / address)', html`<textarea name="deliver_to" id="deliverTo" rows="2" required placeholder="Where the goods go — site name and address"></textarea>`, 'span-3')}
        ${field('Contact on site', html`<input name="contact" id="contact" placeholder="Name / phone">`)}
        ${field('DO / invoice no.', html`<input name="reference">`)}
        ${field('Sales person', html`<input name="sales_person" list="salesList" value="${state.me.user.role === 'sales' ? state.me.user.name : ''}"><datalist id="salesList">${users.map((u) => html`<option value="${u.name}">`)}</datalist>`)}
        ${field('Note', html`<input name="note">`, 'span-3')}`,
      buttons: [['slab_out', 'Full slabs'], ['slab_cut', 'Cut by m²'], ['remnant_out', 'Whole offcut'], ['glue_out', 'Glue']],
      submitLabel: 'Save delivery',
    }));
    ctx.lineSlabs = () => editor.lines.filter((l) => l.slab_id).map((l) => String(l.slab_id));
    const summary = () => {
      let pcsN = 0; let cut = 0; let total = 0; let glueN = 0;
      for (const l of editor.lines) {
        const s = ctx.slab(l.slab_id);
        if (l.kind === 'slab_out' && s) { pcsN += Number(l.qty) || 0; total += (Number(l.qty) || 0) * s.area; }
        if (l.kind === 'slab_cut') { cut += Number(l.sqm) || 0; total += Number(l.sqm) || 0; }
        if (l.kind === 'remnant_out') { const r = ctx.rem(l.remnant_id); if (r) { cut += r.sqm; total += r.sqm; } }
        if (l.kind === 'glue_out') glueN += Number(l.qty) || 0;
      }
      set($('#summary', main), html`${editor.lines.length} lines · ${pcsN} full slabs · ${n(cut, 2)} m² cut · <strong>${n(total, 2)} m² total</strong> · ${glueN} glue`);
    };
    const editor = lineEditor($('#lines', main), OUT_SPECS, ctx, () => summary());
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    if (query.slab) editor.add('slab_out', { slab_id: query.slab });

    const cust = $('#cust', main);
    let lastAddr = '';
    cust.onchange = () => {
      ctx.header.customer_id = cust.value;
      const c = ctx.ref.customers.find((x) => String(x.id) === cust.value);
      const dt = $('#deliverTo', main);
      if (c && (!dt.value || dt.value === lastAddr)) { dt.value = c.address || ''; lastAddr = dt.value; }
      if (c && !$('#contact', main).value) $('#contact', main).value = [c.contact, c.phone].filter(Boolean).join(' · ');
      editor.lines.forEach((l) => { if ((l.kind === 'slab_out' || l.kind === 'slab_cut') && l.slab_id) autoLock(l, ctx); });
      editor.redrawAll();
    };
    $('#newCust', main).onclick = async () => {
      const id = await customerModal();
      if (id) {
        ctx.ref = await loadRef(true);
        cust.innerHTML = String(options(ctx.ref.customers.filter((c) => c.active), id, { empty: '— choose customer —', label: (c) => `${c.key_account ? '★ ' : ''}${c.name}` }));
        cust.onchange();
      }
    };
    submitDoc(main, async () => {
      const h = headerValues(main);
      if (!editor.lines.length) throw new Error('Add at least one line');
      return api.post('/api/docs', { type: 'outbound', date: h.date, customer_id: h.customer_id, deliver_to: h.deliver_to, contact: h.contact, reference: h.reference, sales_person: h.sales_person, note: h.note, lines: editor.payload() });
    }, 'Delivery saved', (r) => `#/doc/${r.id}`);
  },
};

export async function customerModal(cur = null) {
  const res = await modal({
    title: cur ? `Edit ${cur.name}` : 'New customer',
    body: html`
      <label>Name <input name="name" required value="${cur?.name || ''}"></label>
      <label class="check"><input type="checkbox" name="key_account" ${cur?.key_account ? raw('checked') : ''}> ★ Key account (special customer)</label>
      <div class="row-2"><label>Contact person <input name="contact" value="${cur?.contact || ''}"></label>
      <label>Phone <input name="phone" value="${cur?.phone || ''}"></label></div>
      <label>Default delivery address <textarea name="address" rows="2">${cur?.address || ''}</textarea></label>
      <label>Note <input name="note" value="${cur?.note || ''}"></label>
      ${cur ? html`<label class="check"><input type="checkbox" name="active" ${cur.active ? raw('checked') : ''}> Active</label>` : ''}`,
    onSubmit: async (f) => {
      const v = formData(f);
      if (cur) { await api.patch(`/api/customers/${cur.id}`, v); return cur.id; }
      return (await api.post('/api/customers', v)).id;
    },
  });
  return res;
}

// =====================================================================================
// Receiving (new receipt / incoming shipment), receive expected, edit expected
// =====================================================================================
function receiptHeader(ctx, mode, doc = null) {
  const SH = [{ id: 'ordered', name: 'Ordered' }, { id: 'on_board', name: 'On board' }, { id: 'at_port', name: 'At port' }];
  return html`
    ${mode.fixed ? '' : html`<div class="span-3 seg" role="radiogroup">
      <label class="seg-opt"><input type="radio" name="mode" value="received" ${mode.received ? raw('checked') : ''}> Received now (adds to stock)</label>
      <label class="seg-opt"><input type="radio" name="mode" value="expected" ${mode.received ? '' : raw('checked')}> Incoming — not arrived yet</label>
    </div>`}
    <div class="${mode.received ? '' : 'hidden'}" data-show="received">${field('Received date', html`<input type="date" name="date" value="${ctx.today}">`)}</div>
    <div class="${mode.received ? 'hidden' : ''}" data-show="expected">${field('ETA', html`<input type="date" name="eta" value="${doc?.eta || ''}">`)}</div>
    <div class="${mode.received ? 'hidden' : ''}" data-show="expected">${field('Shipment status', html`<select name="ship_status">${options(SH, doc?.ship_status || 'ordered')}</select>`)}</div>
    ${field('Supplier', html`<input name="partner" value="${doc?.partner || ''}">`)}
    ${field('PO / BL / container no.', html`<input name="reference" value="${doc?.reference || ''}">`)}
    ${field('Note', html`<input name="note" value="${doc?.note || ''}">`, 'span-3')}`;
}

export const newReceipt = {
  title: 'Receive stock',
  roles: EDIT_ROLES,
  async render(main, { query }) {
    const ctx = await loadCtx();
    const mode = { received: query.mode !== 'expected', date: () => $('[name=date]', main)?.value || ctx.today };
    set(main, formFrame({
      headerHtml: receiptHeader(ctx, mode),
      buttons: [['slab_in', 'Slabs'], ['glue_in', 'Glue']],
      submitLabel: mode.received ? 'Save receipt' : 'Save incoming shipment',
    }));
    const summary = () => {
      const pcsN = editor.lines.filter((l) => l.kind === 'slab_in').reduce((a, l) => a + (Number(l.qty) || 0), 0);
      const g = editor.lines.filter((l) => l.kind === 'glue_in').reduce((a, l) => a + (Number(l.qty) || 0), 0);
      set($('#summary', main), html`${pcsN} slabs · ${g} glue`);
    };
    const editor = lineEditor($('#lines', main), inSpecs(mode), ctx, summary);
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    $$('[name=mode]', main).forEach((r) => r.addEventListener('change', () => {
      mode.received = r.value === 'received';
      $$('[data-show]', main).forEach((el) => el.classList.toggle('hidden', el.dataset.show !== r.value));
      $('[type=submit]', main).textContent = mode.received ? 'Save receipt' : 'Save incoming shipment';
      $('#pageTitle').textContent = mode.received ? 'Receive stock' : 'Register incoming shipment';
      editor.redrawAll();
    }));
    if (!mode.received) $('#pageTitle').textContent = 'Register incoming shipment';
    submitDoc(main, async () => {
      const h = headerValues(main);
      if (!editor.lines.length) throw new Error('Add at least one line');
      return api.post('/api/docs', {
        type: 'inbound', status: mode.received ? 'posted' : 'expected', date: mode.received ? h.date : ctx.today, eta: h.eta, ship_status: h.ship_status,
        partner: h.partner, reference: h.reference, note: h.note, lines: editor.payload(),
      });
    }, mode.received ? 'Stock received' : 'Incoming shipment saved', (r) => `#/doc/${r.id}`);
  },
};

export const receiveShipment = {
  title: 'Receive shipment',
  roles: EDIT_ROLES,
  async render(main, { params }) {
    const [ctx, doc] = await Promise.all([loadCtx(), api.get(`/api/docs/${params.id}`)]);
    if (doc.status !== 'expected') { set(main, html`<div class="alert">This shipment was already received. <a href="#/doc/${doc.id}">Open it</a></div>`); return; }
    $('#pageTitle').textContent = `Receive ${doc.doc_no}`;
    const mode = { received: true, fixed: true, date: () => $('[name=date]', main)?.value || ctx.today };
    set(main, formFrame({
      headerHtml: receiptHeader(ctx, mode, doc),
      buttons: [['slab_in', 'Slabs'], ['glue_in', 'Glue']],
      submitLabel: 'Receive into stock',
      extra: html`<section class="card"><label class="check"><input type="checkbox" id="keep" checked> Keep anything not received yet as still incoming (partial delivery)</label>
        <p class="muted small">Check every line against the packing list: adjust quantities, choose the rack and enter the glue lot and expiry.</p></section>`,
    }));
    const editor = lineEditor($('#lines', main), inSpecs(mode), ctx, () => {});
    const offRack = ctx.offcutRack();
    for (const l of doc.lines) {
      if (l.kind === 'slab_in') editor.add('slab_in', { slab_id: String(l.slab_id), qty: String(l.qty), location_id: String(l.location_id || defaultRack(ctx, l.slab_id) || (ctx.activeRacks().find((x) => x !== offRack)?.id ?? '')), note: l.note });
      else {
        const g = ctx.ref.glues.find((x) => x.id === l.glue_id);
        editor.add('glue_in', { glue_id: String(l.glue_id), qty: String(l.qty), lot_no: l.lot_no, expiry: l.expiry || (g ? addMonths(ctx.today, g.shelf_life_months) : ''), note: l.note });
      }
    }
    window.scrollTo(0, 0);
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    submitDoc(main, async () => {
      const h = headerValues(main);
      return api.post(`/api/docs/${doc.id}/receive`, { date: h.date, reference: h.reference, keep_remaining: $('#keep', main).checked, lines: editor.payload() });
    }, 'Shipment received', () => `#/doc/${doc.id}`);
  },
};

export const editShipment = {
  title: 'Edit incoming shipment',
  roles: EDIT_ROLES,
  async render(main, { params }) {
    const [ctx, doc] = await Promise.all([loadCtx(), api.get(`/api/docs/${params.id}`)]);
    if (doc.status !== 'expected') { set(main, html`<div class="alert">Only incoming shipments can be edited.</div>`); return; }
    $('#pageTitle').textContent = `Edit ${doc.doc_no}`;
    const mode = { received: false, fixed: true, date: () => ctx.today };
    set(main, formFrame({ headerHtml: receiptHeader(ctx, mode, doc), buttons: [['slab_in', 'Slabs'], ['glue_in', 'Glue']], submitLabel: 'Save changes' }));
    const editor = lineEditor($('#lines', main), inSpecs(mode), ctx, () => {});
    for (const l of doc.lines) {
      if (l.kind === 'slab_in') editor.add('slab_in', { slab_id: String(l.slab_id), qty: String(l.qty), location_id: String(l.location_id || ''), note: l.note });
      else editor.add('glue_in', { glue_id: String(l.glue_id), qty: String(l.qty), lot_no: l.lot_no, expiry: l.expiry || '', note: l.note });
    }
    window.scrollTo(0, 0);
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    submitDoc(main, async () => {
      const h = headerValues(main);
      return api.patch(`/api/docs/${doc.id}`, { eta: h.eta, ship_status: h.ship_status, partner: h.partner, reference: h.reference, note: h.note, lines: editor.payload() });
    }, 'Shipment updated', () => `#/doc/${doc.id}`);
  },
};

// =====================================================================================
// Adjust / move
// =====================================================================================
const REASONS = ['Stock count correction', 'Damaged / broken', 'Expired glue disposal', 'Customer return', 'Sample / showroom', 'Found', 'Other'];

export const adjust = {
  title: 'Adjust / move stock',
  roles: EDIT_ROLES,
  async render(main, { query }) {
    const ctx = await loadCtx();
    const tab = query.tab === 'move' ? 'move' : 'adjust';
    const isMove = tab === 'move';
    set(main, html`
      <div class="tabs page-tabs">
        <a class="tab ${isMove ? '' : 'on'}" href="#/adjust?tab=adjust">Adjust stock</a>
        <a class="tab ${isMove ? 'on' : ''}" href="#/adjust?tab=move">Move between racks</a>
      </div>
      ${formFrame({
        headerHtml: html`
          ${field('Date', html`<input type="date" name="date" value="${ctx.today}" required>`)}
          ${isMove ? '' : field('Reason', html`<select name="reason" required>${options(REASONS.map((r) => ({ id: r, name: r })), '', { empty: '— reason —' })}</select>`)}
          ${field('Note', html`<input name="note" placeholder="${isMove ? 'e.g. reorganised rack B' : 'Details, e.g. counted on 31 Oct'}">`, isMove ? 'span-2' : '')}`,
        buttons: isMove ? [['slab_move', 'Move slabs'], ['remnant_move', 'Move offcut']]
          : [['slab_adj', 'Slabs + / −'], ['remnant_in', 'Register offcut'], ['remnant_scrap', 'Scrap offcut'], ['glue_adj', 'Glue + / −']],
        submitLabel: isMove ? 'Save move' : 'Save adjustment',
      })}`);
    const editor = lineEditor($('#lines', main), isMove ? MOVE_SPECS : ADJ_SPECS, ctx, () => set($('#summary', main), html`${editor.lines.length} lines`));
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    if (query.add && (isMove ? MOVE_SPECS : ADJ_SPECS)[query.add]) editor.add(query.add);
    submitDoc(main, async () => {
      const h = headerValues(main);
      if (!editor.lines.length) throw new Error('Add at least one line');
      return api.post('/api/docs', { type: isMove ? 'transfer' : 'adjust', date: h.date, reason: h.reason || '', note: h.note, lines: editor.payload() });
    }, 'Saved', (r) => `#/doc/${r.id}`);
  },
};

// =====================================================================================
// Initial stock (opening balance)
// =====================================================================================
export const opening = {
  title: 'Initial stock',
  roles: EDIT_ROLES,
  async render(main) {
    const ctx = await loadCtx();
    const existing = await api.get('/api/docs?type=opening');
    const slabs = ctx.ref.slabs.filter((s) => s.active);
    const rows = slabs.map((s) => ({ key: `${s.id}-0`, slab_id: s.id, location_id: '', qty: '' }));
    const goLive = ctx.ref.settings.go_live_date || ctx.today;
    set(main, html`
      <div class="alert alert-info">
        Enter what is physically in the warehouse on the go-live day: full slabs per rack, offcuts (partial slabs) and glue lots with expiry.
        You can save in several parts (for example one rack at a time) — each save adds to stock.
        ${existing.length ? html`<br><strong>Already entered:</strong> ${existing.map((d, i) => html`${i ? ', ' : ''}<a href="#/doc/${d.id}">${d.doc_no}</a> (${fmtDate(d.date)}, ${n(d.slab_pcs)} slabs${d.status === 'void' ? ', void' : ''})`)}` : ''}
      </div>
      ${slabs.length ? '' : html`<div class="alert alert-error">First add your slab colours (Setup → Slab colours) and rack locations.</div>`}
      <form class="doc-form" id="docForm" novalidate>
        <div class="form-error alert alert-error" hidden></div>
        <section class="card"><div class="form-grid">
          ${field('Stock count date', html`<input type="date" name="date" value="${goLive}" required>`)}
          ${field('Rack for rows without a rack', html`<select id="defRack">${rackOptions(ctx, '', { empty: '— none —' })}</select>`)}
          ${field('Note', html`<input name="note" value="Initial stock count">`)}
        </div></section>
        <section class="card">
          <h2>Full slabs</h2>
          <details class="paste"><summary>Paste from Excel</summary>
            <p class="muted small">Copy three columns from Excel — <strong>colour code</strong>, <strong>pieces</strong>, <strong>rack</strong> (rack is optional) — and paste below.</p>
            <textarea id="pasteBox" rows="5" placeholder="S-008&#9;240&#9;A1&#10;P-004&#9;76&#9;A2"></textarea>
            <button type="button" class="btn btn-sm" id="pasteBtn">Fill the table</button> <span id="pasteMsg" class="small"></span>
          </details>
          <div class="table-wrap"><table class="table compact" id="openTable"></table></div>
        </section>
        <section class="card">
          <h2>Offcuts and glue</h2>
          <div class="line-buttons"><button type="button" class="btn" data-add="remnant_in">+ Offcut</button><button type="button" class="btn" data-add="glue_in">+ Glue lot</button></div>
          <div id="lines" class="lines"></div>
        </section>
        <div class="form-footer"><div id="summary" class="summary"></div><button type="submit" class="btn btn-primary btn-lg">Save initial stock</button></div>
      </form>`);

    const table = $('#openTable', main);
    let editor = null;
    const summary = () => {
      const pcsN = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
      const area = rows.reduce((a, r) => a + (Number(r.qty) || 0) * ctx.slab(r.slab_id).area, 0);
      set($('#summary', main), html`${pcsN} full slabs (${n(area, 1)} m²) · ${editor ? editor.lines.length : 0} offcut / glue lines`);
    };
    const drawTable = () => {
      set(table, html`<thead><tr><th>Colour</th><th>Rack</th><th class="num">Pieces</th><th class="num">m²</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const s = ctx.slab(r.slab_id);
          return html`<tr data-key="${r.key}">
            <td class="nowrap">${swatch(s.color_hex)}<strong>${s.code}</strong> ${s.name}</td>
            <td><select data-f="location_id">${rackOptions(ctx, r.location_id, { empty: '—' })}</select></td>
            <td class="num"><input data-f="qty" type="number" min="0" step="1" value="${r.qty}" class="w-sm"></td>
            <td class="num muted">${r.qty ? n(Number(r.qty) * s.area, 1) : ''}</td>
            <td><button type="button" class="btn btn-xs" data-split="${r.key}" title="Same colour in another rack">+ rack</button></td>
          </tr>`;
        })}</tbody>`);
      summary();
    };
    table.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (!tr || !e.target.dataset.f) return;
      const r = rows.find((x) => x.key === tr.dataset.key);
      r[e.target.dataset.f] = e.target.value;
      if (e.target.dataset.f === 'qty') { const s = ctx.slab(r.slab_id); tr.children[3].textContent = r.qty ? n(Number(r.qty) * s.area, 1) : ''; }
      summary();
    });
    table.addEventListener('click', (e) => {
      const b = e.target.closest('[data-split]');
      if (!b) return;
      const i = rows.findIndex((x) => x.key === b.dataset.split);
      rows.splice(i + 1, 0, { key: `${rows[i].slab_id}-${Date.now()}`, slab_id: rows[i].slab_id, location_id: '', qty: '' });
      drawTable();
    });
    $('#pasteBtn', main).onclick = () => {
      const unknown = [];
      let filled = 0;
      const lines = $('#pasteBox', main).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        const [code, qty, rack] = line.split(/\t|;|,/).map((x) => (x || '').trim());
        const s = slabs.find((x) => x.code.toLowerCase() === code.toLowerCase());
        if (!s || !/^\d+$/.test(qty || '')) { unknown.push(code); continue; }
        const loc = rack ? ctx.activeRacks().find((l) => l.code.toLowerCase() === rack.toLowerCase()) : null;
        if (rack && !loc) { unknown.push(`${code} (rack ${rack}?)`); continue; }
        let r = rows.find((x) => x.slab_id === s.id && !x.qty);
        if (!r) {
          r = { key: `${s.id}-${Date.now()}-${filled}`, slab_id: s.id, location_id: '', qty: '' };
          let last = -1;
          rows.forEach((x, idx) => { if (x.slab_id === s.id) last = idx; });
          rows.splice(last + 1, 0, r);
        }
        r.qty = qty;
        if (loc) r.location_id = String(loc.id);
        filled++;
      }
      drawTable();
      set($('#pasteMsg', main), html`${filled} rows filled.${unknown.length ? html` <span class="text-bad">Not recognised: ${unknown.join(', ')}</span>` : ''}`);
    };
    const mode = { received: true, date: () => $('[name=date]', main).value };
    editor = lineEditor($('#lines', main), { remnant_in: ADJ_SPECS.remnant_in, glue_in: inSpecs(mode).glue_in }, ctx, summary);
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.add)));
    drawTable();
    submitDoc(main, async () => {
      const h = headerValues(main);
      const def = $('#defRack', main).value;
      const slabLines = rows.filter((r) => Number(r.qty) > 0).map((r) => {
        const loc = r.location_id || def;
        if (!loc) throw new Error(`Choose a rack for ${ctx.slab(r.slab_id).code} (or set "Rack for rows without a rack")`);
        return { kind: 'slab_in', slab_id: r.slab_id, location_id: loc, qty: r.qty };
      });
      const lines = [...slabLines, ...editor.payload()];
      if (!lines.length) throw new Error('Enter at least one quantity');
      return api.post('/api/docs', { type: 'opening', date: h.date, note: h.note, lines });
    }, 'Initial stock saved', (r) => `#/doc/${r.id}`);
  },
};
