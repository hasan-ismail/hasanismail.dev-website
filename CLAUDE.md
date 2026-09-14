# hasanismail.dev-website

Personal site for hasanismail.dev: bio, linktree-style links, a Discord
presence badge, and a live status grid for self-hosted services.

Node + Express backend, vanilla HTML/CSS/JS frontend. **No framework, no
build step, no TypeScript, and exactly one dependency (`express`).** Keep
it that way — don't add a bundler, a CSS framework, or a client library.

## Architecture

- `server.js` — Express app. Checks every service in `config.json` on a
  60s interval, persists daily up/total aggregates to `data/history.json`,
  and serves `GET /api/status`.
- `public/` — static frontend. Polls `/api/status` and the Lanyard API
  (Discord presence) every 30s and renders both client-side.
- `config.json` — the list of monitored services.
- `data/history.json` — runtime state, gitignored. Safe to delete; it
  just resets uptime history.

---

## Hard invariant — do not break this

**`/api/status` and every file in `public/` must never expose `target`
from `config.json`, or anything derived from it — hostname, IP, port, or
path.** This is the entire reason the checker runs server-side. Do not
compromise it for convenience.

The response envelope is exactly:

```json
{ "services": [ { "id", "name", "status", "latencyMs", "lastChecked",
                  "uptime24h", "uptime30d", "publicUrl" } ],
  "generatedAt": "<ISO timestamp>" }
```

- `status` is `"up"` | `"down"` | `"unknown"`.
- `latencyMs` is `null` unless the last check succeeded.
- `lastChecked` is `null` until the first check completes.
- `uptime24h` / `uptime30d` are percentages to one decimal, or `null`
  with no data yet.
- `id` is a config slug, not host data — it is safe to expose.
- `publicUrl` is an intentionally public link, or `null`.

Any change that threads a `target` value into an API response or a file
under `public/` is a bug, not a feature. Logging targets server-side is
fine; sending them to a client is not. There is no route other than
`/api/status` and the static mount on `public/` — keep it that way, and
never add a static mount or a route that could serve `config.json`,
`data/`, or the repo root.

---

## Monitored services

Edit `config.json` only — the frontend renders whatever the array
contains, no code changes needed.

```json
{
  "services": [
    { "id": "unique-slug", "name": "Display name", "type": "http",
      "target": "http://192.168.1.X:PORT[/path]",
      "publicUrl": "https://optional-public-link.example" }
  ]
}
```

- `type: "http"` — GET with a 5s timeout. **Any status below 500 counts
  as up**, so a reachable-but-wrong path can read as a false green.
- `type: "tcp"` — opens `host:port` with a 5s timeout. Use this when
  there's no usable HTTP endpoint. `target` is `"host:port"`, no scheme.
- `publicUrl` is optional; it renders a "visit" link on the tile.

See the table in [README.md](README.md) for which of the current targets
have actually been verified.

### Two gotchas worth not rediscovering

1. **Self-signed certs break `http` checks.** Node's `fetch` rejects them
   (`DEPTH_ZERO_SELF_SIGNED_CERT`) even via an HTTP-to-HTTPS redirect, so
   the service reports a false "down". `rahima-aziz` is a `tcp` check for
   exactly this reason. Don't "fix" it back to `http`, and don't disable
   TLS verification globally.
2. **`uptime24h` is prorated, not a bucket sum.** Aggregates are
   per-UTC-day, so a true 24h window straddles two buckets. `uptime24h()`
   takes all of today plus the fraction of yesterday needed to fill the
   window. Summing both buckets outright would report a 24-48h window;
   using today alone collapses to a single sample right after UTC
   midnight (which reads as 100% or 0% at ~20:00 local). Leave the
   proration in place.

---

## Design system — "bioluminescence"

**Bright canvas, not dark.** This is decided. Do not reinterpret it, and
do not let it drift toward a generic dark/SaaS dashboard look. All values
below are the actual contract, not suggestions.

### Color tokens (`public/style.css` `:root`)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f7fbfc` | near-white, cool-tinted page base. **Never dark.** |
| `--ink` | `#0b2530` | body text |
| `--ink-muted` | `#52707c` | secondary text |
| `--glass` | `rgba(255,255,255,0.6)` | panel fill |
| `--glass-strong` | `rgba(255,255,255,0.8)` | presence pill fill |
| `--glass-border` | `rgba(11,37,48,0.09)` | hairline border |
| `--teal` | `#22d3c4` | accent |
| `--violet` | `#8b5cf6` | accent |
| `--pink` | `#ec4899` | accent |
| `--up` | `#0e9f6e` | semantic: up / online |
| `--down` | `#e11d48` | semantic: down / dnd |
| `--unknown` | `#94a3b8` | semantic: unknown / offline |
| `--idle` | `#d9a441` | semantic: idle |

**Three accent hues only** — teal, violet, pink. They are used *solely*
for the ambient background blooms and for glow rings. Never as a flat
card fill, never as a background, and never add a fourth.

The ink pair and the semantic four (`--up` / `--down` / `--unknown` /
`--idle`) are a **separate, non-negotiable token group** — they are not
accents and don't count against the three-accent rule.

### Layout

- `.layout` is a centered grid, `max-width: 980px`,
  `padding: 48px 24px 96px`.
- **Desktop (`min-width: 860px`)**: `grid-template-columns: 260px 1fr`,
  `align-items: start`, `padding-top: 80px`. `.identity` is
  `position: sticky; top: 80px`.
- **Below 860px**: single column. The identity card comes first because
  it's first in DOM order — don't "fix" this with `order` or flex hacks.

> **Do not set `overflow-x: hidden` on `body`.** It makes body a scroll
> container, which silently kills `position: sticky` on the identity
> panel. The rule is `html { overflow-x: clip }` for this reason. The
> blooms are `position: fixed` and create no scrollable overflow anyway.

### Background blooms

Three blurred circular divs, `position: fixed`, `border-radius: 50%`,
`filter: blur(90px)`, `pointer-events: none`, `z-index: 0`, each parked
off-canvas at a different corner:

| | size | position | color | opacity | animation |
|---|---|---|---|---|---|
| `.bloom-1` | 480px | top `-160px`, left `-120px` | teal | 0.28 | `drift1 26s` |
| `.bloom-2` | 420px | top `30%`, right `-160px` | violet | 0.22 | `drift2 32s` |
| `.bloom-3` | 380px | bottom `-140px`, left `20%` | pink | 0.18 | `drift1 30s reverse` |

Both keyframes are `ease-in-out infinite` and animate `transform:
translate` only (~30-40px). These are the **only** continuously animating
elements on the page.

### Glass panels

Every bounded surface uses `.glass`: `background: var(--glass)`,
`backdrop-filter: blur(18px)` (plus the `-webkit-` prefix), and
`1px solid var(--glass-border)`. **No opaque card fills. No drop shadows
anywhere.**

Border radii: **28px** identity card (the `.glass` default) · **999px**
link pills · **20px** status tiles.

### Type

Imported from Google Fonts in one `@import` at the top of `style.css`:

- **Outfit** 500/600 — headings (`h1, h2, h3`) only.
- **Plus Jakarta Sans** 400/500 — body default, set on `html, body`.
- **JetBrains Mono** 400/500 — **numeric data only.**

Mono is allowed on exactly three selectors: `.location`,
`.status-readout dd`, and `.status-meta`. It must **not** be used for
labels, headings, link text, or the presence badge. If you add a mono
usage, it had better be a number.

### Signature motif

**One** thin wavy SVG line (`.wave`), teal `currentColor`,
`opacity: 0.45`, `height: 22px`, placed **once** at the identity-to-links
transition. Do not repeat it, and do not add other decorative shapes.

### Presence badge

A `--glass-strong` pill inside the identity card: colored dot + status
text. The dot glow ring is `box-shadow: 0 0 0 5px <color at 0.16 alpha>`.

| `discord_status` | class | dot | glow ring |
|---|---|---|---|
| online | `.dot.is-online` | `--up` | `rgba(14,159,110,0.16)` |
| idle | `.dot.is-idle` | `--idle` | `rgba(217,164,65,0.16)` |
| dnd | `.dot.is-dnd` | `--down` | `rgba(225,29,72,0.16)` |
| offline | `.dot.is-offline` | `--unknown` | **none** |

The absent glow on offline/unknown is intentional — it's how "no signal"
reads. Don't add one for consistency.

### Status cards

A `.glass` tile per service (20px radius): a header with the service name
plus a small status dot, then a row of **exactly three** mono readouts —
24h uptime, 30d uptime, latency — and an optional `.status-visit` link
when `publicUrl` is set.

Structural details that are load-bearing, not incidental:

- `.status-grid` uses `minmax(260px, 1fr)` tracks. Narrower tracks force
  the three readouts to wrap, which leaves tiles ragged and misaligned
  against each other.
- `.status-readout` is a **3-column grid**, not flex-wrap. A fixed
  three-track layout keeps every tile's numbers on the same baseline;
  wrapping cannot guarantee that.
- `.status-card` is a flex column and `.status-visit` has `margin-top:
  auto`, so the visit link anchors to the bottom and tiles with and
  without one still line up.

The status dot uses the **same glow pattern as the presence dot**:
`0 0 0 5px` at 0.16 alpha, green when up, red when down, and **no glow**
when unknown.

Don't add a fourth readout to that row — it's a fixed three. Freshness
goes in the single `#status-meta` line below the grid, which reports the
most recent `lastChecked` across all services (not `generatedAt`, which
would always read "0s ago").

### Motion

Motion lives in one clearly marked `MOTION SYSTEM` block at the bottom of
`style.css`. Only `transform`, `opacity` and `filter` are animated, so
everything stays on the compositor.

**The safety rule — read before adding any entrance animation.** An
element's *base* CSS state is its *final* state, and the keyframe animates
**from** the hidden state using `backwards` fill:

```css
.thing { animation: rise-in 0.8s var(--ease-out-expo) backwards; }
@keyframes rise-in { from { opacity: 0; transform: translateY(18px); } }
```

Never write `opacity: 0` into an element's base rule. If you do, the
reduced-motion override (`animation: none`) strands it permanently
invisible. Written the way above, killing animations leaves the page fully
rendered. This is verifiable: force reduced motion and the page is complete
immediately, with no stagger.

What moves:

- **Entrance** — identity card, section headings, link pills and status
  tiles rise and fade in, staggered ~70ms apart. Link pills stagger via
  `:nth-child`; status tiles are built by JS, which sets `--i` to the tile
  index and CSS reads `calc(0.6s + var(--i) * 0.07s)`.
- **Blooms** — the only *continuous* page animation: a slow translate +
  gentle scale (`drift1` / `drift2`, 26–32s). Keep the scale amplitude
  small (≤1.06) or they expand past their intended footprint and the
  near-white base stops reading as the canvas.
- **The wave** — draws itself in via `stroke-dashoffset` (the path carries
  `pathLength="1"`, so the dash maths is resolution-independent), then
  breathes slowly in opacity. Still exactly one wave.
- **Pointer glow** — `.cursor-glow`, a soft teal radial that eases toward
  the cursor (~0.12 lerp per frame) so it trails rather than snaps.
  Desktop pointers only: CSS hides it under `(hover: none)` /
  `(pointer: coarse)`, and `initCursorGlow()` bails on reduced motion.
- **Link pills** — `translateY(-3px)`, teal border, and a diagonal sheen
  sweeping across via `::before`, plus an arrow that nudges in on the
  anchor's `::after`.
- **Status tiles** — `translateY(-3px)` with a teal edge on hover. Still
  **no drop shadows** — the lift is border + background, not shade.
- **Live pulse** — an expanding ring on `up` / `online` dots only. It is
  deliberately *not* applied to down/offline: firing it on every failing
  service at once is noise, not signal.
- **Number transitions** — `setReadout()` in `app.js` tweens a readout
  from its previous value (ease-out cubic, 550ms) and flashes it teal via
  `.is-changing`. It falls back to setting text directly on first render,
  on null values, and under reduced motion.

`@media (prefers-reduced-motion: reduce)` disables **all** animation and
transition, including pseudo-elements, and hides the pointer glow. Keep
that rule first-class — it is non-negotiable.

---

## Configuring Discord presence

Set `DISCORD_USER_ID` at the top of `public/app.js`. Presence comes from
[Lanyard](https://api.lanyard.rest), which only reports for members of
its own Discord — join <https://discord.gg/lanyard> once. No token
needed. While the placeholder is unchanged the badge reads "presence not
configured" and no request is made.

## Local dev

```bash
npm install
npm start
```

Then open <http://localhost:3300>. Checks run from wherever the process
runs, so anything unreachable from your machine shows as "down" locally.

## Deployment target

CT 124 on node 1 (`lxcpool`) — Debian 13, 2 vCPU / 2 GB / 32 GB, hostname
`hasanismail.dev`, unprivileged, DHCP (currently 192.168.1.200). Runs as
the `hasanismail-site` systemd unit on port 3300, fronted by a Cloudflare
Tunnel — same pattern as `openmasjidsolutions.org` / `openmasjidos`. See
`install.sh` and `hasanismail-site.service`. GitHub repo:
`hasan-ismail/hasanismail.dev-website` (public).

Re-running `install.sh` is the upgrade path: it pulls, reinstalls deps,
and restarts the unit.
