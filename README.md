# hasanismail.dev

My personal website — [hasanismail.dev](https://hasanismail.dev)

A bio, a few links, a Discord presence badge, and a live status grid for
the self-hosted services I run.

## Built with

Node + Express on the back end, plain HTML/CSS/JS on the front. No
framework, no build step, no TypeScript, and a single dependency
(`express`). The uptime checks run server-side and the API only ever
returns a status, a latency and an uptime percentage — never the
addresses being checked.

## Running it locally

```bash
npm install
npm start
```

Then open <http://localhost:3300>.

The status tiles will read "down" for anything not reachable from your
machine, which is expected — they point at services on my own network.

## Deploying

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/hasanismail.dev-website/main/install.sh | bash
```

Run as root on a Debian host. It installs Node if needed, clones to
`/opt/hasanismail-site`, and sets up a systemd service on port 3300.
Re-running it pulls the latest code and restarts, so it doubles as the
upgrade path. I run it on my own hardware behind a Cloudflare Tunnel.

## Configuration

Monitored services live in `config.json` — add, remove or retarget an
entry there and the front end picks it up, no code changes needed.
Discord presence uses [Lanyard](https://github.com/Phineas/lanyard), so
it needs a Discord user ID that has joined the Lanyard server.

Architecture notes, the design system and the maintenance details are in
[CLAUDE.md](CLAUDE.md).
