// ---- motion preference ----
//
// Every animated flourish is opt-out. CSS handles its own side via the
// prefers-reduced-motion media query; this mirrors it for the JS-driven
// pieces (pointer glow, number tweens, the animated nameplate).
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// Respects the in-page override first, then the OS preference. Defined as a
// function, not a captured boolean, so the toggle takes effect without a
// rebuild of every caller.
// Animations are ON by default, including when the OS asks for reduced motion
// — the owner chose that for this site. Anyone can still turn them off with
// the in-page toggle, and that choice persists.
// Top-level init calls run in sequence in one script, so an exception in any
// of them aborts the rest of the file and silently takes out every feature
// declared below it. The symptom is a scatter of unrelated things failing on
// one device and working everywhere else — which is what was reported for the
// phone (no stars, clock stuck at --:--:--). Each entry point runs through
// this, so one failure costs one feature instead of all of them.
function safe(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error("init failed: " + name, err);
  }
}

const prefersReducedMotion = () => {
  try {
    if (localStorage.getItem("hi-motion") === "off") return true;
  } catch {}
  return false;
};

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

// Set once /api/profile has supplied the richer data. renderProfile() runs on
// every presence update, so without these it would overwrite the icon badges
// with public_flags text pills and re-show the nameplate over the banner.
const richProfile = { badges: false, banner: false };

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
  if (plates && !prefersReducedMotion() && !richProfile.banner) {
    if (plate.getAttribute("src") !== plates.video) plate.src = plates.video;
    plate.hidden = false;
  } else {
    plate.hidden = true;
  }

  const badges = document.getElementById("dc-badges");
  if (badges && !richProfile.badges) {
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
    } else if (!gotSocketData) {
      // A failed REST poll must not blank the line while the socket is healthy.
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
    // Park the loop once the glow has caught up, instead of running forever at
    // 60fps behind an idle pointer. A pointermove restarts it.
    if (Math.abs(targetX - x) < 0.5 && Math.abs(targetY - y) < 0.5) {
      running = false;
      return;
    }
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
  const row = el("div", "svc-row status-" + svc.status);
  row.style.setProperty("--i", String(Math.min(index, 14)));

  const dot = el("span", "status-dot");
  row.appendChild(dot);

  // Status is otherwise conveyed by dot colour alone, which is invisible to a
  // screen reader and to red/green colour blindness.
  const sr = el("span", "sr-only");
  row.appendChild(sr);

  const name = el("span", "svc-name", svc.name);
  // Most guests are LXCs, so only the exception is marked.
  if (svc.kind === "vm") name.appendChild(el("span", "svc-kind", "VM"));
  row.appendChild(name);

  const readouts = {};
  const meta = el("span", "svc-meta");
  for (const [key, label] of [["uptime24h", "24h"], ["uptime30d", "30d"], ["latencyMs", "ping"]]) {
    const cell = el("span", "svc-stat");
    cell.appendChild(el("span", "svc-stat-label", label));
    const val = el("span", "svc-stat-value");
    cell.appendChild(val);
    meta.appendChild(cell);
    readouts[key] = val;
  }
  row.appendChild(meta);

  // The visit slot is ALWAYS present, even when empty. Appending the link only
  // on rows that have one took width out of the flex row and shunted that row's
  // stat columns left, so a single linked service broke alignment for the
  // whole list.
  const visitSlot = el("span", "svc-visit-slot");
  if (svc.publicUrl) {
    const link = el("a", "svc-visit", "visit");
    link.href = svc.publicUrl;
    link.rel = "noopener";
    visitSlot.appendChild(link);
  }
  row.appendChild(visitSlot);

  return { card: row, readouts, sr };
}

function gridForNode(nodeId, nodes) {
  if (groups.has(nodeId)) return groups.get(nodeId);

  const container = document.getElementById("status-groups");
  const wrap = el("div", "status-group");

  const meta = nodes.find((n) => n.id === nodeId);
  if (meta) wrap.appendChild(el("h3", "status-group-title", meta.label));

  const grid = el("div", "svc-list");
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
      tile.node = svc.node;
      tiles.set(svc.id, tile);
      gridForNode(svc.node, nodes).appendChild(tile.card);
    } else if (tile.node !== svc.node) {
      // Node assignment now comes from Proxmox, so a guest that migrates moves
      // to its new node's group instead of staying where it was first drawn.
      tile.node = svc.node;
      gridForNode(svc.node, nodes).appendChild(tile.card);
    }
    tile.card.className = "svc-row status-" + svc.status;
    if (tile.sr) tile.sr.textContent = svc.name + ": " + svc.status;
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
  const total = services.length;
  const summary = document.getElementById("status-summary");
  const allUp = up === total && total > 0;
  summary.textContent = allUp
    ? "All services online and operational"
    : "Some services offline — " + up + " of " + total + " online";
  summary.classList.toggle("is-degraded", !allUp);
  summary.hidden = false;
}

// ---- homelab dashboard ----
//
// Cluster, internet, clients, local traffic and DNS panels, mirroring the
// owner's Homarr board. Everything here comes from /api/status, which builds
// each field explicitly server-side; nothing in these panels is an address.
//
// Built once and updated in place each poll, like the service rows, so the
// rings and bars ease between readings instead of redrawing.

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

const fmt = {
  pct: (v) => (v == null ? "–" : (v >= 10 ? Math.round(v) : v.toFixed(1)) + "%"),
  mbps: (bps) => (bps == null ? "–" : (bps / 1e6 >= 100 ? Math.round(bps / 1e6) : (bps / 1e6).toFixed(1))),
  gb: (b) => (b == null ? "–" : Math.round(b / 1073741824)),
  tb: (b) => (b == null ? "–" : (b / 1e12).toFixed(1)),
  count: (n) =>
    n == null ? "–"
    : n >= 1e6 ? (n / 1e6).toFixed(1) + "M"
    : n >= 1e3 ? (n / 1e3).toFixed(1) + "k"
    : String(n),
  uptime: (s) => {
    if (s == null) return "–";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return d ? d + "d " + h + "h" : h + "h " + Math.floor((s % 3600) / 60) + "m";
  },
};

// The short name after "Node 1 — ", so the cluster panel reads "proxmox 2".
const nodeShortName = (label) => String(label).split("—").pop().trim();

function makeRing(kind, label) {
  const wrap = el("div", "ring ring--" + kind);
  wrap.setAttribute("role", "img");
  const svg = svgEl("svg", { viewBox: "0 0 44 44", "aria-hidden": "true" });
  svg.appendChild(svgEl("circle", { class: "ring-track", cx: 22, cy: 22, r: 18, pathLength: 100 }));
  const arc = svgEl("circle", { class: "ring-arc", cx: 22, cy: 22, r: 18, pathLength: 100 });
  svg.appendChild(arc);
  wrap.appendChild(svg);
  const mid = el("div", "ring-mid");
  const value = el("span", "ring-value", "–");
  mid.append(value, el("span", "ring-label", label));
  wrap.appendChild(mid);
  return {
    wrap,
    set(p) {
      const v = p == null ? 0 : Math.max(0, Math.min(100, p));
      arc.style.strokeDasharray = v + " 100";
      value.textContent = fmt.pct(p);
      wrap.setAttribute("aria-label", label + " " + fmt.pct(p));
    },
  };
}

function makeCard(cls, title) {
  const card = el("article", "dash-card glass " + cls);
  const head = el("header", "dash-head");
  head.appendChild(el("h3", "dash-title", title));
  const aside = el("div", "dash-aside");
  head.appendChild(aside);
  card.appendChild(head);
  return { card, head, aside };
}

// A labelled "<n> online · <n> offline" chip for the cluster footer.
function makeTally(label) {
  const chip = el("div", "dash-tally");
  chip.appendChild(el("span", "dash-tally-label", label));
  const on = el("span", "dash-tally-on");
  const off = el("span", "dash-tally-off");
  chip.append(on, off);
  return {
    chip,
    set(t) {
      on.textContent = (t ? t.online : "–") + " online";
      off.textContent = (t ? t.offline : "–") + " offline";
      chip.classList.toggle("has-offline", !!(t && t.offline));
    },
  };
}

// Signal-quality bands for the 5G (NR) readings, coarse on purpose.
function quality(metric, v) {
  if (v == null) return "";
  const t = { rsrp: [-90, -105], sinr: [13, 0], rsrq: [-10, -15] }[metric];
  return v >= t[0] ? "q-good" : v >= t[1] ? "q-fair" : "q-poor";
}

const dashRefs = {};

function buildDash(root, nodes) {
  // ---- cluster ----
  const c = makeCard("dash-cluster", "Cluster");
  dashRefs.clusterUp = el("span", "dash-chip dash-chip--up");
  c.aside.appendChild(dashRefs.clusterUp);
  const grid = el("div", "cluster-grid");
  dashRefs.nodes = new Map();
  for (const n of nodes) {
    if (n.cpu == null && n.mem == null) continue; // a config-only node has no stats
    const col = el("div", "cluster-node");
    col.appendChild(el("h4", "cluster-node-name", nodeShortName(n.label)));
    const rings = el("div", "cluster-rings");
    const cpu = makeRing("cpu", "CPU");
    const ram = makeRing("ram", "RAM");
    rings.append(cpu.wrap, ram.wrap);
    col.appendChild(rings);
    const foot = el("p", "cluster-node-foot");
    col.appendChild(foot);
    grid.appendChild(col);
    dashRefs.nodes.set(n.id, { col, cpu, ram, foot });
  }
  const poolCol = el("div", "cluster-node cluster-pool");
  dashRefs.poolName = el("h4", "cluster-node-name");
  poolCol.appendChild(dashRefs.poolName);
  dashRefs.pool = makeRing("pool", "ZFS");
  const poolRings = el("div", "cluster-rings");
  poolRings.appendChild(dashRefs.pool.wrap);
  poolCol.appendChild(poolRings);
  dashRefs.poolFoot = el("p", "cluster-node-foot");
  poolCol.appendChild(dashRefs.poolFoot);
  grid.appendChild(poolCol);
  dashRefs.poolCol = poolCol;
  c.card.appendChild(grid);
  const tallies = el("div", "dash-tallies");
  dashRefs.vms = makeTally("VMs");
  dashRefs.lxcs = makeTally("LXCs");
  dashRefs.storage = makeTally("Storage");
  tallies.append(dashRefs.vms.chip, dashRefs.lxcs.chip, dashRefs.storage.chip);
  c.card.appendChild(tallies);
  dashRefs.clusterCard = c.card;
  root.appendChild(c.card);

  // ---- internet ----
  const i = makeCard("dash-internet", "Internet");
  dashRefs.tech = el("span", "dash-badge");
  dashRefs.bars = el("span", "signal-bars");
  dashRefs.bars.setAttribute("role", "img");
  for (let b = 1; b <= 5; b++) dashRefs.bars.appendChild(el("i"));
  dashRefs.netDot = el("span", "dash-dot");
  i.aside.append(dashRefs.tech, dashRefs.bars, dashRefs.netDot);
  const speed = el("p", "dash-speed");
  dashRefs.down = el("span", "dash-big");
  dashRefs.up = el("span", "dash-big");
  speed.append(el("span", "dash-arrow dash-arrow--down", "↓"), dashRefs.down,
               el("span", "dash-arrow dash-arrow--up", "↑"), dashRefs.up,
               el("span", "dash-unit", "Mbps"));
  i.card.appendChild(speed);
  const sig = el("dl", "dash-signal");
  dashRefs.sig = {};
  for (const [key, label, unit] of [["rsrp", "RSRP", "dBm"], ["sinr", "SINR", "dB"], ["rsrq", "RSRQ", "dB"]]) {
    const cell = el("div", "dash-signal-cell");
    cell.appendChild(el("dt", "", label));
    const dd = el("dd");
    const val = el("span", "dash-signal-value");
    dd.append(val, el("span", "dash-unit", unit));
    cell.appendChild(dd);
    sig.appendChild(cell);
    dashRefs.sig[key] = val;
  }
  dashRefs.sigRow = sig;
  i.card.appendChild(sig);
  dashRefs.netFoot = el("p", "dash-foot");
  i.card.appendChild(dashRefs.netFoot);
  dashRefs.internetCard = i.card;
  root.appendChild(i.card);

  // ---- clients ----
  const k = makeCard("dash-clients", "Clients");
  dashRefs.clients = el("span", "dash-total");
  k.aside.appendChild(dashRefs.clients);
  const split = el("div", "dash-split");
  dashRefs.wifiBar = el("span", "dash-split-wifi");
  dashRefs.wiredBar = el("span", "dash-split-wired");
  split.append(dashRefs.wifiBar, dashRefs.wiredBar);
  k.card.appendChild(split);
  const legend = el("p", "dash-legend");
  dashRefs.wifiCount = el("strong");
  dashRefs.wiredCount = el("strong");
  const l1 = el("span", "dash-legend-item dash-legend-item--wifi", "Wi-Fi ");
  l1.appendChild(dashRefs.wifiCount);
  const l2 = el("span", "dash-legend-item dash-legend-item--wired", "Wired ");
  l2.appendChild(dashRefs.wiredCount);
  legend.append(l1, l2);
  k.card.appendChild(legend);
  dashRefs.gear = el("p", "dash-foot");
  k.card.appendChild(dashRefs.gear);
  dashRefs.clientsCard = k.card;
  root.appendChild(k.card);

  // ---- local traffic ----
  const t = makeCard("dash-traffic", "Local traffic");
  dashRefs.localTotal = el("span", "dash-total");
  t.aside.appendChild(dashRefs.localTotal);
  const spark = svgEl("svg", { class: "spark", viewBox: "0 0 300 56", preserveAspectRatio: "none", "aria-hidden": "true" });
  dashRefs.sparkFill = svgEl("path", { class: "spark-fill" });
  dashRefs.sparkLine = svgEl("path", { class: "spark-line" });
  spark.append(dashRefs.sparkFill, dashRefs.sparkLine);
  t.card.appendChild(spark);
  // Two separate items so each wraps as a unit, never mid-reading.
  const localFoot = el("p", "dash-legend");
  dashRefs.wiredLine = el("span", "dash-nowrap");
  dashRefs.wifiLine = el("span", "dash-nowrap");
  localFoot.append(dashRefs.wiredLine, dashRefs.wifiLine);
  t.card.appendChild(localFoot);
  dashRefs.trafficCard = t.card;
  root.appendChild(t.card);

  // ---- pi-hole ----
  const p = makeCard("dash-dns", "Pi-hole");
  dashRefs.blockedPct = el("span", "dash-total");
  p.aside.appendChild(dashRefs.blockedPct);
  const bar = el("div", "dash-bar");
  dashRefs.blockedBar = el("span");
  bar.appendChild(dashRefs.blockedBar);
  p.card.appendChild(bar);
  dashRefs.dnsLine = el("p", "dash-legend");
  p.card.appendChild(dashRefs.dnsLine);
  dashRefs.dnsFoot = el("p", "dash-foot");
  p.card.appendChild(dashRefs.dnsFoot);
  dashRefs.dnsCard = p.card;
  root.appendChild(p.card);
}

function sparkPaths(values) {
  if (!values || values.length < 2) return ["", ""];
  const W = 300, H = 56, max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 2 - (v / max) * (H - 6)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return [line, line + " L" + W + " " + H + " L0 " + H + " Z"];
}

function renderDash(json) {
  const root = document.getElementById("lab-dash");
  if (!root) return;
  const { cluster, network, dns } = json;
  if (!cluster && !network && !dns) {
    root.hidden = true; // no Homarr token on the server: list only
    return;
  }
  if (!dashRefs.built) {
    buildDash(root, json.nodes || []);
    dashRefs.built = true;
  }
  root.hidden = false;

  // cluster
  dashRefs.clusterCard.hidden = !cluster;
  if (cluster) {
    dashRefs.clusterUp.textContent = "Up " + fmt.uptime(cluster.uptime);
    for (const n of json.nodes || []) {
      const r = dashRefs.nodes.get(n.id);
      if (!r) continue;
      r.cpu.set(n.cpu);
      r.ram.set(n.mem);
      // Two lines: a 124px column cannot hold "72 cores · 149 / 252 GB", and
      // on one line the neighbouring footers ran into each other.
      r.foot.textContent = (n.cores ?? "–") + " cores\n" + fmt.gb(n.memUsed) + " / " + fmt.gb(n.memTotal) + " GB";
      r.col.classList.toggle("is-offline", n.online === false);
    }
    dashRefs.poolCol.hidden = !cluster.pool;
    if (cluster.pool) {
      dashRefs.poolName.textContent = cluster.pool.label;
      dashRefs.pool.set(cluster.pool.pct);
      dashRefs.poolFoot.textContent = fmt.tb(cluster.pool.used) + " / " + fmt.tb(cluster.pool.total) + " TB";
    }
    dashRefs.vms.set(cluster.vms);
    dashRefs.lxcs.set(cluster.lxcs);
    dashRefs.storage.set(cluster.storage);
  }

  // internet, clients, traffic all come from the UniFi reading
  for (const card of [dashRefs.internetCard, dashRefs.clientsCard, dashRefs.trafficCard]) card.hidden = !network;
  if (network) {
    const cell = network.cellular;
    dashRefs.tech.hidden = !cell || !cell.tech;
    if (cell && cell.tech) dashRefs.tech.textContent = cell.tech + (cell.tech === "5G" ? (cell.standalone ? " SA" : " NSA") : "");
    dashRefs.bars.hidden = !cell || cell.bars == null;
    if (cell && cell.bars != null) {
      [...dashRefs.bars.children].forEach((b, idx) => b.classList.toggle("on", idx < cell.bars));
      dashRefs.bars.setAttribute("aria-label", "Signal " + cell.bars + " of 5");
    }
    dashRefs.netDot.className = "dash-dot " + (network.online ? "is-up" : "is-down");
    dashRefs.netDot.title = network.online ? "Internet up" : "Internet down";
    dashRefs.down.textContent = fmt.mbps(network.downBps);
    dashRefs.up.textContent = fmt.mbps(network.upBps);
    dashRefs.sigRow.hidden = !cell;
    if (cell) {
      for (const key of ["rsrp", "sinr", "rsrq"]) {
        const v = cell[key];
        dashRefs.sig[key].textContent = v == null ? "–" : String(Math.round(v));
        dashRefs.sig[key].className = "dash-signal-value " + quality(key, v);
      }
    }
    const bits = [];
    if (network.latencyMs != null) bits.push(network.latencyMs + " ms ping");
    if (network.latencyAvgMs != null) bits.push(network.latencyAvgMs + " ms avg");
    if (network.availability != null) bits.push(fmt.pct(network.availability) + " up (24h)");
    dashRefs.netFoot.textContent = bits.join(" · ");

    const wifi = network.wifiClients || 0, wired = network.wiredClients || 0;
    dashRefs.clients.textContent = network.clients ?? wifi + wired;
    const sum = wifi + wired || 1;
    dashRefs.wifiBar.style.flexGrow = String(wifi / sum);
    dashRefs.wiredBar.style.flexGrow = String(wired / sum);
    dashRefs.wifiCount.textContent = String(wifi);
    dashRefs.wiredCount.textContent = String(wired);
    dashRefs.gear.textContent =
      (network.accessPoints ?? "–") + " access points · " + (network.switches ?? "–") + " switches";

    const L = network.local || {};
    dashRefs.localTotal.replaceChildren(fmt.mbps(L.totalBps) + " ", el("span", "dash-unit", "Mbps"));
    const [line, fill] = sparkPaths(L.history);
    dashRefs.sparkLine.setAttribute("d", line);
    dashRefs.sparkFill.setAttribute("d", fill);
    dashRefs.wiredLine.textContent = "Wired ↓ " + fmt.mbps(L.wiredDownBps) + " ↑ " + fmt.mbps(L.wiredUpBps);
    dashRefs.wifiLine.textContent = "Wi-Fi ↓ " + fmt.mbps(L.wifiDownBps) + " ↑ " + fmt.mbps(L.wifiUpBps);
  }

  // dns
  dashRefs.dnsCard.hidden = !dns;
  if (dns) {
    dashRefs.blockedPct.replaceChildren(fmt.pct(dns.percentBlocked) + " ", el("span", "dash-unit", "blocked"));
    dashRefs.blockedBar.style.width = Math.min(100, Math.max(1, dns.percentBlocked || 0)) + "%";
    dashRefs.dnsLine.textContent = fmt.count(dns.queries) + " queries · " + fmt.count(dns.blocked) + " blocked";
    dashRefs.dnsFoot.textContent = (dns.clients ?? "–") + " clients · " + fmt.count(dns.blocklist) + " domains on the blocklist";
  }
}

async function updateStatus() {
  const meta = document.getElementById("status-meta");
  try {
    const res = await fetch("/api/status");
    const json = await res.json();
    renderStatus(json.services, json.nodes || []);
    try { renderDash(json); } catch (err) { console.error("dashboard render failed", err); }
    // Report when services were last actually checked — generatedAt would
    // always read "0s ago".
    const stamps = json.services.map((s) => s.lastChecked).filter(Boolean).sort();
    meta.textContent =
      (json.source === "proxmox" ? "live from Proxmox · " : "") +
      "checked " + relativeTime(stamps[stamps.length - 1]);
  } catch {
    // Leave already-rendered tiles alone; one failed poll shouldn't discard
    // good data. Only the first-load placeholder gets replaced.
    const placeholder = document.getElementById("status-loading");
    if (placeholder) placeholder.textContent = "Couldn't reach the status service.";
    meta.textContent = "status unavailable";
  }
}

safe("initCursorGlow", initCursorGlow);
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

// Returns true once the figure is on screen. The server computes it from a
// ~14-repo crawl and GitHub answers 202 while it builds cold stats, so on a
// fresh process the first page load legitimately has nothing to show yet.
function renderLinesAdded(la) {
  const loc = document.getElementById("gh-loc");
  if (!loc) return true; // nothing to fill; stop polling
  // Only render a COMPLETE count — a partial sum reads as authoritative and
  // would be wrong by two orders of magnitude. Repos that are permanently
  // unavailable contribute zero and are reported in the tooltip rather than
  // hiding the whole figure.
  if (!la || !la.publishable || !(la.added > 0)) return false;
  const n = la.added;
  loc.textContent = n.toLocaleString() + " lines written";
  loc.title =
    n.toLocaleString() + " added, " + la.removed.toLocaleString() +
    " removed across " + la.repos + " public repos in the last year" +
    (la.coverage < 1
      ? " (" + Math.round(la.coverage * 100) + "% of repos resolved)"
      : "");
  loc.hidden = false;
  return true;
}

// Ask again a few times rather than making the visitor reload. Bounded: the
// server backs off for an hour when rate-limited, and a page left open all
// day should not keep retrying something that is not coming.
function pollLinesAdded(tries = 0) {
  if (tries >= 6) return;
  setTimeout(async () => {
    try {
      const res = await fetch("/api/github");
      if (!res.ok) throw new Error("status " + res.status);
      const d = await res.json();
      if (!renderLinesAdded(d.linesAdded)) pollLinesAdded(tries + 1);
    } catch {
      pollLinesAdded(tries + 1);
    }
  }, 20000);
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

    // Lines added. Deliberately labelled "added", not "written" — it is the
    // sum of per-week additions across public non-fork repos, so it includes
    // things like lockfiles and excludes private work entirely.
    if (!renderLinesAdded(data.linesAdded)) pollLinesAdded();
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
  // Phones get a thinner field rather than none — the owner asked for the
  // drifting motes there too.
  const narrow = window.matchMedia("(max-width: 720px)").matches;

  const layer = document.createElement("div");
  layer.className = "snow";
  layer.setAttribute("aria-hidden", "true");

  const COUNT = narrow ? 14 : 26;
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

  const show = (node) => node.classList.add("is-in");

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        show(entry.target);
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });

  for (const t of targets) {
    t.classList.add("reveal");
    io.observe(t);
    // Already on screen at load? Reveal on the next frame rather than waiting
    // for the observer's first callback.
    if (t.getBoundingClientRect().top < window.innerHeight) {
      requestAnimationFrame(() => show(t));
    }
  }

  // Failsafe. `.reveal` sets opacity:0, so if the observer never fires — a
  // throttled background tab, a headless renderer, anything unexpected — the
  // content would stay invisible permanently. Revealing unconditionally after
  // a short delay means the worst case is a missed animation, never lost
  // content.
  setTimeout(() => targets.forEach(show), 1500);
}

safe("initSnow", initSnow);
safe("initReveal", initReveal);
loadContributions();

// ---- static half of the Discord profile ----
//
// Lanyard covers live presence; it has no banner, About Me, badges or
// connections. Those come from our own /api/profile, which proxies and caches
// a public profile endpoint server-side.


// Render bio text with URLs linked. Built from DOM nodes, never innerHTML —
// the text is remote content and must not be able to inject markup.
function renderBioInto(container, text) {
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  for (const rawLine of String(text).split("\n")) {
    const line = document.createElement("p");
    line.className = "pc-bio-line";
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(rawLine)) !== null) {
      if (m.index > last) line.appendChild(document.createTextNode(rawLine.slice(last, m.index)));
      const a = document.createElement("a");
      a.href = m[0];
      a.rel = "noopener";
      a.className = "pc-bio-link";
      a.textContent = m[0].replace(/^https?:\/\//, "");
      line.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < rawLine.length) line.appendChild(document.createTextNode(rawLine.slice(last)));
    if (!rawLine.trim()) line.classList.add("is-blank");
    container.appendChild(line);
  }
}

async function loadDiscordProfile() {
  let p;
  try {
    const res = await fetch("/api/profile");
    if (!res.ok) throw new Error("status " + res.status);
    p = await res.json();
  } catch {
    return; // the card still works from Lanyard alone
  }

  // Real profile banner, in place of the gradient.
  if (p.banner && p.id) {
    const ext = p.banner.startsWith("a_") ? "gif" : "png";
    const img = el("img", "pc-banner-img");
    img.src = CDN + "/banners/" + p.id + "/" + p.banner + "." + ext + "?size=600";
    img.alt = "";
    hideOnError(img);
    const banner = document.querySelector(".pc-banner");
    if (banner) {
      banner.prepend(img);
      banner.classList.add("has-image");
      richProfile.banner = true;
      // The nameplate would sit on top of the artwork and muddy it.
      const plate = document.getElementById("dc-nameplate");
      if (plate) plate.hidden = true;
    }
  }

  // Accent colour drives the name and the banner edge.
  if (typeof p.accentColor === "number") {
    const hex = "#" + p.accentColor.toString(16).padStart(6, "0");
    document.documentElement.style.setProperty("--dc-accent", hex);
  }

  // Badge icons, with Discord's own descriptions as tooltips.
  const badges = document.getElementById("dc-badges");
  if (badges && p.badges && p.badges.length) {
    badges.textContent = "";
    badges.classList.add("is-icons");
    richProfile.badges = true;
    for (const b of p.badges) {
      if (!b.icon) continue;
      // Mirror of the server-side check: only https becomes a link, so a
      // compromised upstream cannot inject a javascript: URL.
      const safeLink = typeof b.link === "string" && /^https:///i.test(b.link) ? b.link : null;
      const node = safeLink ? el("a", "pc-badge-icon") : el("span", "pc-badge-icon");
      if (safeLink) { node.href = safeLink; node.rel = "noopener"; }
      node.title = b.description || b.id;
      const img = el("img");
      img.src = CDN + "/badge-icons/" + b.icon + ".png";
      img.alt = b.description || b.id;
      img.loading = "lazy";
      hideOnError(img);
      node.appendChild(img);
      badges.appendChild(node);
    }
  }

  // Pronouns — this is where "raid is backup" actually lives.
  if (p.pronouns) {
    const slot = document.getElementById("dc-pronouns");
    if (slot) slot.textContent = p.pronouns;
  }

  // The About Me section is AUTHORED content in index.html, not the Discord
  // bio — the owner asked for copy about the OpenMasjid role and AsmaTec
  // instead. renderBioInto() is kept because the Discord bio may be wanted
  // again, but nothing calls it now; do not re-point it at #dc-bio without
  // checking, or it will wipe the authored copy on first load.

  // The connections list was removed — it restated the links section. The
  // /api/profile payload still carries it (sanitised); we just don't render it.
}

loadDiscordProfile();

// ---- motion override ----
//
// The OS preference is the default, but an explicit click outranks it in both
// directions: someone with reduce-motion enabled system-wide can still opt in
// here, and someone without it can opt out. Stored per-browser.
//
// This is why prefersReducedMotion() is a function rather than a captured
// boolean — every motion-gated feature re-reads it.

const MOTION_KEY = "hi-motion";

function motionOverride() {
  try { return localStorage.getItem(MOTION_KEY); } catch { return null; }
}

function motionEnabled() {
  return motionOverride() !== "off";
}

function applyMotion() {
  // Always stamp the attribute: "on" is the default, so the CSS override has
  // to be present even when the visitor has never touched the toggle.
  document.documentElement.dataset.motion = motionEnabled() ? "on" : "off";

  const btn = document.getElementById("motion-toggle");
  const label = document.getElementById("motion-label");
  if (btn) btn.setAttribute("aria-pressed", String(motionEnabled()));
  // The label spells the state out. aria-pressed alone was ambiguous to
  // sighted users, and "my animations don't work" is indistinguishable from
  // "I turned them off on this device" without it.
  if (label) label.textContent = motionEnabled() ? "Animations on" : "Animations off";
}

function initMotionToggle() {
  const btn = document.getElementById("motion-toggle");
  if (!btn) return;
  applyMotion();
  btn.addEventListener("click", () => {
    const next = motionEnabled() ? "off" : "on";
    try { localStorage.setItem(MOTION_KEY, next); } catch {}
    applyMotion();
    // Features that bail out early when motion is off need starting once it
    // comes back on; a reload is the honest way to re-run all of them.
    if (next === "on") location.reload();
  });
}

safe("initMotionToggle", initMotionToggle);

// ---- shooting stars ----
//
// Occasional, not constant: each star spends most of its cycle parked
// off-screen, and the durations/delays are randomised so they never sync up.
// Phones get a smaller flock rather than none: a star is two composited
// properties on a 2px box, which is nothing like the cost of the animated
// jellyfish this layer replaced. Skipped under reduced motion.

function initShootingStars() {
  if (prefersReducedMotion()) return;
  const narrow = window.matchMedia("(max-width: 720px)").matches;

  // Colours are written as concrete inline values and the travel keyframes
  // carry no var(). Custom properties inside @keyframes are a long-standing
  // Gecko weak spot: if one fails to resolve there, the whole transform
  // declaration is dropped at computed-value time, the star never travels and
  // it sits parked off-screen fading in and out invisibly — which is exactly
  // what "the shooting stars don't work on Firefox mobile" looks like.
  // Nothing in this layer now depends on var() resolution.
  const HUES = [
    [255, 255, 255],
    [122, 232, 251],
    [179, 184, 255],
    [255, 138, 218],
    [255, 215, 154],
    [126, 240, 200],
    [255, 169, 184],
  ];

  const layer = document.createElement("div");
  layer.className = "shooting";
  layer.setAttribute("aria-hidden", "true");

  for (let i = 0; i < (narrow ? 9 : 10); i++) {
    const [r, g, b] = HUES[i % HUES.length];
    const rgb = r + ", " + g + ", " + b;

    // The arm holds the angle as a STATIC transform, so the animation only
    // has to translate along one axis and never needs a variable.
    const arm = document.createElement("i");
    arm.style.top = (4 + Math.random() * 84).toFixed(1) + "%";
    arm.style.transform = "rotate(" + (22 + Math.random() * 22).toFixed(1) + "deg)";

    const streak = document.createElement("b");
    streak.style.width = (narrow ? 170 + Math.random() * 130 : 240 + Math.random() * 200).toFixed(0) + "px";
    // rgba(...,0) rather than `transparent`: some engines fade through grey.
    streak.style.background =
      "linear-gradient(to right, rgba(" + rgb + ", 0), rgba(" + rgb + ", 0.5) 55%, rgb(" + rgb + "))";
    streak.style.boxShadow = "0 0 16px 2px rgba(" + rgb + ", 0.7)";
    streak.style.animationDuration = (6 + Math.random() * 7).toFixed(1) + "s";
    streak.style.animationDelay = (-Math.random() * 13).toFixed(1) + "s";

    const head = document.createElement("u");
    head.style.background = "rgb(" + rgb + ")";
    head.style.boxShadow = "0 0 12px 3px rgba(" + rgb + ", 0.8)";

    streak.appendChild(head);
    arm.appendChild(streak);
    layer.appendChild(arm);
  }
  document.body.appendChild(layer);
}

safe("initShootingStars", initShootingStars);

// ---- timezone chip ----
//
// The chip is labelled "EST" because that is how the owner refers to it; the
// time itself is formatted in America/New_York, so it stays correct across
// the DST boundary rather than drifting an hour for half the year.
//
// The clock only ticks while the chip is open. A permanent 1s timer for a
// tooltip nobody is looking at is exactly the kind of idle wake-up this page
// avoids elsewhere (the pointer glow parks itself for the same reason).
function initTimezone() {
  const chip = document.getElementById("pc-tz");
  const out = document.getElementById("pc-tz-clock");
  if (!chip || !out) return;

  // US Eastern without depending on Intl's timezone database. Intl is tried
  // first because it is authoritative, but an engine with a trimmed ICU build
  // either throws or quietly ignores timeZone, and the chip then sat on its
  // --:--:-- placeholder forever. This is the post-2007 US rule: DST from the
  // second Sunday in March to the first Sunday in November.
  function manual(d) {
    const y = d.getUTCFullYear();
    const nthSunday = (month, n, utcHour) => {
      const dow = new Date(Date.UTC(y, month, 1)).getUTCDay();
      const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
      return Date.UTC(y, month, day, utcHour);
    };
    const start = nthSunday(2, 2, 7);  // 02:00 EST = 07:00 UTC
    const end = nthSunday(10, 1, 6);   // 02:00 EDT = 06:00 UTC
    const t = d.getTime();
    const loc = new Date(t + (t >= start && t < end ? -4 : -5) * 3600000);
    let h = loc.getUTCHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const p2 = (n) => (n < 10 ? "0" + n : String(n));
    return h + ":" + p2(loc.getUTCMinutes()) + ":" + p2(loc.getUTCSeconds()) + " " + ampm;
  }

  let fmt = null;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    });
    // Only trust it if it actually produced digits.
    if (/[0-9]/.test(f.format(new Date()))) fmt = f;
  } catch {
    // fall through to manual
  }

  const paint = () => {
    const t = fmt ? fmt.format(new Date()) : manual(new Date());
    out.textContent = t;
    chip.setAttribute("aria-label", "Eastern Time, currently " + t);
  };

  // Paint BEFORE binding anything. Whatever else fails, the placeholder never
  // survives past this line.
  paint();

  let timer = null;
  const open = () => {
    paint();
    if (!timer) timer = setInterval(paint, 1000);
    chip.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    if (timer) { clearInterval(timer); timer = null; }
    chip.setAttribute("aria-expanded", "false");
  };

  chip.addEventListener("pointerenter", open);
  chip.addEventListener("pointerleave", close);
  chip.addEventListener("focus", open);
  chip.addEventListener("blur", close);
  chip.addEventListener("click", () => {
    const on = chip.classList.toggle("is-open");
    if (on) open(); else close();
  });
  chip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chip.click(); }
  });
  // Touch engines that never fire pointerenter still get a fresh time.
  chip.addEventListener("touchstart", paint, { passive: true });

  // Belt and braces for slow or odd engines.
  setTimeout(paint, 1000);
  window.addEventListener("load", paint);
}

// ---- social stats ----
//
// /api/social returns only the sources that actually answered, so a key being
// absent is the normal case rather than an error: Reddit 403s and Instagram
// 429s without credentials. Nothing is rendered for a missing source — a
// plain link is honest, a confident zero is not.
async function loadSocial() {
  const slots = document.querySelectorAll(".link-stat[data-social]");
  if (!slots.length) return;

  let data;
  try {
    const res = await fetch("/api/social");
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const num = (n) => (typeof n === "number" ? n.toLocaleString() : String(n));
  const label = {
    youtube: (d) => (d.subscribers ? d.subscribers + " subscribers" : null),
    reddit: (d) => (d.karma != null ? num(d.karma) + " karma" : null),
    instagram: (d) => (d.followers != null ? num(d.followers) + " followers" : null),
    facebook: (d) => (d.followers != null ? num(d.followers) + " followers" : null),
  };

  for (const slot of slots) {
    const key = slot.dataset.social;
    const d = data[key];
    if (!d || !label[key]) continue;
    const text = label[key](d);
    if (!text) continue;
    slot.textContent = text;
    slot.hidden = false;
    if (key === "reddit" && d.postKarma != null && d.commentKarma != null) {
      slot.title = num(d.postKarma) + " post karma, " + num(d.commentKarma) +
        " comment karma" + (d.since ? ", on Reddit since " + d.since : "");
    }
    if (key === "youtube" && d.videos) slot.title = d.videos + " videos";
  }
}

// ---- contact form ----
//
// Posts to /api/contact, which forwards to the owner's Discord. Alongside the
// message it sends what the browser reports about itself (timezone, screen,
// hardware, languages); the server adds IP, location and the parsed user
// agent. None of it is echoed back — the response is just ok or an error.

const PAGE_OPENED_AT = Date.now();

// Short example formats rather than instructions: on a phone the field is
// ~320px and a sentence gets cut off mid-word.
const REPLY_PLACEHOLDER = {
  discord: "your Discord username",
  whatsapp: "+1 555 123 4567",
  email: "you@example.com",
  instagram: "@yourhandle",
  telegram: "@yourusername",
  other: "where can I reach you?",
};

async function collectClientInfo() {
  const info = {};
  const tryit = (fn) => { try { fn(); } catch {} };
  tryit(() => { info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; });
  tryit(() => {
    info.localTime = new Date().toLocaleString("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", hour12: true,
    });
  });
  tryit(() => { info.languages = Array.from(navigator.languages || [navigator.language]).slice(0, 6); });
  tryit(() => { info.screen = screen.width + "×" + screen.height; });
  tryit(() => { info.viewport = window.innerWidth + "×" + window.innerHeight; });
  tryit(() => { info.dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100; });
  tryit(() => { info.colorDepth = screen.colorDepth; });
  tryit(() => { if (navigator.hardwareConcurrency) info.cores = navigator.hardwareConcurrency; });
  tryit(() => { if (navigator.deviceMemory) info.memory = navigator.deviceMemory; });
  tryit(() => { info.touch = navigator.maxTouchPoints || 0; });
  tryit(() => {
    const c = navigator.connection;
    if (c) { info.connection = c.effectiveType; if (c.downlink) info.downlink = c.downlink; }
  });
  tryit(() => { info.colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; });
  tryit(() => { info.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches; });
  tryit(() => { info.cookies = navigator.cookieEnabled; });
  tryit(() => { if (document.referrer) info.referrer = document.referrer; });
  info.elapsedMs = Date.now() - PAGE_OPENED_AT;
  // Chromium exposes the real device model and OS version only through
  // user-agent client hints; Firefox and Safari simply do not have them.
  try {
    const uad = navigator.userAgentData;
    if (uad) {
      info.mobile = uad.mobile;
      info.platform = uad.platform;
      info.brands = uad.brands.map((x) => x.brand + " " + x.version).join(", ");
      const hi = await uad.getHighEntropyValues(["model", "platformVersion"]);
      if (hi.model) info.model = hi.model;
      if (hi.platformVersion) info.platformVersion = hi.platformVersion;
    }
  } catch {}
  return info;
}

function initContact() {
  const form = document.getElementById("contact-form");
  if (!form) return;
  const message = document.getElementById("c-message");
  const count = document.getElementById("c-count");
  const method = document.getElementById("c-method");
  const handle = document.getElementById("c-handle");
  const send = document.getElementById("c-send");
  const status = document.getElementById("c-status");

  const updateCount = () => {
    const n = message.value.length;
    count.textContent = n + " / 2000";
    count.classList.toggle("is-near", n > 1800);
  };
  message.addEventListener("input", updateCount);
  updateCount();

  const updatePlaceholder = () => {
    handle.placeholder = REPLY_PLACEHOLDER[method.value] || "";
    handle.type = method.value === "email" ? "email" : "text";
    handle.inputMode = method.value === "whatsapp" ? "tel" : method.value === "email" ? "email" : "text";
  };
  method.addEventListener("change", updatePlaceholder);
  updatePlaceholder();

  const say = (text, kind) => {
    status.textContent = text;
    status.className = "contact-status" + (kind ? " is-" + kind : "");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = message.value.trim();
    if (text.length < 2) {
      say("Write a message first.", "error");
      message.focus();
      return;
    }
    send.disabled = true;
    say("Sending…");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          method: handle.value.trim() ? method.value : "",
          handle: handle.value.trim(),
          website: form.elements.website.value,
          client: await collectClientInfo(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        say(handle.value.trim()
          ? "Sent — thanks! I'll get back to you."
          : "Sent — thanks for the message!", "ok");
        message.value = "";
        handle.value = "";
        updateCount();
      } else {
        say(body.error || "Couldn't send that — please try again.", "error");
      }
    } catch {
      say("Couldn't reach the server — check your connection and try again.", "error");
    } finally {
      send.disabled = false;
    }
  });
}

safe("initTimezone", initTimezone);
safe("loadSocial", loadSocial);
safe("initContact", initContact);
