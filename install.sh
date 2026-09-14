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

apt_updated=0
apt_update_once() {
  [ "$apt_updated" -eq 1 ] && return
  apt-get update
  apt_updated=1
}

# Major version of the installed node, or 0 if there isn't one.
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed 's/v//;s/\..*//'
}

# Debian 13 (trixie) — the deploy target — ships Node 20.19 in its own repos
# (npm is packaged separately), which already satisfies the >=18 requirement.
# Prefer it: it avoids adding a third-party repo and piping a remote script to
# bash as root. NodeSource stays as the fallback for older/other distros.
if [ "$(node_major)" -lt 18 ]; then
  apt_update_once
  # nodejs only — npm is handled separately below, once the version is known
  # good. Installing the distro npm here would conflict with the NodeSource
  # package on older distros, where it bundles its own.
  apt-get install -y nodejs || true

  if [ "$(node_major)" -lt 18 ]; then
    echo "Distro node is missing or older than 18 — falling back to NodeSource."
    apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi

if [ "$(node_major)" -lt 18 ]; then
  echo "Could not install Node 18+. Install it manually, then re-run this script." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  apt_update_once
  apt-get install -y npm
fi

if ! command -v git >/dev/null 2>&1; then
  apt_update_once
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
