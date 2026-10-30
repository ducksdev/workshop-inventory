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
import { DATA_DIR, getSetting } from './db.js';

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

export type InstallMode = 'service' | 'docker' | 'manual';

/**
 * How this copy was installed decides whether it can update itself:
 *  - service: install.sh on Linux. The app writes a request file (UPDATE_TRIGGER, set in
 *             /etc/default/workshop-inventory); a root systemd path unit runs the updater.
 *  - docker:  the container image is immutable; user runs `docker compose pull && up -d`.
 *  - manual:  desktop zip; user downloads the new zip.
 */
export function installMode(): InstallMode {
  if (process.env.UPDATE_TRIGGER) return 'service';
  if (fs.existsSync('/.dockerenv') || process.env.RUNNING_IN_DOCKER) return 'docker';
  return 'manual';
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  url: string | null;
  notes: string | null;
  published_at: string | null;
  checked_at: string | null;
  enabled: boolean;
  repo: string | null;
  install_mode: InstallMode;
  error?: string;
}

// ---- self-update (service mode) ----------------------------------------------

const STATUS_PATH = path.join(DATA_DIR, 'update.status');
const LOG_PATH = path.join(DATA_DIR, 'update.log');

export interface UpdateStatus {
  state: 'idle' | 'requested' | 'running' | 'success' | 'failed';
  target?: string;
  requested?: string;
  started?: string;
  finished?: string;
  from?: string;
  to?: string;
  message?: string;
  log: string[];
}

export function updateStatus(): UpdateStatus {
  let st: Partial<UpdateStatus> = { state: 'idle' };
  try { st = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { /* no status yet */ }
  let log: string[] = [];
  try { log = fs.readFileSync(LOG_PATH, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(-60); } catch { /* no log */ }
  // a request nobody picked up (e.g. updater unit missing) shouldn't look "running" forever
  if ((st.state === 'requested' || st.state === 'running') && st.requested && Date.now() - new Date(st.requested).getTime() > 20 * 60 * 1000 && !st.started) {
    st = { ...st, state: 'failed', message: 'The updater did not start. Run `sudo workshop-inventory update` on the server (and check `systemctl status workshop-inventory-updater.path`).' };
  }
  return { state: 'idle', ...st, log } as UpdateStatus;
}

export function requestUpdate(target = 'latest'): UpdateStatus {
  const trigger = process.env.UPDATE_TRIGGER;
  if (!trigger) throw new Error('This installation cannot update itself. See the instructions for your install type.');
  const cur = updateStatus();
  if ((cur.state === 'requested' || cur.state === 'running') && cur.requested && Date.now() - new Date(cur.requested).getTime() < 20 * 60 * 1000) {
    throw new Error('An update is already in progress.');
  }
  if (!/^(latest|v?\d+\.\d+\.\d+)$/.test(target)) throw new Error('Invalid version');
  const now = new Date().toISOString();
  fs.writeFileSync(STATUS_PATH, JSON.stringify({ state: 'requested', target, requested: now, from: VERSION }));
  try { fs.unlinkSync(LOG_PATH); } catch { /* ignore */ }
  fs.writeFileSync(trigger, target + '\n');
  return updateStatus();
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
  const base: UpdateInfo = { current: VERSION, latest: null, update_available: false, url: null, notes: null, published_at: null, checked_at: null, enabled, repo, install_mode: installMode() };
  if (!enabled || !repo) return base;
  if (!force && cache && Date.now() - cache.at < TTL) return cache.info;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `workshop-inventory/${VERSION}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const rel = await res.json() as { tag_name: string; html_url: string; body?: string; published_at?: string };
    const info: UpdateInfo = {
      ...base, latest: rel.tag_name.replace(/^v/, ''), update_available: cmp(rel.tag_name, VERSION) > 0,
      url: rel.html_url, notes: (rel.body || '').slice(0, 6000), published_at: rel.published_at || null, checked_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), info };
    return info;
  } catch (e) {
    const info: UpdateInfo = { ...base, checked_at: new Date().toISOString(), error: (e as Error).message };
    cache = { at: Date.now() - TTL + 15 * 60 * 1000, info }; // retry in 15 min after a failure
    return info;
  }
}
