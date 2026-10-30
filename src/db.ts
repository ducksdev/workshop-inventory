import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'inventory.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'drawer',   -- cabinet | drawer | shelf | bin | other
  rows      INTEGER NOT NULL DEFAULT 0,       -- grid size (gridfinity units); 0 = no grid
  cols      INTEGER NOT NULL DEFAULT 0,
  notes     TEXT NOT NULL DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
  sku          TEXT NOT NULL DEFAULT '',
  attributes   TEXT NOT NULL DEFAULT '{}',    -- JSON, per-category fields
  quantity     REAL NOT NULL DEFAULT 0,
  unit         TEXT NOT NULL DEFAULT 'pcs',
  min_quantity REAL NOT NULL DEFAULT 0,       -- alert when quantity <= this
  location_id  INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  grid_row     INTEGER,
  grid_col     INTEGER,
  supplier     TEXT NOT NULL DEFAULT '',
  supplier_url TEXT NOT NULL DEFAULT '',
  unit_cost    REAL,
  tags         TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  search_text  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);

CREATE TABLE IF NOT EXISTS movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta          REAL NOT NULL,
  quantity_after REAL NOT NULL,
  reason         TEXT NOT NULL DEFAULT 'adjust', -- receive | consume | build | count | adjust
  ref            TEXT NOT NULL DEFAULT '',       -- free text: project name, order id, etc
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_item ON movements(item_id);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  supplier    TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'ordered',   -- ordered | received | cancelled
  notes       TEXT NOT NULL DEFAULT '',
  ordered_at  TEXT NOT NULL DEFAULT (datetime('now')),
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  builds     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity   REAL NOT NULL DEFAULT 1,
  UNIQUE(project_id, item_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,                     -- smtp | discord | slack | ntfy | webhook
  config     TEXT NOT NULL DEFAULT '{}',        -- JSON
  enabled    INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                   -- low | out
  message      TEXT NOT NULL,
  quantity     REAL NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- migrations -------------------------------------------------------------
// The CREATE TABLE IF NOT EXISTS block above describes a fresh database. When a later
// version needs to change an existing database (add a column, backfill data), append a
// function here. Each runs once, in order, tracked by SQLite's user_version pragma, so
// `workshop-inventory update` is always safe to run on an older data file.
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // 1 (v1.1.0): equipment, fitted parts, maintenance; alerts can now point at equipment
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS equipment (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'other',  -- printer | cnc | laser | soldering | power_tool | hand_tool | other
        make          TEXT NOT NULL DEFAULT '',
        model         TEXT NOT NULL DEFAULT '',
        serial        TEXT NOT NULL DEFAULT '',
        purchase_date TEXT,
        purchase_cost REAL,
        location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        status        TEXT NOT NULL DEFAULT 'active',  -- active | attention | down | retired
        hours         REAL NOT NULL DEFAULT 0,          -- run-hours counter
        url           TEXT NOT NULL DEFAULT '',         -- manual / product page
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS equipment_parts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
        item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
        item_name     TEXT NOT NULL DEFAULT '',         -- kept so history survives item deletion
        slot          TEXT NOT NULL DEFAULT 'Part',     -- Nozzle, Bed surface, Bit, Collet, ...
        fitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
        hours_at_fit  REAL NOT NULL DEFAULT 0,
        removed_at    TEXT,
        hours_at_removal REAL,
        removal_reason TEXT NOT NULL DEFAULT '',        -- replaced | removed | worn | broken
        note          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_parts_equipment ON equipment_parts(equipment_id);
      CREATE TABLE IF NOT EXISTS maintenance_tasks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id    INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        interval_hours  REAL,
        interval_days   INTEGER,
        last_done_at    TEXT,
        last_done_hours REAL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS maintenance_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
        task_id       INTEGER REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
        kind          TEXT NOT NULL DEFAULT 'note',     -- note | maintenance | fit | remove | hours | status
        note          TEXT NOT NULL DEFAULT '',
        hours         REAL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mlog_equipment ON maintenance_log(equipment_id);

      CREATE TABLE alerts_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER REFERENCES items(id) ON DELETE CASCADE,
        equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
        task_id      INTEGER REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,                     -- low | out | maintenance
        message      TEXT NOT NULL,
        quantity     REAL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO alerts_new(id, item_id, kind, message, quantity, acknowledged, created_at)
        SELECT id, item_id, kind, message, quantity, acknowledged, created_at FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_new RENAME TO alerts;
      CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(acknowledged);
    `);
  },
];

{
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < MIGRATIONS.length) {
    const run = db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) {
        MIGRATIONS[v](db);
        db.pragma(`user_version = ${v + 1}`);
      }
    });
    run();
    console.log(`[db] migrated schema ${current} → ${MIGRATIONS.length}`);
  }
}

// ---- settings helpers -------------------------------------------------------

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** A stable per-installation id. Shown in Settings so a vendor can bind a license to it. */
export function installId(): string {
  let id = getSetting('install_id');
  if (!id) {
    id = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
    setSetting('install_id', id);
  }
  return id;
}

// ---- small typed helpers ----------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
