#!/usr/bin/env node
/**
 * Vendor-side license tool. YOU keep this and the private key; customers never see it.
 *
 *   npm run keygen -- init                      create keys/private.pem + keys/public.pem (once)
 *   npm run keygen -- issue --name "Jane Doe" --email jane@example.com [--expires 2027-12-31|never]
 *                            [--install-id XXXX-XXXX-XXXX-XXXX] [--seats 1] [--out licenses/jane.json]
 *   npm run keygen -- verify licenses/jane.json
 *   npm run keygen -- send licenses/jane.json   email the license file (uses SMTP_* env vars)
 *   npm run keygen -- list                      show every license you've issued
 *
 * Ship keys/public.pem with the app. NEVER ship keys/private.pem.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { LICENSE_FORMAT, canonicalJson, signPayload, type LicenseFile, type LicensePayload } from './license.js';

const HELP = `Workshop Inventory license tool (vendor side)

  keygen init                      create keys/private.pem + keys/public.pem (run once)
  keygen issue --name "Jane Doe" --email jane@example.com
               [--expires 2027-12-31 | never] [--install-id XXXX-XXXX-XXXX-XXXX]
               [--seats 1] [--out licenses/jane.json]
  keygen verify <file>             check a license file's signature and expiry
  keygen send <file> [--to email]  email the license file (SMTP_HOST/PORT/USER/PASS/FROM env)
  keygen list                      show every license issued from this machine

Ship keys/public.pem with the app. NEVER ship keys/private.pem.`;

const KEYS_DIR = process.env.KEYS_DIR || path.join(process.cwd(), 'keys');
const PRIVATE_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_PATH = path.join(KEYS_DIR, 'public.pem');
const LEDGER_PATH = path.join(KEYS_DIR, 'issued.jsonl');

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = 'true';
    } else positional.push(a);
  }
  return { positional, flags };
}

function die(msg: string): never {
  console.error('Error: ' + msg);
  process.exit(1);
}

function cmdInit(force: boolean) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  if (fs.existsSync(PRIVATE_PATH) && !force) {
    die(`${PRIVATE_PATH} already exists. Re-running init would invalidate every license you've issued. Use --force if you really mean it.`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIVATE_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUBLIC_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Created\n  ${PRIVATE_PATH}  (SECRET - back it up, never ship it)\n  ${PUBLIC_PATH}   (ship this with the app)`);
}

function loadPrivate(): crypto.KeyObject {
  if (!fs.existsSync(PRIVATE_PATH)) die(`No private key at ${PRIVATE_PATH}. Run: keygen init`);
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_PATH, 'utf8'));
}

function cmdIssue(flags: Record<string, string>) {
  const name = flags.name || die('--name is required');
  const email = flags.email || die('--email is required');
  let expires: string | null = null;
  if (flags.expires && flags.expires !== 'never') {
    const d = new Date(flags.expires);
    if (isNaN(d.getTime())) die('--expires must be YYYY-MM-DD or "never"');
    d.setUTCHours(23, 59, 59, 0);
    expires = d.toISOString();
  }
  const payload: LicensePayload = {
    id: 'WI-' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    licensee: name,
    email,
    product: 'workshop-inventory',
    issued_at: new Date().toISOString(),
    expires_at: expires,
    install_id: flags['install-id'] || null,
    features: (flags.features || 'pro').split(',').map((s) => s.trim()).filter(Boolean),
    seats: parseInt(flags.seats || '1', 10),
  };
  const file: LicenseFile = { format: LICENSE_FORMAT, payload, signature: signPayload(payload, loadPrivate()) };

  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const out = flags.out || path.join(process.cwd(), 'licenses', `${safe}-${payload.id}.license.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(file, null, 2));
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify({ ...payload, file: out }) + '\n');

  console.log(`Issued ${payload.id} to ${name} <${email}>`);
  console.log(`  expires:    ${expires ? expires.slice(0, 10) : 'never'}`);
  console.log(`  install id: ${payload.install_id || 'any'}`);
  console.log(`  file:       ${out}`);
  console.log(`\nEmail this file to the customer; they import it under Settings -> License.`);
  return out;
}

function cmdVerify(file: string) {
  if (!file) die('usage: keygen verify <file>');
  const pub = crypto.createPublicKey(fs.readFileSync(PUBLIC_PATH, 'utf8'));
  const lic = JSON.parse(fs.readFileSync(file, 'utf8')) as LicenseFile;
  const ok = crypto.verify(null, Buffer.from(canonicalJson(lic.payload)), pub, Buffer.from(lic.signature, 'base64'));
  const expired = lic.payload.expires_at ? new Date(lic.payload.expires_at).getTime() < Date.now() : false;
  console.log(`${file}\n  signature: ${ok ? 'VALID' : 'INVALID'}\n  licensee:  ${lic.payload.licensee} <${lic.payload.email}>\n  expires:   ${lic.payload.expires_at?.slice(0, 10) || 'never'}${expired ? ' (EXPIRED)' : ''}\n  install:   ${lic.payload.install_id || 'any'}`);
  if (!ok) process.exit(2);
}

async function cmdSend(file: string, flags: Record<string, string>) {
  if (!file) die('usage: keygen send <file> [--to email]');
  const lic = JSON.parse(fs.readFileSync(file, 'utf8')) as LicenseFile;
  const to = flags.to || lic.payload.email;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_FROM) die('Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (and optionally SMTP_SECURE=true) in your environment.');
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: parseInt(SMTP_PORT || '587', 10), secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  const subject = flags.subject || 'Your Workshop Inventory license';
  const text = flags.body || [
    `Hi ${lic.payload.licensee},`,
    '',
    'Thanks for your purchase! Your Workshop Inventory license file is attached.',
    '',
    'To activate: open Workshop Inventory, go to Settings -> License, and import the attached file.',
    lic.payload.expires_at ? `This license is valid until ${lic.payload.expires_at.slice(0, 10)}.` : 'This is a perpetual license.',
    '',
    'Keep this email somewhere safe in case you need to reinstall.',
  ].join('\n');
  const info = await transport.sendMail({ from: SMTP_FROM, to, subject, text, attachments: [{ filename: path.basename(file), content: fs.readFileSync(file) }] });
  console.log(`Sent to ${to}: ${info.messageId}`);
}

function cmdList() {
  if (!fs.existsSync(LEDGER_PATH)) { console.log('No licenses issued yet.'); return; }
  const rows = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const r of rows) {
    console.log(`${r.id}  ${r.issued_at.slice(0, 10)}  ${(r.licensee as string).padEnd(24)} ${(r.email as string).padEnd(30)} exp:${r.expires_at ? r.expires_at.slice(0, 10) : 'never'}  ${r.install_id || 'any'}`);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = positional;
  switch (cmd) {
    case 'init': return cmdInit(flags.force === 'true');
    case 'issue': return void cmdIssue(flags);
    case 'verify': return cmdVerify(arg);
    case 'send': return cmdSend(arg, flags);
    case 'list': return cmdList();
    default:
      console.log(HELP);
  }
}

main().catch((e) => die(e.message));
