# Workshop Inventory — developer & vendor guide

Self-hosted inventory for makers (hardware, CNC tooling, 3D-printer nozzles, filament, electronics, consumables) with gridfinity-aware locations, project BOMs, low-stock alerts to user-configured channels, and offline Ed25519 licensing you control.

**Stack:** Node 20+, TypeScript, Express, SQLite (better-sqlite3), vanilla JS front end (no build step for the UI).

```
src/
  index.ts          server entry, routing, auth gate
  db.ts             SQLite schema + settings helpers
  categories.ts     ← item categories, their spec fields and auto-naming (edit to add your own)
  stock.ts          adjustStock(): every quantity change, movement history, threshold alerts
  notify.ts         notification channels: smtp, discord, slack, ntfy, webhook
  license.ts        license file format, verification, free-tier limits
  keygen.ts         VENDOR tool: create keys, issue/verify/email licenses
  auth.ts           optional UI password
  routes/           REST API (items, locations, projects, orders, system)
public/             index.html, app.js, style.css
scripts/            package.mjs (release builder), start.sh / start.bat (customer launchers)
CUSTOMER-README.md  shipped to customers as README.md
```

## Develop

```bash
npm install
npm run dev          # tsx watch, http://localhost:3100
npm run build        # compile to dist/
npm start
```

Data lives in `./data/inventory.db` (override with `DATA_DIR`). `PORT` defaults to 3100.

## Licensing — how it works

- You run `keygen init` **once**. It creates `keys/private.pem` (secret, back it up) and `keys/public.pem` (ships with the app).
- `keygen issue` writes a signed `*.license.json`: a JSON payload (licensee, email, expiry, optional install binding) plus an Ed25519 signature over the canonical JSON.
- The app only has the public key. On import it checks the signature, product, expiry and (if set) the install ID. Nothing phones home.
- Without a valid license the app runs in Free mode: `FREE_LIMITS` in `src/license.ts` (30 items, 3 projects, no notification channels, no CSV). Change those numbers to taste.
- If you ever re-run `init`, every license you've issued stops working — the tool refuses unless you pass `--force`.

```bash
npm run build
npm run keygen -- init
npm run keygen -- issue --name "Jane Doe" --email jane@example.com --expires never
npm run keygen -- issue --name "Bob" --email bob@example.com --expires 2027-12-31 --install-id AB12-CD34-EF56-7890
npm run keygen -- verify licenses/jane-doe-WI-XXXX.license.json
npm run keygen -- list
```

### Emailing the license

Either attach the file to an email yourself, or set `SMTP_*` in your environment (see `.env.example`) and run:

```bash
npm run keygen -- send licenses/jane-doe-WI-XXXX.license.json
```

It sends a short email with the file attached and import instructions. Add `--to`, `--subject` or `--body` to override.

### Binding to an installation (optional)

The customer's Install ID is shown under Settings → License (and in the server log). Issue with `--install-id` to lock the license to that machine. Leave it off for a license that works on any install.

## Distribution: GitHub repo → releases → one-line install

```
 you: npm version minor && git push
            │
            ▼
 GitHub Actions (release.yml) sees a new version on main, tags it and builds:
   • workshop-inventory.tar.gz   ← install.sh downloads .../releases/latest/download/…
   • workshop-inventory-X.Y.Z.zip (Windows/Mac users)
   • ghcr.io/<you>/workshop-inventory:latest (Docker)
            │
            ▼
 users: curl -fsSL https://raw.githubusercontent.com/<you>/workshop-inventory/main/install.sh | sudo bash
        sudo workshop-inventory update       (or the dashboard tells them a new version exists)
```

### One-time setup

1. Create a GitHub repo (public is simplest — the installer and Docker image are then reachable without tokens; the code being visible doesn't weaken licensing because the private key never leaves your machine).
2. Replace `OWNER` with your GitHub user/org in: `install.sh`, `package.json` (`repository.url`), `docker-compose.yml`, `CUSTOMER-README.md`.
3. `npm run keygen -- init`, then **commit `keys/public.pem`** (the release build fails without it). Back up `keys/private.pem` — it is git-ignored and must never be committed.
4. Push to `main`. The Release workflow needs no secrets; GitHub's built-in token is enough for releases and GHCR.

### Publishing an update

```bash
# make changes, commit…
npm version patch        # or minor / major — bumps package.json (+ a local tag you can ignore)
git push                 # the version change on main triggers .github/workflows/release.yml
```

The workflow creates tag `vX.Y.Z` on GitHub, builds, and publishes. (Pushing a `vX.Y.Z` tag yourself also works, as does "Run workflow" in the Actions tab.) A few minutes later the release exists and every installation offers the update (dashboard banner + `sudo workshop-inventory update`). If the update changes the database, add a function to `MIGRATIONS` in `src/db.ts`; it runs once on first start of the new version.

### Local release build (no GitHub)

```bash
npm run package
```

Creates `release/workshop-inventory-<version>/`, `workshop-inventory.tar.gz` (and a `.zip` if `zip` is installed) containing `dist/` (minus keygen), `public/`, `keys/public.pem`, `install.sh`, launchers, Dockerfile and the customer README — never the private key, your ledger or `licenses/`. Install a local tarball on a server with `sudo bash install.sh --local workshop-inventory.tar.gz`.

### What install.sh does

Installs Node 22 from NodeSource if Node ≥ 20 isn't present → creates a `workshop` system user → downloads the release tarball → `npm ci` in a temp dir (so a failed update leaves the old version running) → swaps it into `/opt/workshop-inventory` → writes `/etc/default/workshop-inventory` (first run only) → installs the `workshop-inventory` CLI → writes and starts a hardened systemd unit. Data lives in `/var/lib/workshop-inventory`.

## Notifications

Channels are stored per installation in the `channels` table and configured by the end user under Settings → Notifications. Supported out of the box:

| type      | config keys                                   |
|-----------|-----------------------------------------------|
| `smtp`    | host, port, secure, user, pass, from, to       |
| `discord` | webhook_url                                    |
| `slack`   | webhook_url                                    |
| `ntfy`    | url (default https://ntfy.sh), topic, token    |
| `webhook` | url, method, headers (JSON), body_template     |

Alerts fire only when stock **crosses** the threshold (or hits zero), so taking three screws from 11 → 8 with a minimum of 10 alerts once, not on every subsequent use. Restocking above the minimum clears the open alert. There's also a manual "send digest" of everything currently low.

To add a channel type: add a case to `sendToChannel()` in `src/notify.ts`, an entry in `CHANNEL_TYPES`, and its fields in `fieldDefs` inside `channelDialog()` in `public/app.js`.

## Categories

`src/categories.ts` defines each category's spec fields (rendered as the form), default unit and the `buildName()` used when the user leaves the name blank — so `{thread: M3, length: 12, kind: Socket Head Cap Screw}` becomes "M3 x 12mm Socket Head Cap Screw" and `{diameter: 3.175, cut_length: 12, flutes: 1, tool_type: Flat End Mill}` becomes "3.175mm x 12mm 1FL Flat End Mill". Add a category and the UI, search and CSV import pick it up automatically.

## API summary

All JSON, under `/api`. When a UI password is set, everything except `GET /api/meta` and `POST /api/auth/login` needs the session cookie.

| Method & path                         | Purpose |
|---------------------------------------|---------|
| `GET /items?q=&category=&status=&location_id=&sort=` | search |
| `POST /items`, `PUT /items/:id`, `DELETE /items/:id` | CRUD (name auto-generated if blank) |
| `POST /items/:id/adjust {delta, reason, ref}` | take/add stock, fires alerts |
| `POST /items/:id/locate {location_id, grid_row, grid_col}` | put in a cell |
| `GET/POST/PUT/DELETE /locations`, `POST /locations/bulk` | cabinets, drawers, grids |
| `GET /locations/:id` | location with children, items and cell occupancy |
| `GET/POST/PUT/DELETE /projects`, `POST /projects/:id/parts`, `POST /projects/:id/build {count}` | BOMs |
| `GET /orders?status=`, `POST /orders`, `POST /orders/:id/receive`, `POST /orders/:id/cancel`, `GET /orders/suggest` | ordering |
| `GET /alerts`, `POST /alerts/:id/ack`, `POST /alerts/ack-all`, `POST /alerts/digest` | alerts |
| `GET/POST/PUT/DELETE /channels`, `POST /channels/:id/test` | notification channels |
| `GET/POST/DELETE /license` | license status / import / remove |
| `GET /export.csv`, `POST /import.csv` | CSV |
| `GET /dashboard`, `GET /meta`, `PUT /settings`, `POST /auth/*` | misc |
