// dashboard/api/supplierHealthApi.js
// Endpoints powering the "Supplier Health" tab.

const fs = require('fs');
const path = require('path');
const supplierHealth = require('../../utils/supplierHealth');

const STATE_FILE = path.join(__dirname, '..', '..', 'state', 'supplierHealth.json');
const REPORTS_DIR = path.resolve(path.join(__dirname, '..', '..', 'reports'));

function _readRaw() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

// Convert an absolute file path under reports/ into a relative URL the
// dashboard can fetch. Returns null if outside reports/.
function _toScreenshotUrl(absPath) {
  if (!absPath) return null;
  const norm = path.resolve(absPath);
  if (!norm.startsWith(REPORTS_DIR + path.sep)) return null;
  const rel = path.relative(REPORTS_DIR, norm).split(path.sep).join('/');
  return '/api/supplier-health/screenshot?path=' + encodeURIComponent(rel);
}

// GET /api/supplier-health/matrix?windowHours=24
function supplierHealthMatrixApi(req, res) {
  try {
    const w = parseInt(req.query.windowHours || '24', 10) || 24;
    const m = supplierHealth.getMatrix(w);
    res.json(m);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /api/supplier-health/sector?sector=DEL→DXB&windowHours=24
// Returns last N searches for that sector + baseline (now includes screenshotUrl)
function supplierHealthSectorApi(req, res) {
  try {
    const sector = req.query.sector;
    if (!sector) return res.status(400).json({ error: 'sector query parameter required' });
    const w = parseInt(req.query.windowHours || '24', 10) || 24;
    const raw = _readRaw();
    const entry = raw[sector];
    if (!entry || !entry.searches.length) return res.json({ sector, baseline: { airlines: [], totalSearches: 0 }, searches: [] });
    const cutoffMs = Date.now() - (w * 60 * 60 * 1000);
    const searches = entry.searches.filter(s => new Date(s.at).getTime() >= cutoffMs)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 50)
      .map(s => Object.assign({}, s, { screenshotUrl: _toScreenshotUrl(s.screenshotPath) }));
    const baseline = supplierHealth.getBaseline(sector, w);
    res.json({ sector, baseline, searches, windowHours: w });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /api/supplier-health/screenshot?path=journey/PULSE-x/screenshots/airline-filter-x.png
// Serves PNG files under reports/. Path traversal protected — must be under reports/.
function supplierHealthScreenshotApi(req, res) {
  try {
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string') return res.status(400).send('path required');
    const abs = path.resolve(path.join(REPORTS_DIR, rel));
    if (!abs.startsWith(REPORTS_DIR + path.sep)) return res.status(403).send('forbidden');
    if (!fs.existsSync(abs)) return res.status(404).send('not found');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(abs).pipe(res);
  } catch (err) { res.status(500).send(err.message); }
}

module.exports = { supplierHealthMatrixApi, supplierHealthSectorApi, supplierHealthScreenshotApi };
