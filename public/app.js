// ---- presence (Discord, via Lanyard) ----
//
// TODO: set this to your Discord user ID (enable Developer Mode in Discord
// settings, then right-click your profile → Copy User ID).
// Lanyard only tracks presence for members of its support server —
// join it once at https://discord.gg/lanyard and it'll keep working.
const DISCORD_USER_ID = "YOUR_DISCORD_ID_HERE";

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

// ---- service status ----

function formatUptime(value) {
  return value === null || value === undefined ? "—" : value.toFixed(1) + "%";
}

function formatLatency(value) {
  return value === null || value === undefined ? "—" : Math.round(value) + " ms";
}

function relativeTime(iso) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  return Math.round(seconds / 3600) + "h ago";
}

function renderStatus(services) {
  const grid = document.getElementById("status-grid");
  grid.innerHTML = "";
  for (const svc of services) {
    const card = document.createElement("article");
    card.className = "status-card glass status-" + svc.status;

    const head = document.createElement("div");
    head.className = "status-card-head";
    head.innerHTML = `<span class="status-dot"></span><h3></h3>`;
    head.querySelector("h3").textContent = svc.name;
    card.appendChild(head);

    const dl = document.createElement("dl");
    dl.className = "status-readout";
    dl.innerHTML = `
      <div><dt>24h</dt><dd>${formatUptime(svc.uptime24h)}</dd></div>
      <div><dt>30d</dt><dd>${formatUptime(svc.uptime30d)}</dd></div>
      <div><dt>latency</dt><dd>${formatLatency(svc.latencyMs)}</dd></div>
    `;
    card.appendChild(dl);

    if (svc.publicUrl) {
      const link = document.createElement("a");
      link.href = svc.publicUrl;
      link.textContent = "visit";
      link.style.fontSize = "0.8rem";
      link.style.marginTop = "10px";
      link.style.display = "inline-block";
      link.style.borderBottom = "none";
      card.appendChild(link);
    }

    grid.appendChild(card);
  }
}

async function updateStatus() {
  const meta = document.getElementById("status-meta");
  try {
    const res = await fetch("/api/status");
    const json = await res.json();
    renderStatus(json.services);
    meta.textContent = "updated " + relativeTime(json.generatedAt);
  } catch {
    meta.textContent = "status unavailable";
  }
}

updatePresence();
updateStatus();
setInterval(updatePresence, 30_000);
setInterval(updateStatus, 30_000);
