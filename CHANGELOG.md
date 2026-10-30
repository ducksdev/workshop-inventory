# Changelog

Release notes shown to users in **Settings → Updates**. Add a section for each version before running `npm version …`.
Keep it in plain language — users read this to decide whether to update.

## 1.1.1

- **Custom categories.** Settings → Categories lets you rename the built-in categories (name, icon, default unit), hide ones you don't use, and add your own with their own spec fields and an auto-name template — e.g. a "Bearings" category with inner/outer/width fields that names items "8x22x7mm 2RS Bearing".
- Hidden categories disappear from the filter chips and the add-item form; existing items in them are unaffected.

## 1.1.0

- **Equipment.** New section for your 3D printers, CNC, laser, soldering gear and tools: make/model/serial, location, purchase info, status and a run-hours counter you bump after each session.
- **Fitted parts.** Record what's in each machine — nozzle, bed surface, bit, collet… Fitting takes the part from stock; swapping retires the old one into the machine's history. Each slot shows how many *compatible* spares you have (e.g. only MK8 nozzles for an MK8 hotend).
- **Maintenance.** Tasks with an interval in hours and/or days ("Lubricate Z every 200 h", "Clean bed every 7 days"). Due tasks appear on the dashboard, in Alerts, and go to your notification channels like low stock. Mark done to reset.
- Per-machine log of fits, removals, hours and notes. Items show which machine they're fitted in.
- Free version includes up to 3 pieces of equipment.

## 1.0.4

- Side-by-side cards (Settings, Dashboard, Orders) now line up at the top.

## 1.0.3

- Dialogs with a form (add item, order, receive, notification channel…) no longer close when you click outside them, so you can't lose what you've typed by accident. Use ✕, Cancel or Escape.
- Settings tabs wrap instead of showing a scrollbar.

## 1.0.2

- Updater now fetches its installer from the release itself, so updates are never served a stale script. No visible changes.

## 1.0.1

- **Update from inside the app.** Settings → Updates shows what's new and, on server installs, an *Update now* button that installs the new version and restarts for you. Docker and desktop installs get the right instructions instead.
- Dashboard banner when a new version is available, with a link to the release notes.
- Installer: adds the background updater used by the button. Run `sudo workshop-inventory update` once to get it on existing installs — after that, the button works.
- Updater log and status are visible in the app if an update fails.

## 1.0.0

- First release: hardware, cutting tools, 3D-printer nozzles, filament, electronics, consumables and stock material.
- Gridfinity-aware drawers with a visual cell map.
- Orders → receive into a cell; project bills of materials that deduct stock in one go.
- Low-stock alerts to the dashboard, email, Discord, Slack, ntfy or any webhook.
- Offline licence files, CSV import/export, optional password, one-line Ubuntu installer, Docker image.
