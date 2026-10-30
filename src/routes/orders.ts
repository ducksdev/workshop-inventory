import { Router } from 'express';
import { db } from '../db.js';
import { adjustStock, getItem, shapeItem, type ItemRow } from '../stock.js';

export const orders = Router();

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

function orderView(id: number) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
  if (!o) return undefined;
  const item = getItem(o.item_id);
  return { ...o, item: item ? shapeItem(item) : null };
}

/** GET /api/orders?status=ordered|received|cancelled|all */
orders.get('/', (req, res) => {
  const status = str(req.query.status) || 'ordered';
  const rows = status === 'all'
    ? db.prepare('SELECT id FROM orders ORDER BY id DESC').all()
    : db.prepare('SELECT id FROM orders WHERE status = ? ORDER BY id DESC').all(status);
  res.json((rows as { id: number }[]).map((r) => orderView(r.id)));
});

/** POST /api/orders { item_id, quantity, supplier?, url?, notes? } — "None in stock, order from Ali" */
orders.post('/', (req, res) => {
  const item = getItem(Number(req.body?.item_id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const quantity = Number(req.body?.quantity);
  if (!(quantity > 0)) return res.status(400).json({ error: 'quantity must be > 0' });
  const supplier = str(req.body?.supplier) || item.supplier;
  const url = str(req.body?.url) || item.supplier_url;
  const info = db.prepare('INSERT INTO orders(item_id, quantity, supplier, url, notes) VALUES (?,?,?,?,?)').run(item.id, quantity, supplier, url, str(req.body?.notes));
  // remember the supplier on the item for next time
  if (supplier && !item.supplier) db.prepare('UPDATE items SET supplier = ?, supplier_url = ? WHERE id = ?').run(supplier, url, item.id);
  res.status(201).json(orderView(Number(info.lastInsertRowid)));
});

/**
 * POST /api/orders/:id/receive { quantity?, location_id?, grid_row?, grid_col? }
 * Marks the order received, adds stock (partial receipts allowed), and optionally assigns the
 * item to a gridfinity cell in one step — "when it arrives, dedicate a box in drawer 1 R3 C9".
 */
orders.post('/:id/receive', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id)) as any;
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status !== 'ordered') return res.status(400).json({ error: `Order is already ${o.status}` });
  const qty = req.body?.quantity !== undefined && req.body.quantity !== '' ? Number(req.body.quantity) : o.quantity;
  if (!(qty > 0)) return res.status(400).json({ error: 'quantity must be > 0' });

  const b = req.body || {};
  if (b.location_id) {
    db.prepare("UPDATE items SET location_id = ?, grid_row = ?, grid_col = ?, updated_at = datetime('now') WHERE id = ?")
      .run(Number(b.location_id), b.grid_row ? Number(b.grid_row) : null, b.grid_col ? Number(b.grid_col) : null, o.item_id);
  }
  const result = adjustStock(o.item_id, qty, 'receive', `order #${o.id}${o.supplier ? ' from ' + o.supplier : ''}`);
  if (qty >= o.quantity) {
    db.prepare("UPDATE orders SET status = 'received', received_at = datetime('now') WHERE id = ?").run(o.id);
  } else {
    // partial: close this one as received for what arrived, open a new order for the remainder
    db.prepare("UPDATE orders SET status = 'received', quantity = ?, received_at = datetime('now') WHERE id = ?").run(qty, o.id);
    db.prepare('INSERT INTO orders(item_id, quantity, supplier, url, notes, ordered_at) VALUES (?,?,?,?,?,?)').run(o.item_id, o.quantity - qty, o.supplier, o.url, `remainder of order #${o.id}`, o.ordered_at);
  }
  res.json({ order: orderView(o.id), item: result.item, alert: result.alert });
});

orders.post('/:id/cancel', (req, res) => {
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'ordered'").run(Number(req.params.id));
  res.json(orderView(Number(req.params.id)));
});

orders.delete('/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM orders WHERE id = ?').run(Number(req.params.id)).changes });
});

/** GET /api/orders/suggest — items at/below minimum with no open order: your shopping list. */
orders.get('/suggest', (_req, res) => {
  const rows = db.prepare(`SELECT i.* FROM items i WHERE i.quantity <= i.min_quantity
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.item_id = i.id AND o.status = 'ordered') ORDER BY i.quantity ASC, i.name`).all() as ItemRow[];
  res.json(rows.map((r) => shapeItem(r)));
});
