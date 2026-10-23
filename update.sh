#!/usr/bin/env bash
# Auto-updater, run every 5 minutes by hasanismail-site-update.timer.
#
# Does nothing unless GitHub's main has moved past what is deployed. A restart
# is not free here: the lines-written figure is a GitHub crawl that a fresh
# process has to redo, and restarting every 5 minutes would spend the whole
# 60-request/hour unauthenticated budget on it. So: fetch, compare, and only
# when there is a new commit, fast-forward and re-run install.sh — the normal
# upgrade path.
#
# The fetch is git's own protocol, not the REST API, so it costs nothing
# against that budget.
set -euo pipefail

# Everything is inside main(), which bash parses in full before running any
# of it: the merge below can replace this very file on disk mid-run.
main() {
  cd /opt/hasanismail-site

  git fetch --quiet origin main

  # Covers "already deployed" and also a checkout that is somehow ahead of
  # GitHub — comparing hashes for equality would redeploy that every 5 minutes.
  if git merge-base --is-ancestor FETCH_HEAD HEAD; then
    return 0
  fi

  local from to
  from=$(git rev-parse --short HEAD)
  to=$(git rev-parse --short FETCH_HEAD)

  # --ff-only: rewritten history (a force-push) is never deployed
  # automatically, and neither is anything that would clobber a local edit.
  if ! git merge --ff-only --quiet FETCH_HEAD; then
    echo "update: cannot fast-forward $from -> $to; deploy by hand" >&2
    return 1
  fi
  echo "update: $from -> $to"

  # The freshly pulled install.sh, so a change to the installer itself takes
  # effect on the same run. Its own git pull is a no-op by now.
  exec bash ./install.sh
}

main "$@"
