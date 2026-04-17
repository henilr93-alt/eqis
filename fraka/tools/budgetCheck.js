// Compute today's spend + budget status.
// Uses the same pricing + calculation logic as dashboard/api/costApi.js.
const fs = require('fs');
const path = require('path');

const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');
const FRAKA_STATE_PATH = path.join(__dirname, '..', '..', 'state', 'fraka', 'frakaState.json');

const PRICING = {
  inputPerMillion: 3.00,
  outputPerMillion: 15.00,
};

const DEFAULT_DAILY_CAP_USD = 50;

function calcCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputPerMillion;
  return parseFloat((inputCost + outputCost).toFixed(5));
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8')); } catch { return []; }
}

function readFrakaState() {
  try { return JSON.parse(fs.readFileSync(FRAKA_STATE_PATH, 'utf-8')); } catch { return {}; }
}

function getEffectiveCapUsd() {
  const state = readFrakaState();
  const now = new Date();
  const approvedUntil = state.approvedUntil ? new Date(state.approvedUntil) : null;
  if (approvedUntil && approvedUntil > now && state.approvedSpendUsd) {
    return Math.max(DEFAULT_DAILY_CAP_USD, state.approvedSpendUsd);
  }
  return DEFAULT_DAILY_CAP_USD;
}

function budgetCheck() {
  const history = readHistory();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = history.filter(e => new Date(e.timestamp) >= cutoff);

  let inputT = 0, outputT = 0, apiCalls = 0;
  const byEngine = { searchpulse: 0, journey: 0, zipy: 0, fullbooking: 0 };
  for (const e of recent) {
    const i = e.tokensInput || 0;
    const o = e.tokensOutput || 0;
    inputT += i;
    outputT += o;
    apiCalls += (e.apiCalls || 0);
    const c = calcCost(i, o);
    if (byEngine[e.engineType] !== undefined) byEngine[e.engineType] += c;
  }

  const spendLast24hUsd = calcCost(inputT, outputT);
  const capUsd = getEffectiveCapUsd();
  const pctUsed = capUsd > 0 ? Math.round((spendLast24hUsd / capUsd) * 100) : 0;

  let status = 'ok';
  if (pctUsed >= 100) status = 'cap-reached';
  else if (pctUsed >= 80) status = 'warn';

  return {
    spendLast24hUsd: parseFloat(spendLast24hUsd.toFixed(5)),
    capUsd,
    defaultCapUsd: DEFAULT_DAILY_CAP_USD,
    pctUsed,
    status,
    runs: recent.length,
    apiCalls,
    tokensInput: inputT,
    tokensOutput: outputT,
    byEngineUsd: Object.fromEntries(
      Object.entries(byEngine).map(([k, v]) => [k, parseFloat(v.toFixed(5))])
    ),
    approvedUntil: readFrakaState().approvedUntil || null,
  };
}

module.exports = { budgetCheck, PRICING, calcCost, getEffectiveCapUsd };
