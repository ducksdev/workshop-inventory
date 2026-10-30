import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, installId } from './db.js';
import { requireAuth } from './auth.js';
import { licenseStatus } from './license.js';
import { items } from './routes/items.js';
import { locations } from './routes/locations.js';
import { projects } from './routes/projects.js';
import { orders } from './routes/orders.js';
import { system } from './routes/system.js';
import { equipment } from './routes/equipment.js';
import { startMaintenanceScheduler } from './equipment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '20mb' }));

// Public endpoints (login flow + meta so the UI knows whether to show the login screen)
app.use('/api', (req, res, next) => {
  const isPublic = (req.method === 'GET' && req.path === '/meta') || (req.method === 'POST' && req.path === '/auth/login');
  return isPublic ? system(req, res, next) : next();
});

// Everything else under /api requires auth when a password is set
app.use('/api', requireAuth);
app.use('/api/items', items);
app.use('/api/locations', locations);
app.use('/api/projects', projects);
app.use('/api/orders', orders);
app.use('/api/equipment', equipment);
app.use('/api', system);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// Static UI
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

startMaintenanceScheduler();
app.listen(PORT, HOST, () => {
  const lic = licenseStatus();
  console.log(`Workshop Inventory listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  data:    ${DATA_DIR}`);
  console.log(`  install: ${installId()}`);
  console.log(`  license: ${lic.licensed ? `Pro (${lic.licensee}${lic.expires_at ? ', expires ' + lic.expires_at.slice(0, 10) : ', perpetual'})` : `Free (${lic.reason})`}`);
});
