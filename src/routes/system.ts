import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { EQUIPMENT_KINDS, addCategory, categoriesForClient, categoryOrDefault, deleteCategory, isBuiltin, resetCategory, updateCategory } from '../categories.js';
import { importLicense, licenseStatus, limits, removeLicense } from '../license.js';
import { CHANNEL_TYPES, broadcast, sendToChannel, type ChannelRow } from '../notify.js';
import { checkPassword, isAuthed, login, logout, passwordIsSet, setPassword } from '../auth.js';
import { allLocations, buildSearchText, locationPath, shapeItem, type ItemRow } from '../stock.js';
import { VERSION, checkForUpdate, requestUpdate, updateStatus } from '../updates.js';

export const system = Router();
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

const settingsView = () => ({
  currency: getSetting('currency', '£'), site_name: getSetting('site_name', 'Workshop'), update_check: getSetting('update_check', '1') !== '0',
});

// ---- meta -------------------------------------------------------------------

system.get('/meta', (req, res) => {
  res.json({
    app: 'Workshop Inventory', version: VERSION,
    categories: categoriesForClient(), equipment_kinds: EQUIPMENT_KINDS, channel_types: CHANNEL_TYPES, license: licenseStatus(),
    auth: { password_set: passwordIsSet(), authed: isAuthed(req) },
    settings: settingsView(),
  });
});

/** GET /api/update-check[?force=1] — cached lookup of the latest GitHub release. */
system.get('/update-check', async (req, res) => {
  res.json(await checkForUpdate(str(req.query.force) === '1'));
});

/** GET /api/update-status — progress of a self-update (service installs). */
system.get('/update-status', (_req, res) => res.json(updateStatus()));

/** POST /api/update { target?: "latest" | "v1.2.0" } — ask the system updater to install a release. */
system.post('/update', async (req, res) => {
  try {
    const info = await checkForUpdate(true);
    if (!info.update_available && !req.body?.force) return res.status(400).json({ error: 'You are already on the latest version.' });
    res.json(requestUpdate(str(req.body?.target) || (info.latest ? 'v' + info.latest : 'latest')));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

system.get('/dashboard', (_req, res) => {
  const locs = allLocations();
  const shape = (rows: ItemRow[]) => rows.map((r) => shapeItem(r, locs));
  res.json({
    counts: {
      items: (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c,
      low: (db.prepare('SELECT COUNT(*) c FROM items WHERE quantity <= min_quantity AND quantity > 0').get() as any).c,
      out: (db.prepare('SELECT COUNT(*) c FROM items WHERE quantity <= 0').get() as any).c,
      on_order: (db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'ordered'").get() as any).c,
      open_alerts: (db.prepare('SELECT COUNT(*) c FROM alerts WHERE acknowledged = 0').get() as any).c,
      locations: locs.length,
      value: (db.prepare('SELECT COALESCE(SUM(quantity * unit_cost),0) v FROM items WHERE unit_cost IS NOT NULL').get() as any).v,
      equipment: (db.prepare('SELECT COUNT(*) c FROM equipment').get() as any).c,
      maintenance_due: (db.prepare("SELECT COUNT(*) c FROM alerts WHERE kind = 'maintenance' AND acknowledged = 0").get() as any).c,
    },
    maintenance: db.prepare("SELECT a.id, a.equipment_id, a.task_id, a.message, a.created_at, e.name AS equipment_name, e.kind FROM alerts a JOIN equipment e ON e.id = a.equipment_id WHERE a.kind = 'maintenance' AND a.acknowledged = 0 ORDER BY a.id DESC LIMIT 10").all(),
    attention: shape(db.prepare('SELECT * FROM items WHERE quantity <= min_quantity ORDER BY quantity <= 0 DESC, quantity ASC, name LIMIT 25').all() as ItemRow[]),
    recent: db.prepare('SELECT m.*, i.name, i.unit FROM movements m JOIN items i ON i.id = m.item_id ORDER BY m.id DESC LIMIT 15').all(),
    by_category: db.prepare('SELECT category, COUNT(*) c FROM items GROUP BY category').all(),
  });
});

// ---- categories (rename built-ins, add custom) --------------------------------

system.get('/categories', (_req, res) => {
  const counts = Object.fromEntries((db.prepare('SELECT category, COUNT(*) c FROM items GROUP BY category').all() as { category: string; c: number }[]).map((r) => [r.category, r.c]));
  res.json(categoriesForClient().map((c) => ({ ...c, item_count: counts[c.key] || 0 })));
});
system.post('/categories', (req, res) => {
  try { const c = addCategory(req.body || {}); res.status(201).json({ key: c.key, categories: categoriesForClient() }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
system.put('/categories/:key', (req, res) => {
  try { updateCategory(req.params.key, req.body || {}); res.json(categoriesForClient()); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
system.post('/categories/:key/reset', (req, res) => {
  try { resetCategory(req.params.key); res.json(categoriesForClient()); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
/** Deleting a custom category moves its items to "Other" (their spec fields are kept). */
system.delete('/categories/:key', (req, res) => {
  const key = req.params.key;
  if (isBuiltin(key)) return res.status(400).json({ error: 'Built-in categories can be hidden but not deleted.' });
  try {
    const moved = db.prepare("UPDATE items SET category = 'other', updated_at = datetime('now') WHERE category = ?").run(key).changes;
    deleteCategory(key);
    res.json({ moved, categories: categoriesForClient() });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// ---- alerts -----------------------------------------------------------------

system.get('/alerts', (req, res) => {
  const all = str(req.query.all) === '1';
  res.json(db.prepare(`SELECT a.*, COALESCE(i.name, e.name) AS name, i.unit, i.quantity AS current_quantity, e.kind AS equipment_kind FROM alerts a LEFT JOIN items i ON i.id = a.item_id LEFT JOIN equipment e ON e.id = a.equipment_id ${all ? '' : 'WHERE a.acknowledged = 0'} ORDER BY a.id DESC LIMIT 200`).all());
});
system.post('/alerts/:id/ack', (req, res) => {
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
system.post('/alerts/ack-all', (_req, res) => {
  res.json({ acknowledged: db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run().changes });
});

// ---- notification channels --------------------------------------------------

const safeChannel = (ch: ChannelRow) => {
  const cfg = JSON.parse(ch.config || '{}');
  if (cfg.pass) cfg.pass = '••••••';
  if (cfg.token) cfg.token = '••••••';
  return { ...ch, config: cfg };
};

system.get('/channels', (_req, res) => {
  res.json((db.prepare('SELECT * FROM channels ORDER BY id').all() as ChannelRow[]).map(safeChannel));
});

system.post('/channels', (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) c FROM channels').get() as any).c;
  const lim = limits();
  if (count >= lim.maxChannels) return res.status(402).json({ error: 'Notification channels (email, Discord, webhooks…) need a license. Import one under Settings → License.', upgrade: true });
  const type = str(req.body?.type);
  if (!CHANNEL_TYPES.some((t) => t.type === type)) return res.status(400).json({ error: 'Unknown channel type' });
  const info = db.prepare('INSERT INTO channels(name, type, config, enabled) VALUES (?,?,?,?)')
    .run(str(req.body?.name) || type, type, JSON.stringify(req.body?.config || {}), req.body?.enabled === false ? 0 : 1);
  res.status(201).json(safeChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid) as ChannelRow));
});

system.put('/channels/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id)) as ChannelRow | undefined;
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const oldCfg = JSON.parse(cur.config || '{}');
  const newCfg = { ...oldCfg, ...(req.body?.config || {}) };
  // keep stored secrets if the client sent back the mask
  for (const k of ['pass', 'token']) if (newCfg[k] === '••••••') newCfg[k] = oldCfg[k];
  db.prepare('UPDATE channels SET name = ?, config = ?, enabled = ? WHERE id = ?')
    .run(str(req.body?.name) || cur.name, JSON.stringify(newCfg), req.body?.enabled === undefined ? cur.enabled : (req.body.enabled ? 1 : 0), cur.id);
  res.json(safeChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(cur.id) as ChannelRow));
});

system.delete('/channels/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM channels WHERE id = ?').run(Number(req.params.id)).changes });
});

system.post('/channels/:id/test', async (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id)) as ChannelRow | undefined;
  if (!ch) return res.status(404).json({ error: 'Not found' });
  try {
    await sendToChannel(ch, {
      kind: 'test', title: 'Test notification', message: `Workshop Inventory can reach "${ch.name}". Low-stock alerts will arrive here.`,
      item: { id: 0, name: 'M3 x 12mm Socket Head Cap Screw', sku: 'DIN912-M3-12', quantity: 8, min_quantity: 10, unit: 'pcs', location: 'Drawer 1 › R3 C9', supplier: 'AliExpress', supplier_url: 'https://www.aliexpress.com' },
    });
    db.prepare("UPDATE channels SET last_error = '' WHERE id = ?").run(ch.id);
    res.json({ ok: true });
  } catch (e) {
    db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run((e as Error).message.slice(0, 500), ch.id);
    res.status(502).json({ error: (e as Error).message });
  }
});

/** Send a digest of everything currently needing attention to all channels. */
system.post('/alerts/digest', async (_req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE quantity <= min_quantity ORDER BY quantity <= 0 DESC, name').all() as ItemRow[];
  const maint = db.prepare("SELECT message FROM alerts WHERE kind = 'maintenance' AND acknowledged = 0 ORDER BY id").all() as { message: string }[];
  if (!rows.length && !maint.length) return res.json({ sent: false, reason: 'Nothing is low, out of stock, or due for maintenance.' });
  const lines = [...rows.map((r) => `${r.quantity <= 0 ? '🚫' : '⚠️'} ${r.name}: ${r.quantity} ${r.unit} (min ${r.min_quantity})`), ...maint.map((m) => `🔧 ${m.message}`)];
  await broadcast({ kind: 'info', title: `Workshop digest: ${lines.length} thing${lines.length === 1 ? '' : 's'} need attention`, message: lines.join('\n') });
  res.json({ sent: true, count: lines.length });
});

// ---- license ----------------------------------------------------------------

system.get('/license', (_req, res) => res.json(licenseStatus()));
system.post('/license', (req, res) => {
  try {
    const input = req.body?.license ?? req.body;
    res.json(importLicense(input));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
system.delete('/license', (_req, res) => { removeLicense(); res.json(licenseStatus()); });

// ---- settings & auth --------------------------------------------------------

system.put('/settings', (req, res) => {
  const allowed = ['currency', 'site_name'];
  for (const k of allowed) if (req.body?.[k] !== undefined) setSetting(k, str(req.body[k]));
  if (req.body?.update_check !== undefined) setSetting('update_check', req.body.update_check === false || req.body.update_check === 'false' || req.body.update_check === '0' ? '0' : '1');
  res.json(settingsView());
});

system.post('/auth/login', (req, res) => {
  if (!checkPassword(str(req.body?.password))) return res.status(401).json({ error: 'Wrong password' });
  login(res);
  res.json({ ok: true });
});
system.post('/auth/logout', (req, res) => { logout(req, res); res.json({ ok: true }); });
system.post('/auth/password', (req, res) => {
  if (passwordIsSet() && !checkPassword(str(req.body?.current))) return res.status(401).json({ error: 'Current password is wrong' });
  setPassword(str(req.body?.password));
  if (str(req.body?.password)) login(res);
  res.json({ password_set: passwordIsSet() });
});

// ---- CSV import / export ----------------------------------------------------

const CSV_COLS = ['id', 'name', 'category', 'sku', 'quantity', 'unit', 'min_quantity', 'location', 'supplier', 'supplier_url', 'unit_cost', 'tags', 'notes', 'attributes'];
const csvEscape = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

system.get('/export.csv', (_req, res) => {
  if (!limits().csvImportExport) return res.status(402).json({ error: 'CSV export needs a license.', upgrade: true });
  const locs = allLocations();
  const rows = (db.prepare('SELECT * FROM items ORDER BY category, name').all() as ItemRow[]).map((r) => shapeItem(r, locs));
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) lines.push(CSV_COLS.map((c) => csvEscape(c === 'attributes' ? JSON.stringify(r.attributes) : (r as any)[c])).join(','));
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\r\n'));
});

/**
 * POST /api/import.csv  (text/csv body)
 * Columns: name, category, sku, quantity, unit, min_quantity, location (path like "Drawer 1 › R3 C9" or just "Drawer 1"),
 * supplier, supplier_url, unit_cost, tags, notes, attributes (JSON) — plus any extra column is treated as an attribute.
 * Rows with an `id` that exists are updated; otherwise created. Missing locations are created.
 */
system.post('/import.csv', (req, res) => {
  if (!limits().csvImportExport) return res.status(402).json({ error: 'CSV import needs a license.', upgrade: true });
  const text = typeof req.body === 'string' ? req.body : String(req.body?.csv || '');
  const rows = parseCsv(text);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  let created = 0, updated = 0; const errors: string[] = [];

  const findOrCreateLocation = (pathStr: string): { location_id: number | null; grid_row: number | null; grid_col: number | null } => {
    if (!pathStr) return { location_id: null, grid_row: null, grid_col: null };
    const parts = pathStr.split(/\s*[›>\/]\s*/).map((p) => p.trim()).filter(Boolean);
    let grid_row: number | null = null, grid_col: number | null = null;
    const m = parts[parts.length - 1]?.match(/^R(\d+)\s*C(\d+)$/i);
    if (m) { grid_row = +m[1]; grid_col = +m[2]; parts.pop(); }
    let parent: number | null = null;
    for (const name of parts) {
      let loc = db.prepare('SELECT id FROM locations WHERE name = ? AND parent_id IS ?').get(name, parent) as { id: number } | undefined;
      if (!loc) loc = { id: Number(db.prepare('INSERT INTO locations(name, parent_id, kind) VALUES (?,?,?)').run(name, parent, parent ? 'drawer' : 'cabinet').lastInsertRowid) };
      parent = loc.id;
    }
    return { location_id: parent, grid_row, grid_col };
  };

  db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const rec: Record<string, string> = {};
      header.forEach((h, i) => { rec[h] = (rows[r][i] ?? '').trim(); });
      try {
        const category = categoryOrDefault(rec.category).key;
        let attributes: Record<string, string> = {};
        if (rec.attributes) { try { attributes = JSON.parse(rec.attributes); } catch { /* ignore */ } }
        for (const h of header) if (!CSV_COLS.includes(h) && rec[h]) attributes[h] = rec[h];
        const loc = findOrCreateLocation(rec.location);
        const name = rec.name || categoryOrDefault(category).buildName(attributes);
        const base = {
          name, category, attributes: JSON.stringify(attributes), sku: rec.sku || '', unit: rec.unit || categoryOrDefault(category).defaultUnit,
          min_quantity: Number(rec.min_quantity) || 0, ...loc, supplier: rec.supplier || '', supplier_url: rec.supplier_url || '',
          unit_cost: rec.unit_cost ? Number(rec.unit_cost) : null, tags: rec.tags || '', notes: rec.notes || '',
        };
        const search_text = buildSearchText(base as any, locationPath(loc.location_id, loc.grid_row, loc.grid_col));
        const quantity = Number(rec.quantity) || 0;
        const existing = rec.id ? db.prepare('SELECT id, quantity FROM items WHERE id = ?').get(Number(rec.id)) as { id: number; quantity: number } | undefined : undefined;
        if (existing) {
          db.prepare(`UPDATE items SET name=@name, category=@category, attributes=@attributes, sku=@sku, unit=@unit, min_quantity=@min_quantity, location_id=@location_id,
            grid_row=@grid_row, grid_col=@grid_col, supplier=@supplier, supplier_url=@supplier_url, unit_cost=@unit_cost, tags=@tags, notes=@notes, search_text=@search_text,
            quantity=@quantity, updated_at=datetime('now') WHERE id=@id`).run({ ...base, search_text, quantity, id: existing.id });
          if (quantity !== existing.quantity) db.prepare('INSERT INTO movements(item_id, delta, quantity_after, reason, ref) VALUES (?,?,?,?,?)').run(existing.id, quantity - existing.quantity, quantity, 'count', 'csv import');
          updated++;
        } else {
          const info = db.prepare(`INSERT INTO items(name, category, attributes, sku, unit, min_quantity, location_id, grid_row, grid_col, supplier, supplier_url, unit_cost, tags, notes, search_text, quantity)
            VALUES (@name, @category, @attributes, @sku, @unit, @min_quantity, @location_id, @grid_row, @grid_col, @supplier, @supplier_url, @unit_cost, @tags, @notes, @search_text, @quantity)`).run({ ...base, search_text, quantity });
          if (quantity) db.prepare('INSERT INTO movements(item_id, delta, quantity_after, reason, ref) VALUES (?,?,?,?,?)').run(info.lastInsertRowid, quantity, quantity, 'count', 'csv import');
          created++;
        }
      } catch (e) { errors.push(`row ${r + 1}: ${(e as Error).message}`); }
    }
  })();
  res.json({ created, updated, errors });
});
