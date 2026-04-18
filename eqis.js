#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Load settings (validates .env)
const settings = require('./config/settings');
const logger = require('./utils/logger');

const STATE_PATH = path.join(__dirname, 'state', 'systemState.json');
const REPORT_DIRS = [
  path.join(settings.REPORT_DIR, 'zipy'),
  path.join(settings.REPORT_DIR, 'journey'),
  path.join(settings.REPORT_DIR, 'searchpulse'),
];
const LOG_DIR = settings.LOG_DIR;

// ── State management ────────────────────────────────────────────

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {
      status: 'stopped',
      startedAt: null,
      lastJourneyRun: { timestamp: null, status: null, reportPath: null },
      lastZipyRun: { timestamp: null, status: null, reportPath: null },
      lastSearchPulseRun: { timestamp: null, health: null, reportPath: null },
      nextJourneyRun: null,
      nextZipyRun: null,
      nextSearchPulseRun: null,
      totalJourneyRuns: 0,
      totalZipyRuns: 0,
      totalSearchPulseRuns: 0,
      currentSearchHealth: 'UNKNOWN',
    };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function ensureDirs() {
  for (const dir of [...REPORT_DIRS, LOG_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Engine runners (lazy-loaded) ────────────────────────────────

async function runZipyEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering Zipy Engine...');
  try {
    const { runZipyEngine: run } = require('./engine1-zipy/zipyEngine');
    const result = await run();
    state.lastZipyRun = {
      timestamp: new Date().toISOString(),
      status: result.success ? 'success' : 'failed',
      reportPath: result.reportPath || null,
    };
    state.totalZipyRuns++;
    writeState(state);
    logger.info(`[EQIS] Zipy Engine complete — ${result.reportPath || 'no report'}`);
  } catch (err) {
    state.lastZipyRun = { timestamp: new Date().toISOString(), status: 'error', reportPath: null };
    writeState(state);
    logger.error(`[EQIS] Zipy Engine failed: ${err.message}`);
  }
}

async function runJourneyEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering Journey Engine...');
  try {
    const { runJourneyEngine: run } = require('./engine2-journey/journeyEngine');
    const result = await run();
    state.lastJourneyRun = {
      timestamp: new Date().toISOString(),
      status: result.success ? 'success' : 'failed',
      reportPath: result.reportPath || null,
    };
    state.totalJourneyRuns++;
    writeState(state);
    logger.info(`[EQIS] Journey Engine complete — ${result.reportPath || 'no report'}`);
  } catch (err) {
    state.lastJourneyRun = { timestamp: new Date().toISOString(), status: 'error', reportPath: null };
    writeState(state);
    logger.error(`[EQIS] Journey Engine failed: ${err.message}`);
  }
}

async function runSearchPulseEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering Search Pulse Engine...');
  try {
    const { runSearchPulseEngine: run } = require('./engine3-searchpulse/searchPulseEngine');
    const result = await run();
    state.lastSearchPulseRun = {
      timestamp: new Date().toISOString(),
      health: result.pulseData?.overallHealth || 'UNKNOWN',
      reportPath: result.reportPath || null,
    };
    state.totalSearchPulseRuns++;
    state.currentSearchHealth = result.pulseData?.overallHealth || state.currentSearchHealth;
    writeState(state);
    logger.info(`[EQIS] Search Pulse complete — Health: ${state.currentSearchHealth}`);
  } catch (err) {
    state.lastSearchPulseRun = { timestamp: new Date().toISOString(), health: 'error', reportPath: null };
    writeState(state);
    logger.error(`[EQIS] Search Pulse failed: ${err.message}`);
  }
}

async function runFullBookingEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering Full Booking Engine...');
  try {
    const { runFullBookingEngine: run } = require('./engine4-fullbooking/fullBookingEngine');
    const result = await run();
    if (result.skipped) {
      logger.info(`[EQIS] Full Booking skipped: ${result.reason}`);
      return;
    }
    state.lastFullBookingRun = {
      timestamp: new Date().toISOString(),
      status: result.success ? 'success' : 'failed',
      pnrs: result.pnrs || [],
      reportPath: result.reportPath || null,
    };
    state.totalFullBookingRuns = (state.totalFullBookingRuns || 0) + 1;
    writeState(state);
    logger.info(`[EQIS] Full Booking complete — PNRs: ${(result.pnrs || []).join(', ') || 'none'}`);
  } catch (err) {
    state.lastFullBookingRun = { timestamp: new Date().toISOString(), status: 'error', reportPath: null };
    writeState(state);
    logger.error(`[EQIS] Full Booking failed: ${err.message}`);
  }
}

// ── CLI commands ────────────────────────────────────────────────

const command = process.argv[2];

function showHelp() {
  console.log(`
ETRAV QA INTELLIGENCE SYSTEM (EQIS) v1.2

Commands:
  node eqis.js start              Start all engines (recommended)
  node eqis.js stop               Stop all engines
  node eqis.js status             Show current system status
  node eqis.js run-zipy           Run Zipy analysis now
  node eqis.js run-journey        Run journey test now
  node eqis.js run-searchpulse    Run search pulse now
  node eqis.js run-fullbooking    Run full booking test now (requires BOOKING_FLOW_ENABLED=true)
  node eqis.js trial-cmt          Trial run: discover CMT escalation form (headed browser)
  node eqis.js --help             Show this help message
`);
}

function showStatus() {
  const state = readState();
  const sp = state.lastSearchPulseRun || {};
  console.log(`
╔══════════════════════════════════════════════════════╗
║  EQIS STATUS                                         ║
╠══════════════════════════════════════════════════════╣
║  System: ${(state.status || 'unknown').padEnd(45)}║
║  Started: ${(state.startedAt || 'never').padEnd(44)}║
║  Search Health: ${(state.currentSearchHealth || 'UNKNOWN').padEnd(38)}║
║                                                      ║
║  Search Pulse Engine (every 15 min):                 ║
║    Last run: ${(sp.timestamp || 'never').padEnd(41)}║
║    Health: ${(sp.health || 'n/a').padEnd(43)}║
║    Total runs: ${String(state.totalSearchPulseRuns || 0).padEnd(39)}║
║                                                      ║
║  Journey Engine (every 30 min):                      ║
║    Last run: ${(state.lastJourneyRun?.timestamp || 'never').padEnd(41)}║
║    Status: ${(state.lastJourneyRun?.status || 'n/a').padEnd(43)}║
║    Total runs: ${String(state.totalJourneyRuns || 0).padEnd(39)}║
║                                                      ║
║  Zipy Engine (every 10 min):                         ║
║    Last run: ${(state.lastZipyRun?.timestamp || 'never').padEnd(41)}║
║    Status: ${(state.lastZipyRun?.status || 'n/a').padEnd(43)}║
║    Total runs: ${String(state.totalZipyRuns || 0).padEnd(39)}║
╚══════════════════════════════════════════════════════╝
`);
}

async function startSystem() {
  ensureDirs();

  const state = readState();
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.lastSearchPulseRun = state.lastSearchPulseRun || { timestamp: null, health: null, reportPath: null };
  state.totalSearchPulseRuns = state.totalSearchPulseRuns || 0;
  state.currentSearchHealth = state.currentSearchHealth || 'UNKNOWN';
  writeState(state);

  // Start dashboard FIRST so healthchecks (Railway/Render/uptime monitors) get a 200 response
  // immediately. The rest of startup (cron registration, FRAKA setup, CLAUDE.md update) can
  // take 10-30s and would block the healthcheck if dashboard started last.
  try {
    const { startDashboard } = require('./dashboard/server');
    startDashboard();
  } catch (err) {
    logger.error(`[EQIS] Dashboard failed to start: ${err.message}`);
  }

  // Yield to the event loop so app.listen() can actually bind the port BEFORE
  // we run the heavy synchronous work below (cron registration, updateClaudeMd, etc.).
  // Without this yield, the listen callback only fires after all sync code finishes,
  // which can take 10-30s on a fresh deploy and times out cloud healthchecks.
  await new Promise(resolve => setImmediate(resolve));

  console.log(`
╔══════════════════════════════════════════════════════╗
║     ETRAV QA INTELLIGENCE SYSTEM — STARTING UP       ║
╠══════════════════════════════════════════════════════╣
║  Engine 1 — Zipy Analysis    : every 10 minutes      ║
║  Engine 2 — Journey Testing  : every 30 minutes      ║
║  Engine 3 — Search Pulse     : every 15 minutes      ║
║  Engine 4 — Full Booking     : every 60 minutes      ║
║  FRAKA    — Sub-CTO Review   : hourly auto-review    ║
║  Dashboard : http://localhost:${String(settings.DASHBOARD_PORT || 4000).padEnd(4)}               ║
║  Reports  : ./reports/                               ║
║  Logs     : ./logs/                                  ║
╚══════════════════════════════════════════════════════╝
`);

  // All 4 engines managed by cronManager (user can start/stop each from dashboard)
  const cronManager = require('./utils/cronManager');
  cronManager.setTimezone(settings.TIMEZONE);
  cronManager.setRunner('zipy', () => runZipyEngine());
  cronManager.setRunner('journey', () => runJourneyEngine());
  cronManager.setRunner('searchPulse', () => runSearchPulseEngine());
  cronManager.setRunner('fullBooking', () => {
    if (settings.BOOKING_FLOW_ENABLED === 'true') runFullBookingEngine();
  });

  // Schedule all engines (Zipy is now interval-based like the others)
  const intervals = cronManager.getIntervals();
  cronManager.scheduleZipy(intervals.zipyMinutes);
  const journeyPattern = cronManager.scheduleJourney(intervals.journeyMinutes);
  const pulsePattern = cronManager.scheduleSearchPulse(intervals.searchPulseMinutes);
  logger.info(`[EQIS] Journey cron: ${journeyPattern} (every ${intervals.journeyMinutes} min)`);
  logger.info(`[EQIS] Search Pulse cron: ${pulsePattern} (every ${intervals.searchPulseMinutes} min)`);

  // Full Booking — now interval-driven (default every 60 min) via cronManager
  const bookingPattern = cronManager.scheduleFullBooking(intervals.fullBookingMinutes);
  logger.info(`[EQIS] Full Booking cron: ${bookingPattern} (every ${intervals.fullBookingMinutes} min) (${settings.BOOKING_FLOW_ENABLED === 'true' ? 'ENV ENABLED' : 'ENV DISABLED — set BOOKING_FLOW_ENABLED=true to activate real bookings'})`);

  // Restore paused state from previous session (if any engines were stopped via dashboard)
  const persistedState = cronManager.applyPersistedState();
  logger.info(`[EQIS] Engine states: ${JSON.stringify(persistedState)}`);

  // FRAKA sub-CTO agent — hourly review cron (always on, always just suggests)
  try {
    const { runHourlyReview } = require('./fraka/reviewer');
    cron.schedule('0 * * * *', async () => {
      logger.info('[FRAKA] Hourly review triggered by cron');
      try {
        await runHourlyReview();
      } catch (err) {
        logger.error('[FRAKA] Hourly review failed: ' + err.message);
      }
    }, { timezone: settings.TIMEZONE });
    logger.info('[EQIS] FRAKA hourly reviewer registered: 0 * * * * (every hour, on the hour)');
  } catch (err) {
    logger.error('[EQIS] Failed to register FRAKA hourly cron: ' + err.message);
  }

  // CLAUDE.md daily updater — writes full project context every 24h at midnight IST
  try {
    const { updateClaudeMd } = require('./fraka/tools/claudeMdUpdater');
    // Run immediately on startup so CLAUDE.md is always fresh
    updateClaudeMd();
    // Then schedule daily at midnight IST
    cron.schedule('0 0 * * *', () => {
      try { updateClaudeMd(); } catch (e) { logger.error('[EQIS] CLAUDE.md update failed: ' + e.message); }
    }, { timezone: settings.TIMEZONE });
    logger.info('[EQIS] CLAUDE.md updater registered: daily at midnight IST + immediate on boot');
  } catch (err) {
    logger.error('[EQIS] CLAUDE.md updater failed: ' + err.message);
  }

  // (dashboard already started at top of startSystem so healthchecks pass immediately)

  // No automatic boot runs — engines only run when the user
  // explicitly clicks Start on the dashboard (per-engine or master).
  // Scheduled cron runs are still gated by engineState (guardedRun).

  // FRAKA wake/sleep gate: EQIS only runs when FRAKA is awake.
  try {
    const { isFrakaAwake } = require('./fraka/reviewer');
    if (!isFrakaAwake()) {
      cronManager.pauseAllEngines();
      logger.info('[EQIS] 💤 FRAKA is sleeping — all engines paused on boot');
      console.log('  💤 FRAKA is sleeping. Click "Wake Up FRAKA" in the dashboard to activate EQIS.\n');
    } else {
      logger.info('[EQIS] ☀ FRAKA is awake — engines run on schedule');
      console.log('  ☀ FRAKA is awake. EQIS operations are live.\n');
    }
  } catch (e) {
    logger.warn('[EQIS] FRAKA wake/sleep gate check failed: ' + e.message);
    console.log('  System ready. Click START on any engine in the dashboard to begin.\n');
  }

  // Keep process alive
  process.stdin.resume();

  // Graceful shutdown
  const shutdown = () => {
    logger.info('[EQIS] Shutting down gracefully...');
    const s = readState();
    s.status = 'stopped';
    writeState(s);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function stopSystem() {
  const state = readState();
  state.status = 'stopped';
  writeState(state);
  logger.info('[EQIS] System marked as stopped.');
  console.log('EQIS stopped. If running in another terminal, send SIGINT (Ctrl+C) to that process.');
}

// ── Route command ───────────────────────────────────────────────

(async () => {
  switch (command) {
    case 'start':
      await startSystem();
      break;
    case 'stop':
      stopSystem();
      break;
    case 'status':
      showStatus();
      break;
    case 'run-zipy':
      ensureDirs();
      await runZipyEngine();
      process.exit(0);
      break;
    case 'run-journey':
      ensureDirs();
      await runJourneyEngine();
      process.exit(0);
      break;
    case 'run-searchpulse':
      ensureDirs();
      await runSearchPulseEngine();
      process.exit(0);
      break;
    case 'run-fullbooking':
      ensureDirs();
      await runFullBookingEngine();
      process.exit(0);
      break;
    case 'trial-cmt':
      ensureDirs();
      const { runCmtTrial } = require('./engine3-searchpulse/cmtTrialRun');
      await runCmtTrial();
      process.exit(0);
      break;
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
})();
