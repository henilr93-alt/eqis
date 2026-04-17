const fs = require('fs');
const path = require('path');

const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

const PRICING = {
  inputPerMillion: 3.00,
  outputPerMillion: 15.00,
};

function calcCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputPerMillion;
  return {
    inputCost: parseFloat(inputCost.toFixed(5)),
    outputCost: parseFloat(outputCost.toFixed(5)),
    totalCost: parseFloat((inputCost + outputCost).toFixed(5)),
  };
}

function readMetricsHistory() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));
  } catch { return []; }
}

function costApi(req, res) {
  try {
    const days = parseInt(req.query.days) || 30;
    // Support custom date range via from/to params (YYYY-MM-DD)
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00') : null;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59') : null;
    const history = readMetricsHistory();
    const cutoff = fromDate || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filtered = history.filter(e => { const t = new Date(e.timestamp); return t >= cutoff && (!toDate || t <= toDate); });

    const engines = ['searchpulse', 'journey', 'zipy', 'fullbooking'];

    // Per-engine totals
    const engineTotals = {};
    for (const eng of engines) {
      const entries = filtered.filter(e => e.engineType === eng);
      const inputT = entries.reduce((s, e) => s + (e.tokensInput || Math.round((e.tokensUsed || 0) * 0.85)), 0);
      const outputT = entries.reduce((s, e) => s + (e.tokensOutput || Math.round((e.tokensUsed || 0) * 0.15)), 0);
      const cost = calcCost(inputT, outputT);
      engineTotals[eng] = {
        runs: entries.length,
        inputTokens: inputT,
        outputTokens: outputT,
        totalTokens: inputT + outputT,
        ...cost,
        avgCostPerRun: entries.length > 0 ? parseFloat((cost.totalCost / entries.length).toFixed(6)) : 0,
        evalsFast: entries.reduce((s, e) => s + (e.evalsFast || 0), 0),
        evalsStandard: entries.reduce((s, e) => s + (e.evalsStandard || 0), 0),
        evalsDeep: entries.reduce((s, e) => s + (e.evalsDeep || 0), 0),
      };
    }

    // Daily breakdown
    const byDay = {};
    for (const e of filtered) {
      const day = e.timestamp?.slice(0, 10);
      if (!day) continue;
      if (!byDay[day]) {
        byDay[day] = {};
        for (const eng of engines) byDay[day][eng] = { inputT: 0, outputT: 0 };
      }
      const eng = e.engineType;
      if (byDay[day][eng]) {
        byDay[day][eng].inputT += e.tokensInput || Math.round((e.tokensUsed || 0) * 0.85);
        byDay[day][eng].outputT += e.tokensOutput || Math.round((e.tokensUsed || 0) * 0.15);
      }
    }

    const sortedDays = Object.keys(byDay).sort();
    const dailyCostByEngine = {
      labels: sortedDays,
      searchpulse: sortedDays.map(d => calcCost(byDay[d].searchpulse.inputT, byDay[d].searchpulse.outputT).totalCost),
      journey: sortedDays.map(d => calcCost(byDay[d].journey.inputT, byDay[d].journey.outputT).totalCost),
      zipy: sortedDays.map(d => calcCost(byDay[d].zipy.inputT, byDay[d].zipy.outputT).totalCost),
      fullbooking: sortedDays.map(d => calcCost(byDay[d].fullbooking.inputT, byDay[d].fullbooking.outputT).totalCost),
      total: sortedDays.map(d =>
        engines.reduce((sum, eng) => sum + calcCost(byDay[d][eng].inputT, byDay[d][eng].outputT).totalCost, 0)
      ),
      totalInput: sortedDays.map(d =>
        engines.reduce((sum, eng) => sum + calcCost(byDay[d][eng].inputT, 0).inputCost, 0)
      ),
      totalOutput: sortedDays.map(d =>
        engines.reduce((sum, eng) => sum + calcCost(0, byDay[d][eng].outputT).outputCost, 0)
      ),
    };

    // Monthly projection
    const last7 = filtered.filter(e => new Date(e.timestamp) >= new Date(Date.now() - 7 * 86400000));
    const l7In = last7.reduce((s, e) => s + (e.tokensInput || Math.round((e.tokensUsed || 0) * 0.85)), 0);
    const l7Out = last7.reduce((s, e) => s + (e.tokensOutput || Math.round((e.tokensUsed || 0) * 0.15)), 0);
    const l7Cost = calcCost(l7In, l7Out).totalCost;

    const avgDailyCost = l7Cost / 7;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const monthSoFar = parseFloat((avgDailyCost * dayOfMonth).toFixed(4));
    const monthProjected = parseFloat((avgDailyCost * daysInMonth).toFixed(4));

    const modeBreakdown = {
      fast: Object.values(engineTotals).reduce((s, e) => s + e.evalsFast, 0),
      standard: Object.values(engineTotals).reduce((s, e) => s + e.evalsStandard, 0),
      deep: Object.values(engineTotals).reduce((s, e) => s + e.evalsDeep, 0),
    };

    const alerts = [];
    if (avgDailyCost > 2.00) {
      alerts.push({ level: 'WARN', msg: `Daily avg $${avgDailyCost.toFixed(3)} exceeds the $2.00/day target` });
    }
    if (monthProjected > 30.00) {
      alerts.push({ level: 'WARN', msg: `Month projection $${monthProjected.toFixed(2)} will exceed the $30/month budget` });
    }
    const grandTotal = Object.values(engineTotals).reduce((s, e) => s + e.totalCost, 0);
    for (const [eng, d] of Object.entries(engineTotals)) {
      if (grandTotal > 0 && d.totalCost / grandTotal > 0.65) {
        alerts.push({ level: 'INFO', msg: `${eng} engine is using ${Math.round(d.totalCost / grandTotal * 100)}% of total spend` });
      }
    }

    res.json({
      engineTotals,
      dailyCostByEngine,
      projection: {
        avgDailyCost: parseFloat(avgDailyCost.toFixed(5)),
        monthSoFar,
        monthProjected,
        daysRemaining: daysInMonth - dayOfMonth,
        onTrackBudget: monthProjected <= 30.00,
      },
      modeBreakdown,
      alerts,
      pricing: PRICING,
      meta: { days, totalEntries: filtered.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { costApi };
