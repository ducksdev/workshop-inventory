/**
 * Version info and a lightweight "is there a newer release?" check against GitHub Releases.
 *
 * The check is anonymous (public GitHub API), cached for 6 hours, never blocks a request,
 * and can be turned off by the user (Settings → General → "Check for updates").
 * The repo comes from package.json "repository" or the UPDATE_REPO env var ("owner/repo").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Pkg { version: string; repository?: string | { url?: string } }
const pkg: Pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

export const VERSION: string = pkg.version;

export function repoSlug(): string | null {
  if (process.env.UPDATE_REPO) return process.env.UPDATE_REPO;
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = r.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  url: string | null;
  notes: string | null;
  checked_at: string | null;
  enabled: boolean;
  repo: string | null;
  error?: string;
}

let cache: { at: number; info: UpdateInfo } | null = null;
const TTL = 6 * 60 * 60 * 1000;

function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const repo = repoSlug();
  const enabled = getSetting('update_check', '1') !== '0';
  const base: UpdateInfo = { current: VERSION, latest: null, update_available: false, url: null, notes: null, checked_at: null, enabled, repo };
  if (!enabled || !repo) return base;
  if (!force && cache && Date.now() - cache.at < TTL) return cache.info;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `workshop-inventory/${VERSION}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const rel = await res.json() as { tag_name: string; html_url: string; body?: string };
    const info: UpdateInfo = {
      ...base, latest: rel.tag_name.replace(/^v/, ''), update_available: cmp(rel.tag_name, VERSION) > 0,
      url: rel.html_url, notes: (rel.body || '').slice(0, 2000), checked_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), info };
    return info;
  } catch (e) {
    const info: UpdateInfo = { ...base, checked_at: new Date().toISOString(), error: (e as Error).message };
    cache = { at: Date.now() - TTL + 15 * 60 * 1000, info }; // retry in 15 min after a failure
    return info;
  }
}
