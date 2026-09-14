#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/hasan-ismail/hasanismail.dev-website.git"
INSTALL_DIR="/opt/hasanismail-site"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || apt-get install -y git

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install --omit=dev

cp hasanismail-site.service /etc/systemd/system/hasanismail-site.service
systemctl daemon-reload
systemctl enable --now hasanismail-site

echo
echo "Installed to $INSTALL_DIR — service is running on :3300"
echo "Still to do: edit config.json + public/app.js (DISCORD_USER_ID), then:"
echo "  systemctl restart hasanismail-site"
