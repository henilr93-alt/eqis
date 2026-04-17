const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

function downloadApi(req, res) {
  try {
    const { type } = req.params;
    // Support both flat (:filename) and nested (:a/:b/:c) paths for screenshots
    let filename = req.params.filename || '';
    if (req.params.a) {
      filename = [req.params.a, req.params.b, req.params.c].filter(Boolean).join('/');
    }

    const allowedTypes = ['journey', 'zipy', 'searchpulse', 'fullbooking', 'recordings'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid report type' });
    }

    // Sanitize each path segment to prevent directory traversal
    const segments = filename.split('/').filter(Boolean);
    for (const seg of segments) {
      if (seg === '..' || seg === '.') {
        return res.status(400).json({ error: 'Invalid path' });
      }
      const safeSeg = seg.replace(/[^a-zA-Z0-9\-_.]/g, '');
      if (safeSeg !== seg) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
    }

    const filePath = path.join(REPORTS_DIR, type, ...segments);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Detect content type from extension
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.gif': 'image/gif',
      '.json': 'application/json',
    };
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ error: 'Report not found' });
  }
}

module.exports = { downloadApi };
