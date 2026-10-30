# Workshop Inventory

Self-hosted stock control for your workshop: screws and fasteners, CNC cutting tools, 3D-printer nozzles, filament, electronics, consumables and stock material. Runs on your own computer; open it from any browser on your network, including your phone.

## Install & run

### Ubuntu / Debian server or Raspberry Pi (recommended)

One line, as root. Installs Node.js if needed and sets up a service that starts on boot:

```bash
curl -fsSL https://raw.githubusercontent.com/ducksdev/workshop-inventory/main/install.sh | sudo bash
```

Add `-s -- --port 8080` at the end to change the port. Afterwards:

```bash
sudo workshop-inventory update     # install the latest version (data & settings are kept)
sudo workshop-inventory status     # is it running?
sudo workshop-inventory logs       # follow the log
sudo workshop-inventory backup     # consistent copy of the database into /var/backups
sudo workshop-inventory config     # change port etc.
```

Data: `/var/lib/workshop-inventory/inventory.db`. Config: `/etc/default/workshop-inventory`.

### Docker

```bash
mkdir workshop-inventory && cd workshop-inventory
curl -fsSL https://raw.githubusercontent.com/ducksdev/workshop-inventory/main/docker-compose.yml -o docker-compose.yml
docker compose up -d          # update later with: docker compose pull && docker compose up -d
```

### Windows / Mac (desktop)

Download the `.zip` from the Releases page, unzip, and double-click `start.bat` (Windows) or run `./start.sh` (Mac). Needs Node.js 20+ from https://nodejs.org. Data is in the `data` folder next to the app.

In every case the app prints its address — normally http://localhost:3100. From your phone on the same Wi-Fi use `http://<server-ip>:3100`.

### Updating

When a newer version exists the dashboard tells you. **Settings → Updates** shows what's new; on a server install there's an **Update now** button that installs it and restarts for you (your data and settings are kept). Docker: `docker compose pull && docker compose up -d`. Desktop: download the new zip over the old folder.

## The basic workflow

1. **Search** for a part (press `/` to jump to search): "m3 12", "1fl", "0.4 nozzle".
2. **None in stock?** Click **Order** — it goes on your order list with the supplier link.
3. **When it arrives**, go to Orders → **Received**, type the quantity and pick the drawer cell it lives in (e.g. Drawer 1, row 3, column 9). Stock goes up, location is set.
4. **Use some** — hit **−** on the item, or build a **Project** (a bill of materials) to deduct every part in one go. Stock goes down.
5. **At the alert level** (you set it per item, e.g. 10) you get an alert on the dashboard and, with a licence, on email / Discord / Slack / ntfy / any webhook.

## Locations

Create a cabinet, then add drawers with a grid (rows × columns) matching your gridfinity baseplate. Every item can sit in a cell like **R3 C9**, and the Locations page draws the drawer so you can see what's where and which cells are free. Click an empty cell to put something in it.

## Alerts

Set an alert level on each item ("Alert when ≤"). When stock drops to it, an alert appears on the dashboard. Under **Settings → Notifications** you can also have alerts sent to email (SMTP), Discord, Slack, ntfy (phone push) or any custom webhook — each channel has a **Test** button.

## Licence

The free version is fully functional but limited to 30 items, 3 projects and dashboard-only alerts. A licence unlocks unlimited items and projects, notification channels, and CSV import/export.

After purchasing you'll receive a `.license.json` file by email. Open **Settings → License**, choose the file (or paste its contents) and click **Import**. No internet connection is needed. If you're asked for your **Install ID** when purchasing, it's shown on the same page.

## Password & backups

By default anyone on your network can open the app. Set a password under **Settings → Security** if you'd like to lock it.

Everything is stored in one SQLite file (`inventory.db`). On a server, `sudo workshop-inventory backup` writes a consistent copy to `/var/backups`; on desktop just copy the `data` folder. **Settings → Data** also exports/imports CSV.

## API

Everything is a plain JSON API under `/api/…`, so you can wire up a barcode scanner, Home Assistant or a script:

```
POST /api/items/12/adjust   {"delta": -3, "reason": "consume", "ref": "Spool holder"}
GET  /api/items?q=m3%2012
POST /api/orders            {"item_id": 12, "quantity": 100}
```
