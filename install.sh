#!/usr/bin/env bash
# One-shot installer for the hasanismail.dev site.
# Safe to re-run: it pulls the latest code, refreshes deps, and restarts.
set -euo pipefail

REPO_URL="https://github.com/hasan-ismail/hasanismail.dev-website.git"
INSTALL_DIR="/opt/hasanismail-site"
SERVICE="hasanismail-site"

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer writes to /opt and /etc/systemd/system — run it as root." >&2
  exit 1
fi

# Node 20 via NodeSource if node is missing or older than 18.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v git >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install --omit=dev

cp "$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
# enable --now only *starts* an inactive unit. On a re-run the unit is already
# active, so without this restart the old code would keep serving.
systemctl restart "$SERVICE"

cat <<'NOTE'

Installed to /opt/hasanismail-site — service is running on :3300

Still to do:
  1. Confirm the service targets in config.json (internal IPs/ports).
  2. Set DISCORD_USER_ID in public/app.js, and join discord.gg/lanyard once.
  3. Point your Cloudflare Tunnel at this host's port 3300.

After editing either file:
  systemctl restart hasanismail-site
NOTE
