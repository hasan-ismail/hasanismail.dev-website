// hasanismail.org — server
//
// Serves the static site and runs a lightweight uptime checker for the
// services listed in config.json. The checker runs entirely server-side
// against internal hosts/IPs; only sanitized results (name, status,
// latency, uptime %) are ever exposed via /api/status. Internal
// hosts/ports/IPs are never sent to the client.

const express = require("express");
const fs = require("fs");
const path = require("path");
const net = require("net");

const PORT = process.env.PORT || 3300;
const CHECK_INTERVAL_MS = 60_000; // how often each service is checked
const CHECK_TIMEOUT_MS = 5_000; // per-check timeout
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const RETAIN_DAYS = 30;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ---------- config ----------

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.services)) throw new Error("config.json: services must be an array");
  return cfg;
}

let config = loadConfig();

// ---------- persistence ----------
// Per service: { days: { "YYYY-MM-DD": { up: n, total: n } }, last: {...} }

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

let history = loadHistory();
let saveTimer = null;

function saveHistorySoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  }, 1000);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldDays(days) {
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
  for (const day of Object.keys(days)) {
    if (new Date(day + "T00:00:00Z").getTime() < cutoff) delete days[day];
  }
}

function recordResult(id, ok, latencyMs) {
  if (!history[id]) history[id] = { days: {}, last: null };
  const entry = history[id];
  const day = todayKey();
  if (!entry.days[day]) entry.days[day] = { up: 0, total: 0 };
  entry.days[day].total += 1;
  if (ok) entry.days[day].up += 1;
  entry.last = { ok, latencyMs, at: new Date().toISOString() };
  pruneOldDays(entry.days);
  saveHistorySoon();
}

function uptimeOverDays(id, days) {
  const entry = history[id];
  if (!entry) return null;
  const cutoff = Date.now() - days * 86_400_000;
  let up = 0;
  let total = 0;
  for (const [day, stats] of Object.entries(entry.days)) {
    if (new Date(day + "T00:00:00Z").getTime() < cutoff) continue;
    up += stats.up;
    total += stats.total;
  }
  if (total === 0) return null;
  return Math.round((up / total) * 1000) / 10; // one decimal place
}

// ---------- checks ----------

function checkHttp(target, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(target, { signal: controller.signal, redirect: "follow" })
      .then((res) => {
        clearTimeout(timer);
        resolve({ ok: res.status < 500, latencyMs: Date.now() - started });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ ok: false, latencyMs: Date.now() - started });
      });
  });
}

function checkTcp(target, timeoutMs) {
  const [host, portStr] = target.split(":");
  const port = Number(portStr);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function runChecks() {
  for (const svc of config.services) {
    const result =
      svc.type === "tcp"
        ? await checkTcp(svc.target, CHECK_TIMEOUT_MS)
        : await checkHttp(svc.target, CHECK_TIMEOUT_MS);
    recordResult(svc.id, result.ok, result.latencyMs);
  }
}

runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);

// ---------- public API (sanitized — no internal hosts/ports/IPs) ----------

app.get("/api/status", (req, res) => {
  const out = config.services.map((svc) => {
    const entry = history[svc.id];
    const last = entry?.last;
    return {
      id: svc.id,
      name: svc.name,
      status: last ? (last.ok ? "up" : "down") : "unknown",
      latencyMs: last?.ok ? last.latencyMs : null,
      lastChecked: last?.at ?? null,
      uptime24h: uptimeOverDays(svc.id, 1),
      uptime30d: uptimeOverDays(svc.id, 30),
      publicUrl: svc.publicUrl ?? null,
    };
  });
  res.json({ services: out, generatedAt: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`hasanismail-site listening on :${PORT}`);
});
