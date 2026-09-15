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
- `public/` — static frontend. Polls `/api/status` every 30s, and receives
  Discord presence over the Lanyard **WebSocket** so it updates instantly.
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
{ "nodes": [ { "id", "label" } ],
  "services": [ { "id", "name", "node", "status", "latencyMs", "lastChecked",
                  "uptime24h", "uptime30d", "publicUrl" } ],
  "generatedAt": "<ISO timestamp>" }
```

- `status` is `"up"` | `"down"` | `"unknown"`.
- `latencyMs` is `null` unless the last check succeeded.
- `lastChecked` is `null` until the first check completes.
- `uptime24h` / `uptime30d` are percentages to one decimal, or `null`
  with no data yet.
- `id` is a config slug, not host data — it is safe to expose.
- `node` / `nodes` are display labels ("Node 1 — lxcpool"), not addresses.
- `publicUrl` is an intentionally public link, or `null`.

The handler builds this object field by field on purpose. Don't "simplify"
it by spreading the config entry (`...svc`) into the response — that would
carry `target` straight out to every visitor.

Any change that threads a `target` value into an API response or a file
under `public/` is a bug, not a feature. Logging targets server-side is
fine; sending them to a client is not.

The only routes are `/api/status`, `/api/github` and the static mount on
`public/`. Never add a static mount or a route that could serve
`config.json`, `data/`, or the repo root.

`/api/github` returns `{ user, total, days: [{ date, count, level }] }` —
all already-public GitHub data, no addresses. It exists as a server-side
proxy for two reasons: it caches upstream for an hour so the page doesn't
hit a third-party API once per visitor, and it serves the last good
response if upstream fails, so a brief outage doesn't blank the graph.
The username comes from `config.github`.

---

## Monitored services

Edit `config.json` only — the frontend renders whatever the array
contains, no code changes needed.

```json
{
  "nodes": [
    { "id": "node1", "label": "Node 1 — lxcpool" }
  ],
  "services": [
    { "id": "unique-slug", "name": "Display name", "node": "node1",
      "type": "http", "target": "http://192.168.1.X:PORT[/path]",
      "publicUrl": "https://optional-public-link.example" }
  ]
}
```

- `type: "http"` — GET with a 5s timeout. **Any status below 500 counts
  as up**, so a reachable-but-wrong path can read as a false green.
- `type: "tcp"` — opens `host:port` with a 5s timeout. Use this when
  there's no usable HTTP endpoint. `target` is `"host:port"`, no scheme.
- `node` must match a `nodes[].id`; the front end renders one grid per
  node, in the order `nodes` declares. A service with an unknown `node`
  gets an unlabelled group, so keep the two in sync.
- `publicUrl` is optional; it renders a "visit" link on the tile.

**Checks run concurrently**, with `CHECK_CONCURRENCY = 8` and a
`checksRunning` guard. This isn't premature optimisation: sequentially, 26
services at up to 5s each is ~130s, which overruns the 60s interval and
makes rounds overlap and double-count. If the service list grows a lot,
raise the pool rather than the interval.

### How the current targets were established

Every port in `config.json` was found by scanning the hosts from `pct list`
across ~40 common self-hosted ports, then HTTP-probing each open port with
the same `fetch` call `server.js` uses. None of them are guesses — but
re-verify after moving a service: a wrong port reads as "down", and a
reachable-but-wrong *path* reads as **up** (any status below 500 counts),
which produces a falsely green tile.

Services that are `tcp` rather than `http`, and why. Don't "upgrade" these
to `http` without re-testing:

| service | why tcp |
|---|---|
| `openmasjidos`, `mycontainer` | redirect to HTTPS with a self-signed cert; `fetch` rejects it (`DEPTH_ZERO_SELF_SIGNED_CERT`) and reports a false "down". |
| `proxmox-backup-server` | HTTPS on 8007, self-signed, same failure. |
| `vaultwarden` | answers on 8000 but not with HTTP/1.1 — `fetch` throws "Response does not match the HTTP/1.1 protocol". |
| `anytype-server` | only 6379 (Redis) is exposed; there is no HTTP endpoint. |
| `osint`, `postiebot` | no network service at all — only SSH. The check is on :22, so a green tile means "the container is alive", not "the app is healthy". |

**`openmasjid-solutions` is the one deliberate exception to local-only
checking.** Nothing listens on CT 122 locally — the container is up (SSH
answers) but no port in 1–10000 serves the app, so a LAN check reported a
permanent false "down". It therefore targets the **public** URL
`https://openmasjidsolutions.org` (200, ~280ms), which is what visitors
actually care about anyway.

This does not weaken the invariant: that target *is* public, identical to
its own `publicUrl`, so there is nothing to leak. Every other service is
checked over the LAN. Don't take this as licence to point the rest at their
public hostnames — checking through the Cloudflare Tunnel would measure the
tunnel, not the service, and would hide a LAN-side outage behind a cached
edge response.


### Two gotchas worth not rediscovering

1. **Self-signed certs break `http` checks.** Node's `fetch` rejects them
   (`DEPTH_ZERO_SELF_SIGNED_CERT`) even via an HTTP-to-HTTPS redirect, so
   the service reports a false "down". `openmasjidos` is a `tcp` check for
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

## Design system — "deep bioluminescence"

**Dark, underwater ground.** The site was originally a light "bright canvas"
design; it was deliberately inverted to dark at the owner's request, and the
jellyfish motif comes from their Discord avatar. Do not drift it back toward a
light theme, and do not let it become a generic grey SaaS dark — the ground is
a blue-black ocean, not neutral charcoal.

Every value below is the actual contract. All colour lives in `:root`;
components never hardcode a hex.

### Contrast rule — read before changing any colour

Contrast was computed against **`--glass-strong`**, not `--glass`. That is the
binding constraint: `--glass-strong` is the fill for `.pc-presence` and
`.pc-btn` (both base state),
`.link-item:hover` and `.status-card:hover`, and it composites *lighter* than
`--glass` over every backdrop. Measuring against `--glass` overstates every
ratio by roughly a full point.

Consequence: **`--down` and `--unknown` are not body-text colours.** Over
`--glass-strong` on a bloom they land at ~3.8–4.3:1. They are dot, ring and
border colours only. `--violet` and `--pink` are worse still and are ambient
only — if either ever needs to carry a glyph, add a lightened sibling token
rather than using the accent directly.

Body copy is `--ink` (17.4:1 on `--bg`) or `--ink-muted` (10.0:1); `--teal` is
also text-safe at 10.3:1.

### Colour tokens

| Token | Value | Role |
|---|---|---|
| `--bg` | `#060f1a` | abyssal blue-black page ground |
| `--bg-deep` | `#03070e` | vignette edge of the body radial |
| `--bg-lift` | `#0b1a2b` | opaque raised surface (image placeholders) |
| `--ink` | `#e9f6f5` | body text, cyan-cast near-white |
| `--ink-muted` | `#a2c0ca` | secondary text |
| `--ink-rgb` | `233 246 245` | channel triplet for `rgb(… / α)` |
| `--glass` | `rgba(16,33,50,0.58)` | panel fill — a navy that **darkens** its backdrop |
| `--glass-strong` | `rgba(26,50,72,0.74)` | elevated/hover fill |
| `--glass-border` | `rgba(154,226,235,0.14)` | panel hairline |
| `--glass-border-strong` | `rgba(154,226,235,0.22)` | hover hairline |
| `--glass-highlight` | `rgba(196,242,248,0.07)` | inset top line — this is what sells "glass" on dark |
| `--glass-blur` | `20px` | backdrop blur |
| `--glass-saturate` | `135%` | stops dark translucency going muddy grey |
| `--teal` | `#22d3c4` | accent 1 (also text-safe) |
| `--violet` | `#8b5cf6` | accent 2, **ambient only** |
| `--pink` | `#ec4899` | accent 3, **ambient only** |
| `--up` | `#22d07f` | up / online |
| `--down` | `#ff5c74` | down / dnd |
| `--unknown` | `#8aa2b2` | unknown / offline |
| `--idle` | `#e6b054` | idle / away |
| `--ring-up` / `--ring-down` / `--ring-idle` | `… 0.24` | dot glow rings |
| `--veil` | `rgba(5,12,20,0.45)` | the contrast scrim (see below) |
| `--sheen` | `rgba(34,211,196,0.16)` | link sweep gradient stop |
| `--border-accent` | `rgba(34,211,196,0.55)` | accent edge on hover |
| `--cursor-glow` | `rgba(34,211,196,0.17)` | pointer light |
| `--wave-opacity` | `0.85` | base opacity of the wave motif |
| `--focus-ring` | `#e6b054` | focus outline |

Teal, violet and pink remain the core accents, used as ambient glow (blooms,
jellyfish tint, glow rings) and never as a flat card fill. The ink pair and
the semantic four are a separate, non-negotiable group.

**Two deliberate additions to the original three-accent rule** — the owner
asked for more colour; the page read as monochrome teal. Both are scoped, not
a licence to add colour anywhere:

1. **Per-link brand accents.** Each `.link-item` sets `--brand` / `--brand-rgb`
   (`link--github` `#c9d6e4`, `link--oms` `#22d07f`, `link--web` `#22d3c4`,
   `link--discord` `#7f8cff`, `link--reddit` `#ff6a33`). Brand colour may tint
   the icon, the icon chip, the left edge bar, the hover border, the hover glow
   and the sheen — **never a panel fill**, and link *text* stays `--ink`, so
   contrast never depends on the brand hue.

   Discord blurple `#5865f2` and Reddit `#ff4500` were both **lifted** for this
   ground; at their true brand values they read as muddy on near-black. Lift a
   new brand colour the same way rather than pasting the official hex.

2. **A fourth ambient bloom** (`.bloom-4`, amber `--idle`, opacity 0.13) parked
   bottom-right, away from the reading column, to warm a palette that was all
   cool hues.

Glow ring alphas are `0.24`, not the `0.16` the light theme used: a 16% halo is
nearly invisible on near-black.

### Backdrop stack — order is load-bearing

Paint order is **blooms → jellyfish → cursor glow → veil → content**.

`.veil` must be the **last** element before `.layout`. It is a radial scrim that
holds muted text above 4.5:1 when a bloom or the pointer light drifts beneath
it. If it is moved to sit directly after the blooms (the intuitive place), the
cursor glow paints *above* it and `--ink-muted` measures 3.95:1 on bare ground —
a real, measured failure. Do not reorder these.

### Background blooms

Three fixed blurred circles, `filter: blur(90px)`, `pointer-events: none`:

| | size | position | colour | opacity | animation |
|---|---|---|---|---|---|
| `.bloom-1` | 480px | top `-170px`, left `-130px` | teal | 0.30 | `drift1 26s` |
| `.bloom-2` | 420px | top `28%`, right `-170px` | violet | 0.26 | `drift2 32s` |
| `.bloom-3` | 380px | bottom `-150px`, left `18%` | pink | 0.20 | `drift1 30s reverse` |

Keep the bloom `scale()` amplitude ≤1.06 or they expand past their intended
footprint.

### Jellyfish

Five inline SVG creatures (`.jelly--1` … `--5`) that rise slowly through the
viewport. Each is a bell (dome, skirt, rim, sheen, two core ellipses), four oral
arms and six trailing strands, all `currentColor` and tinted per-instance via
`--jf`.

Motion is deliberately split across **nested** elements so every keyframe
touches only `transform` or `opacity`:

- `.jelly` — the long rise (`jf-rise-1` / `jf-rise-2`, 74–128s, `translate3d`)
- `.jelly__body` — an 11s bob (`translateY` + slight `rotate`)
- `.jelly__body::before` — a blurred halo pulsing in opacity
- `.jf-bell` — a 7s bell pulse (`scaleX`/`scaleY` about `50% 76%`)
- `.jf-strands--a/b`, `.jf-arms` — out-of-phase `skewX` sway

**No SVG filters.** A `feTurbulence`/`feDisplacementMap` version was prototyped
and rejected: filters re-rasterise on phone GPUs and mobile is the primary
target here. Below 720px two jellyfish are hidden and the inner detail
animations stop — five sets of nested transforms is real cost for decoration.

### Glass panels

`.glass` = `--glass` fill + `backdrop-filter: blur(var(--glass-blur))
saturate(var(--glass-saturate))` + a `--glass-border` hairline + an inset
`--glass-highlight` top line. Radii: 24px mobile / 26px desktop, 28px on the
identity card, 999px link pills on desktop, 14px status tiles.

The `saturate()` is not decoration — a dark translucent fill desaturates
whatever shows through, and without it the teal/violet behind the glass goes
grey. This is the main reason dark glass usually looks cheap.

### Type

Outfit 500/600 for headings, Plus Jakarta Sans 400/500/600 for body, JetBrains
Mono 400/500 for **numeric data only**. Mono is allowed on `.location`,
`.status-readout dd`, `.status-meta`, `.dc-username`, `.dc-act-elapsed` and the
`.status-summary` pill — all of which are numbers, handles or timers. Never on
labels or headings.

### Signature motif

**One** wavy SVG line (`.wave`), teal, `--wave-opacity: 0.85`, 22px tall, placed
once between the Discord card and the links. `wave-breathe` multiplies that base
down by ×0.8 at the trough, which is why the base is 0.85 rather than 0.6 — at
0.6 the trough falls to 2.9:1 against a teal-lit ground.

### Profile card

**Static half comes from `/api/profile`.** Lanyard has no banner, About Me,
badges or connections, so the server proxies a public profile endpoint
(`dcdn.dstn.to`) and caches it for 30 minutes. It is **sanitised on the way
out**: connection `type`/`name`/`verified` are what Discord already shows, but
the raw account ids upstream returns are dropped server-side and never reach
the browser.

`renderProfile()` (Lanyard, live) and `loadDiscordProfile()` (static) both
write to the same card, and Lanyard re-runs on every presence change. The
`richProfile` flags stop it overwriting the icon badges with `public_flags`
text pills, and stop it re-showing the nameplate over the real banner. Keep
those guards if you touch either function.

About Me is rendered **node by node, never `innerHTML`** — it is remote text
and must not be able to inject markup. URLs are auto-linked.


**The bio and the live Discord profile are one merged surface** —
`.profile-card`, `pc-*` classes — laid out to mirror Discord's own profile
panel: banner (with the animated nameplate webm over it) → avatar with APNG
decoration and a presence dot → display name → `@handle · raid is backup` +
guild tag → badges → action buttons → presence pill → custom status →
"Currently" → bio → games → member since → connections. Don't split it back
into two cards.

The panel is deliberately **not** `position: sticky`. Merged, it is taller
than most viewports, and a sticky box taller than the screen traps its own
bottom off-screen permanently.

Badges are decoded from the `public_flags` bitfield in `badgesFor()` — only
flags Lanyard actually exposes, nothing inferred.

**Games** are static content in a native `<details>`, collapsed by default, so
the toggle needs no JS and stays keyboard accessible. Covers are Steam library
capsules (`library_600x900.jpg`, portrait 2:3 — the shape Discord uses). Every
app id was resolved through Steam's search endpoint, confirmed against the
store API's returned name, and each image URL checked for a 200 before being
hardcoded. **Don't add a game by guessing its app id** — a wrong id silently
renders someone else's box art.

Two have no cover and use a lettered `.game-art--empty` tile instead: Pragmata
(unreleased — its assets live under a hashed path with no portrait capsule) and
Minecraft (not on Steam at all).

Details worth not rediscovering:

- Discord CDN `?size=` accepts only powers of two 16–4096. `192` and `384`
  return **HTTP 400**, which fires `onerror` and demotes the user to a default
  avatar. `AVATAR_SIZE` is 256.
- Avatar decoration: `?size=` is ignored on that route; the asset is a 222KB
  animated APNG, so it is `loading="lazy"`.
- Nameplate: use `asset.webm` (147KB) — **never `img.png`**, which is a 390KB
  animated APNG. `static.png` is the 11KB still.
- Both the decoration and the nameplate can carry `expires_at`; `unexpired()`
  guards them.
- Activity `assets.large_image` may be a `mp:external/…` proxy string → resolve
  against `media.discordapp.net`. Arbitrary `http(s)` asset values are
  deliberately **dropped**, not passed through, so a third-party RPC client
  cannot point an `<img>` at any origin.
- Activity **buttons are labels only** — Discord never exposes their URLs to
  third parties. They render as chips, not links. Do not invent a destination.
- Lanyard has no banner and no "About Me". The bio lines in the profile card
  are static content, not a live feed.

### Status cards — "My homelab"

**Collapsed behind a `<details class="lab">`, closed by default.** Twenty-six
tiles dominated the page; the owner asked for it tucked away. The live
`#status-summary` pill ("26/26 services up") sits on the *closed* summary row,
so status stays glanceable without expanding — keep it there if you restyle
this, that pill is the whole point of hiding the rest.

Inside: one small glass tile per container, grouped by node, with a name, a
status dot and three mono readouts (24h, 30d, ping).

Grid columns are **pinned per breakpoint, not `auto-fill`**: 2 columns on
mobile, 3 from 600px, 3 on desktop. `auto-fill` packed 3 tracks at 500px and 5
at 880px, which starved the readouts and made them collide. `minmax(0, 1fr)`
keeps a long service name from forcing overflow.

### Motion

All motion lives in transform/opacity. The safety rule: an element's **base**
state is its **final** state, and keyframes animate *from* hidden using
`backwards` fill:

```css
.thing { animation: rise-in 0.42s var(--ease-out-expo) backwards; }
@keyframes rise-in { from { opacity: 0; transform: translateY(18px); } }
```

Never put `opacity: 0` in a base rule — the reduced-motion override
(`animation: none`) would strand it invisible forever. Verify by forcing
reduced motion: the page must be *complete* immediately, with no stagger.

What moves: the blooms drift; the jellyfish rise, bob, pulse and sway; the wave
draws itself in (via `stroke-dashoffset`, with `pathLength="1"` so the maths is
resolution-independent) then breathes; link pills lift 3px with a teal sheen
sweeping across and an arrow nudging in; status tiles lift 2px; the pointer glow
eases toward the cursor at 0.12/frame; numeric readouts tween between values and
flash teal.

**Timings are deliberately quick** — entrance ~0.26-0.42s, staggers
0.10-0.28s, transitions ~0.18s, number tweens 320ms, pointer lerp 0.2/frame.
The owner asked for speed; don't slow them back down for "elegance".

Ambient motion is the exception and stays slow (blooms 19-23s, jellyfish rise
48-82s). Speeding those to match the UI reads as frantic, not fast.

Also moving: marine snow (26 motes, randomised size/speed, desktop only), the
contribution cells stagger in by week, the contribution total counts up, game
covers lift on hover, and the display name carries a slow gradient shimmer.

**Two places legitimately use `opacity: 0` in a base rule**, and both are safe
only because JS gates them:

- `.reveal` (scroll reveal on the GitHub and homelab sections) — `initReveal()`
  returns early unless `IntersectionObserver` exists *and* motion is allowed.

  **That gate alone was not enough and it shipped broken once.** The observer
  existing does not mean it *fires* — in a throttled tab or a headless
  renderer it may not, and the contribution graph sat at `opacity: 0`
  permanently. `initReveal()` now also reveals anything already on screen at
  load, and has an unconditional `setTimeout(…, 1500)` failsafe. Keep the
  failsafe: the worst case becomes a missed animation instead of lost content.
- `.pc-display`'s shimmer sets `color: transparent` for the gradient clip; the
  reduced-motion block pins it back to a solid `--ink` with
  `-webkit-text-fill-color`, or the name would vanish entirely.

If you add another, gate it the same way and verify by forcing reduced motion.

`@media (prefers-reduced-motion: reduce)` disables **all** animation and
transition including pseudo-elements, and hides the pointer glow. Non-negotiable.


## Configuring Discord presence

Set `DISCORD_USER_ID` at the top of `public/app.js`. Presence comes from
[Lanyard](https://api.lanyard.rest), which only reports for members of its own
Discord — the account must join <https://discord.gg/lanyard> once. No token
needed, and the ID is public by necessity (the browser calls the API with it).

**Transport.** `fetchPresence()` does one REST call on load so the card is
populated on first paint, then `connectLanyard()` opens the WebSocket
(`wss://api.lanyard.rest/socket`) for instant updates. Keep both: the socket
alone leaves the card empty until the handshake completes, and REST alone lags
up to 30s. On socket close it backs off exponentially and polls in the
meantime; `gotSocketData` stops a late REST response clobbering fresher socket
data.

With `subscribe_to_id` (singular) the `INIT_STATE` payload **is** the presence
object. With `subscribe_to_ids` (plural) it would be keyed by user id — an easy
mistake to make when reading the Lanyard docs.

What Lanyard does **not** provide: the profile banner and the "About Me" text.
The bio lines, games, member-since date and connections are static content in `index.html`.

## Local dev

```bash
npm install
npm start
```

Then open <http://localhost:3300>. Checks run from wherever the process
runs, so anything unreachable from your machine shows as "down" locally.

## Deployment target

A **Proxmox LXC**: CT 124 on node 1 (`lxcpool`) — Debian 13, 2 vCPU /
2 GB / 32 GB, hostname `hasanismail.dev`, unprivileged, DHCP (currently
192.168.1.200). Runs as the `hasanismail-site` systemd unit on port 3300,
fronted by a Cloudflare Tunnel — same pattern as
`openmasjidsolutions.org` / `openmasjidos`. See `install.sh` and
`hasanismail-site.service`. GitHub repo:
`hasan-ismail/hasanismail.dev-website` (public).

The installer runs as root inside the container. It only installs Node if
18+ isn't present: **Debian 13 ships Node 20.19 in its own repos** (npm is
a separate package), so `apt` covers it and NodeSource is just a fallback
for older distros. Don't "simplify" that back to an unconditional
NodeSource pipe — the distro package avoids a third-party repo and piping
a remote script to bash as root.

Re-running `install.sh` is the upgrade path: it pulls, reinstalls deps,
and restarts the unit.

The monitored services span **both** Proxmox nodes — Immich is CT 200 on
node 2 (192.168.1.98), everything else is on node 1. Checks go over the
LAN, so the split doesn't matter operationally, but it explains why the
Immich target's IP is in a different range of the inventory.
