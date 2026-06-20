#!/usr/bin/env bash
#
# EQIS — Auto-pull timer installer (RUNS ON THE MAC MINI)
# Registers a launchd job that runs autopull-on-mini.sh every 3 minutes, so the
# Mini keeps itself in sync with GitHub and restarts EQIS whenever you push new
# code from the MacBook.
#
# Run this ONCE on the Mac Mini, AFTER install-daemon.sh:
#   cd eqis  &&  bash install-autopull-timer.sh
#
set -e

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

LABEL="com.eqis.autopull"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT="$PROJECT_DIR/autopull-on-mini.sh"
INTERVAL=180   # seconds between pulls (3 minutes)

BASH_BIN="$(command -v bash)"

echo "Project : $PROJECT_DIR"
echo "Script  : $SCRIPT"
echo "Plist   : $PLIST_PATH"
echo "Every   : ${INTERVAL}s"
echo ""

mkdir -p "$PLIST_DIR"
mkdir -p "$PROJECT_DIR/logs"
chmod +x "$SCRIPT"

if [ -f "$PLIST_PATH" ]; then
  echo "Existing timer found — unloading it first..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BASH_BIN</string>
        <string>$SCRIPT</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>StartInterval</key>
    <integer>$INTERVAL</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/autopull-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/autopull-stderr.log</string>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"

echo "Auto-pull timer installed and running."
echo ""
echo "  Watch it work:   tail -f \"$PROJECT_DIR/logs/autopull.log\""
echo "  Stop syncing:    launchctl unload \"$PLIST_PATH\""
echo "  Start again:     launchctl load \"$PLIST_PATH\""
