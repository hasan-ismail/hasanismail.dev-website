// ---- motion preference ----
//
// Every animated flourish in here is opt-out. CSS handles its own side via
// the prefers-reduced-motion media query; this mirrors it for the
// JS-driven pieces (pointer glow, animated number transitions).
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const prefersReducedMotion = () => reducedMotion.matches;

// ---- presence (Discord, via Lanyard) ----
//
// To change this: enable Developer Mode in Discord settings, then right-click
// a profile → Copy User ID. Lanyard only tracks presence for members of its
// own server, so the account must have joined https://discord.gg/lanyard once.
//
// This ID is public by necessity — the browser calls the Lanyard API with it,
// so it ships in this file. Discord user IDs aren't secrets, but don't treat
// this as a private value.
const DISCORD_USER_ID = "761016030892916737";

const PRESENCE_LABEL = {
  online: "online now",
  idle: "away",
  dnd: "busy",
  offline: "offline",
};

async function updatePresence() {
  const dot = document.getElementById("presence-dot");
  const text = document.getElementById("presence-text");
  if (DISCORD_USER_ID === "YOUR_DISCORD_ID_HERE") {
    text.textContent = "presence not configured";
    return;
  }
  try {
    const res = await fetch(`https://api.lanyard.rest/v1/users/${DISCORD_USER_ID}`);
    const json = await res.json();
    if (!json.success) throw new Error("lanyard error");
    const status = json.data.discord_status || "offline";
    dot.className = "dot is-" + status;
    text.textContent = PRESENCE_LABEL[status] || status;
  } catch {
    dot.className = "dot";
    text.textContent = "presence unavailable";
  }
}

// ---- pointer-follow glow ----
//
// A soft teal light trailing the cursor, eased toward the pointer each frame
// so it lags slightly rather than snapping. Pointer-fine devices only; the
// CSS hides it on touch, and reduced-motion skips it entirely.
function initCursorGlow() {
  const glow = document.querySelector(".cursor-glow");
  if (!glow || prefersReducedMotion()) return;
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  let targetX = window.innerWidth / 2;
  let targetY = window.innerHeight / 2;
  let x = targetX;
  let y = targetY;
  let running = false;

  window.addEventListener(
    "pointermove",
    (e) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!running) {
        running = true;
        glow.classList.add("is-active");
        requestAnimationFrame(frame);
      }
    },
    { passive: true },
  );

  window.addEventListener("pointerleave", () => glow.classList.remove("is-active"));

  function frame() {
    x += (targetX - x) * 0.12;
    y += (targetY - y) * 0.12;
    glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    requestAnimationFrame(frame);
  }
}

// ---- service status ----

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

// Tween a numeric readout from its previous value to the new one. Falls back
// to setting the text outright on the first render, when the value is not a
// number, or under reduced motion.
function setReadout(el, value, format) {
  const hadValue = el.dataset.value !== undefined && el.dataset.value !== "";
  const previous = hadValue ? Number(el.dataset.value) : NaN;
  const next = value === null || value === undefined ? NaN : Number(value);
  const canTween =
    !prefersReducedMotion() &&
    Number.isFinite(previous) &&
    Number.isFinite(next) &&
    previous !== next;

  el.dataset.value = Number.isFinite(next) ? String(next) : "";

  if (!canTween) {
    el.textContent = format(value);
    return;
  }

  el.classList.add("is-changing");
  const DURATION = 550;
  const start = performance.now();

  requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = format(previous + (next - previous) * eased);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = format(value);
      el.classList.remove("is-changing");
    }
  });
}

// Tiles are built once and then updated in place. Rebuilding the grid on
// every poll would replay the entrance animation every 30 seconds and throw
// away the number tweens.
const tiles = new Map();

function buildTile(svc, index) {
  const card = document.createElement("article");
  card.className = "status-card glass status-" + svc.status;
  card.style.setProperty("--i", String(index)); // drives the staggered entrance

  const head = document.createElement("div");
  head.className = "status-card-head";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  const title = document.createElement("h3");
  title.textContent = svc.name;
  head.append(dot, title);
  card.appendChild(head);

  const dl = document.createElement("dl");
  dl.className = "status-readout";
  const readouts = {};
  for (const [key, label] of [
    ["uptime24h", "24h"],
    ["uptime30d", "30d"],
    ["latencyMs", "latency"],
  ]) {
    const group = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    group.append(dt, dd);
    dl.appendChild(group);
    readouts[key] = dd;
  }
  card.appendChild(dl);

  if (svc.publicUrl) {
    const link = document.createElement("a");
    link.className = "status-visit";
    link.href = svc.publicUrl;
    link.rel = "noopener";
    link.textContent = "visit";
    card.appendChild(link);
  }

  return { card, readouts };
}

function renderStatus(services) {
  const grid = document.getElementById("status-grid");
  const placeholder = document.getElementById("status-loading");
  if (placeholder) placeholder.remove();

  services.forEach((svc, index) => {
    let tile = tiles.get(svc.id);
    if (!tile) {
      tile = buildTile(svc, index);
      tiles.set(svc.id, tile);
      grid.appendChild(tile.card);
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
}

async function updateStatus() {
  const meta = document.getElementById("status-meta");
  try {
    const res = await fetch("/api/status");
    const json = await res.json();
    renderStatus(json.services);
    // Report when the services were last actually checked, not when the
    // response was generated — generatedAt is always "0s ago".
    const stamps = json.services.map((s) => s.lastChecked).filter(Boolean).sort();
    meta.textContent = "checked " + relativeTime(stamps[stamps.length - 1]);
  } catch {
    // Leave any already-rendered tiles alone; a single failed poll should not
    // discard good data. Only the first-load placeholder gets replaced.
    const placeholder = document.getElementById("status-loading");
    if (placeholder) placeholder.textContent = "Couldn't reach the status service.";
    meta.textContent = "status unavailable";
  }
}

initCursorGlow();
updatePresence();
updateStatus();
setInterval(updatePresence, 30_000);
setInterval(updateStatus, 30_000);
