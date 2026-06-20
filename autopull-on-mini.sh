#!/usr/bin/env bash
#
# EQIS — Auto-pull updater (RUNS ON THE MAC MINI)
# Pulls the latest code from GitHub and restarts EQIS ONLY when something
# actually changed. Safe to run every few minutes from a launchd timer.
#
# It NEVER touches your live data: .env, state/, reports/, and logs/ are
# either git-ignored or stashed aside, so the Mini's "brain" stays intact.
#
# ── ONE-TIME PREP (on the Mac Mini) ──────────────────────────────────────────
#   1. Make sure the eqis folder is a git clone of your repo:
#        cd /Users/henielrupaarelia/Desktop/eqis && git remote -v
#      (should show github.com/henilr93-alt/eqis)
#   2. Make sure the always-on daemon is installed (install-daemon.sh).
#   3. Install the timer (see install-autopull-timer.sh) OR run manually:
#        bash autopull-on-mini.sh
#
set -u

LABEL="com.eqis.daemon"          # launchd label from install-daemon.sh
BRANCH="main"

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"

LOG="$PROJECT_DIR/logs/autopull.log"
mkdir -p "$PROJECT_DIR/logs"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# --- Only proceed if this is a git repo --------------------------------------
if [ ! -d ".git" ]; then
  say "ERROR: $PROJECT_DIR is not a git repo. Clone the repo here first."
  exit 1
fi

# --- Record the current commit so we can tell if anything changed ------------
BEFORE="$(git rev-parse HEAD 2>/dev/null)"

# --- Fetch + fast-forward ----------------------------------------------------
# Stash any local edits (e.g. live state files that slipped through) so the
# pull never fails on a dirty tree, then restore them afterwards.
git fetch origin "$BRANCH" --quiet 2>>"$LOG"

LOCAL_DIRTY=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  LOCAL_DIRTY=1
  git stash push -u -m "autopull-$(date +%s)" --quiet 2>>"$LOG"
fi

git merge --ff-only "origin/$BRANCH" --quiet 2>>"$LOG"
PULL_RC=$?

if [ "$LOCAL_DIRTY" -eq 1 ]; then
  git stash pop --quiet 2>>"$LOG" || say "WARN: stash pop had conflicts (left in stash)."
fi

if [ "$PULL_RC" -ne 0 ]; then
  say "WARN: fast-forward failed (Mini may have diverged — e.g. FRAKA self-edits). No restart."
  exit 0
fi

AFTER="$(git rev-parse HEAD 2>/dev/null)"

# --- Restart EQIS only if the code commit actually moved ---------------------
if [ "$BEFORE" != "$AFTER" ]; then
  say "Updated $BEFORE -> $AFTER. Reinstalling deps (if needed) + restarting EQIS..."
  # Refresh dependencies in case package.json changed (npm ci is a no-op if lockfile unchanged is not guaranteed, so use install).
  npm install --silent >>"$LOG" 2>&1 || say "WARN: npm install reported an issue."
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >>"$LOG" 2>&1 \
    && say "EQIS restarted with new code." \
    || say "WARN: restart failed (is the daemon installed?)."
else
  : # No change — stay quiet to keep the log clean.
fi
