/**
 * Offline licensing.
 *
 * A license file is JSON:
 *   { "format": "workshop-inventory-license/1", "payload": {...}, "signature": "<base64>" }
 *
 * The payload is signed with the vendor's Ed25519 private key (see keygen.ts). The app
 * ships with only the PUBLIC key (keys/public.pem) and verifies the signature on import.
 * No network access is involved, so it works on an air-gapped workshop PC.
 *
 * Without a valid license the app runs in "Free" mode with the limits in FREE_LIMITS.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting, deleteSetting, installId } from './db.js';

export const LICENSE_FORMAT = 'workshop-inventory-license/1';

export interface LicensePayload {
  id: string;             // unique license id
  licensee: string;       // customer name
  email: string;
  product: string;        // "workshop-inventory"
  issued_at: string;      // ISO date
  expires_at: string | null; // ISO date or null for perpetual
  install_id: string | null; // bind to one installation, or null for any
  features: string[];     // e.g. ["pro"]
  seats: number;
}

export interface LicenseFile {
  format: string;
  payload: LicensePayload;
  signature: string;
}

/** What the Free (unlicensed) tier can do. Tweak to taste. */
export const FREE_LIMITS = {
  maxItems: 30,
  maxChannels: 0,       // notification channels (SMTP/Discord/...) are a paid feature
  csvImportExport: false,
  maxProjects: 3,
  maxEquipment: 3,
};

export const PRO_LIMITS = {
  maxItems: Infinity,
  maxChannels: Infinity,
  csvImportExport: true,
  maxProjects: Infinity,
  maxEquipment: Infinity,
};

export interface LicenseStatus {
  licensed: boolean;
  tier: 'free' | 'pro';
  reason?: string;           // why not licensed (expired, invalid, none)
  licensee?: string;
  email?: string;
  expires_at?: string | null;
  days_left?: number | null;
  license_id?: string;
  install_id: string;
  limits: typeof FREE_LIMITS;
  public_key_present: boolean;
}

const PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY || path.join(process.cwd(), 'keys', 'public.pem');

let cachedPublicKey: crypto.KeyObject | null | undefined;

export function loadPublicKey(): crypto.KeyObject | null {
  if (cachedPublicKey !== undefined) return cachedPublicKey;
  try {
    const pem = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
    cachedPublicKey = crypto.createPublicKey(pem);
  } catch {
    cachedPublicKey = null;
  }
  return cachedPublicKey;
}

/** Deterministic JSON so signer and verifier hash identical bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function signPayload(payload: LicensePayload, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
}

export function verifySignature(file: LicenseFile, publicKey: crypto.KeyObject): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(file.payload)), publicKey, Buffer.from(file.signature, 'base64'));
  } catch {
    return false;
  }
}

/** Parse + validate a license file. Throws a human-readable Error if anything is wrong. */
export function validateLicense(input: unknown, opts: { checkInstall?: boolean } = { checkInstall: true }): LicenseFile {
  let file: LicenseFile;
  if (typeof input === 'string') {
    try { file = JSON.parse(input); } catch { throw new Error('License file is not valid JSON.'); }
  } else {
    file = input as LicenseFile;
  }
  if (!file || file.format !== LICENSE_FORMAT) throw new Error('This is not a Workshop Inventory license file.');
  if (!file.payload || typeof file.signature !== 'string') throw new Error('License file is incomplete.');

  const pub = loadPublicKey();
  if (!pub) throw new Error('This build has no public key (keys/public.pem), so licenses cannot be verified.');
  if (!verifySignature(file, pub)) throw new Error('License signature is invalid. The file may have been edited or was issued for a different product build.');

  const p = file.payload;
  if (p.product !== 'workshop-inventory') throw new Error(`License is for a different product (${p.product}).`);
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) throw new Error(`License expired on ${p.expires_at.slice(0, 10)}.`);
  if (opts.checkInstall && p.install_id && p.install_id !== installId()) {
    throw new Error(`License is bound to install ID ${p.install_id}, but this installation is ${installId()}.`);
  }
  return file;
}

export function importLicense(input: unknown): LicenseStatus {
  const file = validateLicense(input);
  setSetting('license', JSON.stringify(file));
  return licenseStatus();
}

export function removeLicense(): void {
  deleteSetting('license');
}

export function licenseStatus(): LicenseStatus {
  const base = { install_id: installId(), public_key_present: !!loadPublicKey() };
  const raw = getSetting('license');
  if (!raw) return { ...base, licensed: false, tier: 'free', reason: 'No license installed.', limits: FREE_LIMITS };
  try {
    const file = validateLicense(raw);
    const p = file.payload;
    const days_left = p.expires_at ? Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 86_400_000) : null;
    return {
      ...base, licensed: true, tier: 'pro', licensee: p.licensee, email: p.email, expires_at: p.expires_at,
      days_left, license_id: p.id, limits: PRO_LIMITS,
    };
  } catch (e) {
    // keep the stored file so the user can see why it stopped working
    let licensee: string | undefined; let expires_at: string | null | undefined;
    try { const f = JSON.parse(raw) as LicenseFile; licensee = f.payload?.licensee; expires_at = f.payload?.expires_at; } catch { /* ignore */ }
    return { ...base, licensed: false, tier: 'free', reason: (e as Error).message, licensee, expires_at, limits: FREE_LIMITS };
  }
}

export function limits() {
  return licenseStatus().limits;
}
