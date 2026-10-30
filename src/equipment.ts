/**
 * Equipment service: machines you own (printers, CNC, tools), the consumable parts fitted
 * to them, run-hours, and maintenance tasks with hour/day intervals.
 */
import { db } from './db.js';
import { EQUIPMENT_KINDS, getCategory } from './categories.js';
import { adjustStock, allLocations, getItem, locationPath, shapeItem, type ItemRow } from './stock.js';
import { broadcast } from './notify.js';

export interface EquipmentRow {
  id: number; name: string; kind: string; make: string; model: string; serial: string; purchase_date: string | null;
  purchase_cost: number | null; location_id: number | null; status: string; hours: number; url: string; notes: string;
  created_at: string; updated_at: string;
}
export interface PartRow {
  id: number; equipment_id: number; item_id: number | null; item_name: string; slot: string; fitted_at: string; hours_at_fit: number;
  removed_at: string | null; hours_at_removal: number | null; removal_reason: string; note: string;
}
export interface TaskRow {
  id: number; equipment_id: number; name: string; interval_hours: number | null; interval_days: number | null;
  last_done_at: string | null; last_done_hours: number | null; notes: string; created_at: string;
}

const kindOf = (k: string) => EQUIPMENT_KINDS.find((x) => x.key === k) || EQUIPMENT_KINDS[EQUIPMENT_KINDS.length - 1];
const daysBetween = (a: string, b = new Date()) => (b.getTime() - new Date(a.replace(' ', 'T') + (a.endsWith('Z') ? '' : 'Z')).getTime()) / 86_400_000;

export function getEquipment(id: number): EquipmentRow | undefined {
  return db.prepare('SELECT * FROM equipment WHERE id = ?').get(id) as EquipmentRow | undefined;
}

/** Items in stock that could replace this fitted part: same category, matching compat attributes. */
export function compatibleSpares(part: PartRow): ReturnType<typeof shapeItem>[] {
  const item = part.item_id ? getItem(part.item_id) : undefined;
  if (!item) return [];
  const cat = getCategory(item.category);
  let attrs: Record<string, string> = {};
  try { attrs = JSON.parse(item.attributes); } catch { /* ignore */ }
  const keys = (cat?.compatKeys || []).filter((k) => attrs[k]);
  const rows = db.prepare('SELECT * FROM items WHERE category = ? AND quantity > 0 ORDER BY name').all(item.category) as ItemRow[];
  return rows.filter((r) => {
    let a: Record<string, string> = {}; try { a = JSON.parse(r.attributes); } catch { /* ignore */ }
    return keys.every((k) => (a[k] || '').toLowerCase() === attrs[k].toLowerCase());
  }).map((r) => shapeItem(r));
}

export function taskDue(t: TaskRow, hours: number) {
  let hoursLeft: number | null = null, daysLeft: number | null = null;
  if (t.interval_hours) hoursLeft = Math.round(((t.last_done_hours ?? 0) + t.interval_hours - hours) * 10) / 10;
  if (t.interval_days) daysLeft = Math.ceil(t.interval_days - (t.last_done_at ? daysBetween(t.last_done_at) : daysBetween(t.created_at)));
  const due = (hoursLeft !== null && hoursLeft <= 0) || (daysLeft !== null && daysLeft <= 0);
  const soon = !due && ((hoursLeft !== null && t.interval_hours && hoursLeft <= t.interval_hours * 0.1) || (daysLeft !== null && t.interval_days && daysLeft <= Math.max(1, t.interval_days * 0.1)));
  // progress 0..1 of the shortest interval
  let progress = 0;
  if (t.interval_hours) progress = Math.max(progress, (hours - (t.last_done_hours ?? 0)) / t.interval_hours);
  if (t.interval_days) progress = Math.max(progress, (t.last_done_at ? daysBetween(t.last_done_at) : daysBetween(t.created_at)) / t.interval_days);
  return { ...t, hours_left: hoursLeft, days_left: daysLeft, due, soon, progress: Math.min(1, Math.max(0, progress)), status: due ? 'due' : soon ? 'soon' : 'ok' };
}

export function equipmentView(id: number) {
  const e = getEquipment(id);
  if (!e) return undefined;
  const locs = allLocations();
  const parts = (db.prepare('SELECT * FROM equipment_parts WHERE equipment_id = ? AND removed_at IS NULL ORDER BY slot, fitted_at').all(id) as PartRow[]).map((p) => {
    const item = p.item_id ? getItem(p.item_id) : undefined;
    const spares = compatibleSpares(p);
    return { ...p, item: item ? shapeItem(item, locs) : null, hours_in_use: Math.round((e.hours - p.hours_at_fit) * 10) / 10, days_in_use: Math.floor(daysBetween(p.fitted_at)), spares_count: spares.reduce((n, s) => n + s.quantity, 0), spares: spares.slice(0, 8) };
  });
  const history = db.prepare('SELECT * FROM equipment_parts WHERE equipment_id = ? AND removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT 50').all(id) as PartRow[];
  const tasks = (db.prepare('SELECT * FROM maintenance_tasks WHERE equipment_id = ? ORDER BY name').all(id) as TaskRow[]).map((t) => taskDue(t, e.hours));
  const log = db.prepare('SELECT l.*, t.name AS task_name FROM maintenance_log l LEFT JOIN maintenance_tasks t ON t.id = l.task_id WHERE l.equipment_id = ? ORDER BY l.id DESC LIMIT 100').all(id);
  const k = kindOf(e.kind);
  return { ...e, kind_label: k.label, kind_icon: k.icon, suggested_slots: k.slots, location: locationPath(e.location_id, null, null, locs), parts, history, tasks, log, due_count: tasks.filter((t) => t.due).length, soon_count: tasks.filter((t) => t.soon).length };
}

export function equipmentSummaryList() {
  const locs = allLocations();
  return (db.prepare('SELECT * FROM equipment ORDER BY name COLLATE NOCASE').all() as EquipmentRow[]).map((e) => {
    const tasks = (db.prepare('SELECT * FROM maintenance_tasks WHERE equipment_id = ?').all(e.id) as TaskRow[]).map((t) => taskDue(t, e.hours));
    const parts = (db.prepare('SELECT COUNT(*) c FROM equipment_parts WHERE equipment_id = ? AND removed_at IS NULL').get(e.id) as { c: number }).c;
    const k = kindOf(e.kind);
    return { ...e, kind_label: k.label, kind_icon: k.icon, location: locationPath(e.location_id, null, null, locs), parts_count: parts, due_count: tasks.filter((t) => t.due).length, soon_count: tasks.filter((t) => t.soon).length };
  });
}

export function logEntry(equipmentId: number, kind: string, note: string, hours?: number | null, taskId?: number | null) {
  db.prepare('INSERT INTO maintenance_log(equipment_id, task_id, kind, note, hours) VALUES (?,?,?,?,?)').run(equipmentId, taskId ?? null, kind, note, hours ?? null);
}

/** Fit a stock item into a slot. Replaces whatever is in that slot; optionally deducts one from stock. */
export function fitPart(equipmentId: number, itemId: number, slot: string, deduct: boolean, note = '') {
  const e = getEquipment(equipmentId); if (!e) throw new Error('Equipment not found');
  const item = getItem(itemId); if (!item) throw new Error('Item not found');
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM equipment_parts WHERE equipment_id = ? AND slot = ? AND removed_at IS NULL').all(equipmentId, slot) as PartRow[];
    for (const p of existing) {
      db.prepare("UPDATE equipment_parts SET removed_at = datetime('now'), hours_at_removal = ?, removal_reason = 'replaced' WHERE id = ?").run(e.hours, p.id);
      logEntry(equipmentId, 'remove', `${p.slot}: ${p.item_name} removed (replaced) after ${Math.round((e.hours - p.hours_at_fit) * 10) / 10} h`, e.hours);
    }
    db.prepare('INSERT INTO equipment_parts(equipment_id, item_id, item_name, slot, hours_at_fit, note) VALUES (?,?,?,?,?,?)').run(equipmentId, itemId, item.name, slot, e.hours, note);
    logEntry(equipmentId, 'fit', `${slot}: ${item.name} fitted${deduct ? ' (1 taken from stock)' : ''}`, e.hours);
  });
  tx();
  let alert;
  if (deduct) alert = adjustStock(itemId, -1, 'fit', `Fitted to ${e.name} (${slot})`).alert;
  return { view: equipmentView(equipmentId)!, alert };
}

export function removePart(equipmentId: number, partId: number, reason: string, returnToStock: boolean) {
  const e = getEquipment(equipmentId); if (!e) throw new Error('Equipment not found');
  const p = db.prepare('SELECT * FROM equipment_parts WHERE id = ? AND equipment_id = ? AND removed_at IS NULL').get(partId, equipmentId) as PartRow | undefined;
  if (!p) throw new Error('Part not found');
  db.prepare("UPDATE equipment_parts SET removed_at = datetime('now'), hours_at_removal = ?, removal_reason = ? WHERE id = ?").run(e.hours, reason || 'removed', p.id);
  logEntry(equipmentId, 'remove', `${p.slot}: ${p.item_name} removed (${reason || 'removed'}) after ${Math.round((e.hours - p.hours_at_fit) * 10) / 10} h${returnToStock ? ', returned to stock' : ''}`, e.hours);
  if (returnToStock && p.item_id && getItem(p.item_id)) adjustStock(p.item_id, 1, 'return', `Removed from ${e.name} (${p.slot})`);
  return equipmentView(equipmentId)!;
}

export function addHours(equipmentId: number, delta: number | null, total: number | null, note = '') {
  const e = getEquipment(equipmentId); if (!e) throw new Error('Equipment not found');
  const next = total !== null ? total : e.hours + (delta || 0);
  if (!(next >= 0)) throw new Error('Hours must be ≥ 0');
  db.prepare("UPDATE equipment SET hours = ?, updated_at = datetime('now') WHERE id = ?").run(next, equipmentId);
  logEntry(equipmentId, 'hours', note || (total !== null ? `Hours set to ${next}` : `+${delta} h (now ${Math.round(next * 10) / 10} h)`), next);
  checkMaintenance(equipmentId);
  return equipmentView(equipmentId)!;
}

export function completeTask(equipmentId: number, taskId: number, note = '') {
  const e = getEquipment(equipmentId); if (!e) throw new Error('Equipment not found');
  const t = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ? AND equipment_id = ?').get(taskId, equipmentId) as TaskRow | undefined;
  if (!t) throw new Error('Task not found');
  db.prepare("UPDATE maintenance_tasks SET last_done_at = datetime('now'), last_done_hours = ? WHERE id = ?").run(e.hours, taskId);
  logEntry(equipmentId, 'maintenance', `${t.name} done${note ? ': ' + note : ''}`, e.hours, taskId);
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE task_id = ? AND acknowledged = 0').run(taskId);
  return equipmentView(equipmentId)!;
}

/**
 * Create (once) an alert for every task that has become due, and notify channels.
 * Called when hours change and hourly by the scheduler (day-based intervals come due with time).
 */
export function checkMaintenance(onlyEquipmentId?: number) {
  const rows = (onlyEquipmentId ? [getEquipment(onlyEquipmentId)].filter(Boolean) : db.prepare('SELECT * FROM equipment WHERE status != ?').all('retired')) as EquipmentRow[];
  for (const e of rows) {
    const tasks = (db.prepare('SELECT * FROM maintenance_tasks WHERE equipment_id = ?').all(e.id) as TaskRow[]).map((t) => taskDue(t, e.hours));
    for (const t of tasks) {
      if (!t.due) continue;
      const open = db.prepare('SELECT id FROM alerts WHERE task_id = ? AND acknowledged = 0').get(t.id);
      // one alert per "becoming due": skip if an open one exists, or one was created after the task was last done
      const since = db.prepare('SELECT id FROM alerts WHERE task_id = ? AND created_at >= COALESCE(?, created_at)').get(t.id, t.last_done_at);
      if (open || since) continue;
      const why = [t.hours_left !== null && t.hours_left <= 0 ? `${Math.abs(t.hours_left)} h overdue` : '', t.days_left !== null && t.days_left <= 0 ? `${Math.abs(t.days_left)} d overdue` : ''].filter(Boolean).join(', ');
      const message = `${e.name}: "${t.name}" is due${why ? ` (${why})` : ''}.`;
      db.prepare('INSERT INTO alerts(equipment_id, task_id, kind, message) VALUES (?,?,?,?)').run(e.id, t.id, 'maintenance', message);
      void broadcast({ kind: 'maintenance', title: `Maintenance due: ${e.name}`, message: `${t.name}${t.notes ? '\n' + t.notes : ''}\nRun hours: ${e.hours}${why ? '\n' + why : ''}` });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startMaintenanceScheduler() {
  if (timer) return;
  const run = () => { try { checkMaintenance(); } catch (e) { console.error('[maintenance]', (e as Error).message); } };
  setTimeout(run, 10_000);
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
