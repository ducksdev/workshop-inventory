/**
 * Core stock logic shared by routes: item shaping, location paths, stock movements and
 * threshold alerts. Every quantity change in the app goes through adjustStock() so the
 * movement history and alerts are always consistent.
 */
import { db } from './db.js';
import { categoryOrDefault } from './categories.js';
import { broadcast, type Notification } from './notify.js';

export interface LocationRow {
  id: number; name: string; parent_id: number | null; kind: string; rows: number; cols: number; notes: string; sort: number;
}

export interface ItemRow {
  id: number; name: string; category: string; sku: string; attributes: string; quantity: number; unit: string;
  min_quantity: number; location_id: number | null; grid_row: number | null; grid_col: number | null;
  supplier: string; supplier_url: string; unit_cost: number | null; tags: string; notes: string; search_text: string;
  created_at: string; updated_at: string;
}

// ---- locations --------------------------------------------------------------

export function allLocations(): LocationRow[] {
  return db.prepare('SELECT * FROM locations ORDER BY sort, name').all() as LocationRow[];
}

/** "Drawer 1 › R3 C9" style path for an item. */
export function locationPath(location_id: number | null, row: number | null, col: number | null, locs?: LocationRow[]): string {
  if (!location_id) return '';
  const all = locs || allLocations();
  const byId = new Map(all.map((l) => [l.id, l]));
  const parts: string[] = [];
  let cur = byId.get(location_id);
  let guard = 0;
  while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
  if (row && col) parts.push(`R${row} C${col}`);
  return parts.join(' › ');
}

// ---- items ------------------------------------------------------------------

export function buildSearchText(it: Partial<ItemRow>, locPath: string): string {
  let attrs = '';
  try { attrs = Object.values(JSON.parse(it.attributes || '{}') as Record<string, string>).join(' '); } catch { /* ignore */ }
  return [it.name, it.sku, it.category, attrs, it.tags, it.supplier, it.notes, locPath].filter(Boolean).join(' ').toLowerCase();
}

export function shapeItem(it: ItemRow, locs?: LocationRow[]) {
  let attributes: Record<string, string> = {};
  try { attributes = JSON.parse(it.attributes || '{}'); } catch { /* ignore */ }
  const openOrders = db.prepare("SELECT COALESCE(SUM(quantity),0) AS q FROM orders WHERE item_id = ? AND status = 'ordered'").get(it.id) as { q: number };
  return {
    ...it,
    attributes,
    location: locationPath(it.location_id, it.grid_row, it.grid_col, locs),
    on_order: openOrders.q,
    status: it.quantity <= 0 ? 'out' : it.quantity <= it.min_quantity ? 'low' : 'ok',
    category_icon: categoryOrDefault(it.category).icon,
  };
}

export type ShapedItem = ReturnType<typeof shapeItem>;

export function getItem(id: number): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
}

export function refreshSearchText(id: number): void {
  const it = getItem(id);
  if (!it) return;
  db.prepare('UPDATE items SET search_text = ? WHERE id = ?').run(buildSearchText(it, locationPath(it.location_id, it.grid_row, it.grid_col)), id);
}

// ---- movements + alerts -----------------------------------------------------

export interface AdjustResult {
  item: ShapedItem;
  alert?: { kind: 'low' | 'out'; message: string };
}

/**
 * Change an item's stock by `delta`, record the movement, and fire an alert if the
 * quantity crossed the minimum (or hit zero). Alerts fire only on the crossing, so taking
 * three screws from 11 -> 8 with a minimum of 10 alerts once, not on every subsequent use.
 */
export function adjustStock(itemId: number, delta: number, reason: string, ref = ''): AdjustResult {
  const before = getItem(itemId);
  if (!before) throw new Error('Item not found');
  const after = Math.max(0, Math.round((before.quantity + delta) * 1000) / 1000);
  const actualDelta = after - before.quantity;

  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(after, itemId);
    db.prepare('INSERT INTO movements(item_id, delta, quantity_after, reason, ref) VALUES (?,?,?,?,?)').run(itemId, actualDelta, after, reason, ref);
  });
  tx();

  const item = shapeItem(getItem(itemId)!);
  const result: AdjustResult = { item };

  const min = before.min_quantity;
  const crossedToOut = before.quantity > 0 && after <= 0;
  const crossedToLow = before.quantity > min && after <= min && after > 0;

  if (crossedToOut || crossedToLow) {
    const kind: 'low' | 'out' = crossedToOut ? 'out' : 'low';
    const message = crossedToOut
      ? `${item.name} is out of stock.`
      : `${item.name} is running low: ${after} ${item.unit} left (alert level ${min}).`;
    db.prepare('INSERT INTO alerts(item_id, kind, message, quantity) VALUES (?,?,?,?)').run(itemId, kind, message, after);
    result.alert = { kind, message };
    const n: Notification = {
      kind, title: kind === 'out' ? `Out of stock: ${item.name}` : `Low stock: ${item.name}`, message,
      item: { id: item.id, name: item.name, sku: item.sku, quantity: after, min_quantity: min, unit: item.unit, location: item.location, supplier: item.supplier, supplier_url: item.supplier_url },
    };
    void broadcast(n);
  } else if (after > min && before.quantity <= min) {
    // restocked above the threshold: clear open alerts for this item
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE item_id = ? AND acknowledged = 0').run(itemId);
  }
  return result;
}
