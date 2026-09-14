# hasanismail.dev-website

Bio, links, live self-hosted service status, and Discord presence for
hasanismail.dev. See `CLAUDE.md` for architecture, invariants, and the
design system.

## Publish this as a public GitHub repo

I can't authenticate as you, so this part needs to be run by you.

With the GitHub CLI (`gh auth login` once, if you haven't):
```
cd hasanismail-site
git init && git add -A && git commit -m "Initial commit"
gh repo create hasan-ismail/hasanismail.dev-website --public --source=. --remote=origin --push
```

Without `gh`, after creating an empty public repo named
`hasanismail.dev-website` on github.com:
```
git remote add origin https://github.com/hasan-ismail/hasanismail.dev-website.git
git branch -M main
git push -u origin main
```

## Install on the LXC (CT 124 / hasanismail.dev)

Once the repo above is pushed, run on the container:
```
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/hasanismail.dev-website/main/install.sh | bash
```

This installs Node 20 if needed, clones the repo to
`/opt/hasanismail-site`, installs deps, and enables the
`hasanismail-site` systemd service on port 3300. Re-running it later
just pulls and restarts.

After install, still needed once:
- Edit `config.json` — the 4 pre-filled services have placeholder ports
  except Jellyfin's (8096); confirm/fix the others.
- Set `DISCORD_USER_ID` in `public/app.js`, and join discord.gg/lanyard
  once for presence to populate.
- Point a Cloudflare Tunnel at the container's port 3300, same as your
  other public sites.

## Local dev

```
npm install
npm start
```
