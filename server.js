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
    // An entry with no `target` is a label-only binding (it renames or re-homes
    // a Proxmox guest) and has nothing to check.
    const queue = config.services.filter((svc) => svc.target);
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

// ---------- Proxmox inventory, via Homarr ----------
//
// The homelab list used to be hand-maintained here in config.json and it
// drifted: it was missing four guests, and it still listed "Node 3" as a
// Windows box whose RDP address had gone dead — the machine is now VM 201 on
// proxmox2 and had been up for weeks while the site reported it down. The
// authoritative inventory is the Proxmox cluster itself, reached through
// Homarr 2.0's integration proxy so this site never holds Proxmox credentials
// of its own.
//
// SECURITY — read before touching homarrProxmox(). That proxy forwards ANY
// method (POST, PUT, DELETE) to the saved Proxmox integration with Homarr's
// stored credentials, so a leaked token, or a visitor able to influence the
// path or method, could stop or destroy guests. Therefore:
//   * the token comes only from the environment, never config.json (which is
//     committed to a public repo);
//   * the method is the literal "GET";
//   * every path is a constant in PX_PATHS — nothing from an incoming request
//     ever reaches this function.
//
// Proxmox state complements the health checks rather than replacing them: a
// guest with its own check reports that check (real app health and latency),
// and every other guest reports its Proxmox running state. Either way a guest
// Proxmox says is stopped is down — the check can be a minute stale, Proxmox
// is not.

const HOMARR_URL = String(process.env.HOMARR_URL || config.homarr?.url || "").replace(/\/+$/, "");
const HOMARR_TOKEN = process.env.HOMARR_TOKEN || "";

// The ONLY upstream calls this site makes through Homarr. Integration kinds
// and paths are constants; homarrGet() refuses anything not in this table.
const HOMARR_CALLS = Object.freeze({
  pxNodes: { kind: "proxmox", path: "/api2/json/nodes" },
  pxGuests: { kind: "proxmox", path: "/api2/json/cluster/resources?type=vm" },
  pxStorage: { kind: "proxmox", path: "/api2/json/cluster/resources?type=storage" },
  unifiHealth: { kind: "unifiController", path: "/proxy/network/api/s/default/stat/health" },
  unifiDevices: { kind: "unifiController", path: "/proxy/network/api/s/default/stat/device" },
  piholeSummary: { kind: "piHole", path: "/api/stats/summary" },
});
let pxInventory = null; // last GOOD inventory; a failed refresh keeps it
let pxRunning = false;

async function homarrGet(callName) {
  const call = HOMARR_CALLS[callName];
  if (!call) throw new Error("homarrGet: unknown call " + callName);
  const res = await fetch(HOMARR_URL + "/api/integrations/request", {
    method: "POST",
    headers: { ApiKey: HOMARR_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ integrationKind: call.kind, method: "GET", path: call.path }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error("homarr HTTP " + res.status);
  const env = await res.json();
  // Homarr answers 200 even when the upstream call failed; the real outcome
  // is in ok/status.
  if (!env.ok) throw new Error(call.kind + " HTTP " + env.status);
  if (!env.data || typeof env.data !== "object") throw new Error(call.kind + ": unexpected payload");
  return env.data; // the raw upstream JSON body
}

// Proxmox and UniFi both wrap their results as { data: [...] }.
async function homarrList(callName) {
  const body = await homarrGet(callName);
  if (!Array.isArray(body.data)) throw new Error(callName + ": expected a list");
  return body.data;
}

const finite = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const slugOf = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Guests never shown. Proxmox itself returned CT 106's name as the literal
// string "[REDACTED]"; whatever it really is, it is not ours to publish.
function isHiddenGuest(name) {
  if (/\[redacted\]/i.test(name)) return true;
  return (config.homelab?.hidden ?? []).some((h) => normName(h) === normName(name));
}

// A config entry binds to a guest by an explicit `guest` name, or by its id or
// display name matching the guest name once punctuation is ignored.
function serviceForGuest(guest) {
  const n = normName(guest.name);
  return (
    config.services.find((s) => s.guest && normName(s.guest) === n) ||
    config.services.find((s) => !s.guest && (normName(s.id) === n || normName(s.name) === n)) ||
    null
  );
}

function nodeIdFor(pxNode) {
  const mapped = (config.nodes ?? []).find((n) => n.proxmox === pxNode);
  return mapped ? mapped.id : "px-" + slugOf(pxNode);
}

const pct = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

async function refreshProxmox() {
  if (!HOMARR_URL || !HOMARR_TOKEN || pxRunning) return;
  pxRunning = true;
  try {
    const [nodes, guests, storage] = await Promise.all([
      homarrList("pxNodes"),
      homarrList("pxGuests"),
      homarrList("pxStorage"),
    ]);
    // Keep only what gets rendered. vmid is retained for ordering but never
    // sent; ssl_fingerprint, tags, storage paths and per-guest disk/network
    // counters are dropped here and never reach the response builder.
    const num = finite;

    // Online/offline tallies count EVERY non-template guest, hidden ones
    // included — a count reveals nothing, and it should match Homarr's.
    const tally = { vm: { online: 0, offline: 0 }, lxc: { online: 0, offline: 0 } };
    for (const g of guests) {
      if (g.template) continue;
      const t = g.type === "qemu" ? tally.vm : tally.lxc;
      if (g.status === "running") t.online++; else t.offline++;
    }
    const storeTally = { online: 0, offline: 0 };
    for (const s of storage) {
      if (s.status === "available") storeTally.online++; else storeTally.offline++;
    }
    // The featured pool: config.homelab.pool names a storage id; otherwise the
    // largest ZFS pool. Only its usage numbers leave this function.
    const poolId = config.homelab?.pool?.storage;
    const pools = storage.filter((s) => (poolId ? s.storage === poolId : s.plugintype === "zfspool"));
    const pool = pools.sort((a, b) => (b.maxdisk || 0) - (a.maxdisk || 0))[0];

    pxInventory = {
      at: new Date().toISOString(),
      tally,
      storage: storeTally,
      pool: pool
        ? {
            label: config.homelab?.pool?.label || "Storage pool",
            used: num(pool.disk),
            total: num(pool.maxdisk),
            pct: pct(pool.disk, pool.maxdisk),
          }
        : null,
      nodes: nodes.map((n) => ({
        node: String(n.node),
        online: n.status === "online",
        cpu: num(n.cpu) === null ? null : Math.round(n.cpu * 1000) / 10,
        cores: num(n.maxcpu),
        mem: pct(n.mem, n.maxmem),
        memUsed: num(n.mem),
        memTotal: num(n.maxmem),
        disk: pct(n.disk, n.maxdisk),
        diskUsed: num(n.disk),
        diskTotal: num(n.maxdisk),
        uptime: num(n.uptime),
      })),
      guests: guests
        .filter((g) => !g.template && g.name && !isHiddenGuest(g.name))
        .map((g) => ({
          vmid: Number(g.vmid),
          name: String(g.name),
          node: String(g.node),
          kind: g.type === "qemu" ? "vm" : "lxc",
          state: String(g.status),
        }))
        .sort((a, b) => a.vmid - b.vmid),
    };
    // Guests with no check of their own get one sample per round from their
    // Proxmox state, so they build up 24h/30d uptime like everything else.
    for (const g of pxInventory.guests) {
      if (!serviceForGuest(g)?.target) {
        recordResult(serviceForGuest(g)?.id ?? slugOf(g.name), g.state === "running", null);
      }
    }
  } catch (err) {
    console.error("proxmox inventory failed (keeping last good):", err.message);
  } finally {
    pxRunning = false;
  }
}

// ---------- network health (UniFi, via Homarr) ----------
//
// stat/health is a deliberately mixed bag, and most of it must NOT go public.
// It carries the public WAN IP, the gateway/netmask/DNS servers, the gateway
// MAC, its firmware version (an exact version is a fingerprint for known
// CVEs), the ISP and ASN, VPN state — and the gateway's configured name, which
// identifies the organisation whose network this is. None of those are read
// below. Only latency, availability, throughput and aggregate counts are.
//
// WAN2 is a failover link that has been down for weeks; reporting it would put
// a permanent red light on a healthy connection, so only the primary WAN is
// read.
let netHealth = null; // last GOOD reading
let netRunning = false;
const NET_INTERVAL_MS = 30_000;
const TRAFFIC_SAMPLES = 60; // 30 minutes at NET_INTERVAL_MS
const trafficHistory = []; // total local bits/s, oldest first

async function refreshNetwork() {
  if (!HOMARR_URL || !HOMARR_TOKEN || netRunning) return;
  netRunning = true;
  try {
    const subs = await homarrList("unifiHealth");
    const sub = (name) => subs.find((s) => s && s.subsystem === name) || {};
    const wan = sub("wan"), www = sub("www"), wlan = sub("wlan"), lan = sub("lan");
    const num = finite;
    const wan1 = wan.uptime_stats?.WAN ?? {};
    const gw = wan["gw_system-stats"] ?? {};
    const rate = (v) => (num(v) === null ? null : Math.round(num(v) * 8)); // bytes/s -> bits/s

    // Direction: on the WAN, rx is download and tx is upload. On wlan/lan the
    // access points and switches TRANSMIT to clients, so tx is the clients'
    // download. This agrees with Homarr's own widget for the same readings.
    const local = {
      wiredDownBps: rate(lan["tx_bytes-r"]),
      wiredUpBps: rate(lan["rx_bytes-r"]),
      wifiDownBps: rate(wlan["tx_bytes-r"]),
      wifiUpBps: rate(wlan["rx_bytes-r"]),
    };
    local.totalBps = Object.values(local).reduce((a, b) => a + (b || 0), 0);
    trafficHistory.push(local.totalBps);
    while (trafficHistory.length > TRAFFIC_SAMPLES) trafficHistory.shift();

    netHealth = {
      at: new Date().toISOString(),
      online: www.status === "ok",
      latencyMs: num(www.latency),
      latencyAvgMs: num(wan1.latency_average),
      availability: num(wan1.availability),
      internetUptime: num(www.uptime),
      downBps: rate(wan["rx_bytes-r"]),
      upBps: rate(wan["tx_bytes-r"]),
      clients: num(wan.num_sta),
      wifiClients: num(wlan.num_user),
      wiredClients: num(lan.num_user),
      accessPoints: num(wlan.num_ap),
      switches: num(lan.num_sw),
      gatewayCpu: num(gw.cpu),
      gatewayMem: num(gw.mem),
      local,
    };
  } catch (err) {
    console.error("unifi health failed (keeping last good):", err.message);
  } finally {
    netRunning = false;
  }
}

// ---------- cellular signal (U5G Outdoor, via UniFi) ----------
//
// The link is a UniFi U5G Outdoor CPE. Its device record is the most sensitive
// payload anywhere on this site: alongside the radio metrics it holds the
// IMEI, the eSIM EID, SIM details, a geo_info block with a STREET ADDRESS, the
// carrier/MCC/MNC, cell ID and PCI (which locate the serving tower), its own
// IP settings, x_authkey and an SSH host-key fingerprint.
//
// Read below, by explicit path and nothing else: network mode, standalone or
// not, signal bars, and RSRP/SINR/RSRQ. The owner asked for general link info
// and specifically not the carrier, so bands and channels are left out too
// (n71 alone identifies the carrier in the US).
//
// stat/device is ~400KB per call for the whole site's gear, and signal does
// not change fast enough to matter, so this runs every two minutes rather than
// with the 30s health poll.
const CELL_INTERVAL_MS = 2 * 60_000;
let cellular = null;
let cellRunning = false;

async function refreshCellular() {
  if (!HOMARR_URL || !HOMARR_TOKEN || cellRunning) return;
  cellRunning = true;
  try {
    const devices = await homarrList("unifiDevices");
    const modem = devices.find((d) => d && d.type === "umbb");
    const radio = modem?.mbb?.radio;
    if (!radio) {
      cellular = null;
      return;
    }
    const num = finite;
    // NR (5G) readings when the 5G leg is up, LTE otherwise. In NSA mode both
    // legs exist; the NR one is what Homarr shows and what matters for speed.
    const nr = num(radio.rsrp_nr) !== null;
    cellular = {
      tech: typeof radio.rat_mode_active === "string" ? radio.rat_mode_active.slice(0, 8) : null,
      standalone: radio["5g_sa_mode"] === true,
      bars: num(radio.signal),
      signalPct: num(radio.signal_percent),
      rsrp: num(nr ? radio.rsrp_nr : radio.rsrp),
      sinr: num(nr ? radio.snr_nr : radio.snr),
      rsrq: num(nr ? radio.rsrq_nr : radio.rsrq),
      ready: modem.mbb.state === "ready",
    };
  } catch (err) {
    console.error("cellular signal failed (keeping last good):", err.message);
  } finally {
    cellRunning = false;
  }
}

// ---------- DNS filtering (Pi-hole, via Homarr) ----------
//
// Aggregates only. Never the query log, top domains or top clients — those
// are a browsing history for everyone on the network.
let dnsStats = null;
let dnsRunning = false;

async function refreshPihole() {
  if (!HOMARR_URL || !HOMARR_TOKEN || dnsRunning) return;
  dnsRunning = true;
  try {
    const s = await homarrGet("piholeSummary");
    const num = finite;
    dnsStats = {
      queries: num(s.queries?.total),
      blocked: num(s.queries?.blocked),
      percentBlocked: num(s.queries?.percent_blocked) === null
        ? null
        : Math.round(s.queries.percent_blocked * 10) / 10,
      clients: num(s.clients?.active),
      blocklist: num(s.gravity?.domains_being_blocked),
    };
  } catch (err) {
    console.error("pi-hole summary failed (keeping last good):", err.message);
  } finally {
    dnsRunning = false;
  }
}

if (HOMARR_URL && HOMARR_TOKEN) {
  refreshProxmox();
  refreshNetwork();
  refreshCellular();
  refreshPihole();
  setInterval(refreshProxmox, CHECK_INTERVAL_MS);
  setInterval(refreshNetwork, NET_INTERVAL_MS);
  setInterval(refreshCellular, CELL_INTERVAL_MS);
  setInterval(refreshPihole, CHECK_INTERVAL_MS);
} else {
  console.warn("HOMARR_TOKEN not set — homelab list falls back to config.json only");
}

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
// Entirely optional. Unauthenticated GitHub allows 60 requests/hour per IP,
// which one cold crawl can exhaust on its own; a token raises that to 5000.
// Absent, everything below still works — it just paces itself harder.
if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GitHub reports the remaining quota on every response. Reading it is the
// only way to pace the crawl honestly — guessing from a call counter drifts,
// because /api/github's own proxy shares the same per-IP budget.
let ghRemaining = null;
let ghResetAt = 0;

async function ghJson(url) {
  const res = await fetch(url, { headers: ghHeaders });
  const rem = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (rem !== null && rem !== "") ghRemaining = Number(rem);
  if (reset !== null && reset !== "") ghResetAt = Number(reset) * 1000;
  const text = res.status === 204 ? "" : await res.text();
  return { status: res.status, text };
}

// Thrown when GitHub rate-limits us, so the whole run aborts instead of
// grinding through a dozen more requests that will all fail the same way.
class RateLimited extends Error {}

// Sentinel: GitHub is still computing this repo's stats, as opposed to the
// repo being unavailable. The two must be handled differently.
const NOT_READY = Symbol("not-ready");

// tries was 10. At 13 repos that is up to 130 calls for one crawl, against an
// unauthenticated ceiling of 60/hour — a single cold crawl could not finish
// inside its own quota. Three gives GitHub ~5s to produce stats it has not
// cached; anything still computing is picked up by the next crawl instead.
async function repoStats(fullName, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const { status, text } = await ghJson(`https://api.github.com/repos/${fullName}/stats/contributors`);
    if (status === 200 && text.trim().startsWith("[")) return JSON.parse(text);
    if (status === 202) { await sleep(2500); continue; } // still computing
    if (status === 204) return [];                       // empty repo, counts as covered
    if (status === 403 || status === 429) throw new RateLimited(fullName);
    return null;                                         // 404 / unexpected: permanent
  }
  return NOT_READY; // exhausted the 202 retries
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
  let added = 0, removed = 0, counted = 0;
  // Two very different kinds of miss, and conflating them is what made the
  // figure disappear entirely:
  //   notReady   — GitHub is still computing (202). Transient, and a repo that
  //                is pushed often can sit here indefinitely because every push
  //                invalidates the cached stats. Blocks publication.
  //   unavailable— 404 or an unexpected status. Permanent; the repo simply
  //                contributes nothing and must NOT block publication forever.
  let notReady = 0, unavailable = 0;

  // Leave a little quota behind so /api/github and /api/profile can still
  // refresh; a crawl that consumes the last call starves the rest of the page.
  const RESERVE = 6;

  for (const full of repos) {
    if (ghRemaining !== null && ghRemaining <= RESERVE) {
      notReady += repos.length - counted - unavailable - notReady;
      return { added, removed, repos: counted, notReady, unavailable, rateLimited: true };
    }
    let stats;
    try {
      stats = await repoStats(full);
    } catch (err) {
      if (err instanceof RateLimited) {
        // Stop immediately. Continuing would burn the remaining quota on calls
        // that cannot succeed.
        notReady += repos.length - counted - unavailable;
        return { added, removed, repos: counted, notReady, unavailable, rateLimited: true };
      }
      throw err;
    }
    if (stats === null) { unavailable++; continue; }
    if (stats === NOT_READY) { notReady++; continue; }
    counted++;
    const mine = stats.find(
      (c) => c.author && c.author.login.toLowerCase() === GITHUB_USER.toLowerCase(),
    );
    if (!mine) continue;
    for (const w of mine.weeks) if (w.w >= cutoff) { added += w.a; removed += w.d; }
  }
  return { added, removed, repos: counted, notReady, unavailable, rateLimited: false };
}

// A PARTIAL total is worse than none: GitHub answers 202 while it computes a
// cold repo's stats, and counting only the repos that happened to be warm
// produced 6,473 instead of the real 483,277. So an incomplete run is never
// cached as the answer — it is retried shortly, and a previously complete
// result keeps being served in the meantime.
// Scheduling is an explicit "do not attempt before" timestamp rather than an
// age comparison against a completeness flag.
//
// The previous version tested `locCache.data.skipped === 0`, but
// computeLinesAdded() returns `notReady` and `unavailable` and has never
// returned a `skipped` field — so that test was `undefined === 0`, i.e.
// permanently false. The 6-hour TTL could therefore never apply and the
// 3-minute retry branch ran forever. Combined with up to 10 polls per repo,
// that was several hundred unauthenticated GitHub calls an hour against a
// limit of 60, so the deployed instance sat permanently rate-limited and the
// figure never appeared for anyone. Don't reintroduce a derived boolean here;
// set the next attempt time explicitly at each outcome below.
const LOC_RETRY_MS = 20 * 60 * 1000;  // some repos still computing
const LOC_FAIL_MS = 10 * 60 * 1000;   // the crawl threw
let locNextAt = 0;

function refreshLinesAdded() {
  if (locRunning) return;
  if (Date.now() < locNextAt) return;

  locRunning = true;
  computeLinesAdded()
    .then((data) => {
      // Publish on COVERAGE, not on a binary. Requiring every repo to resolve
      // meant one perpetually-cold repo hid the figure forever — and this repo
      // is exactly that, since every push invalidates its cached stats on
      // GitHub, so it answers 202 more or less permanently.
      //
      // The threshold separates the two cases that actually occur:
      //   cold start  — 4 of 13 resolved (31%): blocked, which is what stopped
      //                 the wrong 6,473 figure being published.
      //   steady state— 12 of 13 resolved (92%): published, one stale repo is
      //                 a rounding error against ~483k lines.
      const attempted = data.repos + data.notReady + data.unavailable;
      data.coverage = attempted ? data.repos / attempted : 0;
      data.publishable = data.coverage >= 0.85;
      // Only a publishable result replaces a publishable one. The first run
      // seeds the cache regardless so /api/github has something to report,
      // and the client gates rendering on data.publishable anyway.
      if (data.publishable || !locCache.data) locCache = { at: Date.now(), data };

      if (data.rateLimited) {
        // Wait for the window GitHub itself named, not a guess. ghResetAt
        // comes from x-ratelimit-reset; the fallback covers a 403 that
        // arrived without usable headers.
        const until = ghResetAt > Date.now() ? ghResetAt + 30_000 : Date.now() + 60 * 60 * 1000;
        locNextAt = until;
        console.warn(
          `lines-added rate-limited; next attempt ${new Date(until).toISOString()}`,
        );
      } else if (!data.publishable) {
        // Not good enough to show yet, so it is worth coming back soon.
        locNextAt = Date.now() + LOC_RETRY_MS;
        console.warn(
          `lines-added: ${data.notReady} repo(s) still computing, ` +
          `coverage ${Math.round(data.coverage * 100)}%, retrying in 20m`,
        );
      } else {
        // Publishable: take the full TTL even if a repo is still computing.
        // This repo is pushed constantly, so GitHub invalidates its stats and
        // answers 202 more or less permanently — chasing that last repo every
        // 20 minutes would keep the unauthenticated quota pinned forever for a
        // rounding error against ~478k lines.
        locNextAt = Date.now() + LOC_TTL_MS;
        if (data.notReady || data.unavailable) {
          console.warn(
            `lines-added: published at ${Math.round(data.coverage * 100)}% coverage ` +
            `(${data.notReady} computing, ${data.unavailable} unavailable)`,
          );
        }
      }
    })
    .catch((err) => {
      console.error("lines-added computation failed:", err.message);
      // Back off, or a failing run restarts the whole crawl on every request.
      locNextAt = Date.now() + LOC_FAIL_MS;
      if (!locCache.data) locCache = { at: Date.now(), data: null };
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

// One row of the public list. Every field is explicitly chosen: `id`, `name`
// and `node` are labels, `kind` is "lxc" | "vm" | null. `target`, the Homarr
// URL, vmids and anything else address-like never appear.
function statusRow(id, name, node, publicUrl, guest) {
  const last = history[id]?.last;
  let status = last ? (last.ok ? "up" : "down") : "unknown";
  // Proxmox outranks a check here: the check can be a minute stale.
  if (guest && guest.state !== "running") {
    status = guest.state === "stopped" ? "down" : "unknown";
  }
  return {
    id,
    name,
    node,
    status,
    latencyMs: status === "up" && last?.ok ? last.latencyMs : null,
    lastChecked: last?.at ?? null,
    uptime24h: uptime24h(id),
    uptime30d: uptimeOverDays(id, RETAIN_DAYS),
    publicUrl: publicUrl ?? null,
    kind: guest ? guest.kind : null,
  };
}

app.get("/api/status", (req, res) => {
  const rows = [];
  const counts = new Map(); // node id -> guest count, for the group headers

  if (pxInventory) {
    // Pair every guest with the config entry that describes it, if any.
    const guestFor = new Map();
    const unbound = [];
    for (const g of pxInventory.guests) {
      const svc = serviceForGuest(g);
      if (svc && !guestFor.has(svc.id)) guestFor.set(svc.id, g);
      else unbound.push(g);
    }
    // Curated order first (config order), then anything Proxmox knows about
    // that config does not, by vmid, then checks that are not cluster guests.
    for (const svc of config.services) {
      const g = guestFor.get(svc.id);
      if (g) rows.push(statusRow(svc.id, svc.name, nodeIdFor(g.node), svc.publicUrl, g));
    }
    for (const g of unbound) rows.push(statusRow(slugOf(g.name), g.name, nodeIdFor(g.node), null, g));
    for (const svc of config.services) {
      if (!guestFor.has(svc.id) && svc.target) {
        rows.push(statusRow(svc.id, svc.name, svc.node ?? null, svc.publicUrl, null));
      }
    }
    for (const g of pxInventory.guests) {
      const id = nodeIdFor(g.node);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  } else {
    // No Homarr token, or Proxmox unreachable since boot: config only.
    for (const svc of config.services) {
      if (svc.target) rows.push(statusRow(svc.id, svc.name, svc.node ?? null, svc.publicUrl, null));
    }
  }

  const nodeRow = (id, label, px) => ({
    id,
    label,
    online: px ? px.online : null,
    cpu: px ? px.cpu : null,
    cores: px ? px.cores : null,
    mem: px ? px.mem : null,
    memUsed: px ? px.memUsed : null,
    memTotal: px ? px.memTotal : null,
    uptime: px ? px.uptime : null,
    guests: counts.get(id) ?? null,
  });
  const nodes = (config.nodes ?? []).map((n) =>
    nodeRow(n.id, n.label, pxInventory?.nodes.find((x) => x.node === n.proxmox)),
  );
  // A node Proxmox reports that config does not name yet still gets a group.
  for (const px of pxInventory?.nodes ?? []) {
    if (!(config.nodes ?? []).some((n) => n.proxmox === px.node)) {
      nodes.push(nodeRow(nodeIdFor(px.node), px.node, px));
    }
  }

  // Copied field by field, like everything else here: the refresh functions
  // already discarded the dangerous parts, and this keeps it that way even if
  // one of them later grows a field.
  const cluster = pxInventory
    ? {
        uptime: Math.max(0, ...pxInventory.nodes.map((n) => n.uptime || 0)) || null,
        vms: { online: pxInventory.tally.vm.online, offline: pxInventory.tally.vm.offline },
        lxcs: { online: pxInventory.tally.lxc.online, offline: pxInventory.tally.lxc.offline },
        storage: { online: pxInventory.storage.online, offline: pxInventory.storage.offline },
        pool: pxInventory.pool
          ? {
              label: pxInventory.pool.label,
              used: pxInventory.pool.used,
              total: pxInventory.pool.total,
              pct: pxInventory.pool.pct,
            }
          : null,
      }
    : null;

  const n = netHealth;
  const network = n
    ? {
        online: n.online,
        latencyMs: n.latencyMs,
        latencyAvgMs: n.latencyAvgMs,
        availability: n.availability,
        internetUptime: n.internetUptime,
        downBps: n.downBps,
        upBps: n.upBps,
        clients: n.clients,
        wifiClients: n.wifiClients,
        wiredClients: n.wiredClients,
        accessPoints: n.accessPoints,
        switches: n.switches,
        gatewayCpu: n.gatewayCpu,
        gatewayMem: n.gatewayMem,
        local: {
          totalBps: n.local.totalBps,
          wiredDownBps: n.local.wiredDownBps,
          wiredUpBps: n.local.wiredUpBps,
          wifiDownBps: n.local.wifiDownBps,
          wifiUpBps: n.local.wifiUpBps,
          history: trafficHistory.slice(),
        },
        cellular: cellular
          ? {
              tech: cellular.tech,
              standalone: cellular.standalone,
              bars: cellular.bars,
              signalPct: cellular.signalPct,
              rsrp: cellular.rsrp,
              sinr: cellular.sinr,
              rsrq: cellular.rsrq,
              ready: cellular.ready,
            }
          : null,
      }
    : null;

  const dns = dnsStats
    ? {
        queries: dnsStats.queries,
        blocked: dnsStats.blocked,
        percentBlocked: dnsStats.percentBlocked,
        clients: dnsStats.clients,
        blocklist: dnsStats.blocklist,
      }
    : null;

  res.json({
    nodes,
    services: rows,
    cluster,
    network,
    dns,
    source: pxInventory ? "proxmox" : "config",
    inventoryAt: pxInventory?.at ?? null,
    generatedAt: new Date().toISOString(),
  });
});

// ---------- social stats ----------
//
// Best-effort and deliberately partial. Each source is fetched server-side,
// cached for an hour, and simply ABSENT from the response when it fails; the
// page renders a stat only when one is present, so a blocked source quietly
// degrades to a plain link rather than an error or a zero.
//
// What is actually reachable without credentials, measured rather than assumed:
//
//   youtube   works. The channel page embeds the count in its JSON payload.
//   reddit    403. /user/<n>/about.json now requires OAuth; every UA is
//             refused. Left in because it costs one request and starts
//             working the day that changes or a token is supplied.
//   instagram 429. Needs a logged-in session; the public app-id header is
//             rate-limited to uselessness from a server IP.
//   facebook  not attempted. A personal profile's follower count is not
//             exposed to logged-out clients at all, so there is no endpoint
//             to call — a scraper here would be dead code pretending to work.
//
// Scraping HTML is brittle by nature. Every extractor below therefore returns
// null on any surprise instead of throwing, and a null is indistinguishable
// from 'not configured' to the client.

const SOCIAL_TTL_MS = 60 * 60 * 1000;
const SOCIAL_RETRY_MS = 10 * 60 * 1000;
let socialCache = { at: 0, data: null };
let socialRunning = false;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function textOf(url, headers = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function youtubeStats(handle) {
  const html = await textOf("https://www.youtube.com/@" + encodeURIComponent(handle));
  if (!html) return null;
  // The rendered page carries the count as plain text in its embedded JSON.
  const subs = html.match(/([0-9][0-9.,]*\s*[KMB]?)\s+subscribers/i);
  const videos = html.match(/([0-9][0-9.,]*\s*[KMB]?)\s+videos/i);
  if (!subs) return null;
  const out = { subscribers: subs[1].trim() };
  if (videos) out.videos = videos[1].trim();
  return out;
}

async function redditStats(user) {
  const body = await textOf(
    "https://www.reddit.com/user/" + encodeURIComponent(user) + "/about.json",
    { Accept: "application/json" },
  );
  if (!body) return null;
  try {
    const d = JSON.parse(body).data;
    if (!d || typeof d.total_karma !== "number") return null;
    return {
      karma: d.total_karma,
      postKarma: d.link_karma ?? null,
      commentKarma: d.comment_karma ?? null,
      since: d.created_utc ? new Date(d.created_utc * 1000).getUTCFullYear() : null,
    };
  } catch {
    return null; // Reddit serves its HTML shell to blocked clients
  }
}

async function instagramStats(user) {
  const body = await textOf(
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(user),
    { "X-IG-App-ID": "936619743392459" },
  );
  if (!body) return null;
  try {
    const u = JSON.parse(body).data.user;
    const n = u?.edge_followed_by?.count;
    return typeof n === "number" ? { followers: n } : null;
  } catch {
    return null;
  }
}

function refreshSocial() {
  if (socialRunning) return;
  const age = Date.now() - socialCache.at;
  if (socialCache.data && age < SOCIAL_TTL_MS) return;
  if (!socialCache.data && age < SOCIAL_RETRY_MS) return;

  socialRunning = true;
  const social = config.social || {};
  Promise.all([
    social.youtube ? youtubeStats(social.youtube) : null,
    social.reddit ? redditStats(social.reddit) : null,
    social.instagram ? instagramStats(social.instagram) : null,
  ])
    .then(([youtube, reddit, instagram]) => {
      const data = {};
      if (youtube) data.youtube = youtube;
      if (reddit) data.reddit = reddit;
      if (instagram) data.instagram = instagram;
      // Keep the previous answer if this round produced nothing at all —
      // a transient block should not blank stats that were working.
      if (Object.keys(data).length || !socialCache.data) socialCache = { at: Date.now(), data };
      else socialCache.at = Date.now();
    })
    .catch((err) => {
      console.error("social stats failed:", err.message);
      socialCache.at = Date.now();
    })
    .finally(() => { socialRunning = false; });
}

app.get("/api/social", (req, res) => {
  refreshSocial(); // background; never blocks this response
  res.json(socialCache.data || {});
});

app.listen(PORT, () => {
  console.log(`hasanismail-site listening on :${PORT}`);

  // Start the lines-added crawl at boot rather than on the first request.
  // It is a ~14-call crawl and cold repos answer 202, so a lazy start meant
  // the first visitors after a restart saw no figure at all and had to come
  // back minutes later. The tick just drives the retry/TTL logic inside
  // refreshLinesAdded(), which decides for itself whether to do any work.
  refreshLinesAdded();
  // Same reasoning: the YouTube page fetch is the only social source that
  // answers, and doing it at boot means the first visitor already has it.
  refreshSocial();
  setInterval(refreshLinesAdded, 10 * 60 * 1000).unref();
});
