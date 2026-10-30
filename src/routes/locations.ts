import { Router } from 'express';
import { db } from '../db.js';
import { allLocations, locationPath, refreshSearchText, shapeItem, type ItemRow, type LocationRow } from '../stock.js';

export const locations = Router();

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
const intOr = (v: unknown, d: number) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Math.trunc(Number(v)));
const intOrNull = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Math.trunc(Number(v)));

/** GET /api/locations — flat list with path + item counts (UI builds the tree). */
locations.get('/', (_req, res) => {
  const locs = allLocations();
  const counts = db.prepare('SELECT location_id, COUNT(*) AS c FROM items WHERE location_id IS NOT NULL GROUP BY location_id').all() as { location_id: number; c: number }[];
  const countMap = new Map(counts.map((c) => [c.location_id, c.c]));
  res.json(locs.map((l) => ({ ...l, path: locationPath(l.id, null, null, locs), item_count: countMap.get(l.id) || 0 })));
});

/** GET /api/locations/:id — the location, its children, and its items with grid cells. */
locations.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
  if (!loc) return res.status(404).json({ error: 'Not found' });
  const locs = allLocations();
  const children = locs.filter((l) => l.parent_id === id);
  const items = (db.prepare('SELECT * FROM items WHERE location_id = ? ORDER BY grid_row, grid_col, name').all(id) as ItemRow[]).map((i) => shapeItem(i, locs));
  res.json({ ...loc, path: locationPath(id, null, null, locs), children, items });
});

locations.post('/', (req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO locations(name, parent_id, kind, rows, cols, notes, sort) VALUES (?,?,?,?,?,?,?)')
    .run(name, intOrNull(b.parent_id), str(b.kind) || 'drawer', intOr(b.rows, 0), intOr(b.cols, 0), str(b.notes), intOr(b.sort, 0));
  res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid));
});

/**
 * POST /api/locations/bulk { name: "Drawer", parent_id, count: 6, rows: 4, cols: 10 }
 * Creates "Drawer 1" .. "Drawer 6" in one go — handy when setting up a cabinet.
 */
locations.post('/bulk', (req, res) => {
  const b = req.body || {};
  const base = str(b.name) || 'Drawer';
  const count = Math.min(100, intOr(b.count, 1));
  const ins = db.prepare('INSERT INTO locations(name, parent_id, kind, rows, cols, sort) VALUES (?,?,?,?,?,?)');
  const ids: number[] = [];
  db.transaction(() => {
    for (let i = 1; i <= count; i++) ids.push(Number(ins.run(`${base} ${i}`, intOrNull(b.parent_id), str(b.kind) || 'drawer', intOr(b.rows, 0), intOr(b.cols, 0), i).lastInsertRowid));
  })();
  res.status(201).json({ created: ids });
});

locations.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as LocationRow | undefined;
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const parent_id = b.parent_id === undefined ? cur.parent_id : intOrNull(b.parent_id);
  if (parent_id === id) return res.status(400).json({ error: 'A location cannot be its own parent' });
  db.prepare('UPDATE locations SET name=?, parent_id=?, kind=?, rows=?, cols=?, notes=?, sort=? WHERE id=?')
    .run(str(b.name) || cur.name, parent_id, str(b.kind) || cur.kind, intOr(b.rows, cur.rows), intOr(b.cols, cur.cols), b.notes === undefined ? cur.notes : str(b.notes), intOr(b.sort, cur.sort), id);
  // location names are part of the search text of items stored there
  for (const it of db.prepare('SELECT id FROM items WHERE location_id = ?').all(id) as { id: number }[]) refreshSearchText(it.id);
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(id));
});

locations.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM locations WHERE id = ?').run(Number(req.params.id));
  res.json({ deleted: info.changes });
});
