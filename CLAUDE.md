# hasanismail.dev-website

Personal site for hasanismail.dev: bio, linktree-style links, a Discord
presence badge, and a live status grid for self-hosted services.

## Architecture

- `server.js` — Express backend. Runs an HTTP/TCP check against every
  service in `config.json` on a 60s interval, persists daily up/total
  counts to `data/history.json`, and serves `GET /api/status`.
- `public/` — static frontend. Polls `/api/status` and the Lanyard API
  (Discord presence) every 30s and renders them client-side.
- `config.json` — the list of monitored services (see below).

## Hard invariant — do not break this

`/api/status` and everything in `public/` must never expose internal
hostnames, IPs, or ports. The API only ever returns: service name,
`status` (`up`/`down`/`unknown`), `latencyMs`, `lastChecked`, `uptime24h`,
`uptime30d`, and an optional `publicUrl`. All host/port/IP data stays
server-side in `config.json` and `server.js`. Any change that threads a
`target` value (or anything derived from it) into an API response or
frontend file is a bug, not a feature.

## Adding or editing a monitored service

Edit `config.json` only — the frontend renders whatever the array
contains, no code changes needed. Each entry:

```json
{ "id": "slug", "name": "Display name", "type": "http", "target": "http://192.168.1.X:PORT", "publicUrl": "https://optional.example" }
```

`type: "tcp"` uses `"target": "host:port"` instead, for services with no
HTTP endpoint.

## Design system — "bioluminescence"

Bright canvas, not dark. Changes to `public/style.css` should stay
inside this system rather than drifting toward a generic dark/SaaS look:

- Base background near-white/cool-tinted (`--bg: #f7fbfc`), never a dark
  page background.
- Three accent hues only — teal `#22d3c4`, violet `#8b5cf6`, pink
  `#ec4899` — used for the ambient background blooms and status/presence
  glow. Don't introduce a fourth accent or apply these as flat card
  fills; they're glows and borders, not backgrounds.
- Glass panels (`.glass`: translucent white + `backdrop-filter: blur`)
  for every bounded surface — identity card, link pills, status tiles.
  No opaque cards, no drop shadows.
- Type: Outfit for headings, Plus Jakarta Sans for body, JetBrains Mono
  for numeric readouts only (uptime %, latency, location). Keep mono
  usage restrained — it's for data, not labels.
- One wave-line SVG divider (`.wave`) is the signature motif. It appears
  once, between the identity block and the links section. Don't repeat
  it elsewhere or add other decorative shapes.
- Ambient bloom motion only (`.bloom` drift animation); no hover
  animations beyond a small translateY lift on links, and everything
  respects `prefers-reduced-motion`.

## Configuring Discord presence

`public/app.js` — set `DISCORD_USER_ID`. This uses Lanyard
(api.lanyard.rest), which only tracks presence for members of its own
Discord server (discord.gg/lanyard) — join once, no token needed.

## Local dev

```
npm install
npm start
```

Visits `http://localhost:3300`. Checks will report "down" for anything
not reachable from wherever the process is actually running.

## Deployment target

CT 124 on node 1 (`lxcpool`) — Debian 13, 2 vCPU / 2GB / 32GB,
hostname `hasanismail.dev`, unprivileged, DHCP. Runs as the
`hasanismail-site` systemd unit on port 3300, fronted by a Cloudflare
Tunnel (same pattern as `openmasjidsolutions.org` / `openmasjidos`).
See `install.sh` and `hasanismail-site.service`.
