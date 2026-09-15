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
// Short max-age with revalidation. There is no build step and therefore no
// content hashing, so a long immutable cache would strand returning visitors on
// stale CSS/JS with no recovery path.
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "5m",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));

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
    // This runs in a bare timer, so an uncaught throw here takes the whole
    // process down — and because the cause (disk full, read-only mount) is
    // persistent, systemd's Restart=on-failure would flap forever. The history
    // file is a disposable cache; failing to write it must never cost the site.
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      // Write-then-rename: a crash mid-write would otherwise leave truncated
      // JSON, which loadHistory() silently reads back as {} — losing 30 days of
      // aggregates without any error.
      const tmp = HISTORY_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
      fs.renameSync(tmp, HISTORY_FILE);
    } catch (err) {
      console.error("history write failed (continuing):", err.message);
    }
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

// ---------- GitHub contributions ----------
//
// Proxied server-side and cached so the page doesn't hammer a third-party API
// once per visitor, and so a brief upstream outage doesn't blank the graph.
// The upstream needs no token; everything here is already-public data.

const DISCORD_USER_ID = config.discordUserId || "761016030892916737";
const GITHUB_USER = config.github || "hasan-ismail";
const GITHUB_TTL_MS = 60 * 60 * 1000; // 1 hour
let githubCache = { at: 0, data: null };

async function fetchContributions() {
  const url = `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(GITHUB_USER)}?y=last`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("upstream " + res.status);
    const json = await res.json();
    if (!Array.isArray(json.contributions)) throw new Error("unexpected shape");
    // Keep only the fields the UI needs.
    return {
      user: GITHUB_USER,
      total: (json.total && json.total.lastYear) || 0,
      days: json.contributions.map((d) => ({ date: d.date, count: d.count, level: d.level })),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- lines added, across public non-fork repos ----------
//
// GitHub has no "lines of code" endpoint. This sums per-week additions from
// /stats/contributors for every non-fork repo the user owns or co-owns via an
// org, keeping only their own commits and only the last 365 days.
//
// Two things make it slow and therefore heavily cached:
//   * it is one request per repo, and
//   * GitHub computes those stats on demand and answers 202 until ready, so a
//     cold repo needs polling.
// It refreshes in the background so /api/github never blocks on it.

const GITHUB_ORGS = config.githubOrgs || ["OpenMasjid-Solutions"];
const LOC_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let locCache = { at: 0, data: null };
let locRunning = false;

const ghHeaders = { "User-Agent": "hasanismail.dev", Accept: "application/vnd.github+json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghJson(url) {
  const res = await fetch(url, { headers: ghHeaders });
  const text = res.status === 204 ? "" : await res.text();
  return { status: res.status, text };
}

// Thrown when GitHub rate-limits us, so the whole run aborts instead of
// grinding through a dozen more requests that will all fail the same way.
class RateLimited extends Error {}

async function repoStats(fullName, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const { status, text } = await ghJson(`https://api.github.com/repos/${fullName}/stats/contributors`);
    if (status === 200 && text.trim().startsWith("[")) return JSON.parse(text);
    if (status === 202) { await sleep(2500); continue; } // still computing
    if (status === 204) return [];                       // empty repo
    if (status === 403 || status === 429) throw new RateLimited(fullName);
    return null;                                         // 404 / unexpected
  }
  return null;
}

async function computeLinesAdded() {
  const owners = [{ name: GITHUB_USER, kind: "users" }, ...GITHUB_ORGS.map((o) => ({ name: o, kind: "orgs" }))];
  const repos = [];
  for (const o of owners) {
    const { status, text } = await ghJson(`https://api.github.com/${o.kind}/${o.name}/repos?per_page=100`);
    if (status !== 200) continue;
    for (const r of JSON.parse(text)) if (!r.fork) repos.push(r.full_name);
  }

  const cutoff = Math.floor(Date.now() / 1000) - 365 * 86400;
  let added = 0, removed = 0, counted = 0, skipped = 0;
  for (const full of repos) {
    let stats;
    try {
      stats = await repoStats(full);
    } catch (err) {
      if (err instanceof RateLimited) {
        // Stop immediately. Continuing would burn the remaining quota on calls
        // that cannot succeed, and the partial result is discarded anyway.
        skipped += repos.length - counted;
        return { added, removed, repos: counted, skipped, rateLimited: true };
      }
      throw err;
    }
    if (!stats) { skipped++; continue; }
    counted++;
    const mine = stats.find(
      (c) => c.author && c.author.login.toLowerCase() === GITHUB_USER.toLowerCase(),
    );
    if (!mine) continue;
    for (const w of mine.weeks) if (w.w >= cutoff) { added += w.a; removed += w.d; }
  }
  // `skipped` is reported so the UI never implies full coverage it didn't get.
  return { added, removed, repos: counted, skipped, rateLimited: false };
}

// A PARTIAL total is worse than none: GitHub answers 202 while it computes a
// cold repo's stats, and counting only the repos that happened to be warm
// produced 6,473 instead of the real 483,277. So an incomplete run is never
// cached as the answer — it is retried shortly, and a previously complete
// result keeps being served in the meantime.
const LOC_RETRY_MS = 3 * 60 * 1000;

function refreshLinesAdded() {
  if (locRunning) return;
  const age = Date.now() - locCache.at;
  const complete = locCache.data && locCache.data.skipped === 0;
  if (complete && age < LOC_TTL_MS) return;
  if (!complete && age < LOC_RETRY_MS) return;

  locRunning = true;
  computeLinesAdded()
    .then((data) => {
      if (data.skipped === 0 || !locCache.data) {
        // Keep an incomplete result only as a placeholder when nothing better
        // exists; `skipped` tells the UI not to display it.
        locCache = { at: Date.now(), data };
      } else {
        locCache.at = Date.now(); // keep the good data, just back off
      }
      if (data.rateLimited) {
        // Rate-limited is NOT "stats not ready" — retrying in 3 minutes would
        // just re-trip the limit. Back off for a full hour, which is the
        // unauthenticated window.
        locCache.at = Date.now() + LOC_RETRY_MS;
        console.warn("lines-added hit the GitHub rate limit; backing off an hour");
      } else if (data.skipped) {
        console.warn(`lines-added incomplete: ${data.skipped} repo(s) not ready, retrying later`);
      }
    })
    .catch((err) => {
      console.error("lines-added computation failed:", err.message);
      // Stamp the attempt, or a failing run restarts a ~14-call GitHub crawl on
      // every single request.
      if (!locCache.data) locCache = { at: Date.now(), data: null };
      else locCache.at = Date.now();
    })
    .finally(() => { locRunning = false; });
}

app.get("/api/github", async (req, res) => {
  refreshLinesAdded(); // background; never blocks this response

  const fresh = Date.now() - githubCache.at < GITHUB_TTL_MS;
  const withLoc = (d) => ({ ...d, linesAdded: locCache.data || null });

  if (fresh && githubCache.data) return res.json(withLoc(githubCache.data));
  try {
    const data = await fetchContributions();
    githubCache = { at: Date.now(), data };
    res.json(withLoc(data));
  } catch (err) {
    console.error("github contributions fetch failed:", err.message);
    // Serve stale rather than nothing — a year of history doesn't go bad fast.
    if (githubCache.data) return res.json(withLoc(githubCache.data));
    res.status(503).json({ error: "contributions unavailable" });
  }
});

// ---------- Discord profile (banner, About Me, badges, connections) ----------
//
// Lanyard gives live presence but no banner and no About Me. This proxies a
// public profile endpoint for the static half of the card, cached hard because
// it changes rarely. Sanitised on the way out: connection *names* are what
// Discord already shows on the profile, but the raw account ids it returns are
// not, so they are dropped here rather than shipped to the browser.

const DISCORD_PROFILE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let profileCache = { at: 0, data: null };

async function fetchDiscordProfile() {
  const url = `https://dcdn.dstn.to/profile/${encodeURIComponent(DISCORD_USER_ID)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("upstream " + res.status);
    const j = await res.json();
    const u = j.user || {};
    const p = j.user_profile || {};
    return {
      id: u.id,
      banner: u.banner || null,
      bannerColor: u.banner_color || null,
      accentColor: typeof p.accent_color === "number" ? p.accent_color : null,
      themeColors: Array.isArray(p.theme_colors) ? p.theme_colors : null,
      pronouns: p.pronouns || null,
      bio: p.bio || u.bio || "",
      premiumType: j.premium_type || 0,
      badges: (j.badges || []).map((b) => ({
        id: b.id,
        description: b.description || "",
        icon: b.icon || null,
        // https only. This value becomes an href in the browser, so a
        // compromised upstream could otherwise hand us a javascript: URL.
        link: typeof b.link === "string" && /^https:///i.test(b.link) ? b.link : null,
      })),
      // type/name/verified only — the raw ids are deliberately not forwarded.
      connections: (j.connected_accounts || []).map((c) => ({
        type: c.type,
        name: c.name,
        verified: !!c.verified,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/profile", async (req, res) => {
  const fresh = Date.now() - profileCache.at < DISCORD_PROFILE_TTL_MS;
  if (fresh && profileCache.data) return res.json(profileCache.data);
  try {
    const data = await fetchDiscordProfile();
    profileCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error("discord profile fetch failed:", err.message);
    if (profileCache.data) return res.json(profileCache.data);
    res.status(503).json({ error: "profile unavailable" });
  }
});

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
