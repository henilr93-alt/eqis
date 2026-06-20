#!/usr/bin/env bash
#
# EQIS — Always-On daemon installer (Mac Mini)
# Sets EQIS up as a macOS LaunchAgent so it:
#   - starts automatically when the Mac Mini boots / you log in
#   - restarts automatically if it ever crashes
#   - keeps running after you close Terminal
#
# Run this ONCE on the Mac Mini, AFTER setup-macmini.sh has finished:
#   cd eqis  &&  bash install-daemon.sh
#
set -e

echo "=============================================="
echo "  EQIS — Always-On daemon installer"
echo "=============================================="
echo ""

# --- Resolve paths ------------------------------------------------------------
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: Node.js not found. Run setup-macmini.sh first."
  exit 1
fi

LABEL="com.eqis.daemon"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_OUT="$PROJECT_DIR/logs/daemon-stdout.log"
LOG_ERR="$PROJECT_DIR/logs/daemon-stderr.log"

echo "Project : $PROJECT_DIR"
echo "Node    : $NODE_BIN"
echo "Plist   : $PLIST_PATH"
echo ""

mkdir -p "$PLIST_DIR"
mkdir -p "$PROJECT_DIR/logs"

# --- If already installed, unload the old one first ---------------------------
if [ -f "$PLIST_PATH" ]; then
  echo "Existing daemon found — unloading it first..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# --- Write the LaunchAgent plist ----------------------------------------------
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$PROJECT_DIR/eqis.js</string>
        <string>start</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <!-- Start on login/boot -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Restart automatically if it crashes or exits -->
    <key>KeepAlive</key>
    <true/>

    <!-- Capture output to log files -->
    <key>StandardOutPath</key>
    <string>$LOG_OUT</string>
    <key>StandardErrorPath</key>
    <string>$LOG_ERR</string>
</dict>
</plist>
PLIST

echo "Plist written."
echo ""

# --- Load it ------------------------------------------------------------------
launchctl load "$PLIST_PATH"
echo "Daemon loaded and started."
echo ""

echo "=============================================="
echo "  Done! EQIS is now an always-on service."
echo "=============================================="
echo ""
echo "  Check it is running:   launchctl list | grep eqis"
echo "  View live output:      tail -f \"$LOG_OUT\""
echo "  Stop the service:      launchctl unload \"$PLIST_PATH\""
echo "  Start it again:        launchctl load \"$PLIST_PATH\""
echo ""
echo "  IMPORTANT — stop the Mac Mini from sleeping (otherwise the"
echo "  engines pause when it sleeps). Run this once:"
echo "      sudo pmset -a sleep 0 disksleep 0"
echo "  Or: System Settings > Lock Screen / Energy > never sleep."
echo ""
