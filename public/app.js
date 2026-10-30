/* Workshop Inventory — single-page UI. Vanilla JS, no build step. */
(() => {
  'use strict';

  // ---- tiny helpers ---------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtQty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
  const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const ago = (s) => { if (!s) return ''; const d = (Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 1000; if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const state = { meta: null, route: '', params: {} };

  async function api(method, path, body, opts = {}) {
    const headers = {};
    let payload = body;
    if (body !== undefined && !(typeof body === 'string')) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    if (typeof body === 'string') headers['content-type'] = opts.contentType || 'text/plain';
    const res = await fetch('/api' + path, { method, headers, body: payload });
    if (res.status === 401) { showLogin(); throw new Error('Login required'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.data = data; err.status = res.status;
      if (data && data.upgrade) err.upgrade = true;
      throw err;
    }
    return data;
  }

  function toast(msg, kind = 'info', ms = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = esc(msg);
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  const handleErr = (e) => {
    if (e.message === 'Login required') return;
    if (e.upgrade) { toast(e.message, 'warn', 6000); if (confirm(e.message + '\n\nOpen the License settings now?')) location.hash = '#/settings/license'; return; }
    toast(e.message || 'Something went wrong', 'err');
  };

  // ---- modal ----------------------------------------------------------------
  function modal(title, bodyHtml, { size = '', onOpen } = {}) {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(title)}</h2><button class="close" aria-label="Close">×</button></div><div class="modal-body">${bodyHtml}</div></div>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    $('.close', wrap).addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    root.appendChild(wrap);
    const first = $('input:not([type=hidden]), select, textarea', wrap);
    if (first) setTimeout(() => first.focus(), 30);
    if (onOpen) onOpen(wrap, close);
    return { el: wrap, close };
  }

  // ---- shared widgets -------------------------------------------------------
  const cat = (key) => (state.meta.categories.find((c) => c.key === key) || state.meta.categories[state.meta.categories.length - 1]);
  const catOptions = (sel) => state.meta.categories.map((c) => `<option value="${c.key}" ${c.key === sel ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('');

  function attrFieldsHtml(category, attrs = {}) {
    const c = cat(category);
    return c.fields.map((f) => {
      const v = attrs[f.key] ?? '';
      if (f.type === 'select') {
        const listId = `dl-${c.key}-${f.key}`;
        return `<label>${esc(f.label)}<input type="text" name="attr.${f.key}" list="${listId}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"><datalist id="${listId}">${f.options.map((o) => `<option value="${esc(o)}">`).join('')}</datalist></label>`;
      }
      const unit = f.unit ? `<span class="input-unit" data-unit="${esc(f.unit)}">` : '<span>';
      return `<label>${esc(f.label)}${unit}<input type="${f.type === 'number' ? 'text' : 'text'}" inputmode="${f.type === 'number' ? 'decimal' : 'text'}" name="attr.${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"></span></label>`;
    }).join('');
  }

  function locationOptions(locs, selected) {
    const byParent = new Map();
    locs.forEach((l) => { const k = l.parent_id || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(l); });
    const out = ['<option value="">— none —</option>'];
    const walk = (pid, depth) => (byParent.get(pid) || []).forEach((l) => {
      out.push(`<option value="${l.id}" data-rows="${l.rows}" data-cols="${l.cols}" ${l.id == selected ? 'selected' : ''}>${'&nbsp;&nbsp;'.repeat(depth)}${esc(l.name)}${l.rows && l.cols ? ` (${l.rows}×${l.cols})` : ''}</option>`);
      walk(l.id, depth + 1);
    });
    walk(0, 0);
    return out.join('');
  }

  /** Mini grid for picking a cell inside a location. Marks occupied cells. */
  async function renderCellPicker(container, locationId, selRow, selCol, excludeItemId, onPick) {
    container.innerHTML = '';
    if (!locationId) return;
    const loc = await api('GET', `/locations/${locationId}`);
    if (!loc.rows || !loc.cols) { container.innerHTML = '<div class="help">This location has no grid. Set rows × columns on the location to pick a cell.</div>'; return; }
    const used = new Map();
    loc.items.forEach((it) => { if (it.grid_row && it.grid_col && it.id !== excludeItemId) used.set(`${it.grid_row},${it.grid_col}`, it); });
    const grid = document.createElement('div');
    grid.className = 'gf-grid gf-mini';
    grid.style.gridTemplateColumns = `repeat(${loc.cols}, 34px)`;
    grid.style.justifyContent = 'start';
    for (let r = 1; r <= loc.rows; r++) for (let c = 1; c <= loc.cols; c++) {
      const b = document.createElement('button');
      b.type = 'button';
      const occ = used.get(`${r},${c}`);
      b.className = 'gf-cell' + (occ ? ' used' : '') + (r === selRow && c === selCol ? ' sel' : '');
      b.title = occ ? `R${r} C${c}: ${occ.name}` : `R${r} C${c}`;
      b.innerHTML = `<span class="coord">${r},${c}</span>`;
      b.addEventListener('click', () => { $$('.gf-cell.sel', grid).forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); onPick(r, c, occ); });
      grid.appendChild(b);
    }
    container.appendChild(grid);
    const help = document.createElement('div'); help.className = 'help'; help.textContent = 'Click a cell. Filled cells already hold an item (you can still share a cell).';
    container.appendChild(help);
  }

  /** Searchable item picker: renders into `container`, calls onPick(item). */
  function itemPicker(container, onPick, placeholder = 'Search for an item…') {
    container.classList.add('picker');
    container.innerHTML = `<input type="search" placeholder="${esc(placeholder)}" autocomplete="off"><div class="picker-results hidden"></div>`;
    const input = $('input', container); const results = $('.picker-results', container);
    const search = debounce(async () => {
      const q = input.value.trim();
      if (!q) { results.classList.add('hidden'); return; }
      const items = await api('GET', `/items?q=${encodeURIComponent(q)}`);
      results.innerHTML = items.slice(0, 20).map((it) => `<div data-id="${it.id}"><span>${it.category_icon}</span><span>${esc(it.name)}</span><span class="q">${fmtQty(it.quantity)} ${esc(it.unit)}</span></div>`).join('') || '<div class="dim">No matches</div>';
      results.classList.remove('hidden');
      $$('div[data-id]', results).forEach((d) => d.addEventListener('click', () => { const it = items.find((x) => x.id == d.dataset.id); input.value = it.name; results.classList.add('hidden'); onPick(it); }));
    }, 180);
    input.addEventListener('input', search);
    input.addEventListener('focus', () => { if (results.innerHTML && input.value) results.classList.remove('hidden'); });
    document.addEventListener('click', (e) => { if (!container.contains(e.target)) results.classList.add('hidden'); });
    return input;
  }

  const statusPill = (s) => `<span class="status ${s}">${s === 'ok' ? 'OK' : s === 'low' ? 'LOW' : 'OUT'}</span>`;
  const attrTags = (it) => {
    const fields = cat(it.category).fields;
    const vals = fields.filter((f) => it.attributes?.[f.key]).map((f) => it.attributes[f.key] + (f.unit && /^[\d.]+$/.test(it.attributes[f.key]) ? f.unit : ''));
    return vals.length ? `<div class="attr-tags">${vals.slice(0, 6).map((v) => `<span>${esc(v)}</span>`).join('')}</div>` : '';
  };

  // ---- item editor ----------------------------------------------------------
  async function editItem(item, { presetCategory, presetLocation } = {}) {
    const isNew = !item;
    const it = item || { category: presetCategory || 'hardware', attributes: {}, quantity: 0, min_quantity: 0, unit: '', location_id: presetLocation?.location_id || null, grid_row: presetLocation?.grid_row || null, grid_col: presetLocation?.grid_col || null };
    const locs = await api('GET', '/locations');
    const body = `
      <form id="item-form" class="stack">
        <div class="form">
          <label>Category<select name="category">${catOptions(it.category)}</select></label>
          <label class="span-2">Name <span class="dim">(leave blank to auto-generate from the fields below)</span><input type="text" name="name" value="${esc(isNew ? '' : it.name)}" placeholder="${esc(isNew ? 'auto' : it.name)}"></label>
          <label>SKU / part no.<input type="text" name="sku" value="${esc(it.sku || '')}"></label>
        </div>
        <h3>Specification</h3>
        <div class="form" id="attr-fields">${attrFieldsHtml(it.category, it.attributes)}</div>
        <h3>Stock</h3>
        <div class="form">
          ${isNew ? `<label>Quantity in stock<input type="text" inputmode="decimal" name="quantity" value="${fmtQty(it.quantity)}"></label>` : `<label>Quantity <span class="dim">(stock take — use +/− for day-to-day)</span><input type="text" inputmode="decimal" name="quantity" value="${fmtQty(it.quantity)}"></label>`}
          <label>Unit<input type="text" name="unit" value="${esc(it.unit || cat(it.category).defaultUnit)}" list="dl-units"><datalist id="dl-units"><option value="pcs"><option value="g"><option value="m"><option value="ml"><option value="sheets"><option value="rolls"><option value="pairs"><option value="sets"></datalist></label>
          <label>Alert when ≤<input type="text" inputmode="decimal" name="min_quantity" value="${fmtQty(it.min_quantity || 0)}"></label>
          <label>Unit cost<input type="text" inputmode="decimal" name="unit_cost" value="${it.unit_cost ?? ''}" placeholder="optional"></label>
        </div>
        <h3>Location</h3>
        <div class="form">
          <label>Stored in<select name="location_id">${locationOptions(locs, it.location_id)}</select></label>
          <label>Row<input type="number" name="grid_row" min="1" value="${it.grid_row || ''}"></label>
          <label>Column<input type="number" name="grid_col" min="1" value="${it.grid_col || ''}"></label>
          <div class="span-all" id="cell-picker"></div>
        </div>
        <h3>Supplier & notes</h3>
        <div class="form">
          <label>Supplier<input type="text" name="supplier" value="${esc(it.supplier || '')}" placeholder="AliExpress, Amazon, local shop" list="dl-sup"><datalist id="dl-sup"><option value="AliExpress"><option value="Amazon"><option value="eBay"><option value="Accu"><option value="RS"><option value="Farnell"><option value="Screwfix"><option value="E3D"><option value="Bambu Lab"></datalist></label>
          <label class="span-2">Product link<input type="url" name="supplier_url" value="${esc(it.supplier_url || '')}" placeholder="https://"></label>
          <label>Tags<input type="text" name="tags" value="${esc(it.tags || '')}" placeholder="voron, cnc, favourites"></label>
          <label class="span-all">Notes<textarea name="notes">${esc(it.notes || '')}</textarea></label>
        </div>
        <div class="form-actions">
          ${isNew ? '' : '<button type="button" class="btn danger" id="del-item">Delete</button><span class="grow"></span>'}
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">${isNew ? 'Add item' : 'Save changes'}</button>
        </div>
      </form>`;
    return new Promise((resolve) => {
      const m = modal(isNew ? 'Add item' : 'Edit item', body, { size: 'wide', onOpen: (wrap, close) => {
        const form = $('#item-form', wrap);
        const picker = $('#cell-picker', wrap);
        const updatePicker = () => renderCellPicker(picker, Number(form.location_id.value) || null, Number(form.grid_row.value) || null, Number(form.grid_col.value) || null, it.id, (r, c) => { form.grid_row.value = r; form.grid_col.value = c; });
        form.category.addEventListener('change', () => {
          const prev = Object.fromEntries([...form.querySelectorAll('[name^="attr."]')].map((i) => [i.name.slice(5), i.value]));
          $('#attr-fields', wrap).innerHTML = attrFieldsHtml(form.category.value, prev);
          if (!form.unit.value || state.meta.categories.some((c) => c.defaultUnit === form.unit.value)) form.unit.value = cat(form.category.value).defaultUnit;
        });
        form.location_id.addEventListener('change', updatePicker);
        [form.grid_row, form.grid_col].forEach((i) => i.addEventListener('change', updatePicker));
        updatePicker();
        $('[data-close]', wrap).addEventListener('click', () => { close(); resolve(null); });
        $('#del-item', wrap)?.addEventListener('click', async () => {
          if (!confirm(`Delete "${it.name}" and its history?`)) return;
          try { await api('DELETE', `/items/${it.id}`); toast('Item deleted', 'ok'); close(); resolve({ deleted: true }); } catch (e) { handleErr(e); }
        });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const payload = { attributes: {} };
          for (const [k, v] of fd.entries()) { if (k.startsWith('attr.')) payload.attributes[k.slice(5)] = v; else payload[k] = v; }
          try {
            const saved = isNew ? await api('POST', '/items', payload) : await api('PUT', `/items/${it.id}`, payload);
            toast(isNew ? `Added ${saved.name}` : 'Saved', 'ok');
            close(); resolve(saved);
          } catch (err) { handleErr(err); }
        });
      } });
      m.el.addEventListener('remove', () => resolve(null));
    });
  }

  // ---- item detail ----------------------------------------------------------
  async function showItem(id) {
    let it;
    try { it = await api('GET', `/items/${id}`); } catch (e) { return handleErr(e); }
    const c = cat(it.category);
    const spec = c.fields.filter((f) => it.attributes[f.key]).map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(it.attributes[f.key])}${f.unit && /^[\d.]+$/.test(it.attributes[f.key]) ? ' ' + f.unit : ''}</dd>`).join('');
    const body = `
      <div class="stack">
        <div class="row between">
          <div class="row">${statusPill(it.status)}<span class="pill">${c.icon} ${esc(c.label)}</span>${it.sku ? `<span class="mono dim">${esc(it.sku)}</span>` : ''}${it.on_order ? `<span class="pill">📦 ${fmtQty(it.on_order)} on order</span>` : ''}</div>
          <div class="row"><button class="btn sm" id="it-edit">Edit</button><button class="btn sm" id="it-order">Order more</button><button class="btn sm" id="it-locate">Move</button></div>
        </div>
        <div class="grid-2">
          <div class="card">
            <h3>Stock</h3>
            <div class="row" style="margin:8px 0 12px">
              <div class="qty-ctl">
                <button class="btn icon" data-d="-10">−10</button><button class="btn icon" data-d="-1">−1</button>
                <span class="n" id="it-qty">${fmtQty(it.quantity)}</span>
                <button class="btn icon" data-d="1">+1</button><button class="btn icon" data-d="10">+10</button>
              </div>
              <span class="dim">${esc(it.unit)} · alert at ${fmtQty(it.min_quantity)}</span>
            </div>
            <form id="use-form" class="row">
              <input type="text" inputmode="decimal" name="n" placeholder="qty" style="width:80px">
              <input type="text" name="ref" placeholder="what for? (optional)" class="grow">
              <button class="btn sm" name="act" value="use">Use</button>
              <button class="btn sm" name="act" value="add">Add</button>
            </form>
            <dl class="kv" style="margin-top:14px">
              <dt>Location</dt><dd class="loc">${esc(it.location) || '<span class="dim">unassigned</span>'}</dd>
              <dt>Supplier</dt><dd>${it.supplier_url ? `<a href="${esc(it.supplier_url)}" target="_blank" rel="noopener">${esc(it.supplier || it.supplier_url)} ↗</a>` : esc(it.supplier) || '<span class="dim">—</span>'}</dd>
              ${it.unit_cost != null ? `<dt>Unit cost</dt><dd>${esc(state.meta.settings.currency)}${it.unit_cost}</dd>` : ''}
              ${it.tags ? `<dt>Tags</dt><dd>${esc(it.tags)}</dd>` : ''}
              ${it.notes ? `<dt>Notes</dt><dd>${esc(it.notes)}</dd>` : ''}
              ${it.projects.length ? `<dt>Used in</dt><dd>${it.projects.map((p) => `<a href="#/projects/${p.id}">${esc(p.name)}</a> (×${fmtQty(p.quantity)})`).join(', ')}</dd>` : ''}
            </dl>
          </div>
          <div class="card">
            <h3>Specification</h3>
            ${spec ? `<dl class="kv">${spec}</dl>` : '<p class="dim">No specification fields filled in.</p>'}
          </div>
        </div>
        <div class="card">
          <h3>History</h3>
          ${it.movements.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Change</th><th>After</th><th>Reason</th><th>Ref</th></tr></thead><tbody>
            ${it.movements.map((m) => `<tr><td class="dim">${fmtDate(m.created_at)}</td><td class="movement-delta ${m.delta >= 0 ? 'pos' : 'neg'}">${m.delta >= 0 ? '+' : ''}${fmtQty(m.delta)}</td><td class="num">${fmtQty(m.quantity_after)}</td><td>${esc(m.reason)}</td><td class="dim">${esc(m.ref)}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="dim">No movements yet.</p>'}
        </div>
      </div>`;
    modal(it.name, body, { size: 'wide', onOpen: (wrap, close) => {
      const refresh = () => { close(); showItem(id); };
      const adjust = async (delta, reason, ref) => {
        try {
          const r = await api('POST', `/items/${id}/adjust`, { delta, reason, ref });
          $('#it-qty', wrap).textContent = fmtQty(r.item.quantity);
          if (r.alert) toast(r.alert.message, r.alert.kind === 'out' ? 'err' : 'warn', 6000);
          refreshBadge();
        } catch (e) { handleErr(e); }
      };
      $$('[data-d]', wrap).forEach((b) => b.addEventListener('click', () => adjust(Number(b.dataset.d), Number(b.dataset.d) < 0 ? 'consume' : 'receive', '')));
      $('#use-form', wrap).addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target; const n = Number(f.n.value); if (!(n > 0)) return toast('Enter a quantity', 'warn');
        const act = e.submitter?.value || 'use';
        adjust(act === 'use' ? -n : n, act === 'use' ? 'consume' : 'receive', f.ref.value.trim()).then(() => { f.n.value = ''; });
      });
      $('#it-edit', wrap).addEventListener('click', async () => { close(); const r = await editItem(it); if (r && !r.deleted) showItem(id); render(); });
      $('#it-order', wrap).addEventListener('click', () => { close(); orderDialog(it).then(() => showItem(id)); });
      $('#it-locate', wrap).addEventListener('click', () => { close(); locateDialog(it).then(refresh); });
    } });
  }

  async function locateDialog(it) {
    const locs = await api('GET', '/locations');
    return new Promise((resolve) => {
      modal(`Move: ${it.name}`, `<form id="loc-form" class="stack">
        <div class="form"><label>Stored in<select name="location_id">${locationOptions(locs, it.location_id)}</select></label>
        <label>Row<input type="number" name="grid_row" min="1" value="${it.grid_row || ''}"></label><label>Column<input type="number" name="grid_col" min="1" value="${it.grid_col || ''}"></label></div>
        <div id="cell-picker"></div>
        <div class="form-actions"><button type="submit" class="btn primary">Save location</button></div></form>`, { onOpen: (wrap, close) => {
        const form = $('#loc-form', wrap); const picker = $('#cell-picker', wrap);
        const up = () => renderCellPicker(picker, Number(form.location_id.value) || null, Number(form.grid_row.value) || null, Number(form.grid_col.value) || null, it.id, (r, c) => { form.grid_row.value = r; form.grid_col.value = c; });
        form.location_id.addEventListener('change', up); up();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try { await api('POST', `/items/${it.id}/locate`, { location_id: form.location_id.value, grid_row: form.grid_row.value, grid_col: form.grid_col.value, force: true }); toast('Location saved', 'ok'); close(); resolve(true); } catch (err) { handleErr(err); }
        });
      } });
    });
  }

  async function orderDialog(it) {
    return new Promise((resolve) => {
      modal(`Order: ${it.name}`, `<form id="ord-form" class="stack">
        <div class="form"><label>Quantity<input type="text" inputmode="decimal" name="quantity" value="${it.min_quantity ? fmtQty(Math.max(it.min_quantity * 5, 10)) : 10}"></label>
        <label>Supplier<input type="text" name="supplier" value="${esc(it.supplier || '')}" placeholder="AliExpress"></label>
        <label class="span-2">Link<input type="url" name="url" value="${esc(it.supplier_url || '')}" placeholder="https://"></label>
        <label class="span-all">Notes<input type="text" name="notes" placeholder="order no., ETA…"></label></div>
        <p class="help">In stock: ${fmtQty(it.quantity)} ${esc(it.unit)}${it.on_order ? ` · already on order: ${fmtQty(it.on_order)}` : ''}. When it arrives, mark it received under Orders and pick a drawer cell.</p>
        <div class="form-actions"><button type="submit" class="btn primary">Place on order list</button></div></form>`, { onOpen: (wrap, close) => {
        $('#ord-form', wrap).addEventListener('submit', async (e) => {
          e.preventDefault(); const f = e.target;
          try { await api('POST', '/orders', { item_id: it.id, quantity: f.quantity.value, supplier: f.supplier.value, url: f.url.value, notes: f.notes.value }); toast('Added to orders', 'ok'); close(); resolve(true); render(); } catch (err) { handleErr(err); }
        });
      } });
    });
  }

  async function receiveDialog(order) {
    const locs = await api('GET', '/locations');
    const it = order.item;
    return new Promise((resolve) => {
      modal(`Receive: ${it.name}`, `<form id="rcv-form" class="stack">
        <div class="form"><label>Quantity received<input type="text" inputmode="decimal" name="quantity" value="${fmtQty(order.quantity)}"></label>
        <label>Put it in<select name="location_id">${locationOptions(locs, it.location_id)}</select></label>
        <label>Row<input type="number" name="grid_row" min="1" value="${it.grid_row || ''}"></label><label>Column<input type="number" name="grid_col" min="1" value="${it.grid_col || ''}"></label></div>
        <div id="cell-picker"></div>
        <p class="help">Receiving fewer than ordered keeps the remainder on the order list.</p>
        <div class="form-actions"><button type="submit" class="btn primary">Receive into stock</button></div></form>`, { onOpen: (wrap, close) => {
        const form = $('#rcv-form', wrap); const picker = $('#cell-picker', wrap);
        const up = () => renderCellPicker(picker, Number(form.location_id.value) || null, Number(form.grid_row.value) || null, Number(form.grid_col.value) || null, it.id, (r, c) => { form.grid_row.value = r; form.grid_col.value = c; });
        form.location_id.addEventListener('change', up); up();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try { const r = await api('POST', `/orders/${order.id}/receive`, { quantity: form.quantity.value, location_id: form.location_id.value, grid_row: form.grid_row.value, grid_col: form.grid_col.value }); toast(`${r.item.name}: now ${fmtQty(r.item.quantity)} ${r.item.unit}${r.item.location ? ' in ' + r.item.location : ''}`, 'ok', 5000); close(); resolve(true); } catch (err) { handleErr(err); }
        });
      } });
    });
  }

  // ---- views ----------------------------------------------------------------
  const views = {};

  views[''] = async (view) => {
    const d = await api('GET', '/dashboard');
    const lic = state.meta.license;
    view.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><p>${d.counts.items} item${d.counts.items === 1 ? '' : 's'} across ${d.counts.locations} location${d.counts.locations === 1 ? '' : 's'}${d.counts.value ? ` · stock value ≈ ${esc(state.meta.settings.currency)}${Math.round(d.counts.value)}` : ''}</p></div>
        <div class="row"><button class="btn primary" id="add-item">+ Add item</button></div></div>
      ${!lic.licensed && d.counts.items >= (lic.limits.maxItems || 9e9) - 5 ? `<div class="alert-box warn" style="margin-bottom:14px">Free version: ${d.counts.items} of ${lic.limits.maxItems} items used. <a href="#/settings/license">Import a license</a> for unlimited items and notifications.</div>` : ''}
      <div class="tiles">
        <a class="tile" href="#/items"><div class="n">${d.counts.items}</div><div class="l">Items</div></a>
        <a class="tile ${d.counts.low ? 'warn' : ''}" href="#/items?status=low"><div class="n">${d.counts.low}</div><div class="l">Running low</div></a>
        <a class="tile ${d.counts.out ? 'bad' : ''}" href="#/items?status=out"><div class="n">${d.counts.out}</div><div class="l">Out of stock</div></a>
        <a class="tile info" href="#/orders"><div class="n">${d.counts.on_order}</div><div class="l">On order</div></a>
        <a class="tile ${d.counts.open_alerts ? 'warn' : 'ok'}" href="#/alerts"><div class="n">${d.counts.open_alerts}</div><div class="l">Open alerts</div></a>
      </div>
      <div class="grid-2">
        <div class="card"><h2>Needs attention <a class="btn sm ghost" href="#/orders">Shopping list →</a></h2>
          ${d.attention.length ? `<div class="list">${d.attention.map((it) => `<div class="list-item clickable" data-item="${it.id}"><span>${it.category_icon}</span><div class="grow"><div class="title">${esc(it.name)}</div><div class="sub">${fmtQty(it.quantity)} ${esc(it.unit)} left · min ${fmtQty(it.min_quantity)}${it.on_order ? ` · ${fmtQty(it.on_order)} on order` : ''}${it.location ? ` · ${esc(it.location)}` : ''}</div></div>${statusPill(it.status)}${it.on_order ? '' : `<button class="btn sm" data-order="${it.id}">Order</button>`}</div>`).join('')}</div>` : '<div class="empty"><strong>All stocked up</strong>Nothing is at or below its alert level.</div>'}
        </div>
        <div class="card"><h2>Recent activity</h2>
          ${d.recent.length ? `<div class="list">${d.recent.map((m) => `<div class="list-item clickable" data-item="${m.item_id}"><span class="movement-delta ${m.delta >= 0 ? 'pos' : 'neg'}" style="min-width:48px">${m.delta >= 0 ? '+' : ''}${fmtQty(m.delta)}</span><div class="grow"><div class="title">${esc(m.name)}</div><div class="sub">${esc(m.reason)}${m.ref ? ' · ' + esc(m.ref) : ''} · now ${fmtQty(m.quantity_after)} ${esc(m.unit)}</div></div><span class="dim" style="font-size:12px">${ago(m.created_at)}</span></div>`).join('')}</div>` : '<div class="empty"><strong>No activity yet</strong>Add an item to get started.</div>'}
        </div>
      </div>`;
    $('#add-item', view).addEventListener('click', async () => { if (await editItem(null)) render(); });
    $$('[data-item]', view).forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('[data-order]')) return; showItem(Number(el.dataset.item)); }));
    $$('[data-order]', view).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); const it = d.attention.find((x) => x.id == b.dataset.order); await orderDialog(it); }));
    // non-blocking update notice
    api('GET', '/update-check').then((u) => {
      if (!u.update_available || sessionStorage.getItem('wi-hide-update') === u.latest) return;
      const box = document.createElement('div');
      box.className = 'alert-box info row between'; box.style.marginBottom = '14px';
      box.innerHTML = `<span>⬆️ <b>Version ${esc(u.latest)}</b> is available (you have ${esc(u.current)}).</span><span class="row"><a class="btn sm primary" href="#/settings/updates">See what's new & update</a><button class="btn sm ghost">Later</button></span>`;
      $('button', box).addEventListener('click', () => { sessionStorage.setItem('wi-hide-update', u.latest); box.remove(); });
      $('.page-head', view).after(box);
    }).catch(() => {});
  };

  views.items = async (view) => {
    const p = state.params;
    const items = await api('GET', `/items?q=${encodeURIComponent(p.q || '')}&category=${encodeURIComponent(p.category || '')}&status=${encodeURIComponent(p.status || '')}&location_id=${encodeURIComponent(p.location_id || '')}&sort=${encodeURIComponent(p.sort || 'name')}`);
    const setParam = (k, v) => { const np = { ...state.params }; if (v) np[k] = v; else delete np[k]; location.hash = '#/items' + (Object.keys(np).length ? '?' + new URLSearchParams(np) : ''); };
    view.innerHTML = `
      <div class="page-head"><div><h1>Inventory</h1><p>${items.length} item${items.length === 1 ? '' : 's'}${p.q ? ` matching “${esc(p.q)}”` : ''}</p></div>
        <div class="row"><button class="btn" id="export">Export CSV</button><button class="btn primary" id="add-item">+ Add item</button></div></div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search name, spec, SKU, tag, location…" value="${esc(p.q || '')}">
        <select id="status"><option value="">Any status</option><option value="attention" ${p.status === 'attention' ? 'selected' : ''}>Needs attention</option><option value="low" ${p.status === 'low' ? 'selected' : ''}>Running low</option><option value="out" ${p.status === 'out' ? 'selected' : ''}>Out of stock</option><option value="ok" ${p.status === 'ok' ? 'selected' : ''}>In stock</option></select>
        <select id="sort"><option value="name">Sort: name</option><option value="quantity" ${p.sort === 'quantity' ? 'selected' : ''}>Sort: quantity</option><option value="updated" ${p.sort === 'updated' ? 'selected' : ''}>Sort: recently changed</option><option value="created" ${p.sort === 'created' ? 'selected' : ''}>Sort: newest</option><option value="category" ${p.sort === 'category' ? 'selected' : ''}>Sort: category</option></select>
      </div>
      <div class="chips" style="margin-bottom:12px"><button class="chip ${!p.category ? 'active' : ''}" data-cat="">All</button>${state.meta.categories.map((c) => `<button class="chip ${p.category === c.key ? 'active' : ''}" data-cat="${c.key}">${c.icon} ${esc(c.label)}</button>`).join('')}</div>
      ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="hide-m">Spec</th><th class="right">Stock</th><th class="hide-m">Location</th><th></th></tr></thead><tbody>
        ${items.map((it) => `<tr class="clickable" data-id="${it.id}">
          <td><span class="cat-icon">${it.category_icon}</span><span class="item-name">${esc(it.name)}</span>${it.sku ? `<div class="item-sub" style="margin-left:30px">${esc(it.sku)}</div>` : ''}</td>
          <td class="hide-m">${attrTags(it)}</td>
          <td class="right"><div class="qty-ctl" style="justify-content:flex-end"><button class="btn icon" data-adj="-1" title="Use one">−</button><span class="n">${fmtQty(it.quantity)}</span><button class="btn icon" data-adj="1" title="Add one">+</button></div><div class="item-sub">${esc(it.unit)} · min ${fmtQty(it.min_quantity)}${it.on_order ? ` · 📦${fmtQty(it.on_order)}` : ''}</div></td>
          <td class="hide-m loc">${esc(it.location) || '<span class="dim">—</span>'}</td>
          <td class="right">${statusPill(it.status)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card empty"><strong>${p.q || p.category || p.status ? 'Nothing matches' : 'No items yet'}</strong>${p.q || p.category || p.status ? 'Try a broader search or clear the filters.' : 'Add your first screw, end mill or nozzle.'}<div style="margin-top:12px"><button class="btn primary" id="add-item-2">+ Add item</button></div></div>`}`;
    const onAdd = async () => { if (await editItem(null, { presetCategory: p.category })) render(); };
    $('#add-item', view).addEventListener('click', onAdd);
    $('#add-item-2', view)?.addEventListener('click', onAdd);
    $('#export', view).addEventListener('click', async () => {
      if (!state.meta.license.limits.csvImportExport) return handleErr(Object.assign(new Error('CSV export needs a license.'), { upgrade: true }));
      location.href = '/api/export.csv';
    });
    const qEl = $('#q', view);
    qEl.addEventListener('input', debounce(() => setParam('q', qEl.value.trim()), 300));
    $('#status', view).addEventListener('change', (e) => setParam('status', e.target.value));
    $('#sort', view).addEventListener('change', (e) => setParam('sort', e.target.value));
    $$('[data-cat]', view).forEach((b) => b.addEventListener('click', () => setParam('category', b.dataset.cat)));
    $$('tr[data-id]', view).forEach((tr) => {
      tr.addEventListener('click', (e) => { if (e.target.closest('[data-adj]')) return; showItem(Number(tr.dataset.id)); });
      $$('[data-adj]', tr).forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await api('POST', `/items/${tr.dataset.id}/adjust`, { delta: Number(b.dataset.adj) });
          $('.n', tr).textContent = fmtQty(r.item.quantity);
          $('.status', tr).outerHTML = statusPill(r.item.status);
          if (r.alert) toast(r.alert.message, r.alert.kind === 'out' ? 'err' : 'warn', 6000);
          refreshBadge();
        } catch (err) { handleErr(err); }
      }));
    });
  };

  views.locations = async (view) => {
    const locs = await api('GET', '/locations');
    const selId = Number(state.params.id) || (locs[0] && locs[0].id);
    const byParent = new Map();
    locs.forEach((l) => { const k = l.parent_id || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(l); });
    const treeHtml = []; const walk = (pid, d) => (byParent.get(pid) || []).forEach((l) => { treeHtml.push(`<a href="#/locations?id=${l.id}" class="lvl-${Math.min(d, 3)} ${l.id === selId ? 'active' : ''}">${l.kind === 'cabinet' ? '🗄️' : l.kind === 'shelf' ? '📚' : l.kind === 'bin' ? '🧺' : '🗃️'} ${esc(l.name)}<span class="cnt">${l.item_count || ''}</span></a>`); walk(l.id, d + 1); }); walk(0, 0);
    const sel = selId ? await api('GET', `/locations/${selId}`).catch(() => null) : null;

    let detail = '<div class="card empty"><strong>No locations yet</strong>Create a cabinet, then add drawers with a gridfinity grid (e.g. 4 rows × 10 columns).</div>';
    if (sel) {
      const used = new Map(); sel.items.forEach((it) => { if (it.grid_row && it.grid_col) used.set(`${it.grid_row},${it.grid_col}`, [...(used.get(`${it.grid_row},${it.grid_col}`) || []), it]); });
      const loose = sel.items.filter((it) => !it.grid_row || !it.grid_col);
      let gridHtml = '';
      if (sel.rows && sel.cols) {
        const cells = [];
        for (let r = 1; r <= sel.rows; r++) for (let c = 1; c <= sel.cols; c++) {
          const its = used.get(`${r},${c}`);
          if (its) { const it = its[0]; cells.push(`<button class="gf-cell used ${it.status}" data-cell="${r},${c}" data-item="${it.id}" title="R${r} C${c}: ${esc(its.map((x) => x.name).join(' + '))}"><span class="coord">${r},${c}</span>${esc(shortName(it))}${its.length > 1 ? ` +${its.length - 1}` : ''}</button>`); }
          else cells.push(`<button class="gf-cell" data-cell="${r},${c}" title="R${r} C${c} — empty, click to assign"><span class="coord">${r},${c}</span></button>`);
        }
        gridHtml = `<div class="gf-grid" style="grid-template-columns:repeat(${sel.cols},minmax(44px,1fr))">${cells.join('')}</div><div class="gf-legend"><span>Rows run top→bottom, columns left→right.</span><span>Click an empty cell to put an item there.</span></div>`;
      } else if (!sel.children.length) {
        gridHtml = '<div class="help">No grid on this location. Edit it and set rows × columns to see a gridfinity layout.</div>';
      }
      detail = `<div class="card">
        <div class="row between" style="margin-bottom:10px"><div><h2 style="margin:0">${esc(sel.name)}</h2><div class="dim">${esc(sel.path)}${sel.rows && sel.cols ? ` · ${sel.rows} × ${sel.cols} grid` : ''}${sel.notes ? ' · ' + esc(sel.notes) : ''}</div></div>
          <div class="row"><button class="btn sm" id="loc-add-child">+ Sub-location</button><button class="btn sm" id="loc-edit">Edit</button><button class="btn sm danger" id="loc-del">Delete</button></div></div>
        ${sel.children.length ? `<div class="chips" style="margin-bottom:12px">${sel.children.map((c) => `<a class="chip" href="#/locations?id=${c.id}">${esc(c.name)}</a>`).join('')}</div>` : ''}
        ${gridHtml}
        ${loose.length ? `<h3 style="margin-top:16px">${sel.rows && sel.cols ? 'Not in a cell' : 'Items here'}</h3><div class="list">${loose.map((it) => `<div class="list-item clickable" data-item="${it.id}"><span>${it.category_icon}</span><div class="grow"><div class="title">${esc(it.name)}</div></div><span class="mono">${fmtQty(it.quantity)} ${esc(it.unit)}</span>${statusPill(it.status)}</div>`).join('')}</div>` : ''}
        ${!sel.items.length && !sel.children.length ? '<p class="dim" style="margin-top:12px">Nothing stored here yet.</p>' : ''}
      </div>`;
    }
    view.innerHTML = `<div class="page-head"><div><h1>Locations</h1><p>Cabinets, drawers and gridfinity cells.</p></div><div class="row"><button class="btn" id="loc-bulk">+ Drawers in bulk</button><button class="btn primary" id="loc-add">+ Location</button></div></div>
      <div class="split"><div class="card"><div class="loc-tree">${treeHtml.join('') || '<span class="dim">None yet</span>'}</div></div><div>${detail}</div></div>`;

    $('#loc-add', view).addEventListener('click', () => locationDialog(null, locs, null).then((r) => r && render()));
    $('#loc-bulk', view).addEventListener('click', () => bulkDialog(locs, sel).then((r) => r && render()));
    $('#loc-add-child', view)?.addEventListener('click', () => locationDialog(null, locs, sel.id).then((r) => r && render()));
    $('#loc-edit', view)?.addEventListener('click', () => locationDialog(sel, locs, sel.parent_id).then((r) => r && render()));
    $('#loc-del', view)?.addEventListener('click', async () => {
      if (!confirm(`Delete "${sel.name}"${sel.children.length ? ' and its sub-locations' : ''}? Items stay in your inventory but lose their location.`)) return;
      try { await api('DELETE', `/locations/${sel.id}`); toast('Deleted', 'ok'); location.hash = '#/locations'; } catch (e) { handleErr(e); }
    });
    $$('[data-item]', view).forEach((el) => el.addEventListener('click', () => showItem(Number(el.dataset.item))));
    $$('.gf-cell:not(.used)', view).forEach((b) => b.addEventListener('click', () => {
      const [r, c] = b.dataset.cell.split(',').map(Number);
      modal(`Assign item to ${sel.name} R${r} C${c}`, `<div class="stack"><div id="pick"></div><p class="help">Pick an existing item, or <a href="#" id="new-here">create a new item</a> stored in this cell.</p></div>`, { onOpen: (wrap, close) => {
        itemPicker($('#pick', wrap), async (it) => { try { await api('POST', `/items/${it.id}/locate`, { location_id: sel.id, grid_row: r, grid_col: c, force: true }); toast(`${it.name} → ${sel.name} R${r} C${c}`, 'ok'); close(); render(); } catch (e) { handleErr(e); } });
        $('#new-here', wrap).addEventListener('click', async (e) => { e.preventDefault(); close(); if (await editItem(null, { presetLocation: { location_id: sel.id, grid_row: r, grid_col: c } })) render(); });
      } });
    }));
  };
  const shortName = (it) => { const a = it.attributes || {}; if (it.category === 'hardware') return [a.thread, a.length ? a.length + 'mm' : ''].filter(Boolean).join('×') || it.name; if (it.category === 'tooling') return [a.diameter ? a.diameter + 'mm' : '', a.flutes ? a.flutes + 'FL' : ''].filter(Boolean).join(' ') || it.name; if (it.category === 'nozzle') return [a.diameter ? a.diameter + 'mm' : '', a.material?.split(' ')[0]].filter(Boolean).join(' ') || it.name; return it.name.length > 22 ? it.name.slice(0, 20) + '…' : it.name; };

  function locationDialog(loc, locs, parentId) {
    return new Promise((resolve) => {
      modal(loc ? 'Edit location' : 'New location', `<form id="loc-form" class="stack"><div class="form">
        <label class="span-2">Name<input type="text" name="name" value="${esc(loc?.name || '')}" placeholder="Drawer 1, Shelf B, Bins" required></label>
        <label>Type<select name="kind">${['cabinet', 'drawer', 'shelf', 'bin', 'other'].map((k) => `<option ${((loc && loc.kind) || 'drawer') === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="span-2">Inside<select name="parent_id">${locationOptions(locs.filter((l) => !loc || l.id !== loc.id), parentId)}</select></label>
        <label>Grid rows<input type="number" name="rows" min="0" value="${loc?.rows ?? 0}"></label><label>Grid columns<input type="number" name="cols" min="0" value="${loc?.cols ?? 0}"></label>
        <label class="span-all">Notes<input type="text" name="notes" value="${esc(loc?.notes || '')}" placeholder="42mm gridfinity, 1×1 bins"></label></div>
        <p class="help">Rows × columns describes the gridfinity baseplate (or any grid) so you can assign items to cells like R3 C9. Leave 0 for a plain shelf.</p>
        <div class="form-actions"><button type="submit" class="btn primary">${loc ? 'Save' : 'Create'}</button></div></form>`, { onOpen: (wrap, close) => {
        $('#loc-form', wrap).addEventListener('submit', async (e) => {
          e.preventDefault(); const f = e.target; const body = Object.fromEntries(new FormData(f).entries());
          try { const r = loc ? await api('PUT', `/locations/${loc.id}`, body) : await api('POST', '/locations', body); toast('Saved', 'ok'); close(); if (!loc) location.hash = `#/locations?id=${r.id}`; resolve(true); } catch (err) { handleErr(err); }
        });
      } });
    });
  }
  function bulkDialog(locs, sel) {
    return new Promise((resolve) => {
      modal('Add drawers in bulk', `<form id="bulk-form" class="stack"><div class="form">
        <label class="span-2">Inside<select name="parent_id">${locationOptions(locs, sel?.id)}</select></label>
        <label>Name prefix<input type="text" name="name" value="Drawer"></label><label>How many<input type="number" name="count" min="1" max="100" value="6"></label>
        <label>Grid rows each<input type="number" name="rows" min="0" value="4"></label><label>Grid columns each<input type="number" name="cols" min="0" value="10"></label></div>
        <p class="help">Creates “Drawer 1” … “Drawer N”, each with the same grid.</p>
        <div class="form-actions"><button type="submit" class="btn primary">Create</button></div></form>`, { onOpen: (wrap, close) => {
        $('#bulk-form', wrap).addEventListener('submit', async (e) => {
          e.preventDefault(); const body = Object.fromEntries(new FormData(e.target).entries());
          try { const r = await api('POST', '/locations/bulk', body); toast(`Created ${r.created.length} locations`, 'ok'); close(); resolve(true); } catch (err) { handleErr(err); }
        });
      } });
    });
  }

  views.projects = async (view) => {
    const projects = await api('GET', '/projects');
    const selId = Number(state.params.id) || (projects[0] && projects[0].id);
    const sel = projects.find((p) => p.id === selId);
    view.innerHTML = `<div class="page-head"><div><h1>Projects</h1><p>Bills of materials. Building a project takes every part out of stock in one go.</p></div><button class="btn primary" id="proj-add">+ Project</button></div>
      <div class="split">
        <div class="card"><div class="loc-tree">${projects.map((p) => `<a href="#/projects?id=${p.id}" class="${p.id === selId ? 'active' : ''}">🛠️ ${esc(p.name)}<span class="cnt">${p.buildable ? `×${p.buildable}` : p.parts.length ? '⚠' : ''}</span></a>`).join('') || '<span class="dim">No projects yet</span>'}</div></div>
        <div>${sel ? `<div class="card">
          <div class="row between" style="margin-bottom:10px"><div><h2 style="margin:0">${esc(sel.name)}</h2><div class="dim">${sel.parts.length} part${sel.parts.length === 1 ? '' : 's'} · built ${sel.builds} time${sel.builds === 1 ? '' : 's'} · ${sel.parts.length ? (sel.buildable ? `enough stock for <b>${sel.buildable}</b> more` : '<span class="status out">short on parts</span>') : 'add parts below'}${sel.notes ? ' · ' + esc(sel.notes) : ''}</div></div>
            <div class="row"><button class="btn sm" id="proj-edit">Edit</button><button class="btn sm danger" id="proj-del">Delete</button></div></div>
          ${sel.parts.length ? `<div class="table-wrap"><table><thead><tr><th>Part</th><th class="right">Per build</th><th class="right">In stock</th><th class="hide-m">Location</th><th></th></tr></thead><tbody>
            ${sel.parts.map((pt) => `<tr class="clickable" data-item="${pt.item.id}"><td><span class="cat-icon">${pt.item.category_icon}</span><span class="item-name">${esc(pt.item.name)}</span></td><td class="num">${fmtQty(pt.needed)}</td><td class="num ${pt.short ? 'status out' : ''}">${fmtQty(pt.item.quantity)} ${esc(pt.item.unit)}</td><td class="hide-m loc">${esc(pt.item.location) || '—'}</td><td class="right"><button class="btn sm ghost" data-rm="${pt.line_id}" title="Remove from BOM">✕</button></td></tr>`).join('')}
          </tbody></table></div>` : ''}
          <div class="row" style="margin-top:14px; align-items:flex-end"><div class="grow"><label>Add a part<div id="pick"></div></label></div><label style="width:90px">Qty per build<input type="text" inputmode="decimal" id="pick-qty" value="1"></label></div>
          <div class="row between" style="margin-top:18px; padding-top:14px; border-top:1px solid var(--line)"><div class="row"><label style="width:80px">Build<input type="number" id="build-n" min="1" value="1"></label><button class="btn primary" id="build" ${sel.parts.length ? '' : 'disabled'} style="margin-top:18px">🛠️ Build & deduct stock</button></div><span class="help">Deducts every part × count and records it against “${esc(sel.name)}”.</span></div>
        </div>` : '<div class="card empty"><strong>No project selected</strong>Create a project and add the parts it uses.</div>'}</div></div>`;
    $('#proj-add', view).addEventListener('click', () => {
      modal('New project', `<form id="pf" class="stack"><label>Name<input type="text" name="name" placeholder="Spool holder v2" required></label><label>Notes<input type="text" name="notes"></label><div class="form-actions"><button class="btn primary">Create</button></div></form>`, { onOpen: (wrap, close) => $('#pf', wrap).addEventListener('submit', async (e) => { e.preventDefault(); try { const r = await api('POST', '/projects', Object.fromEntries(new FormData(e.target).entries())); close(); location.hash = `#/projects?id=${r.id}`; } catch (err) { handleErr(err); } }) });
    });
    if (!sel) return;
    $('#proj-edit', view).addEventListener('click', () => {
      modal('Edit project', `<form id="pf" class="stack"><label>Name<input type="text" name="name" value="${esc(sel.name)}" required></label><label>Notes<input type="text" name="notes" value="${esc(sel.notes)}"></label><div class="form-actions"><button class="btn primary">Save</button></div></form>`, { onOpen: (wrap, close) => $('#pf', wrap).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('PUT', `/projects/${sel.id}`, Object.fromEntries(new FormData(e.target).entries())); close(); render(); } catch (err) { handleErr(err); } }) });
    });
    $('#proj-del', view).addEventListener('click', async () => { if (!confirm(`Delete project "${sel.name}"? Stock is not affected.`)) return; try { await api('DELETE', `/projects/${sel.id}`); location.hash = '#/projects'; } catch (e) { handleErr(e); } });
    $$('tr[data-item]', view).forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) return; showItem(Number(tr.dataset.item)); }));
    $$('[data-rm]', view).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); try { await api('DELETE', `/projects/${sel.id}/parts/${b.dataset.rm}`); render(); } catch (err) { handleErr(err); } }));
    itemPicker($('#pick', view), async (it) => { try { await api('POST', `/projects/${sel.id}/parts`, { item_id: it.id, quantity: $('#pick-qty', view).value || 1 }); toast(`Added ${it.name}`, 'ok'); render(); } catch (e) { handleErr(e); } }, 'Search parts to add…');
    $('#build', view).addEventListener('click', async () => {
      const count = Number($('#build-n', view).value) || 1;
      try {
        const r = await api('POST', `/projects/${sel.id}/build`, { count });
        toast(`Built ${sel.name} ×${count}. Stock updated.`, 'ok');
        r.alerts.forEach((a) => toast(a.message, a.kind === 'out' ? 'err' : 'warn', 7000));
        render(); refreshBadge();
      } catch (e) {
        if (e.status === 409 && e.data?.shortages) {
          const list = e.data.shortages.map((s) => `• ${s.item}: have ${fmtQty(s.have)}, need ${fmtQty(s.need)}`).join('\n');
          if (confirm(`Not enough stock:\n${list}\n\nBuild anyway and let those go to zero?`)) {
            try { const r = await api('POST', `/projects/${sel.id}/build`, { count, allow_negative: true }); r.alerts.forEach((a) => toast(a.message, 'warn', 7000)); render(); refreshBadge(); } catch (e2) { handleErr(e2); }
          }
        } else handleErr(e);
      }
    });
  };

  views.orders = async (view) => {
    const showAll = state.params.history === '1';
    const [open, suggest, history] = await Promise.all([api('GET', '/orders?status=ordered'), api('GET', '/orders/suggest'), showAll ? api('GET', '/orders?status=all') : Promise.resolve([])]);
    view.innerHTML = `<div class="page-head"><div><h1>Orders</h1><p>What's on its way, and what you should order next.</p></div><div class="row"><a class="btn" href="#/orders${showAll ? '' : '?history=1'}">${showAll ? 'Hide history' : 'Show history'}</a></div></div>
      <div class="grid-2">
        <div class="card"><h2>On order <span class="pill">${open.length}</span></h2>
          ${open.length ? `<div class="list">${open.map((o) => `<div class="list-item"><span>${o.item.category_icon}</span><div class="grow"><div class="title">${esc(o.item.name)}</div><div class="sub">${fmtQty(o.quantity)} ${esc(o.item.unit)}${o.supplier ? ' from ' + (o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.supplier)} ↗</a>` : esc(o.supplier)) : ''} · ordered ${ago(o.ordered_at)}${o.notes ? ' · ' + esc(o.notes) : ''}</div></div><button class="btn sm primary" data-rcv="${o.id}">Received</button><button class="btn sm ghost" data-cancel="${o.id}" title="Cancel order">✕</button></div>`).join('')}</div>` : '<div class="empty"><strong>Nothing on order</strong></div>'}
        </div>
        <div class="card"><h2>Shopping list <span class="pill">${suggest.length}</span></h2>
          <p class="help" style="margin-bottom:10px">Items at or below their alert level with nothing on order.</p>
          ${suggest.length ? `<div class="list">${suggest.map((it) => `<div class="list-item clickable" data-item="${it.id}"><span>${it.category_icon}</span><div class="grow"><div class="title">${esc(it.name)}</div><div class="sub">${fmtQty(it.quantity)} ${esc(it.unit)} left · min ${fmtQty(it.min_quantity)}${it.supplier ? ' · ' + esc(it.supplier) : ''}</div></div>${statusPill(it.status)}<button class="btn sm" data-order="${it.id}">Order</button></div>`).join('')}</div>` : '<div class="empty"><strong>All good</strong>Nothing needs ordering.</div>'}
        </div>
      </div>
      ${showAll ? `<div class="card"><h2>History</h2><div class="table-wrap"><table><thead><tr><th>Item</th><th class="right">Qty</th><th>Supplier</th><th>Status</th><th>Ordered</th><th>Received</th></tr></thead><tbody>${history.map((o) => `<tr><td>${esc(o.item?.name || '(deleted)')}</td><td class="num">${fmtQty(o.quantity)}</td><td>${esc(o.supplier)}</td><td><span class="pill">${o.status}</span></td><td class="dim">${fmtDate(o.ordered_at)}</td><td class="dim">${fmtDate(o.received_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">No orders yet</td></tr>'}</tbody></table></div></div>` : ''}`;
    $$('[data-rcv]', view).forEach((b) => b.addEventListener('click', async () => { const o = open.find((x) => x.id == b.dataset.rcv); if (await receiveDialog(o)) render(); }));
    $$('[data-cancel]', view).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Cancel this order?')) return; try { await api('POST', `/orders/${b.dataset.cancel}/cancel`); render(); } catch (e) { handleErr(e); } }));
    $$('[data-order]', view).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); const it = suggest.find((x) => x.id == b.dataset.order); if (await orderDialog(it)) render(); }));
    $$('[data-item]', view).forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('button')) return; showItem(Number(el.dataset.item)); }));
  };

  views.alerts = async (view) => {
    const all = state.params.all === '1';
    const alerts = await api('GET', `/alerts${all ? '?all=1' : ''}`);
    const channels = state.meta.license.licensed ? await api('GET', '/channels').catch(() => []) : [];
    view.innerHTML = `<div class="page-head"><div><h1>Alerts</h1><p>Fired when an item drops to its alert level or runs out.${channels.length ? ` Also sent to ${channels.filter((c) => c.enabled).length} notification channel${channels.filter((c) => c.enabled).length === 1 ? '' : 's'}.` : ` <a href="#/settings/notifications">Set up email, Discord or webhooks →</a>`}</p></div>
      <div class="row"><a class="btn" href="#/alerts${all ? '' : '?all=1'}">${all ? 'Open only' : 'Show history'}</a>${channels.length ? '<button class="btn" id="digest">Send digest now</button>' : ''}${alerts.some((a) => !a.acknowledged) ? '<button class="btn primary" id="ack-all">Acknowledge all</button>' : ''}</div></div>
      ${alerts.length ? `<div class="list">${alerts.map((a) => `<div class="list-item clickable ${a.acknowledged ? 'dim' : ''}" data-item="${a.item_id}"><span>${a.kind === 'out' ? '🚫' : '⚠️'}</span><div class="grow"><div class="title">${esc(a.message)}</div><div class="sub">${fmtDate(a.created_at)} · now ${fmtQty(a.current_quantity)} ${esc(a.unit)}</div></div>${a.acknowledged ? '<span class="pill">seen</span>' : `<button class="btn sm" data-ack="${a.id}">OK</button>`}</div>`).join('')}</div>` : '<div class="card empty"><strong>No alerts</strong>Nothing has dropped below its alert level.</div>'}`;
    $$('[data-ack]', view).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); await api('POST', `/alerts/${b.dataset.ack}/ack`); render(); refreshBadge(); }));
    $('#ack-all', view)?.addEventListener('click', async () => { await api('POST', '/alerts/ack-all'); render(); refreshBadge(); });
    $('#digest', view)?.addEventListener('click', async () => { try { const r = await api('POST', '/alerts/digest'); toast(r.sent ? `Digest sent (${r.count} items)` : r.reason, r.sent ? 'ok' : 'info'); } catch (e) { handleErr(e); } });
    $$('[data-item]', view).forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('button')) return; showItem(Number(el.dataset.item)); }));
  };

  views.settings = async (view) => {
    const tab = state.params.tab || 'license';
    const lic = await api('GET', '/license');
    state.meta.license = lic; paintTier();
    const tabs = [['license', 'License'], ['notifications', 'Notifications'], ['security', 'Security'], ['data', 'Data'], ['general', 'General'], ['updates', 'Updates'], ['about', 'About']];
    view.innerHTML = `<div class="page-head"><div><h1>Settings</h1></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tab"></div>`;
    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => { location.hash = `#/settings/${b.dataset.tab}`; }));
    const pane = $('#tab', view);

    if (tab === 'license') {
      const lim = lic.limits;
      pane.innerHTML = `<div class="grid-2">
        <div class="card"><h2>Status</h2>
          ${lic.licensed ? `<div class="alert-box ok"><b>Pro license active</b><br>Licensed to ${esc(lic.licensee)}${lic.email ? ` &lt;${esc(lic.email)}&gt;` : ''}<br>${lic.expires_at ? `Expires ${lic.expires_at.slice(0, 10)} (${lic.days_left} days)` : 'Perpetual — never expires'}<br><span class="mono dim">${esc(lic.license_id)}</span></div>`
            : `<div class="alert-box ${lic.licensee ? 'bad' : 'info'}"><b>Free version</b><br>${esc(lic.reason)}${lic.licensee ? `<br><span class="dim">Stored license for ${esc(lic.licensee)}</span>` : ''}</div>
               <dl class="kv" style="margin-top:12px"><dt>Items</dt><dd>up to ${lim.maxItems}</dd><dt>Projects</dt><dd>up to ${lim.maxProjects}</dd><dt>Notifications</dt><dd>dashboard only</dd><dt>CSV import/export</dt><dd>—</dd></dl>`}
          <dl class="kv" style="margin-top:14px"><dt>Install ID</dt><dd class="mono" id="install-id">${esc(lic.install_id)} <button class="btn sm ghost" id="copy-id">copy</button></dd></dl>
          <p class="help">Your vendor may ask for the Install ID to issue a license bound to this installation.</p>
          ${lic.licensee ? '<button class="btn danger sm" id="lic-remove" style="margin-top:8px">Remove license</button>' : ''}
        </div>
        <div class="card"><h2>Import a license</h2>
          <p class="help">You'll have received a <code>.license.json</code> file by email. Choose it here, or paste its contents.</p>
          ${lic.public_key_present ? '' : '<div class="alert-box bad">This build has no public key, so licenses can\'t be verified. The vendor needs to include <code>keys/public.pem</code>.</div>'}
          <div class="stack" style="margin-top:10px"><input type="file" id="lic-file" accept=".json,application/json"><textarea id="lic-text" placeholder='{"format":"workshop-inventory-license/1", …}' style="min-height:110px; font-family:var(--mono); font-size:12px"></textarea><div class="form-actions"><button class="btn primary" id="lic-import">Import license</button></div></div>
        </div></div>`;
      $('#copy-id', pane).addEventListener('click', () => navigator.clipboard?.writeText(lic.install_id).then(() => toast('Copied', 'ok')));
      $('#lic-file', pane).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) f.text().then((t) => { $('#lic-text', pane).value = t; }); });
      $('#lic-import', pane).addEventListener('click', async () => {
        const t = $('#lic-text', pane).value.trim(); if (!t) return toast('Choose or paste a license file first', 'warn');
        try { const r = await api('POST', '/license', { license: t }); toast(`License activated for ${r.licensee}`, 'ok', 5000); await loadMeta(); render(); } catch (e) { handleErr(e); }
      });
      $('#lic-remove', pane)?.addEventListener('click', async () => { if (!confirm('Remove the license from this installation?')) return; await api('DELETE', '/license'); await loadMeta(); render(); });
    }

    if (tab === 'notifications') {
      let channels = [];
      try { channels = await api('GET', '/channels'); } catch (e) { /* free tier can still read */ }
      const typeLabel = (t) => state.meta.channel_types.find((x) => x.type === t)?.label || t;
      pane.innerHTML = `<div class="card"><h2>Notification channels <button class="btn primary sm" id="ch-add">+ Add channel</button></h2>
        <p class="help">Every enabled channel receives low-stock and out-of-stock alerts. ${lic.licensed ? '' : '<b>Channels need a Pro license.</b>'}</p>
        ${channels.length ? `<div class="list" style="margin-top:10px">${channels.map((c) => `<div class="list-item"><span>${{ smtp: '✉️', discord: '💬', slack: '💼', ntfy: '📱', webhook: '🔗' }[c.type] || '🔔'}</span><div class="grow"><div class="title">${esc(c.name)} <span class="pill">${esc(typeLabel(c.type))}</span>${c.enabled ? '' : ' <span class="pill">disabled</span>'}</div><div class="sub">${esc(c.config.to || c.config.topic || c.config.webhook_url || c.config.url || '')}${c.last_error ? `<br><span style="color:var(--bad)">Last error: ${esc(c.last_error)}</span>` : ''}</div></div><button class="btn sm" data-test="${c.id}">Test</button><button class="btn sm" data-edit="${c.id}">Edit</button><button class="btn sm ghost" data-del="${c.id}">✕</button></div>`).join('')}</div>` : '<div class="empty" style="padding:20px"><strong>No channels yet</strong>Add email, Discord, Slack, ntfy or a custom webhook.</div>'}
      </div>`;
      $('#ch-add', pane).addEventListener('click', () => channelDialog(null).then((r) => r && render()));
      $$('[data-edit]', pane).forEach((b) => b.addEventListener('click', () => channelDialog(channels.find((c) => c.id == b.dataset.edit)).then((r) => r && render())));
      $$('[data-del]', pane).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this channel?')) return; await api('DELETE', `/channels/${b.dataset.del}`); render(); }));
      $$('[data-test]', pane).forEach((b) => b.addEventListener('click', async () => { b.disabled = true; b.textContent = 'Sending…'; try { await api('POST', `/channels/${b.dataset.test}/test`); toast('Test notification sent ✓', 'ok'); } catch (e) { toast('Test failed: ' + e.message, 'err', 7000); } b.disabled = false; b.textContent = 'Test'; render(); }));
    }

    if (tab === 'security') {
      pane.innerHTML = `<div class="card" style="max-width:480px"><h2>UI password</h2>
        <p class="help">${state.meta.auth.password_set ? 'A password is required to open this app.' : 'No password set — anyone on your network who can reach this address can use the app. Fine for a home LAN; set one if you expose it further.'}</p>
        <form id="pw-form" class="stack" style="margin-top:10px">${state.meta.auth.password_set ? '<label>Current password<input type="password" name="current"></label>' : ''}<label>New password <span class="dim">(blank to remove)</span><input type="password" name="password"></label><div class="form-actions">${state.meta.auth.password_set ? '<button type="button" class="btn" id="logout">Sign out</button>' : ''}<button class="btn primary">Save</button></div></form></div>`;
      $('#pw-form', pane).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/auth/password', Object.fromEntries(new FormData(e.target).entries())); toast('Password updated', 'ok'); await loadMeta(); render(); } catch (err) { handleErr(err); } });
      $('#logout', pane)?.addEventListener('click', async () => { await api('POST', '/auth/logout'); location.reload(); });
    }

    if (tab === 'data') {
      pane.innerHTML = `<div class="grid-2"><div class="card"><h2>Export</h2><p class="help">Download the whole inventory as CSV (opens in Excel / Sheets). Includes location paths and the spec fields as JSON.</p><a class="btn" href="/api/export.csv" id="exp">Download inventory.csv</a></div>
        <div class="card"><h2>Import</h2><p class="help">CSV with columns <code>name, category, sku, quantity, unit, min_quantity, location, supplier, supplier_url, unit_cost, tags, notes</code>. Extra columns become spec fields (e.g. <code>thread</code>, <code>length</code>, <code>flutes</code>, <code>diameter</code>). A <code>location</code> like <code>Cabinet A › Drawer 1 › R3 C9</code> is created if missing. Rows with an existing <code>id</code> are updated.</p><input type="file" id="imp-file" accept=".csv,text/csv"><div class="form-actions"><button class="btn primary" id="imp">Import</button></div><pre class="code" style="margin-top:10px">name,category,quantity,min_quantity,location,thread,length,kind
,hardware,50,10,Cabinet A › Drawer 1 › R3 C9,M3,12,Socket Head Cap Screw
,tooling,4,2,Cabinet A › Drawer 2 › R1 C1,,,
0.4mm Brass Nozzle (V6),nozzle,5,2,Printer shelf,,,</pre></div></div>
        <div class="card"><h2>Backup</h2><p class="help">Everything lives in one SQLite file in the <code>data/</code> folder next to the app (<code>inventory.db</code>). Copy that folder to back up; restore by copying it back while the app is stopped.</p></div>`;
      if (!lic.limits.csvImportExport) { $('#exp', pane).addEventListener('click', (e) => { e.preventDefault(); handleErr(Object.assign(new Error('CSV export needs a license.'), { upgrade: true })); }); }
      $('#imp', pane).addEventListener('click', async () => {
        const f = $('#imp-file', pane).files[0]; if (!f) return toast('Choose a CSV file', 'warn');
        try { const r = await api('POST', '/import.csv', await f.text(), { contentType: 'text/csv' }); toast(`Imported: ${r.created} created, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length ? 'warn' : 'ok', 6000); if (r.errors.length) console.warn(r.errors); } catch (e) { handleErr(e); }
      });
    }

    if (tab === 'general') {
      pane.innerHTML = `<div class="card" style="max-width:480px"><h2>General</h2><form id="gen-form" class="stack"><label>Workshop name<input type="text" name="site_name" value="${esc(state.meta.settings.site_name)}"></label><label>Currency symbol<input type="text" name="currency" value="${esc(state.meta.settings.currency)}" style="width:80px"></label><label class="check"><input type="checkbox" name="update_check" ${state.meta.settings.update_check ? 'checked' : ''}> Check GitHub for new versions (once a day, anonymous)</label><div class="form-actions"><button class="btn primary">Save</button></div></form></div>
        <div class="card"><h2>Categories & spec fields</h2><p class="help">Built in. To add or change categories, edit <code>src/categories.ts</code> and rebuild.</p><div class="stack" style="margin-top:10px">${state.meta.categories.map((c) => `<div><b>${c.icon} ${esc(c.label)}</b> <span class="dim">(${esc(c.defaultUnit)})</span><div class="attr-tags">${c.fields.map((f) => `<span>${esc(f.label)}${f.unit ? ' ' + f.unit : ''}</span>`).join('')}</div></div>`).join('')}</div></div>`;
      $('#gen-form', pane).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('PUT', '/settings', { ...Object.fromEntries(new FormData(e.target).entries()), update_check: e.target.update_check.checked }); toast('Saved', 'ok'); await loadMeta(); render(); } catch (err) { handleErr(err); } });
    }

    if (tab === 'about') {
      pane.innerHTML = `<div class="card" style="max-width:640px"><h2>Workshop Inventory ${esc(state.meta.version)}</h2><p>Self-hosted stock control for makers: fasteners, cutting tools, 3D-printer nozzles, filament, electronics and consumables, with gridfinity-aware locations, project BOMs and low-stock alerts.</p>
        <h3 style="margin-top:14px">Quick workflow</h3><ol style="margin:0; padding-left:18px; color:var(--text-2)"><li>Search for a part. None in stock? Click <b>Order</b>.</li><li>When it arrives, mark it <b>Received</b> and pick the drawer cell it lives in.</li><li>Build a project, or hit <b>−</b> when you take some — stock goes down.</li><li>At the alert level you get a notification wherever you've set up.</li></ol>
        <h3 style="margin-top:14px">API</h3><p class="help">Everything the UI does is a JSON call under <code>/api/…</code> — handy for scripts, Home Assistant or a barcode scanner. e.g. <code>POST /api/items/12/adjust {"delta":-3,"reason":"consume","ref":"Spool holder"}</code>.</p>
        <h3 style="margin-top:14px">Updates</h3><p class="help">See <a href="#/settings/updates">Settings → Updates</a> to check for and install new versions.</p></div>`;
    }

    if (tab === 'updates') {
      pane.innerHTML = '<div class="card" style="max-width:720px" id="upd-card"><h2>Updates</h2><div class="help">Checking GitHub…</div></div>';
      renderUpdates($('#upd-card', pane));
    }
  };

  /** Tiny Markdown → HTML for GitHub release notes (headings, lists, bold, code, links). */
  function mdToHtml(md) {
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url.replace(/^https?:\/\/(www\.)?/, '').replace(/^github\.com\/[^/]+\/[^/]+\/(pull|issues)\//, '#')}</a>`);
    const out = []; let list = null;
    const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
    for (const raw of md.replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,6})\s+(.*)/); const li = line.match(/^\s*[-*+]\s+(.*)/);
      if (h) { flush(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (li) { (list = list || []).push(`<li>${inline(li[1])}</li>`); }
      else if (!line.trim()) { flush(); }
      else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join('');
  }

  const fmtIso = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

  async function renderUpdates(card, force = true) {
    let u, st;
    try { [u, st] = await Promise.all([api('GET', `/update-check${force ? '?force=1' : ''}`), api('GET', '/update-status')]); }
    catch (e) { card.innerHTML = `<h2>Updates</h2><div class="alert-box bad">${esc(e.message)}</div>`; return; }

    const busy = st.state === 'requested' || st.state === 'running';
    const modeHelp = {
      service: '',
      docker: `<p class="help">This copy runs in Docker, so update it from the host:</p><pre class="code">docker compose pull && docker compose up -d</pre>`,
      manual: `<p class="help">This copy was installed from the zip. Download the new version, unzip it over this folder (your <code>data</code> folder is untouched) and restart.</p>`,
    }[u.install_mode];

    let body = `<h2>Updates <span class="pill">installed: v${esc(u.current)}</span></h2>`;
    if (!u.enabled) body += `<div class="alert-box info">Update checks are turned off. Turn them on under <a href="#/settings/general">Settings → General</a>, or check manually below.</div>`;
    if (!u.repo) body += `<div class="alert-box warn">This build has no update source configured.</div>`;
    else if (u.error) body += `<div class="alert-box warn">Couldn't reach GitHub: ${esc(u.error)}</div>`;
    else if (u.update_available) {
      body += `<div class="alert-box info" style="margin-bottom:12px"><b>Version ${esc(u.latest)} is available</b>${u.published_at ? ` · released ${fmtIso(u.published_at)}` : ''}. <a href="${esc(u.url)}" target="_blank" rel="noopener">View on GitHub ↗</a></div>`;
      body += `<h3>What's new in ${esc(u.latest)}</h3><div class="notes">${u.notes ? mdToHtml(u.notes) : '<p class="dim">No release notes were written for this version.</p>'}</div>`;
      body += modeHelp;
    } else {
      body += `<div class="alert-box ok">You're on the latest version (v${esc(u.current)}).${u.checked_at ? ` <span class="dim">Checked ${fmtIso(u.checked_at)}.</span>` : ''}</div>`;
      if (u.notes) body += `<details style="margin-top:12px"><summary class="help" style="cursor:pointer">Release notes for v${esc(u.current)}</summary><div class="notes">${mdToHtml(u.notes)}</div></details>`;
    }

    // progress / last result
    if (busy) {
      body += `<div class="alert-box info" style="margin-top:14px"><b>⏳ ${st.state === 'requested' ? 'Update requested — waiting for the updater to start…' : esc(st.message || 'Updating…')}</b><br><span class="dim">The app will restart; this page reconnects automatically.</span></div>`;
    } else if (st.state === 'success' && st.finished) {
      body += `<div class="alert-box ok" style="margin-top:14px">✓ ${esc(st.message || 'Updated')} <span class="dim">· ${fmtIso(st.finished)}</span></div>`;
    } else if (st.state === 'failed') {
      body += `<div class="alert-box bad" style="margin-top:14px"><b>✗ ${esc(st.message || 'The last update failed')}</b>${st.finished ? ` <span class="dim">· ${fmtIso(st.finished)}</span>` : ''}<br><span class="dim">You can retry, or run <code>sudo workshop-inventory update</code> on the server to see the full output.</span></div>`;
    }
    if (st.log && st.log.length && (busy || st.state === 'failed')) body += `<details ${st.state === 'failed' ? 'open' : ''} style="margin-top:10px"><summary class="help" style="cursor:pointer">Updater log</summary><pre class="code" id="upd-log" style="max-height:220px; overflow:auto">${esc(st.log.join('\n'))}</pre></details>`;

    body += `<div class="row" style="margin-top:16px; gap:8px">`;
    if (u.update_available && u.install_mode === 'service' && !busy) body += `<button class="btn primary" id="upd-now">⬆️ Update to v${esc(u.latest)} now</button>`;
    if (u.update_available && u.install_mode === 'manual' && u.url) body += `<a class="btn primary" href="${esc(u.url)}" target="_blank" rel="noopener">Download v${esc(u.latest)} ↗</a>`;
    body += `<button class="btn" id="upd-check" ${busy ? 'disabled' : ''}>Check again</button></div>`;
    card.innerHTML = body;

    $('#upd-check', card).addEventListener('click', () => { card.querySelector('#upd-check').textContent = 'Checking…'; renderUpdates(card, true); });
    $('#upd-now', card)?.addEventListener('click', async () => {
      if (!confirm(`Update to v${u.latest} now?\n\nThe app will be unavailable for a minute or two while it installs and restarts. Your data is kept.`)) return;
      try { await api('POST', '/update', { target: 'v' + u.latest }); toast('Update started', 'ok'); watchUpdate(card, u.current); } catch (e) { handleErr(e); }
    });
    if (busy) watchUpdate(card, st.from || u.current);
  }

  /** Poll while the updater runs; survive the restart; reload when the new version is up. */
  function watchUpdate(card, fromVersion) {
    if (card._watching) return; card._watching = true;
    const started = Date.now(); let offline = false;
    const tick = async () => {
      if (!document.body.contains(card)) return;
      try {
        const meta = await fetch('/api/meta').then((r) => r.json());
        if (offline || meta.version !== fromVersion) {
          // server is back (or already swapped)
          const st = await api('GET', '/update-status').catch(() => ({ state: 'idle', log: [] }));
          if (meta.version !== fromVersion) {
            toast(`Updated to v${meta.version}`, 'ok', 6000);
            card._watching = false; await loadMeta(); renderUpdates(card, false); return;
          }
          if (st.state === 'failed' || st.state === 'idle') { card._watching = false; renderUpdates(card, false); return; }
        } else {
          const st = await api('GET', '/update-status');
          if (st.state === 'failed') { card._watching = false; renderUpdates(card, false); return; }
          if (st.state === 'success' && st.to === fromVersion) { card._watching = false; renderUpdates(card, false); return; } // re-installed same version
          const logEl = $('#upd-log', card); if (logEl && st.log) { logEl.textContent = st.log.join('\n'); logEl.scrollTop = logEl.scrollHeight; }
          else if (st.log?.length && !logEl) { const d = document.createElement('details'); d.open = true; d.style.marginTop = '10px'; d.innerHTML = `<summary class="help" style="cursor:pointer">Updater log</summary><pre class="code" id="upd-log" style="max-height:220px; overflow:auto">${esc(st.log.join('\n'))}</pre>`; card.querySelector('.row')?.before(d); }
        }
      } catch { offline = true; const b = card.querySelector('.alert-box.info b'); if (b) b.textContent = '⏳ Restarting with the new version…'; }
      if (Date.now() - started > 20 * 60 * 1000) { card._watching = false; toast('The update is taking unusually long — check `sudo workshop-inventory logs` on the server.', 'warn', 8000); return; }
      setTimeout(tick, offline ? 3000 : 2000);
    };
    setTimeout(tick, 2000);
  }

  function channelDialog(ch) {
    const types = state.meta.channel_types;
    const fieldDefs = {
      smtp: [['host', 'SMTP host', 'smtp.gmail.com'], ['port', 'Port', '587'], ['secure', 'TLS on connect (port 465)', 'false'], ['user', 'Username', 'you@gmail.com'], ['pass', 'Password / app password', ''], ['from', 'From', 'Workshop <you@gmail.com>'], ['to', 'To', 'you@gmail.com']],
      discord: [['webhook_url', 'Webhook URL', 'https://discord.com/api/webhooks/…']],
      slack: [['webhook_url', 'Webhook URL', 'https://hooks.slack.com/services/…']],
      ntfy: [['url', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'my-workshop-stock'], ['token', 'Access token (optional)', '']],
      webhook: [['url', 'URL', 'https://…'], ['method', 'Method', 'POST'], ['headers', 'Headers (JSON)', '{"Authorization":"Bearer …"}'], ['body_template', 'Body template (blank = full JSON)', '{"text":"{{title}}: {{message}}"}']],
    };
    const fields = (t, cfg = {}) => fieldDefs[t].map(([k, l, ph]) => `<label class="${k === 'body_template' || k === 'headers' ? 'span-all' : ''}">${esc(l)}${k === 'body_template' || k === 'headers' ? `<textarea name="cfg.${k}" placeholder="${esc(ph)}">${esc(cfg[k] || '')}</textarea>` : `<input type="${k === 'pass' || k === 'token' ? 'password' : 'text'}" name="cfg.${k}" value="${esc(cfg[k] || '')}" placeholder="${esc(ph)}">`}</label>`).join('')
      + (t === 'webhook' ? '<p class="help span-all">Placeholders: {{title}} {{message}} {{kind}} {{item.name}} {{item.quantity}} {{item.min_quantity}} {{item.unit}} {{item.location}} {{item.sku}} {{item.supplier_url}} {{json}}</p>' : '')
      + (t === 'discord' ? '<p class="help span-all">Discord: Server settings → Integrations → Webhooks → New webhook → Copy URL.</p>' : '')
      + (t === 'ntfy' ? '<p class="help span-all">Install the ntfy app on your phone and subscribe to the same topic. Pick something unguessable.</p>' : '')
      + (t === 'smtp' ? '<p class="help span-all">Gmail: use an App Password (Google account → Security → 2-Step → App passwords) with host smtp.gmail.com, port 587.</p>' : '');
    return new Promise((resolve) => {
      modal(ch ? 'Edit channel' : 'Add notification channel', `<form id="ch-form" class="stack"><div class="form">
        <label>Type<select name="type" ${ch ? 'disabled' : ''}>${types.map((t) => `<option value="${t.type}" ${(ch?.type || 'discord') === t.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
        <label class="span-2">Name<input type="text" name="name" value="${esc(ch?.name || '')}" placeholder="Workshop Discord"></label>
        <label class="check span-all"><input type="checkbox" name="enabled" ${ch ? (ch.enabled ? 'checked' : '') : 'checked'}> Enabled</label></div>
        <div class="form" id="cfg">${fields(ch?.type || 'discord', ch?.config)}</div>
        <div class="form-actions"><button type="submit" class="btn primary">${ch ? 'Save' : 'Add channel'}</button></div></form>`, { onOpen: (wrap, close) => {
        const form = $('#ch-form', wrap);
        form.type.addEventListener('change', () => { $('#cfg', wrap).innerHTML = fields(form.type.value); });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = { type: form.type.value, name: form.name.value, enabled: form.enabled.checked, config: {} };
          for (const [k, v] of new FormData(form).entries()) if (k.startsWith('cfg.')) body.config[k.slice(4)] = v;
          try { ch ? await api('PUT', `/channels/${ch.id}`, body) : await api('POST', '/channels', body); toast('Channel saved — hit Test to check it', 'ok'); close(); resolve(true); } catch (err) { handleErr(err); }
        });
      } });
    });
  }

  // ---- shell ----------------------------------------------------------------
  function paintTier() {
    const b = $('#tier-badge'); const lic = state.meta.license;
    b.textContent = lic.licensed ? 'Pro' : 'Free'; b.className = 'tier' + (lic.licensed ? ' pro' : '');
    b.title = lic.licensed ? `Licensed to ${lic.licensee}` : lic.reason;
    b.onclick = () => { location.hash = '#/settings/license'; };
    $('#site-name').textContent = state.meta.settings.site_name || 'Workshop';
    document.title = `${state.meta.settings.site_name || 'Workshop'} Inventory`;
  }
  async function refreshBadge() {
    try { const d = await api('GET', '/alerts'); const b = $('#alert-badge'); b.textContent = d.length; b.classList.toggle('hidden', !d.length); } catch { /* ignore */ }
  }
  async function loadMeta() { state.meta = await api('GET', '/meta'); paintTier(); }

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pathPart, query] = h.split('?');
    const segs = pathPart.split('/').filter(Boolean);
    state.route = segs[0] || '';
    state.params = Object.fromEntries(new URLSearchParams(query || ''));
    if (state.route === 'settings' && segs[1]) state.params.tab = segs[1];
    if (state.route === 'projects' && segs[1]) state.params.id = segs[1];
  }

  async function render() {
    parseHash();
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
    const view = $('#view');
    const fn = views[state.route] || views[''];
    try { await fn(view); } catch (e) { if (e.message !== 'Login required') { view.innerHTML = `<div class="card alert-box bad">Couldn't load this page: ${esc(e.message)}</div>`; } }
    refreshBadge();
    window.scrollTo(0, 0);
  }

  function showLogin() { $('#login').classList.remove('hidden'); setTimeout(() => $('#login-pw').focus(), 50); }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/login', { password: $('#login-pw').value }); $('#login').classList.add('hidden'); $('#login-pw').value = ''; await loadMeta(); render(); } catch (err) { $('#login-err').textContent = err.message; }
  });
  $('#global-search').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/items?q=' + encodeURIComponent($('#global-q').value.trim()); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); $('#global-q').focus(); } });
  window.addEventListener('hashchange', render);

  (async () => {
    try {
      await loadMeta();
      if (state.meta.auth.password_set && !state.meta.auth.authed) { showLogin(); return; }
      render();
    } catch (e) { $('#view').innerHTML = `<div class="card alert-box bad">Can't reach the server: ${esc(e.message)}</div>`; }
  })();
})();
