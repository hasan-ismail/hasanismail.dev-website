# hasanismail.dev-website

Bio, links, live self-hosted service status, and Discord presence for
hasanismail.dev. See [CLAUDE.md](CLAUDE.md) for architecture, the hard
invariant, and the design system.

Node + Express backend, vanilla HTML/CSS/JS frontend. No framework, no
build step, one dependency (`express`).

## Publish this as a public GitHub repo

This part has to be run by you — I can't authenticate as you.

From the project root, with the GitHub CLI (`gh auth login` once, if you
haven't):

```bash
gh repo create hasan-ismail/hasanismail.dev-website --public --source=. --remote=origin --push
```

Without `gh`, create an empty public repo named `hasanismail.dev-website`
on github.com, then:

```bash
git remote add origin https://github.com/hasan-ismail/hasanismail.dev-website.git
git branch -M main
git push -u origin main
```

## Install on the container

Once the repo above is pushed, run this on the target as root:

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/hasanismail.dev-website/main/install.sh | bash
```

It installs Node 20 if needed, installs `git` if needed, clones to
`/opt/hasanismail-site`, installs production deps, and enables the
`hasanismail-site` systemd unit on port 3300. Re-running it pulls the
latest code, refreshes deps, and restarts the service — so the same
one-liner is also the upgrade path.

### Deployment target

CT 124 on node 1 (`lxcpool`) — Debian 13, 2 vCPU / 2 GB / 32 GB,
hostname `hasanismail.dev`, unprivileged, DHCP (currently 192.168.1.200).
The service listens on port 3300 and is fronted by a Cloudflare Tunnel,
the same pattern as `openmasjidsolutions.org` and `openmasjidos`.

## Still manual after install

1. **Confirm the service targets in `config.json`.** Status of the four
   seeded entries (see the table below) — one still needs attention.
2. **Set `DISCORD_USER_ID` in `public/app.js`.** Enable Developer Mode in
   Discord, right-click your profile → Copy User ID. Then join
   <https://discord.gg/lanyard> once — Lanyard only reports presence for
   members of its own server. Until this is set the badge reads
   "presence not configured".
3. **Point the Cloudflare Tunnel** at this host's port 3300.

Then: `systemctl restart hasanismail-site`.

## Monitored services

| id | target | verified? |
|---|---|---|
| `openmasjid-solutions` | `http://192.168.1.241:3000` | ❌ **Not reachable.** CT 122's IP is right, but nothing is listening on 3000 — or on 80, 443, 22, 8080, 8443 or 8723. The container or the app looks stopped. Fix the port (or start the service) before trusting this tile. |
| `jellyfin` | `http://192.168.1.146:8096/health` | ✅ Confirmed — returns 200. |
| `rahima-aziz` | `192.168.1.18:443` (tcp) | ✅ Confirmed — connects. This one is a **TCP** check on purpose: the host redirects HTTP→HTTPS and serves a self-signed cert, which Node's `fetch` rejects (`DEPTH_ZERO_SELF_SIGNED_CERT`), so an `http` check would report a false "down". TCP confirms the port is live but not that the app is healthy. |
| `immich` | `http://192.168.1.98:2283` | ✅ Confirmed — returns 200. Note this is CT 200 on **node 2**, at `.98`. |

Editing `config.json` is all that's needed to add, remove, or retarget a
service — no code changes. A service whose port is wrong reads as
"down"; one pointed at a reachable-but-wrong path can read as "up",
since any HTTP status below 500 counts as up.

## Local dev

```bash
npm install
npm start
```

Then open <http://localhost:3300>.

Checks run from wherever the process is running, so anything not
reachable from your machine will show as "down" locally.
