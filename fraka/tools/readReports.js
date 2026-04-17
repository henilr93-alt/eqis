// Lists the latest N reports from each engine type.
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

const FOLDERS = {
  journey: 'journey',
  searchpulse: 'searchpulse',
  zipy: 'zipy',
  fullbooking: 'fullbooking',
};

function readReports(limitPerEngine = 3) {
  const out = {};
  for (const [type, folder] of Object.entries(FOLDERS)) {
    out[type] = [];
    try {
      const dir = path.join(REPORTS_DIR, folder);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.html'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { filename: f, createdAt: stat.birthtime.toISOString(), sizeKb: Math.round(stat.size / 1024) };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limitPerEngine);
      out[type] = files;
    } catch { /* skip */ }
  }
  return out;
}

module.exports = { readReports };
