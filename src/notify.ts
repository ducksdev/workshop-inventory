/**
 * Notification channels. Each channel is a row in `channels` with a type and a JSON config.
 * All are configured by the end user in Settings; nothing is hard-coded.
 *
 *   smtp     { host, port, secure, user, pass, from, to }
 *   discord  { webhook_url }
 *   slack    { webhook_url }
 *   ntfy     { url, topic, token? }        e.g. https://ntfy.sh + "my-workshop"
 *   webhook  { url, method?, headers?, body_template? }
 *              body_template may use {{title}} {{message}} {{kind}} {{item.name}} {{item.quantity}}
 *              {{item.min_quantity}} {{item.unit}} {{item.location}} {{item.id}} {{item.sku}} {{json}}
 */
import nodemailer from 'nodemailer';
import { db } from './db.js';

export interface ChannelRow {
  id: number;
  name: string;
  type: 'smtp' | 'discord' | 'slack' | 'ntfy' | 'webhook';
  config: string;
  enabled: number;
  last_error: string;
}

export interface Notification {
  kind: 'low' | 'out' | 'test' | 'info';
  title: string;
  message: string;
  item?: {
    id: number; name: string; sku: string; quantity: number; min_quantity: number; unit: string; location: string;
    supplier?: string; supplier_url?: string;
  };
}

export const CHANNEL_TYPES = [
  { type: 'smtp', label: 'Email (SMTP)', fields: ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'] },
  { type: 'discord', label: 'Discord webhook', fields: ['webhook_url'] },
  { type: 'slack', label: 'Slack webhook', fields: ['webhook_url'] },
  { type: 'ntfy', label: 'ntfy push', fields: ['url', 'topic', 'token'] },
  { type: 'webhook', label: 'Custom webhook', fields: ['url', 'method', 'headers', 'body_template'] },
] as const;

const colorFor = (kind: Notification['kind']) => (kind === 'out' ? 0xef4444 : kind === 'low' ? 0xf59e0b : 0x3b82f6);
const emojiFor = (kind: Notification['kind']) => (kind === 'out' ? '🚫' : kind === 'low' ? '⚠️' : kind === 'test' ? '🔔' : 'ℹ️');

function fill(template: string, n: Notification): string {
  const flat: Record<string, string> = {
    title: n.title, message: n.message, kind: n.kind, json: JSON.stringify(n),
    'item.id': String(n.item?.id ?? ''), 'item.name': n.item?.name ?? '', 'item.sku': n.item?.sku ?? '',
    'item.quantity': String(n.item?.quantity ?? ''), 'item.min_quantity': String(n.item?.min_quantity ?? ''),
    'item.unit': n.item?.unit ?? '', 'item.location': n.item?.location ?? '',
    'item.supplier': n.item?.supplier ?? '', 'item.supplier_url': n.item?.supplier_url ?? '',
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => (k in flat ? JSON.stringify(flat[k]).slice(1, -1) : ''));
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
}

export async function sendToChannel(ch: ChannelRow, n: Notification): Promise<void> {
  const cfg = JSON.parse(ch.config || '{}') as Record<string, string>;
  const detail = n.item
    ? `\n${n.item.name}${n.item.sku ? ` [${n.item.sku}]` : ''}\nIn stock: ${n.item.quantity} ${n.item.unit} (alert at ${n.item.min_quantity})${n.item.location ? `\nLocation: ${n.item.location}` : ''}${n.item.supplier ? `\nSupplier: ${n.item.supplier}${n.item.supplier_url ? ' ' + n.item.supplier_url : ''}` : ''}`
    : '';

  switch (ch.type) {
    case 'smtp': {
      const transport = nodemailer.createTransport({
        host: cfg.host, port: parseInt(cfg.port || '587', 10), secure: cfg.secure === 'true' || cfg.secure === '1',
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      });
      await transport.sendMail({ from: cfg.from, to: cfg.to, subject: `${emojiFor(n.kind)} ${n.title}`, text: `${n.message}${detail}` });
      return;
    }
    case 'discord': {
      await postJson(cfg.webhook_url, {
        username: 'Workshop Inventory',
        embeds: [{ title: `${emojiFor(n.kind)} ${n.title}`, description: n.message, color: colorFor(n.kind),
          fields: n.item ? [
            { name: 'Item', value: n.item.name, inline: false },
            { name: 'In stock', value: `${n.item.quantity} ${n.item.unit}`, inline: true },
            { name: 'Alert at', value: `${n.item.min_quantity}`, inline: true },
            ...(n.item.location ? [{ name: 'Location', value: n.item.location, inline: true }] : []),
            ...(n.item.supplier ? [{ name: 'Supplier', value: n.item.supplier_url ? `[${n.item.supplier}](${n.item.supplier_url})` : n.item.supplier, inline: false }] : []),
          ] : [],
          timestamp: new Date().toISOString() }],
      });
      return;
    }
    case 'slack': {
      await postJson(cfg.webhook_url, { text: `${emojiFor(n.kind)} *${n.title}*\n${n.message}${detail}` });
      return;
    }
    case 'ntfy': {
      const base = (cfg.url || 'https://ntfy.sh').replace(/\/$/, '');
      const headers: Record<string, string> = { Title: n.title, Priority: n.kind === 'out' ? 'high' : 'default', Tags: n.kind === 'out' ? 'no_entry' : n.kind === 'low' ? 'warning' : 'bell' };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      if (n.item?.supplier_url) { headers.Click = n.item.supplier_url; }
      const res = await fetch(`${base}/${cfg.topic}`, { method: 'POST', headers, body: `${n.message}${detail}` });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    }
    case 'webhook': {
      let headers: Record<string, string> = {};
      if (cfg.headers) { try { headers = JSON.parse(cfg.headers); } catch { throw new Error('headers must be a JSON object'); } }
      const body = cfg.body_template ? fill(cfg.body_template, n) : JSON.stringify(n);
      if (!('content-type' in Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])))) headers['content-type'] = 'application/json';
      const res = await fetch(cfg.url, { method: (cfg.method || 'POST').toUpperCase(), headers, body });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
      return;
    }
    default:
      throw new Error(`Unknown channel type ${ch.type}`);
  }
}

/** Fan a notification out to every enabled channel. Errors are recorded per channel, never thrown. */
export async function broadcast(n: Notification): Promise<void> {
  const channels = db.prepare('SELECT * FROM channels WHERE enabled = 1').all() as ChannelRow[];
  await Promise.all(channels.map(async (ch) => {
    try {
      await sendToChannel(ch, n);
      db.prepare("UPDATE channels SET last_error = '' WHERE id = ?").run(ch.id);
    } catch (e) {
      const msg = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${(e as Error).message}`.slice(0, 500);
      db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run(msg, ch.id);
      console.error(`[notify] ${ch.name} (${ch.type}) failed: ${(e as Error).message}`);
    }
  }));
}
