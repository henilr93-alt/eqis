#!/usr/bin/env bash
#
# EQIS — Mac Mini setup script
# Run this ONCE on the new Mac Mini after copying the eqis folder over.
# Usage:  cd eqis  &&  bash setup-macmini.sh
#
set -e  # stop on first error

echo "=============================================="
echo "  EQIS — Mac Mini setup"
echo "=============================================="
echo ""

# --- Move into the script's own folder (the eqis project root) ----------------
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
echo "Project folder: $PROJECT_DIR"
echo ""

# --- 1. Check Node.js ---------------------------------------------------------
echo "[1/5] Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "  ERROR: Node.js is not installed."
  echo "  Install it first:  brew install node    (or download from https://nodejs.org)"
  echo "  EQIS needs Node 20 or newer."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "  Found Node $(node -v)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ERROR: Node 20+ is required. Please upgrade (brew upgrade node)."
  exit 1
fi
echo "  Node version OK."
echo ""

# --- 2. Check the .env file ---------------------------------------------------
echo "[2/5] Checking .env file..."
if [ ! -f ".env" ]; then
  echo "  WARNING: No .env file found!"
  echo "  EQIS needs .env for Etrav login, API keys, etc."
  echo "  Copy your .env from the old machine into this folder, then re-run."
  echo ""
  read -p "  Continue anyway? (y/N) " yn
  case "$yn" in
    [Yy]*) echo "  Continuing without .env...";;
    *) echo "  Stopped. Copy .env over and run again."; exit 1;;
  esac
else
  echo "  .env found."
fi
echo ""

# --- 3. Check the state/ folder ----------------------------------------------
echo "[3/5] Checking state/ folder (EQIS 'brain' — engine status, history)..."
if [ ! -d "state" ]; then
  echo "  WARNING: No state/ folder found!"
  echo "  EQIS will start fresh (no saved engine states or history)."
else
  echo "  state/ folder found."
fi
echo ""

# --- 4. Install npm dependencies ---------------------------------------------
echo "[4/5] Installing npm dependencies (this can take a minute)..."
npm install
echo "  Dependencies installed."
echo ""

# --- 5. Install Playwright Chromium browser ----------------------------------
echo "[5/5] Installing Playwright Chromium browser (~300MB download)..."
npx playwright install chromium
echo "  Chromium installed."
echo ""

echo "=============================================="
echo "  Setup complete!"
echo "=============================================="
echo ""
echo "  Start EQIS with:   npm start"
echo "  Then open:         http://localhost:4000"
echo ""
echo "  Note: if Gmail/Drive features fail, re-authorize tokens with:"
echo "    node authorize-gmail.js"
echo "    node authorize-drive.js"
echo ""
