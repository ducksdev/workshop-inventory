import { Router } from 'express';
import { db } from '../db.js';
import { limits } from '../license.js';
import { adjustStock, getItem, shapeItem } from '../stock.js';

export const projects = Router();

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

function projectView(id: number) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { id: number; name: string; notes: string; builds: number; created_at: string } | undefined;
  if (!p) return undefined;
  const parts = (db.prepare('SELECT pi.id AS line_id, pi.quantity AS needed, i.* FROM project_items pi JOIN items i ON i.id = pi.item_id WHERE pi.project_id = ? ORDER BY i.name').all(id) as any[])
    .map((row) => {
      const { line_id, needed, ...item } = row;
      const shaped = shapeItem(item);
      return { line_id, needed, item: shaped, can_build: needed > 0 ? Math.floor(shaped.quantity / needed) : Infinity, short: Math.max(0, needed - shaped.quantity) };
    });
  const buildable = parts.length ? Math.min(...parts.map((p) => p.can_build)) : 0;
  return { ...p, parts, buildable: isFinite(buildable) ? buildable : 0 };
}

projects.get('/', (_req, res) => {
  const ids = db.prepare('SELECT id FROM projects ORDER BY name COLLATE NOCASE').all() as { id: number }[];
  res.json(ids.map((r) => projectView(r.id)));
});

projects.get('/:id', (req, res) => {
  const p = projectView(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

projects.post('/', (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
  const lim = limits();
  if (count >= lim.maxProjects) return res.status(402).json({ error: `The free version is limited to ${lim.maxProjects} projects. Import a license to add more.`, upgrade: true });
  const name = str(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO projects(name, notes) VALUES (?,?)').run(name, str(req.body?.notes));
  res.status(201).json(projectView(Number(info.lastInsertRowid)));
});

projects.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { name: string; notes: string } | undefined;
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE projects SET name = ?, notes = ? WHERE id = ?').run(str(req.body?.name) || cur.name, req.body?.notes === undefined ? cur.notes : str(req.body.notes), id);
  res.json(projectView(id));
});

projects.delete('/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id)).changes });
});

/** POST /api/projects/:id/parts { item_id, quantity } — add or update a BOM line */
projects.post('/:id/parts', (req, res) => {
  const id = Number(req.params.id);
  const item_id = Number(req.body?.item_id);
  const quantity = Number(req.body?.quantity ?? 1);
  if (!getItem(item_id)) return res.status(404).json({ error: 'Item not found' });
  if (!(quantity > 0)) return res.status(400).json({ error: 'quantity must be > 0' });
  db.prepare('INSERT INTO project_items(project_id, item_id, quantity) VALUES (?,?,?) ON CONFLICT(project_id, item_id) DO UPDATE SET quantity = excluded.quantity').run(id, item_id, quantity);
  res.json(projectView(id));
});

projects.delete('/:id/parts/:lineId', (req, res) => {
  db.prepare('DELETE FROM project_items WHERE id = ? AND project_id = ?').run(Number(req.params.lineId), Number(req.params.id));
  res.json(projectView(Number(req.params.id)));
});

/**
 * POST /api/projects/:id/build { count: 1, allow_negative?: false }
 * Consumes every BOM line × count from stock, records movements referencing the project,
 * and fires any low-stock alerts. Refuses if stock is short unless allow_negative.
 */
projects.post('/:id/build', (req, res) => {
  const id = Number(req.params.id);
  const p = projectView(id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const count = Math.max(1, Math.trunc(Number(req.body?.count ?? 1)));
  const shortages = p.parts.filter((pt) => pt.item.quantity < pt.needed * count).map((pt) => ({ item: pt.item.name, have: pt.item.quantity, need: pt.needed * count }));
  if (shortages.length && !req.body?.allow_negative) {
    return res.status(409).json({ error: 'Not enough stock to build', shortages });
  }
  const alerts: { kind: string; message: string }[] = [];
  for (const pt of p.parts) {
    const r = adjustStock(pt.item.id, -pt.needed * count, 'build', `${p.name} ×${count}`);
    if (r.alert) alerts.push(r.alert);
  }
  db.prepare('UPDATE projects SET builds = builds + ? WHERE id = ?').run(count, id);
  res.json({ project: projectView(id), alerts, shortages });
});
