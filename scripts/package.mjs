/**
 * Builds a customer-distributable release folder (and zip if `zip` is installed).
 * Includes compiled code, UI, the PUBLIC key and a customer README.
 * Excludes: src, keys/private.pem, keys/issued.jsonl, licenses/, data/, node_modules.
 *
 *   npm run package
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `workshop-inventory-${pkg.version}`;
const out = path.join(root, 'release', name);

if (!fs.existsSync(path.join(root, 'keys', 'public.pem'))) {
  console.error('keys/public.pem not found. Run `npm run keygen -- init` first so the build can verify licenses.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'keys'), { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
fs.rmSync(path.join(out, 'dist', 'keygen.js'), { force: true }); // vendor-only tool
fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, 'keys', 'public.pem'), path.join(out, 'keys', 'public.pem'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(out, 'package-lock.json'));
fs.copyFileSync(path.join(root, 'Dockerfile'), path.join(out, 'Dockerfile'));
fs.copyFileSync(path.join(root, 'docker-compose.yml'), path.join(out, 'docker-compose.yml'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'install.sh'), path.join(out, 'install.sh'));
for (const f of ['start.sh', 'start.bat']) fs.copyFileSync(path.join(root, 'scripts', f), path.join(out, f));
fs.chmodSync(path.join(out, 'start.sh'), 0o755);
fs.chmodSync(path.join(out, 'install.sh'), 0o755);

const custPkg = { ...pkg, scripts: { start: 'node dist/index.js' }, devDependencies: undefined, bin: undefined };
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(custPkg, null, 2));

// Always: a tarball with a stable name (what install.sh downloads from .../releases/latest/download/)
const rel = path.dirname(out);
execSync(`tar -czf "workshop-inventory.tar.gz" "${name}"`, { cwd: rel });
fs.copyFileSync(path.join(rel, 'workshop-inventory.tar.gz'), path.join(rel, `${name}.tar.gz`));
// Optionally: a zip for Windows/Mac users, if `zip` is installed
let zipped = '';
try { execSync(`rm -f "${name}.zip" && zip -qr "${name}.zip" "${name}"`, { cwd: rel, stdio: 'ignore' }); zipped = path.join(rel, `${name}.zip`); } catch { /* zip not available */ }
console.log(`Release folder: ${out}\nTarball:        ${path.join(rel, 'workshop-inventory.tar.gz')}  (+ ${name}.tar.gz)${zipped ? `\nZip:            ${zipped}` : ''}`);
