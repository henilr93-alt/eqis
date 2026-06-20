#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Load settings (validates .env)
const settings = require('./config/settings');
const logger = require('./utils/logger');

const STATE_PATH = path.join(__dirname, 'state', 'systemState.json');
const REPORT_DIRS = [
  path.join(settings.REPORT_DIR, 'journey'),
  path.join(settings.REPORT_DIR, 'searchpulse'),
  path.join(settings.REPORT_DIR, 'ecd'),
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
      lastSearchPulseRun: { timestamp: null, health: null, reportPath: null },
      nextJourneyRun: null,
      nextSearchPulseRun: null,
      totalJourneyRuns: 0,
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

async function runJourneyEngine() { /* removed 2026-06-13 */ }

async function runSearchPulseEngine(opts) {
  const state = readState();
  logger.info('[EQIS] Triggering Search Pulse Engine' + (opts && opts.subEngine ? ' (' + opts.subEngine + ')' : '') + '...');
  try {
    const { runSearchPulseEngine: run } = require('./engine3-searchpulse/searchPulseEngine');
    const result = await run(opts);  // 2026-06-14: forward opts so per-sub-engine lock works
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

async function runEcdEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering ECD Engine...');
  try {
    if (settings.ECD_ENABLED !== 'true') {
      logger.info('[EQIS] ECD skipped — ECD_ENABLED=false');
      return;
    }
    const { runEcdComparisonCycle } = require('./ecd-comparator/ecdOrchestrator');
    const result = await runEcdComparisonCycle();
    if (result.skipped) {
      logger.info(`[EQIS] ECD skipped: ${result.reason}`);
      return;
    }
    state.lastEcdRun = {
      timestamp: new Date().toISOString(),
      runId: result.comparison?.runId || null,
      reportPath: result.reportPaths?.htmlPath || null,
      summary: result.comparison?.summary || null,
    };
    state.totalEcdRuns = (state.totalEcdRuns || 0) + 1;
    writeState(state);
    logger.info(`[EQIS] ECD complete — ${result.comparison?.hotelComparisons?.length || 0} hotels`);
  } catch (err) {
    state.lastEcdRun = { timestamp: new Date().toISOString(), error: err.message };
    writeState(state);
    logger.error(`[EQIS] ECD failed: ${err.message}`);
  }
}

async function runFullBookingEngine() { /* removed 2026-06-13 */ }

// Engine 9: merged Flight INTL Audit (search → results audit → book → review
// audit on ONE continuous page). ADDITIVE — runs alongside (does not replace)
// the existing SearchPulse Flight INTL + Review engines until verified. Not
// auto-started on boot; only fires when explicitly started/run.
async function runFlightIntlAuditEngine() {
  const state = readState();
  logger.info('[EQIS] Triggering Flight INTL Audit Engine...');
  try {
    const { runFlightIntlAudit } = require('./engine9-flightintlaudit/flightIntlAuditEngine');
    const row = await runFlightIntlAudit();
    state.lastFlightIntlAuditRun = {
      timestamp: new Date().toISOString(),
      runId: (row && row.runId) || null,
      searchStatus: (row && row.search && row.search.status) || null,
      reviewVerdict: (row && row.review && row.review.verdict) || null,
    };
    state.totalFlightIntlAuditRuns = (state.totalFlightIntlAuditRuns || 0) + 1;
    writeState(state);
    logger.info('[EQIS] Flight INTL Audit complete — search=' +
      (state.lastFlightIntlAuditRun.searchStatus || 'n/a') + ' review=' +
      (state.lastFlightIntlAuditRun.reviewVerdict || 'n/a'));
  } catch (err) {
    state.lastFlightIntlAuditRun = { timestamp: new Date().toISOString(), error: err.message };
    writeState(state);
    logger.error('[EQIS] Flight INTL Audit failed: ' + err.message);
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
  node eqis.js run-journey        Run journey test now
  node eqis.js run-searchpulse    Run search pulse now
  node eqis.js run-fullbooking    Run full booking test now (requires BOOKING_FLOW_ENABLED=true)
  node eqis.js run-ecd            Run ECD comparison cycle now (requires ECD_ENABLED=true)
  node eqis.js run-flightintlaudit  Run one merged Flight INTL Audit now (search + book/review)
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
║  Search Pulse Engine (every 3 min):                  ║
║    Last run: ${(sp.timestamp || 'never').padEnd(41)}║
║    Health: ${(sp.health || 'n/a').padEnd(43)}║
║    Total runs: ${String(state.totalSearchPulseRuns || 0).padEnd(39)}║
║                                                      ║
║  Journey Engine (every 30 min):                      ║
║    Last run: ${(state.lastJourneyRun?.timestamp || 'never').padEnd(41)}║
║    Status: ${(state.lastJourneyRun?.status || 'n/a').padEnd(43)}║
║    Total runs: ${String(state.totalJourneyRuns || 0).padEnd(39)}║
║                                                      ║
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
║  Engine 1 — Journey Testing  : every 30 minutes      ║
║  Engine 2 — Search Pulse         : every 3 minutes       ║
║  Engine 3 — Full Booking         : every 60 minutes      ║
║  FRAKA    — Sub-CTO Review   : hourly auto-review    ║
║  Dashboard : http://localhost:${String(settings.DASHBOARD_PORT || 4000).padEnd(4)}               ║
║  Reports  : ./reports/                               ║
║  Logs     : ./logs/                                  ║
╚══════════════════════════════════════════════════════╝
`);

  // All 4 engines managed by cronManager (user can start/stop each from dashboard)
  const cronManager = require('./utils/cronManager');
  cronManager.setTimezone(settings.TIMEZONE);
  // 2026-06-13: Journey engine removed.
  // CEO 2026-06-01: 4 separate SearchPulse sub-engines, each on its own cron clock.
  cronManager.setRunner('searchPulse.flightDom',  () => runSearchPulseEngine({ subEngine: 'flight-dom' }));
  cronManager.setRunner('searchPulse.flightIntl', () => runSearchPulseEngine({ subEngine: 'flight-intl' }));
  cronManager.setRunner('searchPulse.hotelDom',   () => runSearchPulseEngine({ subEngine: 'hotel-dom' }));
  cronManager.setRunner('searchPulse.hotelIntl',  () => runSearchPulseEngine({ subEngine: 'hotel-intl' }));
  // Backward-compat: keep the legacy parent runner for force-run calls that still pass 'searchPulse'.
  cronManager.setRunner('searchPulse', () => runSearchPulseEngine());
  // 2026-06-13: Full Booking engine removed.
  cronManager.setRunner('ecd', () => runEcdEngine());
  // Engine 9: merged Flight INTL Audit — additive runner (not auto-started).
  cronManager.setRunner('flightIntlAudit', () => runFlightIntlAuditEngine());

  // Schedule all engines
  const intervals = cronManager.getIntervals();
  // CEO 2026-06-01: 4 separate sub-engine cron jobs
  const pulsePatterns = cronManager.scheduleSearchPulseAll(intervals.searchPulse);
  logger.info(`[EQIS] Search Pulse Flight DOM:  ${pulsePatterns.flightDom}  (every ${intervals.searchPulse.flightDom} min)`);
  logger.info(`[EQIS] Search Pulse Flight INTL: ${pulsePatterns.flightIntl} (every ${intervals.searchPulse.flightIntl} min)`);
  logger.info(`[EQIS] Search Pulse Hotel DOM:   ${pulsePatterns.hotelDom}   (every ${intervals.searchPulse.hotelDom} min)`);
  logger.info(`[EQIS] Search Pulse Hotel INTL:  ${pulsePatterns.hotelIntl}  (every ${intervals.searchPulse.hotelIntl} min)`);

  // ECD Comparison — paused by default. Set ECD_ENABLED=true in .env + Start
  // via the ECD dashboard tab to activate. cronManager.state.ecd persists pause/run.
  const ecdMinutes = intervals.ecdMinutes || settings.ECD_RUN_INTERVAL_MINUTES;
  const ecdPattern = cronManager.scheduleEcd(ecdMinutes);
  logger.info(`[EQIS] ECD cron: ${ecdPattern} (every ${ecdMinutes} min) (${settings.ECD_ENABLED === 'true' ? 'ENV ENABLED' : 'ENV DISABLED — set ECD_ENABLED=true to activate'})`);

  // Engine 9: merged Flight INTL Audit — every 2 min (per-engine lock self-
  // throttles overlaps). ADDITIVE: scheduled but NOT auto-started — it stays
  // 'paused' until explicitly started (dashboard toggle / run-once CLI), so it
  // never doubles the live booking load against the existing Review engine
  // until it's verified and the legacy path is removed.
  const fiaPattern = cronManager.scheduleFlightIntlAudit(2);
  logger.info('[EQIS] Flight INTL Audit cron: ' + fiaPattern + ' (every 2 min) — additive, not auto-started');

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

  // Daily-digest emailer — sends one email per roster team at 9am IST
  // containing their subscribed reports (SearchPulse SPF digest / ECD
  // Promote / ECD Renegotiate). Runs in DRY-RUN until GMAIL_OAUTH_* env
  // vars (or state/gmail-oauth-*.json) are configured for eqis@etrav.in.
  try {
    require('./utils/dailyDigestScheduler').register();
  } catch (err) {
    logger.error('[EQIS] Daily digest scheduler failed to register: ' + err.message);
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

  // FRAKA Failure Auditor — vision-analyzes every FAILURE/SPF rated search across
  // all 4 SearchPulse engines, decides Etrav-side vs EQIS-side, and updates the
  // rule book + files tech proposals for confirmed automation bugs.
  try {
    const { runAuditCycle } = require('./fraka/tools/failureAuditor');
    cron.schedule('*/15 * * * *', async () => {
      logger.info('[FRAKA-AUDIT] Failure auditor triggered by cron');
      try {
        const result = await runAuditCycle({ hoursBack: 6, maxAudits: 5 });
        logger.info('[FRAKA-AUDIT] Cycle complete — audited ' + result.audited + ' of ' + result.totalCandidates + ' candidates');
      } catch (err) {
        logger.error('[FRAKA-AUDIT] Failure auditor failed: ' + err.message);
      }
    }, { timezone: settings.TIMEZONE });
    logger.info('[EQIS] FRAKA Failure Auditor registered: every 15 minutes');
  } catch (err) {
    logger.error('[EQIS] FRAKA Failure Auditor failed to register: ' + err.message);
  }

  // (dashboard already started at top of startSystem so healthchecks pass immediately)

  // No automatic boot runs — engines only run when the user
  // explicitly clicks Start on the dashboard (per-engine or master).
  // Scheduled cron runs are still gated by engineState (guardedRun).

  // ── CEO HARD RULE 2026-05-28: SearchPulse auto-start ──────────────
  // Every time EQIS boots, SearchPulse is forced to 'running'. It is also
  // marked as protected in cronManager — pauseAllEngines() (e.g. when FRAKA
  // sleeps) will skip it. Only an explicit user click on the dashboard
  // Stop button can pause SearchPulse.
  try {
    cronManager.start('searchPulse');
    // CEO 2026-06-01: also force-start the SearchPulse sub-engines on boot per directive #5.
    // USER OVERRIDE 2026-06-20: legacy 'searchPulse.flightIntl' is intentionally EXCLUDED
    // from the boot force-start — Flight INTL Audit (Engine 9) now covers the Flight INTL
    // slice, so the legacy Flight INTL SearchPulse must stay shut down across restarts until
    // the user explicitly asks to start it again. Do NOT re-add it here.
    for (const sub of ['searchPulse.flightDom', 'searchPulse.hotelDom', 'searchPulse.hotelIntl']) {
      try { cronManager.start(sub); } catch {}
    }
    logger.info('[EQIS] CEO RULE: SearchPulse + sub-engines force-started on boot (flightIntl excluded per user 2026-06-20; protected from auto-stop)');
  } catch (forceStartErr) {
    logger.warn('[EQIS] SearchPulse force-start failed: ' + forceStartErr.message);
  }

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
    case 'run-ecd':
      ensureDirs();
      await runEcdEngine();
      process.exit(0);
      break;
    case 'run-flightintlaudit':
      ensureDirs();
      await runFlightIntlAuditEngine();
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
