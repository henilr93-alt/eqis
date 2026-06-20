#!/usr/bin/env bash
#
# EQIS — Auto-sync MacBook -> Mac Mini
# Watches this project for changes and, a few seconds after you save, pushes the
# CODE to the Mac Mini over Tailscale and restarts the EQIS service there.
#
# It NEVER syncs:  .env (secrets), state/ (the Mini's live brain), reports/,
#                  logs/, node_modules/  -> the Mini's live data stays safe.
#
# ── ONE-TIME PREP (on the MacBook) ────────────────────────────────────────────
#   1. brew install fswatch
#   2. Make sure "Remote Login" (SSH) is ON on the Mac Mini:
#        System Settings > General > Sharing > Remote Login = ON
#   3. Set up passwordless SSH so this script never asks for a password:
#        ssh-keygen -t ed25519            (press Enter through the prompts)
#        ssh-copy-id <MINI_USER>@<MINI_HOST>
#   4. Edit the 4 settings just below to match your Mini.
#
# ── RUN IT ────────────────────────────────────────────────────────────────────
#   bash autosync-to-mini.sh
#   (leave it running in a Terminal tab; every save now auto-deploys to the Mini)
#
set -u

# ===== EDIT THESE 4 LINES ====================================================
MINI_USER="henielrupaarelia"          # your username ON THE MAC MINI
MINI_HOST="mac-mini"                  # Mini's Tailscale name or IP (tailscale status)
MINI_PATH="/Users/henielrupaarelia/Desktop/eqis"   # eqis folder path ON THE MINI
LABEL="com.eqis.daemon"               # the launchd label from install-daemon.sh
# =============================================================================

# Allow env overrides without editing the file:
MINI_USER="${EQIS_MINI_USER:-$MINI_USER}"
MINI_HOST="${EQIS_MINI_HOST:-$MINI_HOST}"
MINI_PATH="${EQIS_MINI_PATH:-$MINI_PATH}"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/"   # this project folder (trailing slash matters)
DEST="$MINI_USER@$MINI_HOST:$MINI_PATH/"
DEBOUNCE=8   # seconds to wait after the LAST change before deploying

EXCLUDES=(
  --exclude ".git"
  --exclude "node_modules"
  --exclude ".env"
  --exclude ".env.bak"
  --exclude "state"
  --exclude "reports"
  --exclude "logs"
  --exclude ".DS_Store"
)

# --- Preflight ---------------------------------------------------------------
if ! command -v fswatch >/dev/null 2>&1; then
  echo "ERROR: fswatch is not installed. Run:  brew install fswatch"
  exit 1
fi

echo "=============================================="
echo "  EQIS auto-sync  (MacBook -> Mac Mini)"
echo "=============================================="
echo "  From : $SRC_DIR"
echo "  To   : $DEST"
echo "  Watching for changes... (Ctrl+C to stop)"
echo ""

# --- The deploy function -----------------------------------------------------
deploy() {
  echo "[$(date '+%H:%M:%S')] Change detected -> syncing code to Mini..."
  # Sync code only. No --delete, so we never wipe Mini-only or FRAKA-made files.
  if rsync -az "${EXCLUDES[@]}" "$SRC_DIR" "$DEST"; then
    echo "[$(date '+%H:%M:%S')] Synced. Restarting EQIS on the Mini..."
    # Graceful restart of the LaunchAgent in the Mini's logged-in GUI session.
    ssh "$MINI_USER@$MINI_HOST" \
      "launchctl kickstart -k gui/\$(id -u)/$LABEL" \
      && echo "[$(date '+%H:%M:%S')] Mini restarted with new code. ✔" \
      || echo "[$(date '+%H:%M:%S')] WARNING: restart command failed (is EQIS daemon installed on the Mini?)"
  else
    echo "[$(date '+%H:%M:%S')] ERROR: rsync failed (check Tailscale / SSH / Mini path)."
  fi
  echo ""
}

# --- Initial sync so both sides start identical ------------------------------
echo "Doing an initial full sync..."
deploy

# --- Watch loop with debounce ------------------------------------------------
# fswatch -o prints one line per batch of changes. We then wait out the debounce
# window, drain any further events, and deploy once.
fswatch -o -l 2 \
  --exclude "/\.git/" \
  --exclude "/node_modules/" \
  --exclude "/state/" \
  --exclude "/reports/" \
  --exclude "/logs/" \
  --exclude "\.DS_Store" \
  "$SRC_DIR" | while read -r _; do
    sleep "$DEBOUNCE"
    deploy
done
