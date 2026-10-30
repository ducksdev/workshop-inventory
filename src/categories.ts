/**
 * Category definitions. Each category has a set of attribute fields (rendered as a form
 * in the UI and stored as JSON on the item), a default unit, and a name builder that
 * generates a consistent, searchable item name from the attributes, e.g.
 *   hardware  -> "M3 x 12mm Socket Head Cap Screw"
 *   tooling   -> "3.175mm x 12mm 1FL Flat End Mill"
 *   nozzle    -> "0.4mm Hardened Steel Nozzle (V6)"
 *
 * To add your own category, add an entry here. The UI picks it up automatically.
 */

export type FieldType = 'text' | 'number' | 'select';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  unit?: string;          // display suffix, e.g. "mm"
  options?: string[];     // for selects (UI also allows free text)
  placeholder?: string;
}

export interface Category {
  key: string;
  label: string;
  icon: string;           // emoji, used in the UI
  defaultUnit: string;
  fields: Field[];
  buildName: (a: Record<string, string>) => string;
  /** Attribute keys that must match for an item to count as a compatible spare for a fitted part. */
  compatKeys?: string[];
}

const num = (v: string | undefined) => (v && v.trim() !== '' ? v.trim().replace(/\.0+$/, '') : '');
const join = (parts: (string | undefined)[], sep = ' ') => parts.filter((p) => p && p.trim() !== '').join(sep);

export const CATEGORIES: Category[] = [
  {
    key: 'hardware',
    label: 'Hardware',
    icon: '🔩',
    defaultUnit: 'pcs',
    fields: [
      { key: 'thread', label: 'Thread', type: 'text', placeholder: 'M3, M5, 1/4-20, #6-32' },
      { key: 'length', label: 'Length', type: 'number', unit: 'mm' },
      {
        key: 'kind', label: 'Type', type: 'select',
        options: ['Socket Head Cap Screw', 'Button Head Screw', 'Countersunk Screw', 'Pan Head Screw', 'Hex Bolt', 'Grub Screw', 'Self-Tapping Screw', 'Wood Screw',
          'Nut', 'Nyloc Nut', 'T-Nut', 'Heat-Set Insert', 'Washer', 'Standoff', 'Threaded Rod', 'Rivet', 'Dowel Pin', 'Bearing', 'Other'],
      },
      { key: 'drive', label: 'Drive', type: 'select', options: ['Hex', 'Torx', 'Phillips', 'Pozi', 'Slotted', 'None'] },
      { key: 'material', label: 'Material', type: 'select', options: ['Steel (black oxide)', 'Steel (zinc)', 'Stainless A2', 'Stainless A4', 'Brass', 'Nylon', 'Titanium', 'Aluminium'] },
      { key: 'standard', label: 'Standard', type: 'text', placeholder: 'DIN 912, ISO 7380' },
    ],
    buildName: (a) => {
      const size = join([a.thread, num(a.length) ? num(a.length) + 'mm' : ''], ' x ');
      return join([size, a.kind || 'Fastener']);
    },
  },
  {
    key: 'tooling',
    label: 'Cutting tools',
    icon: '🪛',
    defaultUnit: 'pcs',
    compatKeys: ['shank'],
    fields: [
      {
        key: 'tool_type', label: 'Tool type', type: 'select',
        options: ['Flat End Mill', 'Ball End Mill', 'Corner Radius End Mill', 'V-Bit', 'Engraving Bit', 'Drill', 'Chamfer Mill', 'Tapered Ball Mill', 'Compression Bit', 'Downcut', 'Upcut', 'Surfacing Bit', 'Tap', 'Die', 'Other'],
      },
      { key: 'diameter', label: 'Diameter', type: 'number', unit: 'mm', placeholder: '3.175' },
      { key: 'cut_length', label: 'Cut length', type: 'number', unit: 'mm' },
      { key: 'flutes', label: 'Flutes', type: 'number', placeholder: '1' },
      { key: 'shank', label: 'Shank', type: 'number', unit: 'mm', placeholder: '3.175' },
      { key: 'overall_length', label: 'Overall length', type: 'number', unit: 'mm' },
      { key: 'coating', label: 'Coating', type: 'select', options: ['None', 'TiAlN', 'AlTiN', 'TiN', 'DLC', 'Diamond', 'ZrN'] },
      { key: 'material', label: 'Tool material', type: 'select', options: ['Carbide', 'HSS', 'Cobalt HSS', 'PCD'] },
      { key: 'for_material', label: 'For cutting', type: 'text', placeholder: 'Aluminium, wood, acrylic' },
    ],
    buildName: (a) => {
      const dims = join([num(a.diameter) ? num(a.diameter) + 'mm' : '', num(a.cut_length) ? num(a.cut_length) + 'mm' : ''], ' x ');
      const fl = num(a.flutes) ? num(a.flutes) + 'FL' : '';
      return join([dims, fl, a.tool_type || 'Cutter']);
    },
  },
  {
    key: 'nozzle',
    label: '3D printer nozzles',
    icon: '🔥',
    defaultUnit: 'pcs',
    compatKeys: ['mount', 'filament_dia'],
    fields: [
      { key: 'diameter', label: 'Orifice', type: 'number', unit: 'mm', placeholder: '0.4' },
      {
        key: 'material', label: 'Material', type: 'select',
        options: ['Brass', 'Hardened Steel', 'Stainless Steel', 'Plated Copper', 'Tungsten Carbide', 'Ruby', 'Vanadium', 'Other'],
      },
      {
        key: 'mount', label: 'Mount / style', type: 'select',
        options: ['V6', 'Volcano', 'MK8', 'MK10', 'Revo', 'Bambu Lab', 'Dragon / Rapido', 'CHT', 'Prusa Nextruder', 'Creality Unicorn', 'Other'],
      },
      { key: 'filament_dia', label: 'Filament', type: 'select', options: ['1.75mm', '2.85mm'] },
      { key: 'printer', label: 'Printer(s)', type: 'text', placeholder: 'Ender 3, Voron 2.4' },
      { key: 'brand', label: 'Brand', type: 'text', placeholder: 'E3D, Bondtech' },
    ],
    buildName: (a) => {
      const d = num(a.diameter) ? num(a.diameter) + 'mm' : '';
      return join([d, a.material, 'Nozzle', a.mount ? `(${a.mount})` : '']);
    },
  },
  {
    key: 'filament',
    label: 'Filament & resin',
    icon: '🧵',
    defaultUnit: 'g',
    compatKeys: ['diameter'],
    fields: [
      { key: 'material', label: 'Material', type: 'select', options: ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon', 'PC', 'PA-CF', 'PETG-CF', 'PLA-CF', 'PVA', 'HIPS', 'Resin (standard)', 'Resin (tough)', 'Resin (flexible)', 'Other'] },
      { key: 'color', label: 'Colour', type: 'text', placeholder: 'Galaxy Black' },
      { key: 'diameter', label: 'Diameter', type: 'select', options: ['1.75mm', '2.85mm', 'n/a'] },
      { key: 'brand', label: 'Brand', type: 'text' },
      { key: 'spool_weight', label: 'Empty spool weight', type: 'number', unit: 'g' },
      { key: 'nozzle_temp', label: 'Nozzle temp', type: 'text', placeholder: '200-220°C' },
      { key: 'bed_temp', label: 'Bed temp', type: 'text', placeholder: '60°C' },
    ],
    buildName: (a) => join([a.brand, a.material, a.color]),
  },
  {
    key: 'electronics',
    label: 'Electronics',
    icon: '⚡',
    defaultUnit: 'pcs',
    fields: [
      { key: 'part_number', label: 'Part number', type: 'text', placeholder: 'ESP32-WROOM-32, LM7805' },
      { key: 'kind', label: 'Type', type: 'select', options: ['Microcontroller', 'Board / module', 'Sensor', 'Resistor', 'Capacitor', 'Inductor', 'Diode', 'LED', 'Transistor / MOSFET', 'IC', 'Connector', 'Switch', 'Cable / wire', 'Stepper motor', 'Servo', 'DC motor', 'Driver', 'Power supply', 'Battery', 'Display', 'Other'] },
      { key: 'value', label: 'Value', type: 'text', placeholder: '10kΩ, 100µF, 5V' },
      { key: 'package', label: 'Package', type: 'text', placeholder: '0805, TO-220, DIP-8' },
      { key: 'rating', label: 'Rating', type: 'text', placeholder: '1/4W, 25V, 3A' },
    ],
    buildName: (a) => join([a.part_number, a.value, a.kind, a.package ? `(${a.package})` : '']),
  },
  {
    key: 'consumable',
    label: 'Consumables',
    icon: '🧴',
    defaultUnit: 'pcs',
    fields: [
      { key: 'kind', label: 'Type', type: 'select', options: ['Sandpaper', 'Adhesive', 'Tape', 'Lubricant', 'Solder', 'Flux', 'Paint / finish', 'Blade', 'Sanding disc', 'Cutting disc', 'Glue stick', 'IPA / solvent', 'Gloves', 'Filter', 'Other'] },
      { key: 'spec', label: 'Spec', type: 'text', placeholder: '240 grit, 0.8mm 60/40, 50mm' },
      { key: 'brand', label: 'Brand', type: 'text' },
    ],
    buildName: (a) => join([a.brand, a.spec, a.kind]),
  },
  {
    key: 'material',
    label: 'Stock material',
    icon: '🪵',
    defaultUnit: 'pcs',
    fields: [
      { key: 'material', label: 'Material', type: 'select', options: ['Plywood', 'MDF', 'Hardwood', 'Acrylic', 'Polycarbonate', 'HDPE', 'Delrin / POM', 'Aluminium', 'Steel', 'Brass', 'Copper', 'PCB blank', 'Foam', 'Other'] },
      { key: 'dimensions', label: 'Dimensions', type: 'text', placeholder: '300 x 300 x 6mm' },
      { key: 'form', label: 'Form', type: 'select', options: ['Sheet', 'Bar', 'Rod', 'Tube', 'Angle', 'Block', 'Extrusion', 'Other'] },
    ],
    buildName: (a) => join([a.material, a.form, a.dimensions]),
  },
  {
    key: 'other',
    label: 'Other',
    icon: '📦',
    defaultUnit: 'pcs',
    fields: [{ key: 'spec', label: 'Spec', type: 'text' }],
    buildName: (a) => a.spec || 'Item',
  },
];

// ---- user customisation ---------------------------------------------------------
// Built-ins above are the defaults. Users can rename/re-icon/hide them and add their own
// categories (with their own spec fields). Both live in the settings table as JSON.

import { getSetting, setSetting } from './db.js';

export interface CategoryOverride { label?: string; icon?: string; defaultUnit?: string; hidden?: boolean }
export interface CustomCategory {
  key: string; label: string; icon: string; defaultUnit: string; fields: Field[];
  nameTemplate?: string;   // e.g. "{diameter}mm {material} Bearing"; blank = join all field values
  compatKeys?: string[];
}

const BUILTIN_KEYS = new Set(CATEGORIES.map((c) => c.key));
let cache: { list: Category[]; map: Record<string, Category>; hidden: Set<string> } | null = null;

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(getSetting(key, '')) as T; } catch { return fallback; }
}
export function categoryOverrides(): Record<string, CategoryOverride> { return readJson('category_overrides', {}); }
export function customCategories(): CustomCategory[] { return readJson('custom_categories', []); }
export function invalidateCategories() { cache = null; }

function customToCategory(c: CustomCategory): Category {
  return {
    key: c.key, label: c.label, icon: c.icon || '📦', defaultUnit: c.defaultUnit || 'pcs', fields: c.fields || [], compatKeys: c.compatKeys,
    buildName: (a) => {
      if (c.nameTemplate && c.nameTemplate.trim()) {
        const out = c.nameTemplate.replace(/\{(\w+)\}/g, (_, k: string) => a[k] || '').replace(/\s+/g, ' ').trim();
        if (out) return out;
      }
      return join((c.fields || []).map((f) => a[f.key])) || c.label;
    },
  };
}

function build() {
  const ov = categoryOverrides();
  const hidden = new Set<string>();
  const list: Category[] = CATEGORIES.map((c) => {
    const o = ov[c.key] || {};
    if (o.hidden) hidden.add(c.key);
    return { ...c, label: o.label || c.label, icon: o.icon || c.icon, defaultUnit: o.defaultUnit || c.defaultUnit };
  });
  for (const cc of customCategories()) if (!BUILTIN_KEYS.has(cc.key)) list.push(customToCategory(cc));
  // keep "Other" last
  list.sort((a, b) => (a.key === 'other' ? 1 : b.key === 'other' ? -1 : 0));
  cache = { list, map: Object.fromEntries(list.map((c) => [c.key, c])), hidden };
  return cache;
}
const current = () => cache || build();

/** All categories (built-in with overrides applied, plus custom), including hidden ones. */
export function allCategories(): Category[] { return current().list; }
export function getCategory(key: string | undefined): Category | undefined { return key ? current().map[key] : undefined; }
export function categoryOrDefault(key: string | undefined): Category {
  return getCategory(key) || current().map.other;
}
export function isBuiltin(key: string) { return BUILTIN_KEYS.has(key); }

/** Public, serialisable view of the categories (without the name builder functions). */
export function categoriesForClient() {
  const { hidden } = current();
  const customs = Object.fromEntries(customCategories().map((c) => [c.key, c]));
  return allCategories().map(({ key, label, icon, defaultUnit, fields, compatKeys }) => ({
    key, label, icon, defaultUnit, fields, compatKeys: compatKeys || [], hidden: hidden.has(key), builtin: BUILTIN_KEYS.has(key),
    nameTemplate: customs[key]?.nameTemplate || '',
  }));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'custom';

function sanitizeFields(raw: unknown): Field[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.map((f: any) => {
    const label = String(f?.label || '').trim(); if (!label) return null;
    let key = slug(String(f?.key || label)); while (seen.has(key)) key += '_2'; seen.add(key);
    const type: FieldType = f?.type === 'number' ? 'number' : f?.type === 'select' ? 'select' : 'text';
    const options = type === 'select' ? String(f?.options || '').split(/[,\n]/).map((o: string) => o.trim()).filter(Boolean) : undefined;
    return { key, label, type, unit: String(f?.unit || '').trim() || undefined, options, placeholder: String(f?.placeholder || '').trim() || undefined } as Field;
  }).filter(Boolean) as Field[];
}

/** Rename / re-icon / change unit / hide a built-in, or fully edit a custom category. */
export function updateCategory(key: string, patch: any): void {
  if (BUILTIN_KEYS.has(key)) {
    const ov = categoryOverrides();
    const o: CategoryOverride = { ...(ov[key] || {}) };
    if (patch.label !== undefined) o.label = String(patch.label).trim() || undefined;
    if (patch.icon !== undefined) o.icon = String(patch.icon).trim() || undefined;
    if (patch.defaultUnit !== undefined) o.defaultUnit = String(patch.defaultUnit).trim() || undefined;
    if (patch.hidden !== undefined) o.hidden = !!patch.hidden || undefined;
    if (key === 'other') delete o.hidden; // "Other" is the fallback, it can't be hidden
    if (Object.keys(o).some((k) => (o as any)[k] !== undefined)) ov[key] = o; else delete ov[key];
    setSetting('category_overrides', JSON.stringify(ov));
  } else {
    const list = customCategories();
    const i = list.findIndex((c) => c.key === key);
    if (i < 0) throw new Error('Category not found');
    const c = list[i];
    if (patch.label !== undefined) c.label = String(patch.label).trim() || c.label;
    if (patch.icon !== undefined) c.icon = String(patch.icon).trim() || c.icon;
    if (patch.defaultUnit !== undefined) c.defaultUnit = String(patch.defaultUnit).trim() || 'pcs';
    if (patch.fields !== undefined) c.fields = sanitizeFields(patch.fields);
    if (patch.nameTemplate !== undefined) c.nameTemplate = String(patch.nameTemplate);
    if (patch.compatKeys !== undefined) c.compatKeys = Array.isArray(patch.compatKeys) ? patch.compatKeys.map(String) : undefined;
    setSetting('custom_categories', JSON.stringify(list));
  }
  invalidateCategories();
}

export function resetCategory(key: string): void {
  if (!BUILTIN_KEYS.has(key)) throw new Error('Only built-in categories can be reset');
  const ov = categoryOverrides(); delete ov[key]; setSetting('category_overrides', JSON.stringify(ov)); invalidateCategories();
}

export function addCategory(input: any): Category {
  const label = String(input?.label || '').trim();
  if (!label) throw new Error('Name is required');
  let key = slug(String(input?.key || label));
  const taken = new Set([...BUILTIN_KEYS, ...customCategories().map((c) => c.key)]);
  let base = key, n = 2; while (taken.has(key)) key = `${base}_${n++}`;
  const c: CustomCategory = { key, label, icon: String(input?.icon || '📦').trim() || '📦', defaultUnit: String(input?.defaultUnit || 'pcs').trim() || 'pcs', fields: sanitizeFields(input?.fields), nameTemplate: String(input?.nameTemplate || '') };
  setSetting('custom_categories', JSON.stringify([...customCategories(), c]));
  invalidateCategories();
  return getCategory(key)!;
}

export function deleteCategory(key: string): void {
  if (BUILTIN_KEYS.has(key)) throw new Error('Built-in categories can be hidden but not deleted');
  setSetting('custom_categories', JSON.stringify(customCategories().filter((c) => c.key !== key)));
  invalidateCategories();
}

/** Equipment kinds, with icons and the part slots we suggest for each. */
export const EQUIPMENT_KINDS = [
  { key: 'printer', label: '3D printer', icon: '🖨️', slots: ['Nozzle', 'Bed surface', 'PTFE tube', 'Belts', 'Filament loaded', 'Extruder gears', 'Fan'] },
  { key: 'cnc', label: 'CNC router / mill', icon: '⚙️', slots: ['Bit / end mill', 'Collet', 'Spoilboard', 'Spindle brushes', 'Belts'] },
  { key: 'laser', label: 'Laser cutter / engraver', icon: '🔦', slots: ['Lens', 'Mirror', 'Nozzle', 'Honeycomb bed', 'Tube'] },
  { key: 'soldering', label: 'Soldering / electronics', icon: '🔌', slots: ['Tip', 'Sponge', 'Heater'] },
  { key: 'power_tool', label: 'Power tool', icon: '🪚', slots: ['Blade / disc', 'Bit', 'Battery', 'Brushes', 'Sandpaper'] },
  { key: 'hand_tool', label: 'Hand tool', icon: '🔧', slots: ['Blade', 'Bit'] },
  { key: 'other', label: 'Other equipment', icon: '🧰', slots: ['Consumable'] },
];
