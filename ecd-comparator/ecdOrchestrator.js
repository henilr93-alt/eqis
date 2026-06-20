// ecdOrchestrator.js — Top-level glue called by eqis.js / cron / dashboard.
//
// One ECD comparison cycle:
//   1. engine5-ecd  → ECD list per destination
//   2. engine6-mirror → normal-search match per ECD hotel
//   3. comparator  → diff + verdicts
//   4. reportBuilder → HTML + JSON
//   5. history     → append to state/ecdHistory.json (capped)
//   6. systemState → update lastEcdRun

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { runEcdEngine } = require('../engine5-ecd/ecdEngine');
const { runMirrorEngine } = require('../engine6-mirror/mirrorEngine');
const { buildComparison } = require('./comparator');
const { refineWithAiJudge } = require('./aiRefiner');
const { writeReports } = require('./ecdReportBuilder');
const ecdActivity = require('../utils/ecdActivity');
const ecdLiveProgress = require('../utils/ecdLiveProgress');
const { resetSessionTokens, getSessionTokens, getSessionEvalModes } = require('../utils/tokenOptimizer');
const { writeMetrics } = require('../utils/metricsWriter');

const HISTORY_FILE = path.join(__dirname, '..', 'state', 'ecdHistory.json');
const SYSTEM_STATE_FILE = path.join(__dirname, '..', 'state', 'systemState.json');
const MAX_HISTORY_RUNS = 200;

function appendHistory(run) {
  let history = { runs: [] };
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      history = JSON.parse(raw);
      if (!Array.isArray(history.runs)) history.runs = [];
    }
  } catch (err) {
    logger.warn('[ECD-ORCH] history read failed, starting fresh: ' + err.message);
    history = { runs: [] };
  }

  history.runs.push({
    runId: run.runId,
    timestamp: run.timestamp,
    destinations: run.destinations,
    summary: run.summary,
  });

  if (history.runs.length > MAX_HISTORY_RUNS) {
    history.runs = history.runs.slice(-MAX_HISTORY_RUNS);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function updateSystemState(run, reportPaths) {
  let state = {};
  try {
    if (fs.existsSync(SYSTEM_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(SYSTEM_STATE_FILE, 'utf-8'));
    }
  } catch { state = {}; }

  state.lastEcdRun = {
    runId: run.runId,
    timestamp: run.timestamp,
    reportPath: reportPaths.htmlPath,
    summary: run.summary,
  };
  state.totalEcdRuns = (state.totalEcdRuns || 0) + 1;
  state.currentEcdVerdictMix = run.summary || null;

  fs.writeFileSync(SYSTEM_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Run one full ECD comparison cycle. Safe to call from cron OR manually.
 */
async function runEcdComparisonCycle(opts = {}) {
  if (settings.ECD_ENABLED !== 'true' && !opts.force) {
    logger.info('[ECD-ORCH] Skipped — ECD_ENABLED is not "true"');
    return { skipped: true, reason: 'ECD_ENABLED=false' };
  }

  const t0 = Date.now();
  logger.info('[ECD-ORCH] Cycle starting');
  ecdActivity.set('starting', 'Preparing ECD comparison cycle');
  resetSessionTokens();

  // 1. ECD search
  const ecdRun = await runEcdEngine(opts.ecdOverrides || {});

  if (ecdRun.skipped) {
    return { skipped: true, reason: 'ecd engine concurrent skip' };
  }

  // 2. Mirror search
  const mirrorRun = await runMirrorEngine(ecdRun);

  ecdActivity.set('comparing', 'Pairing ECD rooms with bedbank rooms');
  // 3. Comparator (deterministic room+meal matching)
  const comparison = buildComparison(ecdRun, mirrorRun);

  // 3b. AI refiner — for any COMBO_UNMATCHED rows, ask Claude (Haiku) whether
  //     the unmatched ECD room+meal is the same product as the closest-price
  //     bedbank combo. Upgrades confirmed matches to real price comparisons.
  try {
    ecdActivity.set('ai-judge', 'Claude is judging uncertain room matches');
    const aiResult = await refineWithAiJudge(comparison, mirrorRun);
    comparison.aiRefinement = aiResult;
  } catch (e) {
    logger.warn('[ECD-ORCH] AI refiner skipped: ' + e.message);
  }

  comparison.durationMs = Date.now() - t0;

  // 4. Reports
  const reportPaths = writeReports(comparison);

  // 5. History + 6. systemState
  try { appendHistory(comparison); } catch (e) { logger.warn('[ECD-ORCH] history append failed: ' + e.message); }
  try { updateSystemState(comparison, reportPaths); } catch (e) { logger.warn('[ECD-ORCH] systemState update failed: ' + e.message); }

  // 7. Cost metrics — write ECD engine tokens/cost so the Cost tab can show it
  try {
    const tokens = getSessionTokens();
    const modes = getSessionEvalModes();
    const summary = comparison.summary || {};
    const overallStatus = (summary.ecdBrokenCount || 0) > 0 ? 'FAIL'
      : (summary.unmatchedComboCount || 0) > 0 ? 'WARN' : 'PASS';
    await writeMetrics({
      engineType: 'ecd',
      runId: comparison.runId,
      overallStatus,
      durationMs: comparison.durationMs,
      hotelsCompared: (comparison.hotelComparisons || []).length,
      combosCompared: summary.totalCombosCompared || 0,
      destinations: comparison.destinations || [],
      tokensUsed: tokens.total,
      tokensInput: tokens.input,
      tokensOutput: tokens.output,
      apiCalls: tokens.calls,
      evalsFast: modes.fast,
      evalsStandard: modes.standard,
      evalsDeep: modes.deep,
    });
  } catch (e) {
    logger.warn('[ECD-ORCH] cost metrics write failed: ' + e.message);
  }

  logger.info(`[ECD-ORCH] Cycle done in ${(comparison.durationMs / 1000).toFixed(1)}s — ${comparison.hotelComparisons.length} hotels, ${comparison.summary?.totalCombosCompared || 0} combos`);
  ecdLiveProgress.finishRun();
  ecdActivity.set('idle', '');

  return { skipped: false, comparison, reportPaths };
}

module.exports = { runEcdComparisonCycle };
