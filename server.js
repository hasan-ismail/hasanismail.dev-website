// hasanismail.dev — server
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
const DAY_MS = 86_400_000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ---------- config ----------
//
// `target` values in config.json are internal addresses and must never leave
// this process. Confirm each one against the actual host before trusting a
// green tile: a wrong port reads as "down", and a reachable-but-wrong path can
// read as "up" (any status < 500 counts as up). See README.md for which of the
// seeded targets have been verified.

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

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function todayKey() {
  return dayKey(Date.now());
}

function pruneOldDays(days) {
  const cutoff = Date.now() - RETAIN_DAYS * DAY_MS;
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

function asPercent(up, total) {
  if (!total) return null;
  return Math.round((up / total) * 1000) / 10; // one decimal place
}

// Rolling 24h from daily buckets.
//
// Buckets are per-UTC-day, so "the last 24 hours" straddles two of them. We
// take all of today plus the fraction of yesterday needed to fill the window:
// at 00:00 UTC that is ~all of yesterday, at 23:59 UTC ~none of it. Summing
// both buckets outright would report a 24-48h window, and using today alone
// collapses to a single sample just after midnight.
function uptime24h(id) {
  const entry = history[id];
  if (!entry) return null;
  const now = Date.now();
  const startOfToday = new Date(todayKey() + "T00:00:00Z").getTime();
  const elapsedFraction = Math.min(1, (now - startOfToday) / DAY_MS);
  const remainder = 1 - elapsedFraction; // how much of yesterday is still in window

  const today = entry.days[todayKey()] || { up: 0, total: 0 };
  const yesterday = entry.days[dayKey(now - DAY_MS)] || { up: 0, total: 0 };

  const up = today.up + yesterday.up * remainder;
  const total = today.total + yesterday.total * remainder;
  return asPercent(up, total);
}

function uptimeOverDays(id, days) {
  const entry = history[id];
  if (!entry) return null;
  const cutoff = Date.now() - days * DAY_MS;
  let up = 0;
  let total = 0;
  for (const [day, stats] of Object.entries(entry.days)) {
    if (new Date(day + "T00:00:00Z").getTime() < cutoff) continue;
    up += stats.up;
    total += stats.total;
  }
  return asPercent(up, total);
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
        // Release the socket — an unread body keeps the connection open.
        if (res.body) res.body.cancel().catch(() => {});
        resolve({ ok: res.status < 500, latencyMs: Date.now() - started });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ ok: false, latencyMs: Date.now() - started });
      });
  });
}

function checkTcp(target, timeoutMs) {
  const [host, portStr] = String(target).split(":");
  const port = Number(portStr);
  return new Promise((resolve) => {
    const started = Date.now();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ ok: false, latencyMs: 0 });
      return;
    }
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

async function checkOne(svc) {
  try {
    const result =
      svc.type === "tcp"
        ? await checkTcp(svc.target, CHECK_TIMEOUT_MS)
        : await checkHttp(svc.target, CHECK_TIMEOUT_MS);
    recordResult(svc.id, result.ok, result.latencyMs);
  } catch (err) {
    // A malformed entry must not take the whole checker down — record it as
    // down and keep going.
    console.error(`check failed for "${svc.id}":`, err.message);
    recordResult(svc.id, false, 0);
  }
}

// Checks run concurrently with a bounded pool. Sequentially, N services each
// costing up to CHECK_TIMEOUT_MS would exceed CHECK_INTERVAL_MS once N grows
// past ~12, so runs would overlap and double-count. The cap keeps a large
// service list from opening dozens of sockets at once.
const CHECK_CONCURRENCY = 8;
let checksRunning = false;

async function runChecks() {
  // Belt-and-braces: never let a slow round overlap the next tick.
  if (checksRunning) return;
  checksRunning = true;
  try {
    const queue = [...config.services];
    const workers = Array.from(
      { length: Math.min(CHECK_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length) await checkOne(queue.shift());
      },
    );
    await Promise.all(workers);
  } finally {
    checksRunning = false;
  }
}

runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);

// ---------- public API (sanitized — no internal hosts/ports/IPs) ----------

app.get("/api/status", (req, res) => {
  // Every field here is explicitly chosen. `id`, `name` and `node` are labels,
  // not addresses — `target` and anything derived from it never appears.
  const out = config.services.map((svc) => {
    const entry = history[svc.id];
    const last = entry?.last;
    return {
      id: svc.id,
      name: svc.name,
      node: svc.node ?? null,
      status: last ? (last.ok ? "up" : "down") : "unknown",
      latencyMs: last?.ok ? last.latencyMs : null,
      lastChecked: last?.at ?? null,
      uptime24h: uptime24h(svc.id),
      uptime30d: uptimeOverDays(svc.id, RETAIN_DAYS),
      publicUrl: svc.publicUrl ?? null,
    };
  });
  const nodes = (config.nodes ?? []).map((n) => ({ id: n.id, label: n.label }));
  res.json({ nodes, services: out, generatedAt: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`hasanismail-site listening on :${PORT}`);
});
