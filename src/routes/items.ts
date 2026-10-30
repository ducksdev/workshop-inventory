import { Router } from 'express';
import { db } from '../db.js';
import { categoryOrDefault } from '../categories.js';
import { limits } from '../license.js';
import { adjustStock, allLocations, buildSearchText, getItem, locationPath, shapeItem, type ItemRow } from '../stock.js';

export const items = Router();

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
const numOr = (v: unknown, d: number) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
const intOrNull = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Math.trunc(Number(v)));

function normalise(body: Record<string, unknown>, existing?: ItemRow) {
  const category = str(body.category) || existing?.category || 'other';
  const cat = categoryOrDefault(category);
  let attributes: Record<string, string> = {};
  if (body.attributes && typeof body.attributes === 'object') {
    for (const [k, v] of Object.entries(body.attributes as Record<string, unknown>)) { const s = str(v); if (s) attributes[k] = s; }
  } else if (existing) {
    try { attributes = JSON.parse(existing.attributes); } catch { /* ignore */ }
  }
  let name = str(body.name);
  if (!name) name = existing?.name || cat.buildName(attributes) || 'Item';
  return {
    name, category, attributes: JSON.stringify(attributes),
    sku: str(body.sku ?? existing?.sku),
    unit: str(body.unit) || existing?.unit || cat.defaultUnit,
    min_quantity: numOr(body.min_quantity, existing?.min_quantity ?? 0),
    location_id: body.location_id === undefined ? existing?.location_id ?? null : intOrNull(body.location_id),
    grid_row: body.grid_row === undefined ? existing?.grid_row ?? null : intOrNull(body.grid_row),
    grid_col: body.grid_col === undefined ? existing?.grid_col ?? null : intOrNull(body.grid_col),
    supplier: str(body.supplier ?? existing?.supplier),
    supplier_url: str(body.supplier_url ?? existing?.supplier_url),
    unit_cost: body.unit_cost === undefined ? existing?.unit_cost ?? null : (str(body.unit_cost) === '' ? null : Number(body.unit_cost)),
    tags: str(body.tags ?? existing?.tags),
    notes: str(body.notes ?? existing?.notes),
  };
}

/** GET /api/items?q=&category=&status=low|out|ok&location_id=&sort= */
items.get('/', (req, res) => {
  const q = str(req.query.q).toLowerCase();
  const category = str(req.query.category);
  const status = str(req.query.status);
  const location_id = intOrNull(req.query.location_id);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) { for (const term of q.split(/\s+/).filter(Boolean)) { where.push('search_text LIKE ?'); params.push(`%${term}%`); } }
  if (category) { where.push('category = ?'); params.push(category); }
  if (location_id) { where.push('location_id = ?'); params.push(location_id); }
  if (status === 'out') where.push('quantity <= 0');
  else if (status === 'low') where.push('quantity <= min_quantity AND quantity > 0');
  else if (status === 'attention') where.push('quantity <= min_quantity');
  else if (status === 'ok') where.push('quantity > min_quantity');
  const sortMap: Record<string, string> = { name: 'name COLLATE NOCASE', quantity: 'quantity', updated: 'updated_at DESC', created: 'created_at DESC', category: 'category, name COLLATE NOCASE' };
  const sort = sortMap[str(req.query.sort)] || 'name COLLATE NOCASE';
  const rows = db.prepare(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort}`).all(...params) as ItemRow[];
  const locs = allLocations();
  res.json(rows.map((r) => shapeItem(r, locs)));
});

items.get('/:id', (req, res) => {
  const it = getItem(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'Not found' });
  const movements = db.prepare('SELECT * FROM movements WHERE item_id = ? ORDER BY id DESC LIMIT 100').all(it.id);
  const orders = db.prepare('SELECT * FROM orders WHERE item_id = ? ORDER BY id DESC').all(it.id);
  const projects = db.prepare('SELECT p.id, p.name, pi.quantity FROM project_items pi JOIN projects p ON p.id = pi.project_id WHERE pi.item_id = ?').all(it.id);
  res.json({ ...shapeItem(it), movements, orders, projects });
});

items.post('/', (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM items').get() as { c: number }).c;
  const lim = limits();
  if (count >= lim.maxItems) {
    return res.status(402).json({ error: `The free version is limited to ${lim.maxItems} items. Import a license under Settings → License to add more.`, upgrade: true });
  }
  const n = normalise(req.body || {});
  const quantity = numOr(req.body?.quantity, 0);
  const info = db.prepare(`INSERT INTO items(name, category, attributes, sku, quantity, unit, min_quantity, location_id, grid_row, grid_col, supplier, supplier_url, unit_cost, tags, notes)
    VALUES (@name, @category, @attributes, @sku, @quantity, @unit, @min_quantity, @location_id, @grid_row, @grid_col, @supplier, @supplier_url, @unit_cost, @tags, @notes)`).run({ ...n, quantity });
  const id = Number(info.lastInsertRowid);
  if (quantity) db.prepare('INSERT INTO movements(item_id, delta, quantity_after, reason, ref) VALUES (?,?,?,?,?)').run(id, quantity, quantity, 'count', 'initial stock');
  db.prepare('UPDATE items SET search_text = ? WHERE id = ?').run(buildSearchText({ ...n, name: n.name }, locationPath(n.location_id, n.grid_row, n.grid_col)), id);
  res.status(201).json(shapeItem(getItem(id)!));
});

items.put('/:id', (req, res) => {
  const existing = getItem(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const n = normalise(req.body || {}, existing);
  db.prepare(`UPDATE items SET name=@name, category=@category, attributes=@attributes, sku=@sku, unit=@unit, min_quantity=@min_quantity,
    location_id=@location_id, grid_row=@grid_row, grid_col=@grid_col, supplier=@supplier, supplier_url=@supplier_url, unit_cost=@unit_cost,
    tags=@tags, notes=@notes, search_text=@search_text, updated_at=datetime('now') WHERE id=@id`).run({
    ...n, id: existing.id, search_text: buildSearchText(n, locationPath(n.location_id, n.grid_row, n.grid_col)),
  });
  // Absolute quantity set (stock-take) is allowed via PUT too, recorded as a "count"
  if (req.body?.quantity !== undefined && req.body.quantity !== '' && Number(req.body.quantity) !== existing.quantity) {
    adjustStock(existing.id, Number(req.body.quantity) - existing.quantity, 'count', 'stock take');
  }
  res.json(shapeItem(getItem(existing.id)!));
});

items.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(Number(req.params.id));
  res.json({ deleted: info.changes });
});

/** POST /api/items/:id/adjust { delta, reason?, ref? }  — e.g. { delta: -3, reason: "consume", ref: "Spool holder v2" } */
items.post('/:id/adjust', (req, res) => {
  const delta = Number(req.body?.delta);
  if (!isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta must be a non-zero number' });
  try {
    const result = adjustStock(Number(req.params.id), delta, str(req.body?.reason) || (delta < 0 ? 'consume' : 'receive'), str(req.body?.ref));
    res.json(result);
  } catch (e) { res.status(404).json({ error: (e as Error).message }); }
});

/** POST /api/items/:id/locate { location_id, grid_row, grid_col } — assign a gridfinity cell */
items.post('/:id/locate', (req, res) => {
  const it = getItem(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'Not found' });
  const location_id = intOrNull(req.body?.location_id);
  const grid_row = intOrNull(req.body?.grid_row);
  const grid_col = intOrNull(req.body?.grid_col);
  if (location_id && grid_row && grid_col) {
    const clash = db.prepare('SELECT id, name FROM items WHERE location_id = ? AND grid_row = ? AND grid_col = ? AND id != ?').get(location_id, grid_row, grid_col, it.id) as { id: number; name: string } | undefined;
    if (clash && !req.body?.force) return res.status(409).json({ error: `That cell already holds "${clash.name}". Pass force:true to share the cell.`, clash });
  }
  db.prepare("UPDATE items SET location_id = ?, grid_row = ?, grid_col = ?, updated_at = datetime('now') WHERE id = ?").run(location_id, grid_row, grid_col, it.id);
  db.prepare('UPDATE items SET search_text = ? WHERE id = ?').run(buildSearchText(getItem(it.id)!, locationPath(location_id, grid_row, grid_col)), it.id);
  res.json(shapeItem(getItem(it.id)!));
});

/** GET /api/items/:id/movements */
items.get('/:id/movements', (req, res) => {
  res.json(db.prepare('SELECT * FROM movements WHERE item_id = ? ORDER BY id DESC LIMIT 500').all(Number(req.params.id)));
});
