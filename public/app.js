// ---- motion preference ----
//
// Every animated flourish is opt-out. CSS handles its own side via the
// prefers-reduced-motion media query; this mirrors it for the JS-driven
// pieces (pointer glow, number tweens, the animated nameplate).
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const prefersReducedMotion = () => reducedMotion.matches;

// ---- Discord presence (Lanyard) ----
//
// To change this: enable Developer Mode in Discord settings, then right-click
// a profile → Copy User ID. Lanyard only tracks members of its own server, so
// the account must have joined https://discord.gg/lanyard once.
//
// This ID is public by necessity — the browser calls the Lanyard API with it,
// so it ships in this file. Discord user IDs aren't secrets.
const DISCORD_USER_ID = "761016030892916737";

const PRESENCE_LABEL = {
  online: "online now",
  idle: "away",
  dnd: "busy",
  offline: "offline",
};

// Discord's CDN only accepts specific sizes. A computed value like 192 returns
// HTTP 400, which fires onerror and demotes the user to a default avatar.
const AVATAR_SIZE = 256;
const CDN = "https://cdn.discordapp.com";

function avatarUrl(user) {
  if (!user || !user.id) return null;
  if (!user.avatar) {
    // Migrated (discriminator "0") accounts index the default set by id.
    const index = Number((BigInt(user.id) >> 22n) % 6n);
    return CDN + "/embed/avatars/" + index + ".png";
  }
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return CDN + "/avatars/" + user.id + "/" + user.avatar + "." + ext + "?size=" + AVATAR_SIZE;
}

// Collectibles can expire; render only while still valid.
function unexpired(obj) {
  if (!obj || !obj.asset) return false;
  if (!obj.expires_at) return true;
  return Date.parse(obj.expires_at) > Date.now();
}

function decorationUrl(user) {
  const d = user && user.avatar_decoration_data;
  if (!unexpired(d)) return null;
  // ?size= is ignored on this route (passthrough is the default). The asset is
  // an animated APNG, which browsers play natively.
  return CDN + "/avatar-decoration-presets/" + d.asset + ".png";
}

function nameplateUrls(user) {
  const n = user && user.collectibles && user.collectibles.nameplate;
  if (!unexpired(n)) return null;
  // Never use img.png here — it is a ~390KB animated APNG. asset.webm is the
  // animated form; static.png is the ~11KB still for reduced motion.
  return {
    video: CDN + "/assets/collectibles/" + n.asset + "asset.webm",
    still: CDN + "/assets/collectibles/" + n.asset + "static.png",
  };
}

// Public profile badges, decoded from the public_flags bitfield. Only the
// flags Lanyard actually exposes are listed — nothing is inferred.
const PUBLIC_FLAGS = [
  [1 << 0, "Discord Staff"],
  [1 << 1, "Partner"],
  [1 << 2, "HypeSquad Events"],
  [1 << 3, "Bug Hunter"],
  [1 << 6, "HypeSquad Bravery"],
  [1 << 7, "HypeSquad Brilliance"],
  [1 << 8, "HypeSquad Balance"],
  [1 << 9, "Early Supporter"],
  [1 << 14, "Bug Hunter Gold"],
  [1 << 17, "Early Verified Bot Developer"],
  [1 << 18, "Moderator Programs Alumni"],
  [1 << 22, "Active Developer"],
];

function badgesFor(user) {
  const flags = Number(user && user.public_flags) || 0;
  return PUBLIC_FLAGS.filter((pair) => flags & pair[0]).map((pair) => pair[1]);
}

function guildTagBadgeUrl(guild) {
  if (!guild || !guild.badge || !guild.identity_guild_id) return null;
  return CDN + "/guild-tag-badges/" + guild.identity_guild_id + "/" + guild.badge + ".png?size=32";
}

// Resolve an activity asset string to a URL. Arbitrary http(s) values are
// deliberately NOT passed through: they would let a third-party RPC client
// point an <img> at any origin.
function activityAssetUrl(activity, key) {
  const raw = activity.assets && activity.assets[key];
  if (!raw) return null;
  if (raw.startsWith("mp:")) return "https://media.discordapp.net/" + raw.slice(3);
  if (/^https?:\/\//i.test(raw)) return null;
  if (!activity.application_id) return null;
  return CDN + "/app-assets/" + activity.application_id + "/" + raw + ".png";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function hideOnError(img) {
  img.addEventListener("error", () => { img.hidden = true; }, { once: true });
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

// ---- profile rendering ----

let liveNodes = []; // elements needing a 1s tick (elapsed counters, progress bars)

function renderProfile(d) {
  const user = d.discord_user || {};
  const status = d.discord_status || "offline";

  const dot = document.getElementById("presence-dot");
  const text = document.getElementById("presence-text");
  dot.className = "dot is-" + status;
  text.textContent = PRESENCE_LABEL[status] || status;

  const avatar = document.getElementById("dc-avatar");
  const url = avatarUrl(user);
  if (url && avatar.getAttribute("src") !== url) avatar.src = url;
  avatar.alt = (user.display_name || user.username || "Discord") + " avatar";

  const deco = document.getElementById("dc-decoration");
  const decoUrl = decorationUrl(user);
  if (decoUrl) {
    if (deco.getAttribute("src") !== decoUrl) {
      deco.loading = "lazy";
      deco.src = decoUrl;
      hideOnError(deco);
    }
    deco.hidden = false;
  } else {
    deco.hidden = true;
  }

  document.getElementById("dc-presence-dot").className = "dc-presence-dot is-" + status;

  document.getElementById("dc-display").textContent =
    user.display_name || user.global_name || user.username || "";
  document.getElementById("dc-username").textContent = user.username ? "@" + user.username : "";

  const tag = document.getElementById("dc-tag");
  const guild = user.primary_guild;
  if (guild && guild.tag) {
    tag.textContent = "";
    const badge = guildTagBadgeUrl(guild);
    if (badge) {
      const img = el("img");
      img.src = badge;
      img.alt = "";
      hideOnError(img);
      tag.appendChild(img);
    }
    tag.appendChild(document.createTextNode(guild.tag));
    tag.hidden = false;
  } else {
    tag.hidden = true;
  }

  // Animated nameplate, skipped entirely under reduced motion.
  const plate = document.getElementById("dc-nameplate");
  const plates = nameplateUrls(user);
  if (plates && !prefersReducedMotion()) {
    if (plate.getAttribute("src") !== plates.video) plate.src = plates.video;
    plate.hidden = false;
  } else {
    plate.hidden = true;
  }

  const badges = document.getElementById("dc-badges");
  if (badges) {
    badges.textContent = "";
    for (const label of badgesFor(user)) badges.appendChild(el("span", "pc-badge", label));
  }

  const platforms = document.getElementById("dc-platforms");
  platforms.textContent = "";
  const active = [
    [d.active_on_discord_desktop, "desktop"],
    [d.active_on_discord_mobile, "mobile"],
    [d.active_on_discord_web, "web"],
  ].filter((pair) => pair[0]).map((pair) => pair[1]);
  for (const name of active) platforms.appendChild(el("span", "dc-platform", name));

  renderActivities(d);
}

function renderActivities(d) {
  liveNodes = [];

  const activities = d.activities || [];
  const custom = activities.find((a) => a.type === 4);
  const customEl = document.getElementById("dc-custom");
  if (custom && custom.state) {
    customEl.textContent = custom.state;
    customEl.hidden = false;
  } else {
    customEl.hidden = true;
  }

  const wrap = document.getElementById("dc-activity-wrap");
  const list = document.getElementById("dc-activities");
  list.textContent = "";

  const cards = [];
  if (d.listening_to_spotify && d.spotify) cards.push(spotifyCard(d.spotify));
  for (const a of activities) {
    if (a.type === 4) continue;                                    // custom status
    if (a.name === "Spotify" && d.listening_to_spotify) continue;  // already rendered
    cards.push(activityCard(a));
  }

  if (!cards.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  for (const c of cards) list.appendChild(c);
  tickLive();
}

function activityCard(a) {
  const card = el("div", "dc-activity");

  const large = activityAssetUrl(a, "large_image");
  const small = activityAssetUrl(a, "small_image");
  if (large) {
    const art = el("div", "dc-act-art");
    const img = el("img");
    img.src = large;
    img.alt = (a.assets && a.assets.large_text) || a.name || "";
    img.loading = "lazy";
    hideOnError(img);
    art.appendChild(img);
    if (small) {
      const s = el("img", "dc-act-small");
      s.src = small;
      s.alt = (a.assets && a.assets.small_text) || "";
      s.loading = "lazy";
      hideOnError(s);
      art.appendChild(s);
    }
    card.appendChild(art);
  }

  const body = el("div", "dc-act-text");
  const VERB = { 0: "Playing", 1: "Streaming", 2: "Listening to", 3: "Watching", 5: "Competing in" };
  body.appendChild(el("div", "dc-act-name", (VERB[a.type] ? VERB[a.type] + " " : "") + (a.name || "")));
  if (a.details) body.appendChild(el("div", "dc-act-line", a.details));
  if (a.state) body.appendChild(el("div", "dc-act-line", a.state));

  if (a.timestamps && a.timestamps.start) {
    const t = el("div", "dc-act-elapsed");
    t.dataset.start = String(a.timestamps.start);
    body.appendChild(t);
    liveNodes.push(t);
  }

  // Discord exposes button LABELS but never their URLs, so these are chips,
  // not links — making them links would mean inventing a destination.
  if (Array.isArray(a.buttons) && a.buttons.length) {
    const row = el("div", "dc-act-buttons");
    for (const label of a.buttons) {
      if (typeof label === "string") row.appendChild(el("span", "dc-act-button", label));
    }
    body.appendChild(row);
  }

  card.appendChild(body);
  return card;
}

function spotifyCard(s) {
  const card = el("div", "dc-activity");

  if (s.album_art_url) {
    const art = el("div", "dc-act-art");
    const img = el("img");
    img.src = s.album_art_url;
    img.alt = s.album || "Album art";
    img.loading = "lazy";
    hideOnError(img);
    art.appendChild(img);
    card.appendChild(art);
  }

  const body = el("div", "dc-act-text");
  body.appendChild(el("div", "dc-act-name", "Listening to Spotify"));
  if (s.song) body.appendChild(el("div", "dc-act-line", s.song));
  if (s.artist) body.appendChild(el("div", "dc-act-line", "by " + s.artist));

  if (s.timestamps && s.timestamps.start && s.timestamps.end) {
    const bar = el("div", "dc-bar");
    bar.appendChild(el("span"));
    bar.dataset.start = String(s.timestamps.start);
    bar.dataset.end = String(s.timestamps.end);
    body.appendChild(bar);
    liveNodes.push(bar);
  }

  card.appendChild(body);
  return card;
}

function tickLive() {
  const now = Date.now();
  for (const node of liveNodes) {
    if (node.classList.contains("dc-bar")) {
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      const span = end - start;
      const pct = span > 0 ? Math.max(0, Math.min(100, ((now - start) / span) * 100)) : 0;
      node.firstChild.style.width = pct + "%";
    } else {
      node.textContent = formatElapsed(now - Number(node.dataset.start)) + " elapsed";
    }
  }
}
setInterval(tickLive, 1000);

function presenceUnavailable() {
  const dot = document.getElementById("presence-dot");
  const text = document.getElementById("presence-text");
  dot.className = "dot";
  text.textContent = "presence unavailable";
}

// ---- Lanyard transport ----
//
// WebSocket first, so presence updates the instant it changes rather than up
// to 30s later. REST polling covers the gap whenever the socket is down.

let socket = null;
let heartbeat = null;
let retry = 0;
let pollTimer = null;
let gotSocketData = false;

async function fetchPresence() {
  try {
    const res = await fetch("https://api.lanyard.rest/v1/users/" + DISCORD_USER_ID);
    const json = await res.json();
    if (json.success) {
      // A late REST response must not clobber fresher socket data.
      if (!gotSocketData) renderProfile(json.data);
    } else {
      presenceUnavailable();
    }
  } catch {
    if (!gotSocketData) presenceUnavailable();
  }
}

function startPolling() {
  if (pollTimer) return;
  fetchPresence();
  pollTimer = setInterval(fetchPresence, 30_000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function connectLanyard() {
  let ws;
  try {
    ws = new WebSocket("wss://api.lanyard.rest/socket");
  } catch {
    startPolling();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => { retry = 0; });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.op === 1) {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 3 }));
      }, msg.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { subscribe_to_id: DISCORD_USER_ID } }));
    } else if (msg.op === 0) {
      // With subscribe_to_id (singular) the payload IS the presence object.
      if (msg.d && msg.d.discord_user) {
        gotSocketData = true;
        stopPolling();
        renderProfile(msg.d);
      }
    }
  });

  const fallback = () => {
    clearInterval(heartbeat);
    if (socket === ws) socket = null;
    gotSocketData = false;
    startPolling(); // keep the card live while we back off
    retry += 1;
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(retry, 5)));
    setTimeout(connectLanyard, delay);
  };

  ws.addEventListener("close", fallback, { once: true });
  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}

// ---- pointer-follow glow ----

function initCursorGlow() {
  const glow = document.querySelector(".cursor-glow");
  if (!glow || prefersReducedMotion()) return;
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  let targetX = window.innerWidth / 2;
  let targetY = window.innerHeight / 2;
  let x = targetX;
  let y = targetY;
  let running = false;

  window.addEventListener("pointermove", (e) => {
    targetX = e.clientX;
    targetY = e.clientY;
    if (!running) {
      running = true;
      glow.classList.add("is-active");
      requestAnimationFrame(frame);
    }
  }, { passive: true });

  window.addEventListener("pointerleave", () => glow.classList.remove("is-active"));

  function frame() {
    x += (targetX - x) * 0.2;
    y += (targetY - y) * 0.2;
    glow.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
    requestAnimationFrame(frame);
  }
}

// ---- homelab status ----

function formatUptime(value) {
  return value === null || value === undefined ? "—" : value.toFixed(1) + "%";
}

function formatLatency(value) {
  return value === null || value === undefined ? "—" : Math.round(value) + " ms";
}

function relativeTime(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  return Math.round(seconds / 3600) + "h ago";
}

// Tween a numeric readout from its previous value. Falls back to setting text
// outright on first render, on null values, and under reduced motion.
function setReadout(node, value, format) {
  const hadValue = node.dataset.value !== undefined && node.dataset.value !== "";
  const previous = hadValue ? Number(node.dataset.value) : NaN;
  const next = value === null || value === undefined ? NaN : Number(value);
  const canTween =
    !prefersReducedMotion() &&
    Number.isFinite(previous) &&
    Number.isFinite(next) &&
    previous !== next;

  node.dataset.value = Number.isFinite(next) ? String(next) : "";

  if (!canTween) {
    node.textContent = format(value);
    return;
  }

  node.classList.add("is-changing");
  const DURATION = 320;
  const start = performance.now();

  requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = format(previous + (next - previous) * eased);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      node.textContent = format(value);
      node.classList.remove("is-changing");
    }
  });
}

// Tiles are built once and updated in place — rebuilding would replay the
// entrance animation every poll and discard the number tweens.
const tiles = new Map();
const groups = new Map();

function buildTile(svc, index) {
  const card = el("article", "status-card glass status-" + svc.status);
  // Stagger, capped so a long list finishes appearing promptly.
  card.style.setProperty("--i", String(Math.min(index, 12)));

  const head = el("div", "status-card-head");
  head.appendChild(el("span", "status-dot"));
  head.appendChild(el("h4", null, svc.name));
  card.appendChild(head);

  const dl = el("dl", "status-readout");
  const readouts = {};
  const FIELDS = [["uptime24h", "24h"], ["uptime30d", "30d"], ["latencyMs", "ping"]];
  for (const pair of FIELDS) {
    const group = el("div");
    group.appendChild(el("dt", null, pair[1]));
    const dd = el("dd");
    group.appendChild(dd);
    dl.appendChild(group);
    readouts[pair[0]] = dd;
  }
  card.appendChild(dl);

  if (svc.publicUrl) {
    const link = el("a", "status-visit", "visit");
    link.href = svc.publicUrl;
    link.rel = "noopener";
    card.appendChild(link);
  }

  return { card, readouts };
}

function gridForNode(nodeId, nodes) {
  if (groups.has(nodeId)) return groups.get(nodeId);

  const container = document.getElementById("status-groups");
  const wrap = el("div", "status-group");

  const meta = nodes.find((n) => n.id === nodeId);
  if (meta) wrap.appendChild(el("h3", "status-group-title", meta.label));

  const grid = el("div", "status-grid");
  wrap.appendChild(grid);
  container.appendChild(wrap);

  groups.set(nodeId, grid);
  return grid;
}

function renderStatus(services, nodes) {
  const placeholder = document.getElementById("status-loading");
  if (placeholder) placeholder.remove();

  services.forEach((svc, index) => {
    let tile = tiles.get(svc.id);
    if (!tile) {
      tile = buildTile(svc, index);
      tiles.set(svc.id, tile);
      gridForNode(svc.node, nodes).appendChild(tile.card);
    }
    tile.card.className = "status-card glass status-" + svc.status;
    setReadout(tile.readouts.uptime24h, svc.uptime24h, formatUptime);
    setReadout(tile.readouts.uptime30d, svc.uptime30d, formatUptime);
    setReadout(tile.readouts.latencyMs, svc.latencyMs, formatLatency);
  });

  // Drop tiles for services removed from config.json.
  const live = new Set(services.map((s) => s.id));
  for (const [id, tile] of tiles) {
    if (!live.has(id)) {
      tile.card.remove();
      tiles.delete(id);
    }
  }

  const up = services.filter((s) => s.status === "up").length;
  const summary = document.getElementById("status-summary");
  summary.textContent = up + "/" + services.length + " services up";
  summary.hidden = false;
}

async function updateStatus() {
  const meta = document.getElementById("status-meta");
  try {
    const res = await fetch("/api/status");
    const json = await res.json();
    renderStatus(json.services, json.nodes || []);
    // Report when services were last actually checked — generatedAt would
    // always read "0s ago".
    const stamps = json.services.map((s) => s.lastChecked).filter(Boolean).sort();
    meta.textContent = "checked " + relativeTime(stamps[stamps.length - 1]);
  } catch {
    // Leave already-rendered tiles alone; one failed poll shouldn't discard
    // good data. Only the first-load placeholder gets replaced.
    const placeholder = document.getElementById("status-loading");
    if (placeholder) placeholder.textContent = "Couldn't reach the status service.";
    meta.textContent = "status unavailable";
  }
}

initCursorGlow();
// Paint the profile straight away from REST so the card is populated on first
// render, then hand over to the socket for instant live updates.
fetchPresence();
connectLanyard();
updateStatus();
setInterval(updateStatus, 30_000);

// ---- GitHub contribution calendar ----
//
// Data comes from our own /api/github, which proxies and caches upstream so
// the page doesn't hammer a third-party API once per visitor.

function countUp(node, to) {
  if (prefersReducedMotion()) { node.textContent = String(to); return; }
  const DURATION = 700;
  const start = performance.now();
  requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step);
  });
}

async function loadContributions() {
  const graph = document.getElementById("gh-graph");
  const loading = document.getElementById("gh-loading");
  if (!graph) return;

  try {
    const res = await fetch("/api/github");
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    if (!Array.isArray(data.days) || !data.days.length) throw new Error("no days");

    if (loading) loading.remove();

    const weeks = document.createElement("div");
    weeks.className = "gh-weeks";

    // Pad so the first column starts on the correct weekday row.
    const firstDay = new Date(data.days[0].date + "T00:00:00Z").getUTCDay();
    for (let i = 0; i < firstDay; i++) {
      const pad = el("span", "gh-cell gh-l0");
      pad.style.visibility = "hidden";
      weeks.appendChild(pad);
    }

    data.days.forEach((d, i) => {
      const cell = el("span", "gh-cell gh-l" + (d.level || 0));
      cell.style.setProperty("--w", String(Math.floor((i + firstDay) / 7)));
      cell.title = d.count + (d.count === 1 ? " contribution" : " contributions") + " on " + d.date;
      weeks.appendChild(cell);
    });

    graph.appendChild(weeks);
    // Most recent weeks are the interesting end on a narrow screen.
    graph.scrollLeft = graph.scrollWidth;

    const count = document.getElementById("gh-count");
    if (count) countUp(count, data.total || 0);

    const legend = document.getElementById("gh-legend");
    if (legend) legend.hidden = false;
  } catch {
    if (loading) loading.textContent = "Couldn't load contributions.";
  }
}

// ---- marine snow ----
//
// A handful of slow motes, sized and paced randomly so they don't pulse in
// unison. Desktop only (the CSS hides it under 720px) and skipped entirely
// under reduced motion.

function initSnow() {
  if (prefersReducedMotion()) return;
  if (window.matchMedia("(max-width: 720px)").matches) return;

  const layer = document.createElement("div");
  layer.className = "snow";
  layer.setAttribute("aria-hidden", "true");

  const COUNT = 26;
  for (let i = 0; i < COUNT; i++) {
    const mote = document.createElement("i");
    const size = 1.5 + Math.random() * 2.5;
    mote.style.left = (Math.random() * 100).toFixed(2) + "%";
    mote.style.width = size.toFixed(1) + "px";
    mote.style.height = size.toFixed(1) + "px";
    mote.style.opacity = (0.25 + Math.random() * 0.45).toFixed(2);
    mote.style.animationDuration = (16 + Math.random() * 26).toFixed(1) + "s";
    mote.style.animationDelay = (-Math.random() * 40).toFixed(1) + "s";
    layer.appendChild(mote);
  }
  document.body.appendChild(layer);
}

// ---- scroll reveal ----
//
// Only applied once IntersectionObserver is confirmed present and motion is
// allowed, so the .reveal opacity:0 state can never strand content on a
// browser that would not animate it back.

function initReveal() {
  if (prefersReducedMotion() || !("IntersectionObserver" in window)) return;

  const targets = document.querySelectorAll(".section-gh, .section-lab");
  if (!targets.length) return;

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });

  for (const t of targets) {
    t.classList.add("reveal");
    io.observe(t);
  }
}

initSnow();
initReveal();
loadContributions();
