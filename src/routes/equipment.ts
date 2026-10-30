import { Router } from 'express';
import { db } from '../db.js';
import { EQUIPMENT_KINDS } from '../categories.js';
import { limits } from '../license.js';
import { addHours, completeTask, equipmentSummaryList, equipmentView, fitPart, getEquipment, logEntry, removePart, type EquipmentRow } from '../equipment.js';

export const equipment = Router();

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
const numOrNull = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
const intOrNull = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Math.trunc(Number(v)));
const STATUSES = ['active', 'attention', 'down', 'retired'];

equipment.get('/', (_req, res) => res.json(equipmentSummaryList()));

equipment.get('/:id', (req, res) => {
  const v = equipmentView(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

equipment.post('/', (req, res) => {
  const count = (db.prepare('SELECT COUNT(*) c FROM equipment').get() as { c: number }).c;
  const lim = limits();
  if (count >= lim.maxEquipment) return res.status(402).json({ error: `The free version is limited to ${lim.maxEquipment} pieces of equipment. Import a license to add more.`, upgrade: true });
  const b = req.body || {};
  const name = str(b.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const kind = EQUIPMENT_KINDS.some((k) => k.key === str(b.kind)) ? str(b.kind) : 'other';
  const info = db.prepare(`INSERT INTO equipment(name, kind, make, model, serial, purchase_date, purchase_cost, location_id, status, hours, url, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, kind, str(b.make), str(b.model), str(b.serial), str(b.purchase_date) || null, numOrNull(b.purchase_cost),
    intOrNull(b.location_id), STATUSES.includes(str(b.status)) ? str(b.status) : 'active', numOrNull(b.hours) ?? 0, str(b.url), str(b.notes));
  const id = Number(info.lastInsertRowid);
  logEntry(id, 'note', 'Added to equipment', numOrNull(b.hours) ?? 0);
  res.status(201).json(equipmentView(id));
});

equipment.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = getEquipment(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const pick = <K extends keyof EquipmentRow>(k: K, conv: (v: unknown) => EquipmentRow[K]) => (b[k] === undefined ? cur[k] : conv(b[k]));
  const status = pick('status', (v) => (STATUSES.includes(str(v)) ? str(v) : cur.status));
  db.prepare(`UPDATE equipment SET name=?, kind=?, make=?, model=?, serial=?, purchase_date=?, purchase_cost=?, location_id=?, status=?, url=?, notes=?, updated_at=datetime('now') WHERE id=?`)
    .run(pick('name', (v) => str(v) || cur.name), pick('kind', (v) => (EQUIPMENT_KINDS.some((k) => k.key === str(v)) ? str(v) : cur.kind)), pick('make', str), pick('model', str), pick('serial', str),
      pick('purchase_date', (v) => str(v) || null), pick('purchase_cost', numOrNull), pick('location_id', intOrNull), status, pick('url', str), pick('notes', str), id);
  if (status !== cur.status) logEntry(id, 'status', `Status changed to ${status}`, cur.hours);
  res.json(equipmentView(id));
});

equipment.delete('/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM equipment WHERE id = ?').run(Number(req.params.id)).changes });
});

/** POST /:id/hours { delta } or { total } — bump the run-hours counter (also usable from Klipper/OctoPrint hooks). */
equipment.post('/:id/hours', (req, res) => {
  try { res.json(addHours(Number(req.params.id), numOrNull(req.body?.delta), numOrNull(req.body?.total), str(req.body?.note))); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** POST /:id/parts { item_id, slot, deduct_stock?: true, note? } — fit a part (replaces the slot's current part). */
equipment.post('/:id/parts', (req, res) => {
  try {
    const r = fitPart(Number(req.params.id), Number(req.body?.item_id), str(req.body?.slot) || 'Part', req.body?.deduct_stock !== false, str(req.body?.note));
    res.json({ equipment: r.view, alert: r.alert });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** DELETE /:id/parts/:partId?reason=worn&return=1 */
equipment.delete('/:id/parts/:partId', (req, res) => {
  try { res.json(removePart(Number(req.params.id), Number(req.params.partId), str(req.query.reason), str(req.query.return) === '1')); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** Maintenance tasks */
equipment.post('/:id/tasks', (req, res) => {
  const id = Number(req.params.id);
  if (!getEquipment(id)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const name = str(b.name);
  const ih = numOrNull(b.interval_hours), idays = intOrNull(b.interval_days);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!ih && !idays) return res.status(400).json({ error: 'Give an interval in hours, days, or both' });
  const e = getEquipment(id)!;
  db.prepare('INSERT INTO maintenance_tasks(equipment_id, name, interval_hours, interval_days, last_done_at, last_done_hours, notes) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, ih, idays, b.start_fresh === false ? null : new Date().toISOString().slice(0, 19).replace('T', ' '), b.start_fresh === false ? null : e.hours, str(b.notes));
  res.status(201).json(equipmentView(id));
});

equipment.put('/:id/tasks/:taskId', (req, res) => {
  const id = Number(req.params.id), tid = Number(req.params.taskId);
  const cur = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ? AND equipment_id = ?').get(tid, id) as any;
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare('UPDATE maintenance_tasks SET name=?, interval_hours=?, interval_days=?, notes=? WHERE id=?')
    .run(str(b.name) || cur.name, b.interval_hours === undefined ? cur.interval_hours : numOrNull(b.interval_hours), b.interval_days === undefined ? cur.interval_days : intOrNull(b.interval_days), b.notes === undefined ? cur.notes : str(b.notes), tid);
  res.json(equipmentView(id));
});

equipment.delete('/:id/tasks/:taskId', (req, res) => {
  db.prepare('DELETE FROM maintenance_tasks WHERE id = ? AND equipment_id = ?').run(Number(req.params.taskId), Number(req.params.id));
  res.json(equipmentView(Number(req.params.id)));
});

equipment.post('/:id/tasks/:taskId/done', (req, res) => {
  try { res.json(completeTask(Number(req.params.id), Number(req.params.taskId), str(req.body?.note))); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** POST /:id/log { note } — free-form log entry */
equipment.post('/:id/log', (req, res) => {
  const id = Number(req.params.id);
  const e = getEquipment(id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const note = str(req.body?.note);
  if (!note) return res.status(400).json({ error: 'note is required' });
  logEntry(id, 'note', note, e.hours);
  res.json(equipmentView(id));
});

/** GET /api/equipment-kinds — for the UI */
export const equipmentKinds = EQUIPMENT_KINDS;
