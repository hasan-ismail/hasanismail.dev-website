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

### The lines-added figure is slow on a cold process

It is a ~14-repo crawl and GitHub answers **202** while it computes a cold
repo's stats, so a freshly restarted process genuinely has nothing to show
for a few minutes. Two things stop that reading as "the number is missing":

- `refreshLinesAdded()` is called at boot and on a 10-minute tick, so the crawl
  starts before the first visitor rather than on their request. The function
  owns its own TTL and back-off, so the tick is free when there is no work.
- The client calls `renderLinesAdded()`; if the figure is not publishable yet
  it retries `/api/github` every 20s, six times, then gives up. Without this
  the visitor had to reload to ever see it — which is exactly what happened.

Both matter more than they look: the deployed container is the cold process.

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
- `node` / `nodes` are display labels ("Node 1 — proxmox"), not addresses.
- `publicUrl` is an intentionally public link, or `null`.

The handler builds this object field by field on purpose. Don't "simplify"
it by spreading the config entry (`...svc`) into the response — that would
carry `target` straight out to every visitor.

Any change that threads a `target` value into an API response or a file
under `public/` is a bug, not a feature. Logging targets server-side is
fine; sending them to a client is not.

The only routes are `/api/status`, `/api/github`, `/api/profile` and the
static mount on `public/`. Never add a static mount or a route that could
serve `config.json`, `data/`, or the repo root.

`/api/github` and `/api/profile` are both **server-side proxies of public
third-party data**, cached (1h and 30min). Neither touches `config.json`
targets. They exist so the page doesn't hit a third-party API once per
visitor and so a brief upstream outage degrades to stale data rather than
an empty card.

`/api/github` also returns `linesAdded`: `{ added, removed, repos, notReady,
unavailable, rateLimited, coverage, publishable }`. **There is no `skipped`
field** — a stale guard testing `locCache.data.skipped === 0` was therefore
always false and cost the site the whole figure; see below.
GitHub has no lines-of-code endpoint, so a background job sums per-week
additions from `/stats/contributors` across every non-fork repo the user owns
or co-owns via `config.githubOrgs`, keeping only their own commits and only
the last 365 days.

**A partial result must never be published.** GitHub answers `202` while it
computes a cold repo's stats, and counting only the warm ones produced
**6,473** instead of the real **483,277** — wrong by two orders of magnitude.
So an incomplete run is not cached as the answer: it retries after 3 minutes
instead of the usual 6 hours, a previously complete result keeps being served
meanwhile, and the UI renders a total only when the server marks it
`publishable` (coverage >= 85%). Keep all three guards.

### The rate-limit trap that hid the figure for real

Unauthenticated GitHub allows **60 requests/hour per IP**. The crawl is one
request per repo across ~13 repos, and `repoStats()` used to poll a `202`
**ten times** — so a single cold crawl could cost ~130 calls and could not
finish inside its own quota.

Worse, `refreshLinesAdded()` gated on `locCache.data.skipped === 0`, a field
`computeLinesAdded()` never returns. That is `undefined === 0`, i.e. always
false, so the 6-hour TTL could never apply and the 3-minute retry branch ran
forever. The deployed instance sat permanently rate-limited, serving
`{rateLimited: true, coverage: 0.08, publishable: false}` — the figure was
invisible on every device, which is what "lines of code not showing on
mobile" actually was.

What holds it together now, all of which matters:

- `ghJson()` reads `x-ratelimit-remaining` / `x-ratelimit-reset` from every
  response. Pacing off a local call counter drifts, because `/api/github`'s
  own proxy spends from the same per-IP budget.
- The crawl aborts while `RESERVE = 6` calls remain, so it can never starve
  the rest of the page.
- `repoStats()` polls a `202` **three** times, not ten.
- Scheduling is an explicit `locNextAt` timestamp set at each outcome, never
  a derived boolean: rate-limited waits for GitHub's own reset time,
  not-publishable retries in 20 minutes, publishable takes the full 6 hours.
- **A publishable result takes the full TTL even when a repo is still
  computing.** This repo is pushed constantly, so GitHub invalidates its
  stats and answers 202 more or less permanently; chasing that one repo
  every 20 minutes is what kept the quota pinned.
- `GITHUB_TOKEN` in the environment is optional and raises the ceiling to
  5000/hour. Nothing requires it; the pacing above is what makes the
  unauthenticated case work.

The figure reads "lines written" in the UI because the owner asked for that
wording. It is still *additions* across public non-fork repos, so it includes
lockfiles and excludes private work — the tooltip keeps the precise framing
("N added, M removed across K public repos in the last year"). Don't silently
change the label back.

`/api/github` returns `{ user, total, days: [{ date, count, level }] }` —
all already-public GitHub data, no addresses. It exists as a server-side
proxy for two reasons: it caches upstream for an hour so the page doesn't
hit a third-party API once per visitor, and it serves the last good
response if upstream fails, so a brief outage doesn't blank the graph.
The username comes from `config.github`.

### The split link row and `.link-item a`

`.link-item a` is written for single-link rows and beats `.link-half` on
specificity (0,1,1 against 0,1,0). It was imposing three things that broke
the split GitHub row outright:

- `display: block` — so the halves were never flex containers at all and each
  icon stacked above its label. That was the whole of "half and half github
  looks weird"; it was never a spacing problem, and no amount of
  `justify-content` could have fixed it.
- a single ellipsised `nowrap` line.
- `::before`, a full-bleed overlay that makes a whole pill clickable. With
  **two** anchors in one row the second overlay covered the entire row and
  swallowed every click meant for the first half.

`.link-item a.link-half` resets all of it and kills both pseudo-elements. A
half is itself the anchor and fills its side of the row, so it is already its
own hit target. Check `elementFromPoint` on each half after touching this.

### /api/social — best-effort, mostly blocked

Returns only the sources that actually answered. A missing key is the normal
case, not an error, and the page renders a stat only when one is present, so a
blocked source degrades to a plain link rather than a zero.

Measured, not assumed:

| source | result |
|---|---|
| youtube | **works** — the channel page embeds the count; scraped from HTML |
| reddit | **403** — `/user/<n>/about.json` needs OAuth now; every UA is refused |
| instagram | **429** — needs a logged-in session |
| facebook | **not attempted** — a personal profile's follower count is not exposed to logged-out clients at all, so there is no endpoint to call |

Reddit and Instagram are still wired up: each costs one request an hour and
starts working the day that changes or a credential is supplied. Facebook is
deliberately absent rather than a scraper that pretends — the link renders
without a stat.

Scraping HTML is brittle by nature, so every extractor returns `null` on any
surprise instead of throwing, and a `null` is indistinguishable from "not
configured" to the client. Handles live in `config.social`.

---

## Monitored services

Edit `config.json` only — the frontend renders whatever the array
contains, no code changes needed.

```json
{
  "nodes": [
    { "id": "node1", "label": "Node 1 — proxmox" }
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
| `--ink-muted` | `#b0cbd4` | secondary text (lifted from #a2c0ca — see below) |
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
| `--veil` | `rgba(5,12,20,0.52)` | the contrast scrim (see below) |
| `--blue` / `--rose` | `#38bdf8` / `#fb7185` | two further ambient hues |
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

   **This rule has teeth.** `.link-stat` (the follower/karma pill) was first
   written with `color: var(--brand)` and measured **4.02:1** for the YouTube
   red — a real AA failure, caught only by the glyph-mask rig. It is now
   `--ink` with the brand kept for the tint and border: **8.52:1**. Brand hue
   tints; it never carries glyphs.

2. **Six ambient blooms** across teal, violet, pink, amber, blue and rose, plus
   a six-stop aurora mesh on `body`. `--blue` `#38bdf8`, `--rose` `#fb7185` and
   `--lime` `#7dd85f` joined the palette for ambient use.

The wave motif now takes a full-spectrum `linearGradient` stroke
(`#wave-grad`), marine snow cycles four hues, and selection/scrollbar pick up
accents. All of it is behind the veil or is non-text chrome, so none of it
moves the text-contrast numbers.

Glow ring alphas are `0.24`, not the `0.16` the light theme used: a 16% halo is
nearly invisible on near-black.

**The colour pass raised the ambient layer** to an aurora mesh plus six blooms.
That pushed `--ink-muted` on bare veiled ground to **4.28:1** in the
all-six-overlap worst case — below AA. The fix was `--veil` 0.45 -> 0.52 and
`--ink-muted` `#a2c0ca` -> `#b0cbd4`, which restores it to **5.55:1** (ink
8.54:1). Re-measure with the compositing model if you touch bloom opacity, the
aurora stops, or the veil: eyeballing this does not work, the failure only
appears where several blooms overlap.

**The GitHub calendar uses GitHub's own dark-mode greens** (`#0e4429`,
`#006d32`, `#26a641`, `#39d353`), not the site palette — the owner asked for
the familiar green dots. Level 1 sits at ~1.56:1 against the empty cell, which
looks wrong until you check GitHub: their own empty-vs-l1 is 1.55:1. It is
supposed to be that subtle; don't "fix" it.

### The .veil / .cursor-glow positioning regression

Both of these declare `inset` / `top` / `left` but relied on a grouped
`position: fixed` rule that was deleted along with the 107 dead jellyfish and
bloom blocks. Neither had a `position` anywhere else in the file, so both fell
back to `static`, with two consequences that took three rounds to spot:

- `.cursor-glow` became an in-flow 400px block. `top/left` stopped applying, its
  `transform` moved it relative to a spot **inside the document**, so it scrolled
  with the page instead of tracking the pointer — reported as "the spotlight on
  the cursor drifts". It also added ~200px of empty column above the content,
  which is the blank band that made the desktop page start too low.
- `.veil` collapsed to a zero-height div. The contrast scrim this design is
  documented to depend on was not painting **at all**, on any page, for several
  commits. Restoring it shifted every measured background.

Both now carry `position: fixed` on the elements themselves. If you ever strip
dead CSS again, check that no surviving selector was sharing a rule with the
ones you removed — that is exactly how this happened.

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

### Backdrop artwork (replaced the jellyfish)

The animated SVG jellyfish were removed; `public/backdrop.jpg` supplies both
the creatures and the colour, and the whole palette is sampled from it. The
image is hosted locally, not hotlinked from the DuckDuckGo proxy it came
from — that proxy would have been a single point of failure for the entire
look of the site.

**The two filter values are load-bearing.** The source is bright — measured
p99 luminance 0.938, near-white in the light rays — so light text over it sat
at about 2.7:1, and even a 0.75 black scrim only reached 3.34:1.
`brightness(0.36)` on `.backdrop` plus the flat `--veil` at 0.30 brings the
worst case to ink 7.64:1 and muted 4.97:1. Raising the brightness or lowering
the veil drops muted text below AA. Re-measure before changing either.

The layer never animates, so its blur/brightness filter rasterises once rather
than per frame. `transform: scale(1.04)` hides the soft edge that `blur()`
leaves at the element's borders.

The old jellyfish and bloom CSS was stripped rather than left dead: 107 rule
blocks, style.css 72.3KB -> 59.8KB, index.html 35KB -> 15KB.

**Why the bell used to clip**, kept because it applies to any inline SVG here:
`jf-contract` scaled the bell `scaleY(1.2)` about `transform-origin: 50% 74%`.
The bell group spanned y 10..86 in viewBox units, putting that origin at
y=66.2 and throwing the dome's top to y=-1.2 — outside `viewBox="0 0 120 260"`,
and an SVG clips to its viewBox by default. The fix was `overflow: visible`.

### Vibrancy pass — the `.tint` layer

The owner asked for "lots of color and vibrancy". The constraint is that the
ink pair was measured against the *darkened* backdrop, and every previous
colour increase in this project broke AA and had to be walked back. So the
chroma is added only where it cannot move text contrast much:

- `saturate()` on `.backdrop` went 1.12 -> 1.85. `brightness()` is the value
  the contrast floor depends on and stays at 0.36.
- `.tint` is a full-viewport layer of six radial hue washes with
  `mix-blend-mode: color`. That blend takes the hue and chroma of the layer
  and keeps the **luminance** of what is underneath, so it recolours the
  artwork into distinct regions without lightening it. A `screen` or
  `plus-lighter` glow of the same intensity would have added light and eaten
  the entire contrast margin. It never animates, so it composites once.
- `--glass-saturate` went 135% -> 175%, and the link pills now carry their own
  `--brand` wash (capped at 0.15 — the descriptions are `--ink-muted`, and a
  lighter wash under them is exactly what failed AA before).

Paint order is **backdrop -> tint -> cursor glow -> veil -> content**.

**How this was verified**, because the old analytic contrast model no longer
applies (the ground is a photograph plus a blend layer, not a stack of
gradients): render the page twice at the same size, once with every glyph
forced to solid magenta and once with every glyph transparent. The first is a
glyph mask, the second is the true background. For each text element, sample
the background only at glyph pixels and compare against the element's real
computed colour. Measuring whole element rects instead gives false failures —
it counts decorative bullets and gradient buttons as "background behind text".

Measured before/after with the identical rig: **0 AA failures in both**, 0 new
regressions. The pass cost 0.1-2.6 points of headroom; the worst element is
now `#presence-text` at 4.82:1 (was 5.11). Re-run that comparison before
pushing colour further — there is not much margin left.

### Shooting stars — no var() in the keyframes, ever

The layer is built as **arm > streak > head** (`i > b > u`). The arm carries
the ANGLE as a static inline `transform: rotate()`, the streak animates a
plain `translateX`, and every colour is written inline as a concrete
`rgb()` / `rgba()` value.

That shape exists for one reason: **custom properties inside `@keyframes` are
a long-standing Gecko weak spot.** The first version animated
`transform: rotate(var(--star-a)) translateX(...)` and tinted from
`var(--star-rgb)`. When a `var()` fails to resolve inside a keyframe the whole
declaration is dropped at computed-value time — so the star never travels,
sits parked off-screen, and fades in and out where nobody can see it. It
worked in Chrome and was invisible in Firefox for Android, reported three
times as "the shooting stars still don't work on mobile".

Do not reintroduce `var()` into `@keyframes shoot`, and do not move the
colours back into custom properties.

### Shooting stars — why they are ABOVE the content

`.shooting` is `z-index: 3`, over `.layout`. It spent three rounds at
`z-index: 0` where every star rendered perfectly and none could be seen: on
a phone the profile card covers essentially the whole viewport, and a star
measured fully opaque at y=295 was simply behind it. Glass at 0.58 alpha
with a 20px backdrop blur swallows a 2px streak completely. Don't move this
layer back down.

**The peak opacity in `@keyframes shoot` is a measured contrast budget.**
Because the layer is above the text, a streak lightens the glyph and its
background together. Measured by pinning a streak across `.pc-bio-line` and
comparing glyph contrast inside the band with the same text outside it:

| peak | inside the band | outside | verdict |
|---|---|---|---|
| 0.55 | 3.19:1 | 4.55:1 | fails AA |
| 0.35 | 3.39:1 | 4.11:1 | measurable cost |
| 0.32 | — | — | no measurable cost |

So brightness is capped and **length is the lever instead** — it costs
nothing, and a long streak reads as a shooting star where a short faint one
reads as a smudge. Same reason the head is 4px, not 6px: the head covers
more glyph height than the 2px streak does.

A `mix-blend-mode: screen` version was tried and dropped. The stars are
near-white and `screen(x, white) == white`, so it was pixel-identical to
plain alpha compositing while forcing the whole viewport to re-composite
every frame.

Nine stars on a phone and ten on desktop at a 45% duty cycle; the old three at
28% left an empty sky ~37% of the time.

Marine snow runs on phones too now (14 motes against 26 on desktop) — it stays
at `z-index: 0`, behind the panels, so on a phone it is only visible in the
gutters and the open areas above and below the content. That is deliberate:
motes are *persistent*, and persistent specks over body text cost far more
legibility than a streak that crosses in a second.

### Timezone chip

`.pc-tz` beside the location. The label says "EST" because that is how the
owner refers to it, but the time is formatted in `America/New_York`, so it
stays correct across the DST boundary instead of drifting an hour for half
the year.

The clock only ticks while the popover is open — a permanent 1s timer for a
tooltip nobody is looking at is the same idle wake-up the pointer glow parks
itself to avoid. Hover, focus and tap (`.is-open`) all open it.

**It paints before it binds anything**, and it does not depend on `Intl`.
`Intl.DateTimeFormat` with a `timeZone` is tried first and only trusted if it
actually returns digits; otherwise a manual US-Eastern calculation takes over
(post-2007 rule: DST from the second Sunday in March to the first Sunday in
November). An engine with a trimmed ICU build either throws or quietly
ignores `timeZone`, and the chip then sat on its `--:--:--` placeholder
forever — which is what it did on Firefox for Android. The placeholder must
never survive past the first `paint()` call.

**Do not put `visibility` in the popover's `transition` list with a duration.**
It interpolates rather than flipping, so the popover measured as `hidden`
even with `.is-open` applied and the rule winning the cascade. It uses
`visibility 0s linear 0.16s` closed and `visibility 0s linear 0s` open, which
steps it on immediately and off after the fade.

### Jellyfish (removed — kept for history)

**They swim, they do not float.** Real jellyfish move by pulse-and-glide: the
bell contracts hard and fast, throwing the animal forward, then relaxes slowly
while it coasts. The keyframes are therefore deliberately ASYMMETRIC — a short
squeeze (~14-30% of the cycle) and a long relax. Even, sinusoidal pulsing reads
as a floating blob; do not "tidy" these curves into symmetry.

Five nested layers, transform only, no extra markup: `.jelly` drifts,
`.jelly__body` weaves laterally and banks into the turn, `.jelly__svg` surges
on the thrust, `.jf-bell` contracts, and the strand/arm groups whip on a
negative `animation-delay` so they trail the bell. A per-animal `--jf-beat`
locks `jf-thrust`, `jf-contract` and `jf-whip` to one rhythm while no two
animals pulse in unison. Seven animals across seven hues; four hide below
720px.

Verify changes here by reading computed `animationName` in a browser, not by
reasoning about the cascade — the original float rules are still earlier in the
file and only lose because the swim rules come later.

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
"Currently" → bio → games → location. Don't split it back into two cards.
("Member since" and the whole Connections list were removed at the owner's
request — Connections restated the links section. `/api/profile` still
returns the sanitised list; it simply isn't rendered.)

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

All eight have real art. Two needed sources other than a Steam portrait capsule:

- **Minecraft** is not on Steam. Its cover is the official **Microsoft Store**
  poster, resolved through the public displaycatalog API
  (`displaycatalog.mp.microsoft.com/v7.0/products?bigIds=9NBLGGH2JHXJ`), which
  lists a 720x1080 `Poster` image — already the 2:3 the tile wants, and it
  accepts `?w=&h=&q=` resizing.
- **Pragmata** does have a portrait capsule, just not at the legacy path —
  `/steam/apps/3357650/library_600x900.jpg` is a 404. Newer apps publish it
  under a per-asset hash: `store_item_assets/steam/apps/<id>/<hash>/`
  `library_capsule.jpg` (300x450, the 2:3 the tile wants). The hashes come
  from `api.steamcmd.net/v1/info/<appid>` under `common.library_assets_full`,
  which is the way to resolve this for any newer title. The old letterbox
  workaround (`.game-art--wide`, a blurred zoomed copy behind the 460x215
  `header.jpg`) has been removed — don't reintroduce it.

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
`#status-summary` pill ("All services online and operational") sits on the *closed* summary row,
so status stays glanceable without expanding — keep it there if you restyle
this, that pill is the whole point of hiding the rest.

Inside: a **list** (`.svc-list` / `.svc-row`), not a tile grid — rows read
faster for 26 services. Each row is a status dot, the service name, then three
mono stats right-aligned (24h, 30d, ping) and an optional visit link. Below
560px the 30d column is hidden rather than letting all three collide.

The summary pill reads "All services online and operational" on a green
bubble when everything is up, and "Some services offline — N of M online" on
a red one (`.is-degraded`) otherwise. Both carry a matching status dot via
`::before`. Measured on the composited pill: the red is `#ffb3c0` at
**7.21:1**. Note it is a lightened rose, not `--down` — `--down` is a dot
colour and is not safe for text (see the contrast rule above).

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

Also moving: shooting stars (10 on desktop, 6 under 720px — see below),
marine snow (26 motes, randomised size/speed, desktop only), the
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

### Every top-level init runs through safe()

All the entry points at the bottom of `app.js` are called as
`safe("initFoo", initFoo)`. They run in sequence in one script, so an exception
in any of them aborts the rest of the file and silently takes out every feature
declared **below** it. The symptom is a scatter of unrelated things failing on
one device while working everywhere else — which is what "the stars and the
clock don't work on mobile" looked like. One failure should cost one feature,
not all of them. Add new entry points the same way.

`@media (prefers-reduced-motion: reduce)` disables **all** animation and
transition including pseudo-elements, and hides the pointer glow.

**Animations are ON by default, including when the OS requests reduced
motion** — the owner chose that for this site. `prefersReducedMotion()`
returns true only when the visitor has explicitly stored `hi-motion=off`. A
small inline script in the document head stamps `data-motion` before first
paint so there is no reduced-motion flash.

This is a deliberate accessibility trade-off, not an oversight: a visitor who
set reduce-motion at OS level will still get animation. The in-page toggle is
the mitigation, so keep it visible, labelled and keyboard reachable.

**An explicit visitor choice outranks the OS**, in both directions. The
reduced-motion block is scoped to `html:not([data-motion="on"])`, and a
separate `html[data-motion="off"]` block force-disables motion for someone
whose OS does not ask for it. The `.motion-toggle` button writes `hi-motion`
to localStorage and sets that attribute.

This exists because the owner reported "animations do not work on desktop" —
the cause was Windows 11 Settings -> Accessibility -> Visual effects ->
Animation effects being off, which is exactly what the media query honours.
Respecting the OS by default is still correct; the toggle just makes the
choice reachable.

The toggle label reads **"Animations on" / "Animations off"**, not a constant
"Animations". `aria-pressed` alone was ambiguous to sighted users, and
"my animations don't work" is indistinguishable from "I turned them off on
this device" without it — which cost real debugging time.

`prefersReducedMotion()` in app.js reads the override first and is a
**function, not a captured boolean**, so every motion-gated feature re-reads
it. Opting back on triggers a reload, because features like the snow layer and
the pointer glow bail out early at init and cannot be restarted in place.


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
