#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Workshop Inventory — installer / updater for Ubuntu & Debian (systemd)
#
#   Install (latest release):
#     curl -fsSL https://raw.githubusercontent.com/ducksdev/workshop-inventory/main/install.sh | sudo bash
#
#   Options (after "bash -s --"):
#     --port 8080            listen port (default 3100; kept on update)
#     --version v1.2.0       install a specific release instead of latest
#     --repo owner/repo      GitHub repository (default baked in below)
#     --local file.tar.gz    install from a local release tarball (offline)
#
#   Afterwards:
#     workshop-inventory update | status | logs | restart | backup | version
#
# Re-running the installer is always safe: it keeps your data and settings and
# just swaps in the new version. Data lives in /var/lib/workshop-inventory.
# ------------------------------------------------------------------------------
set -euo pipefail

REPO="${WI_REPO:-ducksdev/workshop-inventory}"
APP_DIR=/opt/workshop-inventory
DATA_DIR=/var/lib/workshop-inventory
CONF=/etc/default/workshop-inventory
SERVICE=workshop-inventory
RUN_USER=workshop
PORT=""
VERSION="latest"
LOCAL_TARBALL=""
ASSET="workshop-inventory.tar.gz"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --local) LOCAL_TARBALL="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '  \033[36m➜\033[0m %s\n' "$*"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  curl -fsSL … | sudo bash"
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu (apt). For other systems use Docker: see README."

HAVE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then HAVE_SYSTEMD=1; fi

bold "Workshop Inventory installer"

# ---- 1. base packages --------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
need_pkgs=""
for p in curl ca-certificates tar; do dpkg -s "$p" >/dev/null 2>&1 || need_pkgs="$need_pkgs $p"; done
if [ -n "$need_pkgs" ]; then
  info "Installing:$need_pkgs"
  apt-get update -qq && apt-get install -y -qq $need_pkgs >/dev/null
fi

# ---- 2. Node.js 20+ ------------------------------------------------------------
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  info "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js install failed. Install Node 20+ manually and re-run."
fi
NODE_BIN="$(command -v node)"
ok "Node $(node -v) at $NODE_BIN"

# ---- 3. system user + directories ----------------------------------------------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  ok "Created system user '$RUN_USER'"
fi
mkdir -p "$DATA_DIR"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---- 4. fetch release ----------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "$LOCAL_TARBALL" ]; then
  [ -f "$LOCAL_TARBALL" ] || die "No such file: $LOCAL_TARBALL"
  cp "$LOCAL_TARBALL" "$TMP/$ASSET"
  info "Using local tarball $LOCAL_TARBALL"
else
  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  fi
  info "Downloading $URL"
  curl -fL --retry 3 -o "$TMP/$ASSET" "$URL" || die "Download failed. Does the release exist at https://github.com/$REPO/releases ?"
fi
mkdir -p "$TMP/app"
tar -xzf "$TMP/$ASSET" -C "$TMP/app" --strip-components=1
[ -f "$TMP/app/dist/index.js" ] || die "Tarball doesn't look like a Workshop Inventory release."
NEW_VERSION="$("$NODE_BIN" -p "require('$TMP/app/package.json').version")"
OLD_VERSION=""
[ -f "$APP_DIR/package.json" ] && OLD_VERSION="$("$NODE_BIN" -p "require('$APP_DIR/package.json').version" 2>/dev/null || true)"

# ---- 5. install dependencies (in temp dir, so a failure leaves the old install intact)
info "Installing dependencies for v$NEW_VERSION"
( cd "$TMP/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ) || die "npm ci failed"

# ---- 6. swap into place ---------------------------------------------------------
if [ "$HAVE_SYSTEMD" -eq 1 ] && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  systemctl stop "$SERVICE"; info "Stopped running service"
fi
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$TMP/app" "$APP_DIR"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
rm -rf "$APP_DIR.old"
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then ok "Updated v$OLD_VERSION → v$NEW_VERSION"; else ok "Installed v$NEW_VERSION to $APP_DIR"; fi

# ---- 7. config (created once; never overwritten) --------------------------------
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
# Workshop Inventory settings. Edit, then: sudo workshop-inventory restart
PORT=${PORT:-3100}
HOST=0.0.0.0
DATA_DIR=$DATA_DIR
LICENSE_PUBLIC_KEY=$APP_DIR/keys/public.pem
NODE_ENV=production
EOF
  ok "Wrote $CONF"
elif [ -n "$PORT" ]; then
  sed -i "s/^PORT=.*/PORT=$PORT/" "$CONF"; ok "Set PORT=$PORT in $CONF"
fi
# shellcheck disable=SC1090
. "$CONF"

# ---- 8. CLI helper ---------------------------------------------------------------
cat > /usr/local/bin/workshop-inventory <<EOF
#!/usr/bin/env bash
# Workshop Inventory management command.
set -e
REPO="$REPO"; APP_DIR="$APP_DIR"; DATA_DIR="$DATA_DIR"; SERVICE="$SERVICE"; RUN_USER="$RUN_USER"
case "\${1:-help}" in
  update)
    shift
    echo "Fetching installer from github.com/\$REPO…"
    if curl -fsSL "https://raw.githubusercontent.com/\$REPO/main/install.sh" -o /tmp/wi-install.sh; then
      bash /tmp/wi-install.sh --repo "\$REPO" "\$@"; rm -f /tmp/wi-install.sh
    else
      echo "Could not download installer; using the local copy."; bash "\$APP_DIR/install.sh" --repo "\$REPO" "\$@"
    fi ;;
  status)  systemctl status "\$SERVICE" --no-pager ;;
  logs)    journalctl -u "\$SERVICE" -n "\${2:-100}" -f ;;
  restart) systemctl restart "\$SERVICE" && echo "Restarted." ;;
  stop)    systemctl stop "\$SERVICE" ;;
  start)   systemctl start "\$SERVICE" ;;
  backup)
    out="\${2:-/var/backups/workshop-inventory-\$(date +%Y%m%d-%H%M%S).db}"
    mkdir -p "\$(dirname "\$out")"
    (cd "\$APP_DIR" && "$NODE_BIN" -e "const D=require('better-sqlite3');new D('\$DATA_DIR/inventory.db',{readonly:true}).backup('\$out').then(()=>console.log('Backup written to \$out'))")
    ;;
  version) node -p "require('\$APP_DIR/package.json').version" ;;
  config)  \${EDITOR:-nano} $CONF && systemctl restart "\$SERVICE" && echo "Restarted with new config." ;;
  *) cat <<USAGE
workshop-inventory <command>
  update [--version vX.Y.Z]   install the latest (or given) release, keep data & settings
  status | logs | restart | stop | start
  backup [file]               consistent copy of the database (default: /var/backups/…)
  config                      edit $CONF and restart
  version
USAGE
  ;;
esac
EOF
chmod +x /usr/local/bin/workshop-inventory
# keep a copy of this installer for offline "update" fallback
[ -f "$0" ] && cp "$0" "$APP_DIR/install.sh" 2>/dev/null || true

# ---- 9. systemd service ----------------------------------------------------------
if [ "$HAVE_SYSTEMD" -eq 1 ]; then
  cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Workshop Inventory
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
EnvironmentFile=$CONF
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/dist/index.js
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE" >/dev/null 2>&1
  sleep 1
  if systemctl is-active --quiet "$SERVICE"; then
    ok "Service '$SERVICE' is running"
  else
    journalctl -u "$SERVICE" -n 20 --no-pager || true
    die "Service failed to start — see log above."
  fi
else
  info "systemd not detected; service not installed. Start manually with:"
  info "  cd $APP_DIR && PORT=${PORT:-3100} DATA_DIR=$DATA_DIR $NODE_BIN dist/index.js"
fi

# ---- 10. done ---------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
bold "Done!  Open  http://${IP:-localhost}:${PORT}   (or http://localhost:${PORT} on this machine)"
echo "  Manage:  workshop-inventory update | status | logs | backup"
echo "  Data:    $DATA_DIR    Config: $CONF"
echo "  Tip: set a password under Settings → Security if this server is reachable beyond your LAN."
