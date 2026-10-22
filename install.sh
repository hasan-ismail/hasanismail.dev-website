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

# Dedicated unprivileged account for the service. Idempotent.
if ! id -u "$SERVICE" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE"
fi

cd "$INSTALL_DIR"
npm install --omit=dev

# The unit runs as $SERVICE with ProtectSystem=strict, so data/ must exist and
# be writable by it before the first start.
mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE":"$SERVICE" "$INSTALL_DIR/data"

# Secrets file for the unit's EnvironmentFile=. Created once, root:root 0600,
# and NEVER overwritten — a re-run of this script is the upgrade path and must
# not wipe a token someone pasted in. The repo is public; the token never goes
# in config.json.
ENV_FILE="/etc/$SERVICE.env"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat >"$ENV_FILE" <<'ENVTEMPLATE'
# hasanismail-site secrets. Read by systemd as root; keep this file 0600.
#
# Homarr 2.0 API key, used server-side only to read Proxmox, UniFi and Pi-hole
# through Homarr's integration proxy. Create it in Homarr under
# Manage -> Tools -> API, ideally for a user that can see only those three
# integrations. Leave empty to run with config.json checks alone.
HOMARR_TOKEN=
# Optional: overrides config.json "homarr.url".
# HOMARR_URL=http://192.168.1.33:7575
#
# Discord webhook for the "Message me" form. Anyone with this URL can post to
# the channel, so it lives here and nowhere else. Without it, messages are
# still saved to /opt/hasanismail-site/data/contact-log.jsonl.
DISCORD_WEBHOOK_URL=
# Optional: raises the GitHub API ceiling from 60 to 5000 requests/hour.
# GITHUB_TOKEN=
ENVTEMPLATE
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
fi

cp "$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
# enable --now only *starts* an inactive unit. On a re-run the unit is already
# active, so without this restart the old code would keep serving.
systemctl restart "$SERVICE"

cat <<'NOTE'

Installed to /opt/hasanismail-site — service is running on :3300

Still to do:
  1. Put your Homarr API key (HOMARR_TOKEN=...) and Discord webhook
     (DISCORD_WEBHOOK_URL=...) in /etc/hasanismail-site.env to turn on the
     live homelab panels and the contact form.
  2. Confirm the service targets in config.json (internal IPs/ports).
  3. Set DISCORD_USER_ID in public/app.js, and join discord.gg/lanyard once.
  4. Point your Cloudflare Tunnel at this host's port 3300.

After editing any of those:
  systemctl restart hasanismail-site
NOTE
