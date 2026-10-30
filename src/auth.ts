/**
 * Optional UI password. If none is set, the app is open (fine for a LAN-only install).
 * Set one in Settings -> Security to require login. Sessions are random tokens kept in
 * memory and in an httpOnly cookie; restarting the server logs everyone out.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getSetting, setSetting, deleteSetting } from './db.js';

const sessions = new Set<string>();
const COOKIE = 'wi_session';

export function passwordIsSet(): boolean {
  return !!getSetting('ui_password_hash');
}

export function setPassword(pw: string): void {
  if (!pw) { deleteSetting('ui_password_hash'); return; }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  setSetting('ui_password_hash', `${salt}:${hash}`);
}

export function checkPassword(pw: string): boolean {
  const stored = getSetting('ui_password_hash');
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function login(res: Response): void {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86_400_000 });
}

export function logout(req: Request, res: Response): void {
  const t = req.cookies?.[COOKIE];
  if (t) sessions.delete(t);
  res.clearCookie(COOKIE);
}

export function isAuthed(req: Request): boolean {
  if (!passwordIsSet()) return true;
  const t = req.cookies?.[COOKIE];
  return !!t && sessions.has(t);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Login required', login_required: true });
}
