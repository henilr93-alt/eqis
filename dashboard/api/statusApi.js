const fs = require('fs');
const path = require('path');

function readJson(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf-8'));
  } catch { return null; }
}

function statusApi(req, res) {
  try {
    const systemState = readJson('state/systemState.json');
    const searchSignal = readJson('state/searchQualitySignal.json');
    const trendCache = readJson('state/trendCache.json');

    res.json({
      system: systemState,
      searchHealth: searchSignal?.overallHealth || 'UNKNOWN',
      lastPulseSignals: searchSignal?.apiHealthSignals || [],
      trendDate: trendCache?.forDate || null,
      topRoutes: trendCache?.trends?.flightTrends?.topRoutes?.slice(0, 5) || [],
      topHotels: trendCache?.trends?.hotelTrends?.topDestinations?.slice(0, 5) || [],
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { statusApi };
