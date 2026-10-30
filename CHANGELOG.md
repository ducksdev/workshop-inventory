# Changelog

Release notes shown to users in **Settings → Updates**. Add a section for each version before running `npm version …`.
Keep it in plain language — users read this to decide whether to update.

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
